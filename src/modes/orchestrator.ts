import { z } from 'zod';
import { callProvider } from '../providers/index.js';
import type { RetrievalResult } from '../providers/types.js';
import type { ProviderName } from '../config.js';
import { deriveExecutionPolicy, type ExecutionPolicy } from '../agents/policy.js';
import {
  DEFAULT_PEER_EXCERPT_CHARS,
  buildDecisionSynthesisPrompt,
  buildGateAppendix,
  buildPeerExcerpt,
  buildRound2Prompt,
  parseGateOutput,
  resolveSourceRef,
  segmentAll,
  selectIssue,
  validateIssues,
  type CollaborationConfig,
  type CollaborationIssue,
  type CollaborationReport,
  type OutputChunk,
} from '../agents/collaboration.js';
import {
  CHIEF_SYSTEM_PROMPT,
  MISSION_CHAR_LIMIT,
  SPECIALIST_CAP,
  buildPlanningPrompt,
} from '../agents/chief.js';

export interface Worker {
  id: string;
  provider: ProviderName;
  model?: string;
  /** What this specialist is good at / responsible for, used by the Chief to pick and brief it. */
  role: string;
  /**
   * Whether this specialist gathers external evidence (market data, competitor
   * benchmarks, research) rather than reasoning from what the model already knows.
   * Used to label a deep run that produced a strategy with no evidence behind it.
   */
  evidenceCapable?: boolean;
}

export type Complexity = 'simple' | 'normal' | 'deep';

/**
 * Whether the run produced what it set out to produce.
 * - SUCCESS: every recruited specialist returned an answer.
 * - DEGRADED: at least one specialist failed, but at least one succeeded. The final
 *   answer is built from a partial team and is worth less than a clean run.
 * - FAILED: no specialist succeeded. There is nothing to synthesize, so synthesis is
 *   skipped rather than asking a model to write a strategy from a list of errors.
 */
export type RunStatus = 'SUCCESS' | 'DEGRADED' | 'FAILED';

/**
 * How much external grounding a `deep` answer actually has behind it.
 *
 * Decided structurally — from the complexity level, which specialists returned, and what
 * retrieval actually did — never by asking the Chief whether it thinks research was
 * needed. Across four measured runs this Chief answered "not needed" every time, so its
 * self-assessment is not a usable signal.
 *
 * - NOT_APPLICABLE:     not a deep task.
 * - HYPOTHESIS:         no retrieval was even attempted.
 * - CONDITIONAL:        retrieval was attempted and did not deliver.
 * - PARTIALLY_GROUNDED: at least one specialist performed real grounded retrieval.
 *
 * The best available label is PARTIALLY_GROUNDED, and that ceiling is deliberate. One
 * grounded specialist proves that specialist searched; it says nothing about whether the
 * final answer's claims are covered by what it found. Deciding that is claim-level work
 * and belongs to the Validation Layer. There is no EVIDENCE_BACKED here to award,
 * because nothing in this layer can earn it.
 */
export type EvidenceLabel =
  | 'PARTIALLY_GROUNDED'
  | 'CONDITIONAL'
  | 'HYPOTHESIS'
  | 'NOT_APPLICABLE';

export interface WorkerFailure {
  agentId: string;
  provider: ProviderName;
  error: string;
}

export interface RunReport {
  status: RunStatus;
  requestedWorkers: number;
  successfulWorkers: number;
  failedWorkers: number;
  failures: WorkerFailure[];
  /** Failure guard, not a record of execution. The policy decides whether synthesis runs. */
  synthesisAllowed: boolean;
  /** Added by runOrchestrator once the executed plan and worker results are available. */
  policy?: ExecutionPolicy;
  evidenceLabel: EvidenceLabel;
  /** What retrieval actually did across the run. Absent when none was attempted. */
  retrieval?: {
    specialistsAsked: number;
    specialistsGrounded: number;
    sourcesFound: number;
    /** Only counted from what providers reported; undefined when none did. */
    queryCount?: number;
    sources: Array<{ url: string; title?: string }>;
  };
  /** Plain-language reasons for the status and label, safe to show a human. */
  notes: string[];
}

/**
 * Planning is bounded and auditable, not deterministic.
 *
 * The same deep task has produced a 2-specialist plan on one run and a 3-specialist
 * plan on the next, from the same prompt and the same roster. That is not a bug to
 * prompt away: the Chief is meant to have judgement, and the guardrails exist to keep
 * its judgement inside a known range, not to fix its answer. Writing enough rules to
 * make the plan reproducible would be hardcoding the answer while claiming to route
 * dynamically.
 *
 * What must instead be true, and is enforced elsewhere in this file:
 *   - the specialist count, mission count and therefore cost stay inside a known range
 *   - every constraint the enforcement layer applies is recorded
 *   - the run's evidence status is visible on the deliverable, so two runs that differ
 *     in whether they gathered evidence cannot be mistaken for each other
 */


export interface PlanningBudget {
  maxSpecialists?: number;
  maxCostUsd?: number;
  maxLatencySeconds?: number;
}

export interface Assignment {
  agentId: string;
  mission: string;
  priority: 'high' | 'medium' | 'low';
}

export interface Plan {
  complexity: Complexity;
  requiredCapabilities: string[];
  assignments: Assignment[];
  requiresRedTeam: boolean;
  reason: string;
}

export interface OrchestratorOptions {
  task: string;
  orchestrator: {
    provider: ProviderName;
    model?: string;
    /** Replaces the Chief's standing brief. Defaults to CHIEF_SYSTEM_PROMPT. */
    systemPrompt?: string;
  };
  workers: Worker[];
  /** Synthesizes worker results into the final answer. Defaults to the orchestrator. */
  synthesizer?: { provider: ProviderName; model?: string };
  budget?: PlanningBudget;
  /** Injectable dispatcher for offline execution tests; not exposed through MCP. */
  call?: typeof callProvider;
  /**
   * Prototypes under measurement. Everything here is off unless a caller asks for it, and
   * a run with it off is byte-identical to a run on a build without it — including the
   * shape of the returned object, so an A/B comparison is not comparing two payloads.
   */
  experimental?: {
    collaboration?: CollaborationConfig;
  };
}

export interface WorkerRunResult {
  agentId: string;
  provider: ProviderName;
  mission: string;
  output?: string;
  error?: string;
  /** Present only when this specialist was asked to retrieve. */
  retrieval?: RetrievalResult;
}

export function buildWorkerPrompt(task: string, mission: string): string {
  return `Original task:
${task}

Assigned mission:
${mission}

Worker contract:
- Use the original task as immutable context for user language, requested format, constraints, scope, and explicit exclusions.
- Execute only the assigned mission. Do not take over the full task, make final cross-specialist decisions, or perform responsibilities outside this mission.
- If the original task and assigned mission appear to conflict, preserve the original task's constraints and answer only the part relevant to your assigned mission.`;
}

const planSchema = z.object({
  complexity: z.enum(['simple', 'normal', 'deep']),
  requiredCapabilities: z.array(z.string()).default([]),
  assignments: z
    .array(
      z.object({
        agentId: z.string(),
        mission: z.string(),
        priority: z.enum(['high', 'medium', 'low']).default('high'),
      })
    )
    .min(1),
  requiresRedTeam: z.boolean().default(false),
  reason: z.string().default(''),
});

function extractJsonObject(text: string): unknown {
  const withoutFences = text.replace(/```(?:json)?/gi, '');
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Chief did not return a JSON object. Raw output: ${text.slice(0, 500)}`);
  }
  return JSON.parse(withoutFences.slice(start, end + 1));
}

/**
 * The prompt states the constraints, but a model can still ignore them. This layer makes
 * the plan conform so that cost and latency stay predictable, and records every change so
 * the Chief's planning behaviour stays auditable.
 */
function enforceConstraints(
  plan: Plan,
  workers: Worker[],
  budget: PlanningBudget | undefined,
  adjustments: string[]
): Plan {
  const known = new Set(workers.map((w) => w.id));
  const seen = new Set<string>();
  const kept: Assignment[] = [];

  for (const assignment of plan.assignments) {
    if (!known.has(assignment.agentId)) {
      adjustments.push(`Dropped mission for unknown agentId "${assignment.agentId}".`);
      continue;
    }
    if (seen.has(assignment.agentId)) {
      adjustments.push(
        `Dropped extra mission for "${assignment.agentId}" (one coherent mission per specialist).`
      );
      continue;
    }
    seen.add(assignment.agentId);

    let mission = assignment.mission;
    if (mission.length > MISSION_CHAR_LIMIT) {
      adjustments.push(
        `Truncated mission for "${assignment.agentId}" from ${mission.length} to ${MISSION_CHAR_LIMIT} characters.`
      );
      mission = mission.slice(0, MISSION_CHAR_LIMIT);
    }
    kept.push({ ...assignment, mission });
  }

  const cap = Math.min(
    SPECIALIST_CAP[plan.complexity],
    budget?.maxSpecialists ?? Number.POSITIVE_INFINITY
  );
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const capped = [...kept]
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])
    .slice(0, cap);

  if (capped.length < kept.length) {
    const dropped = kept.filter((k) => !capped.includes(k)).map((k) => k.agentId);
    adjustments.push(
      `Capped specialists at ${cap} for complexity "${plan.complexity}"; dropped: ${dropped.join(', ')}.`
    );
  }

  if (capped.length === 0) {
    throw new Error('Planning produced no usable assignments after applying constraints.');
  }

  return { ...plan, assignments: capped };
}

/**
 * Derives the run's status and evidence label from what actually happened.
 *
 * Pure and exported so the status rules can be tested without spending an API call —
 * a real run costs roughly four minutes and four model turns.
 */
export function buildRunReport(
  complexity: Complexity,
  workers: Worker[],
  workerResults: WorkerRunResult[]
): RunReport {
  const notes: string[] = [];

  const failures: WorkerFailure[] = workerResults
    .filter((r) => r.error !== undefined)
    .map((r) => ({ agentId: r.agentId, provider: r.provider, error: r.error! }));
  const successfulWorkers = workerResults.length - failures.length;

  let status: RunStatus;
  if (successfulWorkers === 0) {
    status = 'FAILED';
    notes.push('No specialist returned a result; synthesis was skipped.');
  } else if (failures.length > 0) {
    status = 'DEGRADED';
    notes.push(
      `${failures.length} of ${workerResults.length} specialists failed (${failures
        .map((f) => f.agentId)
        .join(', ')}); the answer was built from a partial team.`
    );
  } else {
    status = 'SUCCESS';
  }

  const retrieval = summarizeRetrieval(workerResults);
  const evidenceLabel = deriveEvidenceLabel(complexity, workers, workerResults, notes);

  return {
    status,
    requestedWorkers: workerResults.length,
    successfulWorkers,
    failedWorkers: failures.length,
    failures,
    synthesisAllowed: status !== 'FAILED',
    evidenceLabel,
    retrieval,
    notes,
  };
}

function summarizeRetrieval(workerResults: WorkerRunResult[]): RunReport['retrieval'] {
  const attempts = workerResults.filter((r) => r.retrieval);
  if (attempts.length === 0) return undefined;

  const grounded = attempts.filter((r) => r.retrieval!.status === 'GROUNDED');
  const sources = grounded.flatMap((r) => r.retrieval!.sources);

  // Only sum counts the providers actually reported. If none did, the field stays
  // undefined rather than becoming a zero that reads like a measurement.
  const reported = attempts
    .map((r) => r.retrieval!.queryCount)
    .filter((c): c is number => typeof c === 'number');

  return {
    specialistsAsked: attempts.length,
    specialistsGrounded: grounded.length,
    sourcesFound: sources.length,
    queryCount: reported.length ? reported.reduce((a, b) => a + b, 0) : undefined,
    sources,
  };
}

function deriveEvidenceLabel(
  complexity: Complexity,
  workers: Worker[],
  workerResults: WorkerRunResult[],
  notes: string[]
): EvidenceLabel {
  if (complexity !== 'deep') return 'NOT_APPLICABLE';

  const evidenceRuns = workerResults.filter(
    (r) => workers.find((w) => w.id === r.agentId)?.evidenceCapable
  );

  if (evidenceRuns.length === 0) {
    notes.push(
      'Deep task, but no evidence-gathering specialist was recruited. External facts in ' +
        'this answer (market size, pricing, competitor behaviour, growth rates) come from ' +
        'what the models already believed, not from gathered evidence.'
    );
    return 'HYPOTHESIS';
  }

  const grounded = evidenceRuns.filter((r) => r.retrieval?.status === 'GROUNDED');

  if (grounded.length === 0) {
    const reasons = evidenceRuns.map((r) =>
      r.error ? `${r.agentId} failed` : `${r.agentId}: ${r.retrieval?.status ?? 'no retrieval'}`
    );
    notes.push(
      `Deep task, retrieval was attempted but nothing was gathered (${reasons.join('; ')}). ` +
        'The answer is unevidenced despite the plan calling for evidence.'
    );
    return 'CONDITIONAL';
  }

  const sources = grounded.reduce((n, r) => n + r.retrieval!.sourcesFound, 0);
  notes.push(
    `${grounded.length} specialist(s) performed grounded retrieval and cited ${sources} source(s). ` +
      'That covers those specialists\' own work only — whether the final answer\'s claims ' +
      'are supported by what was found has not been checked, and needs the Validation Layer.'
  );
  return 'PARTIALLY_GROUNDED';
}

/**
 * Puts the run's status on the deliverable itself. Metadata alone does not protect the
 * reader: an unevidenced strategy document reads exactly like an evidenced one.
 */
export function buildOutputBanner(report: RunReport): string {
  const lines: string[] = [];

  if (report.evidenceLabel === 'HYPOTHESIS' || report.evidenceLabel === 'CONDITIONAL') {
    lines.push(
      `> **UNVERIFIED — ${report.evidenceLabel}**`,
      '> No external evidence was gathered for this answer. Treat it as a strategy',
      '> hypothesis to be validated, not as a conclusion. Pricing, market and growth',
      '> figures below are unchecked model assumptions.'
    );
  }

  // A grounded run is still not a validated one, and must not read as though it were.
  if (report.evidenceLabel === 'PARTIALLY_GROUNDED') {
    const r = report.retrieval;
    lines.push(
      '> **PARTIALLY GROUNDED — claims not yet validated**',
      `> ${r?.specialistsGrounded ?? 0} specialist(s) searched and cited ${r?.sourcesFound ?? 0} source(s),`,
      '> listed in the run report. That covers their own research only. Nobody has checked',
      '> whether the figures and claims below are the ones those sources support.'
    );
  }

  if (report.status === 'DEGRADED') {
    if (lines.length) lines.push('>');
    lines.push(
      `> **DEGRADED — ${report.successfulWorkers}/${report.requestedWorkers} specialists returned.**`,
      `> Missing: ${report.failures.map((f) => f.agentId).join(', ')}.`
    );
  }

  return lines.length ? `${lines.join('\n')}\n\n` : '';
}

export interface Round1StageInput {
  task: string;
  orchestrator: OrchestratorOptions['orchestrator'];
  workers: Worker[];
  budget?: PlanningBudget;
  call?: typeof callProvider;
}

export interface Round1StageOutput {
  plan: Plan;
  planningAdjustments: string[];
  workerResults: WorkerRunResult[];
  /** The production run report, including the execution policy synthesis depends on. */
  report: ReturnType<typeof buildRunReport> & { policy: ExecutionPolicy };
  planningMs: number;
  workersMs: number;
  /** Elapsed from entry to the end of Round 1. */
  round1Ms: number;
  /**
   * When Round 1 began, so a caller measuring a longer span — the whole orchestrator run,
   * say — can time from the same origin rather than starting a second clock.
   */
  startedAt: number;
}

/**
 * Everything a run does before synthesis: plan, execute Round 1, judge what came back.
 *
 * Extracted so there is one implementation of this half, callable on its own. Two things
 * need it: `runOrchestrator`, which continues into synthesis, and an experiment that must
 * obtain a genuine production Round 1 and stop — which was impossible while the two halves
 * were welded together, because every eligible run necessarily continued into a synthesis
 * call. The counterpart to `runSynthesisStage`, extracted earlier for the same reason.
 *
 * Behaviour is unchanged from the inline version, deliberately, down to the number of
 * clock reads: `workersEnd` is captured once and used for both `workersMs` and `round1Ms`
 * rather than sampled twice, so a caller with a stepped fake clock sees the same timings
 * before and after the extraction.
 */
export async function runRound1Stage(input: Round1StageInput): Promise<Round1StageOutput> {
  const { task, orchestrator, workers, budget, call = callProvider } = input;
  if (workers.length === 0) throw new Error('Orchestrator requires at least one worker');

  const startedAt = Date.now();

  const planningStart = Date.now();
  const planResult = await call(
    orchestrator.provider,
    buildPlanningPrompt(task, workers, budget),
    {
      model: orchestrator.model,
      // The standing brief goes in the system slot, where it is separate from — and not
      // rewritable by — the task text. Overridable so a caller can run a different Chief,
      // which is also what makes the default testable against alternatives.
      system: orchestrator.systemPrompt ?? CHIEF_SYSTEM_PROMPT,
      stage: 'planning',
    }
  );
  const rawPlan = planSchema.parse(extractJsonObject(planResult.text));
  const planningAdjustments: string[] = [];
  const plan = enforceConstraints(rawPlan, workers, budget, planningAdjustments);
  const planningMs = Date.now() - planningStart;

  const workersStart = Date.now();
  const workerResults: WorkerRunResult[] = await Promise.all(
    plan.assignments.map(async (assignment): Promise<WorkerRunResult> => {
      const worker = workers.find((w) => w.id === assignment.agentId)!;
      try {
        const result = await call(worker.provider, buildWorkerPrompt(task, assignment.mission), {
          model: worker.model,
          system: worker.role,
          stage: 'round1_worker',
          // Search costs money and changes what the answer is made of, so it is attached
          // only to specialists whose job is gathering evidence — and `evidenceCapable`
          // is itself derived, so a specialist cannot request it by asserting it.
          ...(worker.evidenceCapable ? { retrieval: { enabled: true } } : {}),
        });
        return {
          agentId: worker.id,
          provider: worker.provider,
          mission: assignment.mission,
          output: result.text,
          retrieval: result.retrieval,
        };
      } catch (err) {
        return {
          agentId: worker.id,
          provider: worker.provider,
          mission: assignment.mission,
          error: String(err),
        };
      }
    })
  );
  const workersEnd = Date.now();
  const workersMs = workersEnd - workersStart;

  const runReport = buildRunReport(plan.complexity, workers, workerResults);
  const report = {
    ...runReport,
    policy: deriveExecutionPolicy({
      complexity: plan.complexity,
      assignmentIds: plan.assignments.map((assignment) => assignment.agentId),
      status: runReport.status,
      synthesisAllowed: runReport.synthesisAllowed,
      retrievalRequired: plan.assignments.some((assignment) =>
        Boolean(workers.find((worker) => worker.id === assignment.agentId)!.evidenceCapable)
      ),
      workerResults: workerResults.map(({ agentId, output, error, retrieval }) => ({
        agentId, output, error, retrieval,
      })),
    }),
  };

  return {
    plan,
    planningAdjustments,
    workerResults,
    report,
    planningMs,
    workersMs,
    round1Ms: workersEnd - startedAt,
    startedAt,
  };
}

export async function runOrchestrator(options: OrchestratorOptions) {
  const { task, orchestrator, workers, synthesizer = orchestrator, budget, call = callProvider } = options;

  const round1 = await runRound1Stage({ task, orchestrator, workers, budget, call });
  const { plan, planningAdjustments, workerResults, report, planningMs, workersMs, startedAt } = round1;

  if (!report.policy.synthesize) {
    report.notes.push(`Synthesis skipped: ${report.policy.reason}.`);
    return {
      plan,
      planningAdjustments,
      workerResults,
      report,
      finalOutput: report.synthesisAllowed ? workerResults[0].output! : null,
      timings: {
        planningMs,
        workersMs,
        synthesisMs: 0,
        totalMs: Date.now() - startedAt,
      },
    };
  }

  const stage = await runSynthesisStage({
    call,
    task,
    complexity: plan.complexity,
    agentOrder: plan.assignments.map((a) => a.agentId),
    workers,
    workerResults,
    report,
    synthesizer,
    collaboration: options.experimental?.collaboration,
  });

  return {
    plan,
    planningAdjustments,
    workerResults,
    report,
    finalOutput: stage.finalOutput,
    ...(stage.collaboration ? { collaboration: stage.collaboration } : {}),
    timings: {
      planningMs,
      workersMs,
      synthesisMs: stage.synthesisMs,
      totalMs: Date.now() - startedAt,
    },
  };
}

export interface SynthesisStageInput {
  call: typeof callProvider;
  task: string;
  complexity: Complexity;
  /** Assignment order, which fixes the deterministic issue ordering. */
  agentOrder: readonly string[];
  workers: Worker[];
  workerResults: WorkerRunResult[];
  report: RunReport;
  synthesizer: { provider: ProviderName; model?: string };
  collaboration?: CollaborationConfig;
}

export interface SynthesisStageOutput {
  finalOutput: string;
  synthesisMs: number;
  collaboration?: CollaborationReport;
}

/**
 * Everything from the synthesis call onwards, in one place.
 *
 * Shared with `replaySynthesis` on purpose. A replay that rebuilt this prompt separately
 * would be measuring a second implementation of the system rather than the system, and the
 * B / B-prime comparison it exists to support would be worth nothing.
 */
export async function runSynthesisStage(input: SynthesisStageInput): Promise<SynthesisStageOutput> {
  const { call, task, report, synthesizer } = input;
  const succeeded = input.workerResults.filter((r) => r.output !== undefined);
  const specialistBlock = succeeded
    .map((r) => `### ${r.agentId}\nMission: ${r.mission}\nResult: ${r.output}`)
    .join('\n\n');
  const degradedNote =
    report.status === 'DEGRADED'
      ? `\nNote: ${report.failedWorkers} specialist(s) failed and are missing from the above ` +
        `(${report.failures.map((f) => f.agentId).join(', ')}). Do not invent their contribution. ` +
        `Answer from what is present, and say plainly where the answer is thin because of it.\n`
      : '';
  const synthesisPrompt = `Original task:
${task}

Results from each specialist:
${specialistBlock}
${degradedNote}
Synthesize these results into a single, coherent final answer to the original task.`;

  const collaborationEnabled = input.collaboration?.enabled === true;
  const successfulAgentIds = succeeded.map((r) => r.agentId);
  const chunksByAgent = segmentAll(succeeded);

  // Only a clean, multi-specialist deep run can host a peer challenge. A DEGRADED run is
  // excluded on purpose: the gate would be choosing between specialists while one of them
  // is missing, and a challenge routed at a partial team measures the failure, not the
  // collaboration. When the gate is not active the prompt is the existing one, unchanged,
  // so a non-eligible run is not quietly a different experiment.
  const gateBlocked =
    !collaborationEnabled
      ? 'collaboration_disabled'
      : input.complexity !== 'deep'
        ? `complexity_not_deep (${input.complexity})`
        : report.status !== 'SUCCESS'
          ? `round1_status_${report.status.toLowerCase()}`
          : successfulAgentIds.length < 2
            ? 'single_specialist_no_peer'
            : undefined;
  const gateActive = collaborationEnabled && gateBlocked === undefined;

  const synthesisStart = Date.now();
  const finalResult = await call(
    synthesizer.provider,
    gateActive ? synthesisPrompt + buildGateAppendix(successfulAgentIds, chunksByAgent) : synthesisPrompt,
    {
      model: synthesizer.model,
      stage: gateActive ? 'synthesis_gate' : 'synthesis',
    }
  );
  const synthesisMs = Date.now() - synthesisStart;

  const banner = buildOutputBanner(report);

  if (!collaborationEnabled) {
    return { finalOutput: banner + finalResult.text, synthesisMs };
  }

  const collaboration = await runCollaboration({
    call,
    task,
    agentOrder: input.agentOrder,
    workers: input.workers,
    succeeded,
    chunksByAgent,
    specialistBlock,
    degradedNote,
    synthesizer,
    gateActive,
    gateBlocked,
    gateText: finalResult.text,
    gateMs: synthesisMs,
    peerExcerptChars: input.collaboration?.peerExcerptChars ?? DEFAULT_PEER_EXCERPT_CHARS,
    disableRound2: input.collaboration?.disableRound2 === true,
  });

  return {
    // The banner is built from the Round 1 report either way. Collaboration cannot reach
    // the evidence label, so it cannot change what the deliverable claims about itself.
    finalOutput: banner + collaboration.answer,
    synthesisMs,
    collaboration: collaboration.report,
  };
}

interface CollaborationRunInput {
  call: typeof callProvider;
  task: string;
  agentOrder: readonly string[];
  workers: Worker[];
  succeeded: WorkerRunResult[];
  chunksByAgent: Readonly<Record<string, OutputChunk[]>>;
  specialistBlock: string;
  degradedNote: string;
  synthesizer: { provider: ProviderName; model?: string };
  gateActive: boolean;
  gateBlocked: string | undefined;
  gateText: string;
  gateMs: number;
  peerExcerptChars: number;
  disableRound2: boolean;
}

/**
 * Experimental Milestone 2-A.
 *
 * Every exit from here returns a deliverable. The provisional answer produced by the gate
 * is the floor: a missing block, malformed JSON, an unroutable issue, a failed Round 2 or
 * a failed decision synthesis all land on it. Round 1 has already been paid for by the
 * time this runs, so no failure in here is allowed to cost the user that work.
 */
async function runCollaboration(input: CollaborationRunInput): Promise<{
  answer: string;
  report: CollaborationReport;
}> {
  const startedAt = Date.now();
  const notes: string[] = [];

  // The gate call happens before this function is entered, so its cost has to be added
  // back in. Without that, `totalMs` would report collaboration as cheaper than it is by
  // exactly the most expensive call it added.
  const gateMs = input.gateActive ? input.gateMs : undefined;
  const collaborationTotalMs = () => (gateMs ?? 0) + (Date.now() - startedAt);

  const finish = (
    answer: string,
    status: CollaborationReport['status'],
    reason: string,
    extra: Partial<CollaborationReport> = {}
  ): { answer: string; report: CollaborationReport } => ({
    answer,
    report: {
      status,
      reason,
      answerSource: 'round1_provisional',
      parse: { status: 'absent' },
      issues: { emitted: 0, valid: 0, eligible: 0, recorded: [], rejected: [] },
      timings: { gateMs, totalMs: collaborationTotalMs() },
      notes,
      ...extra,
    },
  });

  if (!input.gateActive) {
    notes.push(
      `The collaboration gate did not run: ${input.gateBlocked}. The answer is the ordinary synthesis, unchanged.`
    );
    return finish(input.gateText, 'NOT_TRIGGERED', input.gateBlocked ?? 'not_eligible');
  }

  const parsed = parseGateOutput(input.gateText);
  if (parsed.note) notes.push(parsed.note);
  const provisional = parsed.answer;
  const parseField = { status: parsed.status, note: parsed.note };
  // Kept on every gated exit. The provisional and final answers differ only by the peer
  // exchange, so they can be compared to each other on one task instead of across tasks —
  // which is the only comparison here that is not confounded by task difficulty.
  const gated = {
    provisionalAnswer: provisional,
    chunkMap: Object.fromEntries(
      Object.entries(input.chunksByAgent).map(([id, chunks]) => [id, chunks.map((c) => c.id)])
    ),
  };

  const { valid, rejected } = validateIssues(parsed.rawIssues, {
    successfulAgentIds: input.succeeded.map((r) => r.agentId),
    chunksByAgent: input.chunksByAgent,
  });
  for (const r of rejected) {
    notes.push(`Issue ${r.index} was dropped: ${r.reason}.`);
  }

  const selected = selectIssue(valid, input.agentOrder);
  const eligibleCount = valid.filter((i) => i.decisionSensitive && i.action === 'peer_challenge').length;
  const issuesField = {
    emitted: parsed.rawIssues.length,
    valid: valid.length,
    eligible: eligibleCount,
    recorded: valid,
    rejected,
  };
  if (eligibleCount > 1) {
    notes.push(
      `The gate was asked for at most one peer challenge and returned ${eligibleCount}. ` +
        'The deterministic ordering picked one; the rest are recorded and were not run.'
    );
  }

  // `needs_evidence` is recorded and never acted on. Retrieval in Round 2 would add a
  // second change on top of peer interaction, and the experiment could not then say which
  // of the two produced any difference it measured.
  const recordedEvidenceIssues = valid.filter((i) => i.action === 'needs_evidence');
  if (recordedEvidenceIssues.length) {
    notes.push(
      `${recordedEvidenceIssues.length} issue(s) asked for external verification. They are recorded only: ` +
        'Round 2 performs no retrieval in this experiment, so nothing here was checked against a source.'
    );
  }

  if (!selected) {
    const reason =
      parsed.status === 'absent'
        ? 'no_issue_block'
        : parsed.status !== 'parsed'
          ? `block_${parsed.status}`
          : valid.length === 0
            ? 'no_valid_issue'
            : 'no_decision_sensitive_peer_challenge';
    notes.push('Round 2 was skipped; the provisional answer was delivered as written.');
    return finish(provisional, 'SKIPPED', reason, { ...gated, parse: parseField, issues: issuesField });
  }

  if (input.disableRound2) {
    notes.push(
      'Round 2 is disabled for this run. The issue that would have been acted on is recorded, ' +
        'and the answer is the gate\'s provisional one.'
    );
    return finish(provisional, 'SKIPPED', 'round2_disabled', {
      ...gated,
      parse: parseField,
      issues: issuesField,
      selectedIssue: selected,
    });
  }

  const targetResult = input.succeeded.find((r) => r.agentId === selected.targetAgentId)!;
  const targetWorker = input.workers.find((w) => w.id === selected.targetAgentId)!;
  // Already proved resolvable during validation; an unresolvable ref never reaches here.
  const resolved = resolveSourceRef(selected.sourceRef, input.chunksByAgent);
  if (!resolved.ok) {
    notes.push(`The selected issue's sourceRef stopped resolving: ${resolved.reason}.`);
    return finish(provisional, 'SKIPPED', 'source_ref_unresolvable', {
      ...gated,
      parse: parseField,
      issues: issuesField,
      selectedIssue: selected,
    });
  }
  const excerpt = buildPeerExcerpt(resolved.agentId, resolved.chunk, input.peerExcerptChars);
  const { text: _excerptText, ...excerptMeta } = excerpt;

  const round2Start = Date.now();
  let revised: string;
  try {
    // No retrieval is attached, deliberately, even when this specialist is evidenceCapable.
    const result = await input.call(
      targetWorker.provider,
      buildRound2Prompt({
        task: input.task,
        mission: targetResult.mission,
        previousOutput: targetResult.output!,
        excerpt,
        challenge: selected.challenge,
      }),
      { model: targetWorker.model, system: targetWorker.role, stage: 'round2_worker' }
    );
    revised = result.text;
  } catch (err) {
    const round2Ms = Date.now() - round2Start;
    notes.push(`Round 2 failed (${String(err)}); the provisional answer was delivered instead.`);
    return finish(provisional, 'FAILED', 'round2_worker_failed', {
      ...gated,
      parse: parseField,
      issues: issuesField,
      selectedIssue: selected,
      round2: {
        agentId: targetWorker.id,
        provider: targetWorker.provider,
        peerExcerpt: excerptMeta,
        error: String(err),
      },
      timings: { gateMs, round2Ms, totalMs: collaborationTotalMs() },
    });
  }
  const round2Ms = Date.now() - round2Start;
  const round2Field = {
    agentId: targetWorker.id,
    provider: targetWorker.provider,
    peerExcerpt: excerptMeta,
    output: revised,
  };

  const decisionStart = Date.now();
  let decisionText: string;
  try {
    const decision = await input.call(
      input.synthesizer.provider,
      buildDecisionSynthesisPrompt({
        task: input.task,
        specialistBlock: input.specialistBlock,
        degradedNote: input.degradedNote,
        issue: selected,
        revisedOutput: revised,
      }),
      { model: input.synthesizer.model, stage: 'decision_synthesis' }
    );
    decisionText = decision.text;
  } catch (err) {
    const decisionSynthesisMs = Date.now() - decisionStart;
    notes.push(
      `Decision synthesis failed (${String(err)}); the provisional answer was delivered instead. ` +
        "Round 2's revision is recorded but did not reach the deliverable."
    );
    return finish(provisional, 'FAILED', 'decision_synthesis_failed', {
      ...gated,
      parse: parseField,
      issues: issuesField,
      selectedIssue: selected,
      round2: round2Field,
      timings: { gateMs, round2Ms, decisionSynthesisMs, totalMs: collaborationTotalMs() },
    });
  }
  const decisionSynthesisMs = Date.now() - decisionStart;

  notes.push(
    `${selected.targetAgentId} was challenged from ${selected.sourceRef} and answered; the final ` +
      'answer came from a decision synthesis over that exchange. No new evidence was gathered.'
  );

  return {
    answer: decisionText,
    report: {
      status: 'COMPLETED',
      reason: 'round2_completed',
      answerSource: 'round2_decision_synthesis',
      ...gated,
      parse: parseField,
      issues: issuesField,
      selectedIssue: selected,
      round2: round2Field,
      timings: { gateMs, round2Ms, decisionSynthesisMs, totalMs: collaborationTotalMs() },
      notes,
    },
  };
}

/**
 * A Round 1 result set, frozen so it can be synthesized more than once.
 *
 * Held separately from a full run because the point is to hold the expensive part still.
 * Planning and the specialists vary between runs — the same deep task has produced both a
 * 2- and a 3-specialist plan — so two live runs never share Round 1, and any difference
 * between their answers is partly that. Replaying one frozen Round 1 removes that.
 */
export interface Round1Snapshot {
  task: string;
  complexity: Complexity;
  /** Assignment order, which fixes the deterministic issue ordering. */
  agentOrder: readonly string[];
  workers: Worker[];
  workerResults: WorkerRunResult[];
}

export interface ReplayOptions {
  synthesizer: { provider: ProviderName; model?: string };
  collaboration?: CollaborationConfig;
  call?: typeof callProvider;
}

/**
 * Re-runs the synthesis stage over a frozen Round 1.
 *
 * This is how arm B and arm B-prime are compared: identical specialist outputs, one
 * synthesized with the existing prompt and one with the gate prompt and Round 2 disabled.
 * The difference between those two answers is what the appendix does, with nothing else
 * moving — which is the confound that cannot be measured any other way, because whether a
 * live run triggers Round 2 is correlated with the task, not assigned at random.
 *
 * It delegates to the same `runSynthesisStage` the live path uses, so a replay cannot
 * drift into being a second implementation of the thing under test.
 */
export async function replaySynthesis(snapshot: Round1Snapshot, options: ReplayOptions) {
  const report = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults);
  const startedAt = Date.now();
  const stage = await runSynthesisStage({
    call: options.call ?? callProvider,
    task: snapshot.task,
    complexity: snapshot.complexity,
    agentOrder: snapshot.agentOrder,
    workers: snapshot.workers,
    workerResults: snapshot.workerResults,
    report,
    synthesizer: options.synthesizer,
    collaboration: options.collaboration,
  });

  return {
    report,
    finalOutput: stage.finalOutput,
    ...(stage.collaboration ? { collaboration: stage.collaboration } : {}),
    timings: { synthesisMs: stage.synthesisMs, totalMs: Date.now() - startedAt },
  };
}

/** Freezes the Round 1 half of a completed run so it can be replayed. */
export function toRound1Snapshot(
  run: { plan: Plan; workerResults: WorkerRunResult[] },
  task: string,
  workers: Worker[]
): Round1Snapshot {
  return {
    task,
    complexity: run.plan.complexity,
    agentOrder: run.plan.assignments.map((a) => a.agentId),
    workers,
    workerResults: run.workerResults,
  };
}
