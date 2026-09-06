/**
 * The four Phase 1 arm runners (protocol v0.2 §3.1).
 *
 * A TRIGGERED repetition — the Gate selected an issue:
 *
 *   B        synthesis only                                        1 billable call
 *   B'       shared synthesis_gate provisional, no Round 2         1 billable call (the shared gate)
 *   C        shared gate -> round2_worker -> decision_synthesis    2 billable calls
 *   D1       shared gate -> self_review   -> decision_synthesis    2 billable calls
 *                                                                  ----------------
 *                                                                  TRIGGERED = 6 per repetition
 *
 * A NO-TRIGGER repetition — the Gate selected nothing — costs 2. C degenerates to B'
 * (same finalOutput, no second round) and D1 is skipped with nothing to review. That is a
 * valid observation and must not be discarded; see the H-03 amendment.
 *
 *                                                                  NO-TRIGGER = 2 per repetition
 *
 * B', C and D1 are built on ONE gate response, not three samples of it. That is not a cost
 * optimization first — protocol §5.1: the gate's own output flipped a headline decision
 * between replay #3 and #4 on a byte-identical fixture, so three independent samples would
 * put that variance straight into `C - D1`, the estimate the study exists to make. Sharing
 * it removes the variance and happens to save two calls.
 *
 * B, B' and C run through the production `replaySynthesis`. They are not reimplemented
 * here: an arm that forked production would stop measuring the thing under test.
 * D1 is harness-only, because a self-review path is a control and does not belong in
 * production code.
 */
import { createHash } from 'node:crypto';
import { replaySynthesis, buildRunReport, buildOutputBanner } from '../../../dist/modes/orchestrator.js';
import { createDispatcher } from './dispatcher.mjs';
import { buildSelfReviewPrompt, buildSelfReviewDecisionPrompt } from './prompts.mjs';
import { assertNoPeerLeakage } from './leakage.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/**
 * Rebuilds the specialist block exactly as `runSynthesisStage` does.
 *
 * D1's decision prompt needs it and production does not export it. The duplication is
 * checked rather than trusted: `verify.mjs` asserts this string appears verbatim inside
 * C's captured decision_synthesis prompt, so a change in production's format fails a test
 * instead of silently making C and D1 incomparable.
 */
export function buildSpecialistBlock(snapshot) {
  return snapshot.workerResults
    .filter((r) => r.output !== undefined)
    .map((r) => `### ${r.agentId}\nMission: ${r.mission}\nResult: ${r.output}`)
    .join('\n\n');
}

/** Arm B — the existing orchestrator. No gate appendix at all. */
export async function runArmB({ snapshot, call, pins, temperature, now }) {
  const d = createDispatcher({ call, pins, temperature, now });
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: pins.synthesis.provider, model: pins.synthesis.requestedModel },
    call: d.dispatcher,
  });
  return { arm: 'B', result, calls: d.calls, billable: d.billableCalls().length, gateRecording: null };
}

/**
 * Arm B-prime — the gate appendix, Round 2 disabled.
 *
 * This is also the run that *records* the shared gate response. `disableRound2` keeps
 * `selectedIssue`, which is what lets C and D1 route to the same target specialist later.
 */
export async function runArmBPrime({ snapshot, call, pins, temperature, now }) {
  const d = createDispatcher({ call, pins, temperature, now });
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: pins.synthesis_gate.provider, model: pins.synthesis_gate.requestedModel },
    collaboration: { enabled: true, disableRound2: true },
    call: d.dispatcher,
  });
  return {
    arm: 'B_prime',
    result,
    calls: d.calls,
    billable: d.billableCalls().length,
    gateRecording: d.gateRecording,
  };
}

/** Arm C — the full targeted peer challenge, replaying B-prime's gate response. */
export async function runArmC({ snapshot, call, pins, temperature, gateRecording, now }) {
  if (!gateRecording) throw new Error('runArmC requires the gate recording from arm B-prime');
  const d = createDispatcher({ call, pins, temperature, replay: gateRecording, now });
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: pins.synthesis_gate.provider, model: pins.synthesis_gate.requestedModel },
    collaboration: { enabled: true },
    call: d.dispatcher,
  });
  return { arm: 'C', result, calls: d.calls, billable: d.billableCalls().length };
}

/**
 * Arm D-1 — matched self-review, harness-only.
 *
 * Takes its provisional answer and its target specialist from the same gate response C
 * used. Inheriting the target is the matching requirement (protocol §3.3), not leakage:
 * C and D1 must challenge the same specialist or they are not comparable. Inheriting the
 * *topic* would be leakage, and NC-3 runs on the constructed prompt before the call to
 * make that failure loud.
 */
export async function runArmD1({ snapshot, call, pins, temperature, bPrime, peer, now }) {
  const collab = bPrime.result.collaboration;
  const selected = collab?.selectedIssue;
  if (!selected) {
    return { arm: 'D1', skipped: true, reason: 'no_selected_issue', calls: [], billable: 0 };
  }

  const targetResult = snapshot.workerResults.find((r) => r.agentId === selected.targetAgentId);
  const targetWorker = snapshot.workers.find((w) => w.id === selected.targetAgentId);
  if (!targetResult?.output || !targetWorker) {
    throw new Error(`arm D1: cannot resolve target specialist "${selected.targetAgentId}" in the frozen snapshot`);
  }

  const d = createDispatcher({ call, pins, temperature, now });

  const selfReviewPrompt = buildSelfReviewPrompt({
    task: snapshot.task,
    mission: targetResult.mission,
    previousOutput: targetResult.output,
  });
  // NC-3 before the call, not after: a contaminated D1 answer is unusable, and a warning
  // logged next to a spent call is not a control.
  const leakageCheck = assertNoPeerLeakage(selfReviewPrompt, peer);

  const reviewed = await d.dispatcher(targetWorker.provider, selfReviewPrompt, {
    model: targetWorker.model,
    system: targetWorker.role,
    stage: 'self_review',
  });

  const decisionPrompt = buildSelfReviewDecisionPrompt({
    task: snapshot.task,
    specialistBlock: buildSpecialistBlock(snapshot),
    degradedNote: '',
    targetAgentId: selected.targetAgentId,
    selfObjection: 'stated by the specialist in its own second-round answer below',
    revisedOutput: reviewed.text,
  });
  // The decision prompt legitimately carries the whole Round 1 specialist block — arm C's
  // does too — so the peer passage is present there in both arms by design. The
  // gate-authored challenge and the sourceRef exist nowhere in Round 1, so those still
  // must not appear. See leakage.mjs for why this is parity, not a weakened guard.
  const decisionLeakageCheck = assertNoPeerLeakage(decisionPrompt, peer, { allowPeerChunk: true });

  const decided = await d.dispatcher(pins.decision_synthesis.provider, decisionPrompt, {
    model: pins.decision_synthesis.requestedModel,
    stage: 'decision_synthesis',
  });

  const report = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults);
  const banner = buildOutputBanner(report);

  return {
    arm: 'D1',
    skipped: false,
    result: {
      report,
      finalOutput: banner + decided.text,
      selfReview: {
        agentId: targetWorker.id,
        provider: targetWorker.provider,
        promptSha256: sha256(selfReviewPrompt),
        output: reviewed.text,
      },
    },
    calls: d.calls,
    billable: d.billableCalls().length,
    leakageCheck,
    decisionLeakageCheck,
  };
}

/**
 * Runs one fixture-repetition across all four arms and returns the accounting.
 *
 * The order matters: B-prime must run first because it produces the gate recording C and
 * D1 replay.
 */
export async function runAllArms({ snapshot, call, pins, temperature, now }) {
  const bPrime = await runArmBPrime({ snapshot, call, pins, temperature, now });
  const b = await runArmB({ snapshot, call, pins, temperature, now });

  const selected = bPrime.result.collaboration?.selectedIssue;
  const peerExcerpt = bPrime.result.collaboration?.round2?.peerExcerpt;
  const peer = {
    chunkText: peerExcerpt?.text ?? resolvePeerText(snapshot, selected) ?? '',
    challengeText: selected?.challenge ?? '',
    sourceRef: selected?.sourceRef ?? '',
  };

  const c = await runArmC({ snapshot, call, pins, temperature, gateRecording: bPrime.gateRecording, now });
  const d1 = await runArmD1({ snapshot, call, pins, temperature, bPrime, peer, now });

  const billable = bPrime.billable + b.billable + c.billable + d1.billable;
  return {
    arms: { B: b, B_prime: bPrime, C: c, D1: d1 },
    peer,
    accounting: {
      B: b.billable,
      sharedGate: bPrime.billable,
      C: c.billable,
      D1: d1.billable,
      totalBillable: billable,
      naiveWithoutSharedGate: b.billable + bPrime.billable + (c.billable + 1) + (d1.billable + 1),
    },
  };
}

/** The peer passage arm C was given, resolved from the frozen snapshot with production code. */
function resolvePeerText(snapshot, selected) {
  if (!selected) return null;
  const [agentId, chunkId] = selected.sourceRef.split(':');
  const source = snapshot.workerResults.find((r) => r.agentId === agentId);
  if (!source?.output) return null;
  const paragraphs = source.output.split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean);
  const index = Number(String(chunkId ?? '').replace('p', '')) - 1;
  return paragraphs[index] ?? null;
}
