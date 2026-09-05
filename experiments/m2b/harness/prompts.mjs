/**
 * Arm D-1 prompt builders. Harness-only: arm D is a control, not a candidate feature, so
 * it must not enter the production code path (protocol §23.2, GPT authorization item 9).
 *
 * The hard part is not writing them. It is keeping the parts that are *not* the treatment
 * byte-identical to arm C while the parts that *are* the treatment differ. Protocol v0.2
 * §4.1.1 lists the treatment components; everything else — above all the Decision
 * contract and its neutrality guard — has to match, or `C - D1` measures the synthesizer's
 * preferences instead of the peer-challenge package.
 *
 * So the contract is not copied. It is extracted from the production builder at run time,
 * which means it cannot silently drift out of sync: if production changes its contract,
 * D's prompt changes with it and the drift test says so.
 */
import { buildDecisionSynthesisPrompt, buildRound2Prompt } from '../../../dist/agents/collaboration.js';

const DECISION_CONTRACT_MARKER = 'Decision contract:';
const ROUND2_CONTRACT_MARKER = 'Round 2 contract:';

/** A throwaway issue used only to make the production builder emit its contract text. */
const PROBE_ISSUE = {
  targetAgentId: '__probe_target__',
  sourceRef: '__probe_source__:p1',
  challenge: '__probe_challenge__',
  decisionSensitive: true,
  action: 'peer_challenge',
};

/**
 * Reads the Decision contract verbatim out of the production decision-synthesis prompt.
 *
 * Returns the text from `Decision contract:` to the end, so arm D ships exactly the rules
 * arm C ships — including `Revision, recency, or agreement between specialists is not
 * evidence`, which is what stops the synthesizer from treating a revision as proof.
 */
export function extractDecisionContract() {
  const produced = buildDecisionSynthesisPrompt({
    task: '__probe_task__',
    specialistBlock: '__probe_block__',
    degradedNote: '',
    issue: PROBE_ISSUE,
    revisedOutput: '__probe_revised__',
  });
  const index = produced.indexOf(DECISION_CONTRACT_MARKER);
  if (index === -1) {
    throw new Error(
      'production buildDecisionSynthesisPrompt no longer contains "Decision contract:". ' +
        'Arm D cannot match arm C on the non-treatment parts until this is re-derived.'
    );
  }
  return produced.slice(index);
}

/** Same idea for the Round 2 contract, so D-1's middle round carries C's rules of engagement. */
export function extractRound2Contract() {
  const produced = buildRound2Prompt({
    task: '__probe_task__',
    mission: '__probe_mission__',
    previousOutput: '__probe_previous__',
    excerpt: { agentId: 'a', chunkId: 'p1', text: '__probe_excerpt__', truncated: false, charLimit: 1000 },
    challenge: '__probe_challenge__',
  });
  const index = produced.indexOf(ROUND2_CONTRACT_MARKER);
  if (index === -1) {
    throw new Error('production buildRound2Prompt no longer contains "Round 2 contract:".');
  }
  return produced.slice(index);
}

/**
 * Arm D-1's middle round: self-targeted challenge.
 *
 * D-1 rather than a generic "think again" (protocol §3.2): if the control merely
 * reconsiders, then C and D differ in two things at once — who wrote the objection *and*
 * whether there is a specific target at all — and a targeting effect would be read as a
 * peer effect.
 *
 * Takes no peer input of any kind, by signature. There is no parameter through which a
 * peer chunk, a challenge or a sourceRef could arrive, which is a stronger guarantee than
 * a leakage check after the fact — though NC-3 still runs, because the task, mission and
 * previous output could in principle carry peer text themselves.
 */
export function buildSelfReviewPrompt({ task, mission, previousOutput }) {
  if (arguments.length > 1) throw new Error('buildSelfReviewPrompt takes exactly one argument object');
  for (const [name, value] of Object.entries({ task, mission, previousOutput })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`buildSelfReviewPrompt: "${name}" must be a non-empty string`);
    }
  }

  return `Original task:
${task}

Your assigned mission (unchanged):
${mission}

Your previous answer:
${previousOutput}

The strongest objection to your own answer:
Identify the single strongest objection to your own argument above — the one whose
resolution would most change, strengthen, falsify or materially qualify the decision you
recommended. State that objection in your own words, then answer it.

${extractRound2Contract().replace(ROUND2_CONTRACT_MARKER, 'Second round contract:').replace(
    '- Address only this challenge. Do not restate or expand the rest of your answer beyond what the challenge affects.',
    '- Address only the objection you identified. Do not restate or expand the rest of your answer beyond what it affects.'
  ).replace(
    '- If the challenge is wrong, say so plainly and explain why. Do not concede in order to agree.',
    '- If the objection does not hold, say so plainly and explain why. Do not concede in order to appear balanced.'
  ).replace(
    '- If it is right, correct your answer and state what changed.',
    '- If it holds, correct your answer and state what changed.'
  )}`;
}

/**
 * Arm D-1's decision synthesis.
 *
 * Structurally parallel to `buildDecisionSynthesisPrompt`: same task, same specialist
 * block, same degraded note, same revised output, and the identical Decision contract.
 * What differs is only the framing of where the revision came from — and per protocol
 * v0.2 §4.1.1 that framing is a declared treatment component, not an accident.
 *
 * Phase 1 does no source masking (GPT authorization item 6). C is not rewritten into a
 * generic objection to make D look more like it.
 */
export function buildSelfReviewDecisionPrompt({ task, specialistBlock, degradedNote, targetAgentId, selfObjection, revisedOutput }) {
  for (const [name, value] of Object.entries({ task, specialistBlock, targetAgentId, selfObjection, revisedOutput })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`buildSelfReviewDecisionPrompt: "${name}" must be a non-empty string`);
    }
  }

  return `Original task:
${task}

Results from each specialist:
${specialistBlock}
${degradedNote ?? ''}
${targetAgentId} reconsidered its own answer in a second round:
- Reconsidering specialist: ${targetAgentId}
- The objection it raised against itself: ${selfObjection}
- ${targetAgentId}'s revised answer after that reconsideration:
${revisedOutput}

${extractDecisionContract()
  .replace(
    '- Where the challenge changed the conclusion, use the revised position.',
    '- Where the reconsideration changed the conclusion, use the revised position.'
  )
  .replace(
    '- Where it did not, keep the original position and say briefly why the challenge did not change it.',
    '- Where it did not, keep the original position and say briefly why the reconsideration did not change it.'
  )
  .replace(
    '- Treat the Round 2 response as a challenge response, not as inherently more correct because it is newer or revised.',
    '- Treat the Round 2 response as a reconsideration, not as inherently more correct because it is newer or revised.'
  )
  .replace('the original reasoning, the peer challenge, and the task constraints', 'the original reasoning, the objection, and the task constraints')}`;
}
