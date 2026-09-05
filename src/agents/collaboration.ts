import type { ProviderName } from '../config.js';

/**
 * Experimental Milestone 2-A: targeted peer challenge.
 *
 * Everything here is pure. The orchestrator supplies facts and receives decisions, so the
 * parsing, validation, selection and excerpt rules can be tested without an API call — a
 * real deep run costs roughly four minutes and five model turns.
 *
 * This is a prototype for measurement, not a production feature. It exists to answer one
 * question: is one specialist challenging another worth more than the same model simply
 * thinking again? Until that is measured, nothing here should be treated as validated.
 */

/** Only `peer_challenge` is acted on in this experiment. `needs_evidence` is recorded and nothing more. */
export type IssueAction = 'peer_challenge' | 'needs_evidence';

export interface CollaborationIssue {
  /** The specialist whose work is challenged. Must be a successful Round 1 specialist. */
  targetAgentId: string;
  /**
   * Where the challenge comes from. Agent granularity only: an agentId, never a character
   * range. A model asked for offsets into another model's text will produce offsets that
   * look precise and are not, and there is nothing to check them against.
   */
  sourceRef: string;
  challenge: string;
  decisionSensitive: boolean;
  action: IssueAction;
}

export type BlockParseStatus = 'absent' | 'parsed' | 'malformed' | 'schema_invalid';

export interface ParsedGateOutput {
  /** What the user sees. Never depends on the block parsing, and never empty for non-empty input. */
  answer: string;
  rawIssues: unknown[];
  status: BlockParseStatus;
  note?: string;
}

export type CollaborationStatus = 'NOT_TRIGGERED' | 'SKIPPED' | 'COMPLETED' | 'FAILED';

/** Which call actually produced the delivered answer. */
export type AnswerSource = 'round1_provisional' | 'round2_decision_synthesis';

export interface PeerExcerpt {
  agentId: string;
  startChar: number;
  endChar: number;
  truncated: boolean;
  /** The limit in force for this run, recorded so a run states its own parameters. */
  charLimit: number;
  text: string;
}

export interface RejectedIssue {
  index: number;
  reason: string;
}

export interface CollaborationReport {
  status: CollaborationStatus;
  reason: string;
  answerSource: AnswerSource;
  parse: { status: BlockParseStatus; note?: string };
  issues: {
    emitted: number;
    valid: number;
    eligible: number;
    /** Every valid issue, including `needs_evidence` ones that were recorded and not acted on. */
    recorded: CollaborationIssue[];
    rejected: RejectedIssue[];
  };
  selectedIssue?: CollaborationIssue;
  round2?: {
    agentId: string;
    provider: ProviderName;
    peerExcerpt: Omit<PeerExcerpt, 'text'>;
    output?: string;
    error?: string;
  };
  timings: {
    gateMs?: number;
    round2Ms?: number;
    decisionSynthesisMs?: number;
    totalMs?: number;
  };
  notes: string[];
}

export interface CollaborationConfig {
  /** Off unless a caller asks for it. The default orchestrator path must not change. */
  enabled: boolean;
  /**
   * How much of a peer's Round 1 output is quoted to the challenged specialist.
   *
   * An experimental parameter, not an architecture constant. There is no measurement
   * behind this default; it is a starting value chosen so the prototype can run, and it is
   * recorded in every CollaborationReport so no run's excerpt size has to be guessed later.
   */
  peerExcerptChars?: number;
}

export const DEFAULT_PEER_EXCERPT_CHARS = 1000;

/* ------------------------------------------------------------------ parsing */

const BLOCK_MARKER = 'collaborationIssues';
/** A fenced block at the very end of the text. */
const FENCED_TAIL = /\n?[ \t]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*$/;
/** A bare JSON object that starts a line and runs to the end of the text. */
const BARE_TAIL = /\n[ \t]*(\{[\s\S]*\})[ \t]*$/;

/**
 * Splits a gate response into the deliverable and its optional issue block.
 *
 * The deliverable must never be behind a parse. Planning already depends on a parse, but
 * it fails before any specialist has been paid for; this parse runs after the whole
 * Round 1 cost is spent and on the call that produces the answer itself. So every failure
 * here degrades to "the answer, plus a note" — never to a failed run.
 *
 * A trailing block is only treated as machine-readable when it mentions
 * `collaborationIssues`. That keeps a JSON example inside a genuine answer from being
 * swallowed as metadata.
 */
export function parseGateOutput(text: string): ParsedGateOutput {
  const trimmedEnd = text.replace(/\s+$/, '');

  let body: string | undefined;
  let answer: string | undefined;

  const fenced = trimmedEnd.match(FENCED_TAIL);
  if (fenced && fenced[1].includes(BLOCK_MARKER)) {
    body = fenced[1];
    answer = trimmedEnd.slice(0, fenced.index);
  } else {
    const bare = trimmedEnd.match(BARE_TAIL);
    if (bare && bare[1].includes(BLOCK_MARKER)) {
      body = bare[1];
      answer = trimmedEnd.slice(0, bare.index);
    }
  }

  if (body === undefined || answer === undefined) {
    return { answer: text, rawIssues: [], status: 'absent' };
  }

  // A block with no answer in front of it is not a reason to deliver nothing. Keep the raw
  // response as the answer and say so, rather than handing the user an empty string.
  if (answer.trim().length === 0) {
    return {
      answer: text,
      rawIssues: [],
      status: 'schema_invalid',
      note: 'The gate returned an issue block with no answer before it; the raw response was delivered unchanged.',
    };
  }

  const cleaned = answer.replace(/\s+$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return {
      answer: cleaned,
      rawIssues: [],
      status: 'malformed',
      note: `Issue block was not valid JSON (${String(err)}); it was dropped and the answer delivered as written.`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      answer: cleaned,
      rawIssues: [],
      status: 'schema_invalid',
      note: 'Issue block was not a JSON object; it was dropped.',
    };
  }

  const issues = (parsed as Record<string, unknown>)[BLOCK_MARKER];
  if (!Array.isArray(issues)) {
    return {
      answer: cleaned,
      rawIssues: [],
      status: 'schema_invalid',
      note: `Issue block had no "${BLOCK_MARKER}" array; it was dropped.`,
    };
  }

  return { answer: cleaned, rawIssues: issues, status: 'parsed' };
}

/* -------------------------------------------------------------- validation */

export interface ValidationContext {
  /** Ids of Round 1 specialists that returned an answer, in assignment order. */
  successfulAgentIds: readonly string[];
}

export interface ValidationOutcome {
  valid: CollaborationIssue[];
  rejected: RejectedIssue[];
}

/**
 * Keeps only issues that can actually be routed.
 *
 * `sourceRef` must name a different specialist from `targetAgentId`. Without that, a
 * "peer challenge" can be an agent quoting itself, which is self-review — the very thing
 * arm D exists to isolate. Allowing it would let the experiment answer its own question
 * wrongly.
 */
export function validateIssues(raw: unknown[], context: ValidationContext): ValidationOutcome {
  const known = new Set(context.successfulAgentIds);
  const valid: CollaborationIssue[] = [];
  const rejected: RejectedIssue[] = [];

  raw.forEach((entry, index) => {
    const reject = (reason: string) => rejected.push({ index, reason });

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return reject('not a JSON object');
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.targetAgentId !== 'string') return reject('targetAgentId is not a string');
    if (typeof e.sourceRef !== 'string') return reject('sourceRef is not a string');
    if (typeof e.challenge !== 'string' || e.challenge.trim().length === 0) {
      return reject('challenge is missing or empty');
    }
    if (typeof e.decisionSensitive !== 'boolean') return reject('decisionSensitive is not a boolean');
    if (e.action !== 'peer_challenge' && e.action !== 'needs_evidence') {
      return reject(`action is not a known action (${JSON.stringify(e.action)})`);
    }
    if (!known.has(e.targetAgentId)) {
      return reject(`targetAgentId "${e.targetAgentId}" is not a successful Round 1 specialist`);
    }
    if (!known.has(e.sourceRef)) {
      return reject(`sourceRef "${e.sourceRef}" is not a successful Round 1 specialist`);
    }
    if (e.sourceRef === e.targetAgentId) {
      return reject('sourceRef and targetAgentId are the same specialist; that is self-review, not a peer challenge');
    }

    valid.push({
      targetAgentId: e.targetAgentId,
      sourceRef: e.sourceRef,
      challenge: e.challenge.trim(),
      decisionSensitive: e.decisionSensitive,
      action: e.action,
    });
  });

  return { valid, rejected };
}

/** Round 2 acts on decision-sensitive peer challenges only. */
export function isRound2Eligible(issue: CollaborationIssue): boolean {
  return issue.decisionSensitive === true && issue.action === 'peer_challenge';
}

/* --------------------------------------------------------------- selection */

/**
 * Picks at most one issue, deterministically and without another model call.
 *
 * Order: the specialist earliest in the plan's assignment order, then the peer earliest in
 * that order, then the order the gate emitted them.
 *
 * Assignment order is already the Chief's priority order, so this challenges the
 * highest-priority work first. The point is not that this ranking is optimal — it is that
 * it is fixed, so the same gate output always selects the same issue and a change in
 * behaviour cannot be waved away as run-to-run variation.
 */
export function selectIssue(
  issues: readonly CollaborationIssue[],
  agentOrder: readonly string[]
): CollaborationIssue | undefined {
  const rank = (id: string) => {
    const i = agentOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  const eligible = issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => isRound2Eligible(issue));
  if (eligible.length === 0) return undefined;

  eligible.sort((a, b) => {
    const target = rank(a.issue.targetAgentId) - rank(b.issue.targetAgentId);
    if (target !== 0) return target;
    const source = rank(a.issue.sourceRef) - rank(b.issue.sourceRef);
    if (source !== 0) return source;
    return a.index - b.index;
  });

  return eligible[0].issue;
}

/* ----------------------------------------------------------------- excerpt */

/**
 * Quotes a bounded, auditable slice of the peer's Round 1 output.
 *
 * Deterministic by construction: the runtime takes the slice, the model never supplies
 * offsets, and the offsets taken are recorded. Known limitation: `sourceRef` resolves to an
 * agent, not a passage, so a long peer answer is quoted from its head and the challenged
 * passage may fall outside the window. Fixing that needs passage-level references, which
 * needs evidence that agent-level quoting is insufficient. That evidence does not exist yet.
 */
export function buildPeerExcerpt(agentId: string, output: string, charLimit: number): PeerExcerpt {
  const limit = Math.max(1, Math.floor(charLimit));
  const truncated = output.length > limit;
  const text = truncated ? output.slice(0, limit) : output;
  return {
    agentId,
    startChar: 0,
    endChar: text.length,
    truncated,
    charLimit: limit,
    text,
  };
}

/* ------------------------------------------------------------------ prompts */

/** Appended to the synthesis prompt when the gate is active. The answer comes first, always. */
export function buildGateAppendix(agentIds: readonly string[]): string {
  return `

Optional collaboration block
----------------------------
After the complete answer above, you may append one fenced block in exactly this form:

\`\`\`json
{"${BLOCK_MARKER}": [{"targetAgentId": "...", "sourceRef": "...", "challenge": "...", "decisionSensitive": true, "action": "peer_challenge"}]}
\`\`\`

If you include it:
- The answer above must already be complete and usable on its own. This block is metadata, not part of the answer.
- Raise an issue only where one specialist's work is materially challenged by another's, and where resolving it would change a decision in the answer.
- "targetAgentId" is the specialist whose work is challenged. "sourceRef" is the different specialist the challenge comes from. They must not be the same id, and both must be one of: ${agentIds.join(', ')}.
- "action" is "peer_challenge" when another specialist's work contradicts or undermines it, or "needs_evidence" when a claim needs external verification. Only "peer_challenge" is acted on in this run.
- Prefer omitting the block entirely to inventing a disagreement. A manufactured issue is worse than none.`;
}

export function buildRound2Prompt(input: {
  task: string;
  mission: string;
  previousOutput: string;
  excerpt: PeerExcerpt;
  challenge: string;
}): string {
  return `Original task:
${input.task}

Your assigned mission (unchanged):
${input.mission}

Your previous answer:
${input.previousOutput}

A passage from another specialist (${input.excerpt.agentId})${
    input.excerpt.truncated ? ', quoted from the start of their answer and truncated' : ''
  }:
${input.excerpt.text}

The challenge to your previous answer:
${input.challenge}

Round 2 contract:
- Address only this challenge. Do not restate or expand the rest of your answer beyond what the challenge affects.
- If the challenge is wrong, say so plainly and explain why. Do not concede in order to agree.
- If it is right, correct your answer and state what changed.
- You have gathered no new external evidence in this round. Do not present anything as verified; mark what you cannot check as an assumption.
- Stay inside your assigned mission, and preserve the original task's language, format and constraints.`;
}

export function buildDecisionSynthesisPrompt(input: {
  task: string;
  specialistBlock: string;
  degradedNote: string;
  issue: CollaborationIssue;
  revisedOutput: string;
}): string {
  return `Original task:
${input.task}

Results from each specialist:
${input.specialistBlock}
${input.degradedNote}
A cross-specialist challenge was raised and answered in a second round:
- Challenged specialist: ${input.issue.targetAgentId}
- Challenge raised from: ${input.issue.sourceRef}
- The challenge: ${input.issue.challenge}
- ${input.issue.targetAgentId}'s revised answer after the challenge:
${input.revisedOutput}

Decision contract:
- Produce the final answer to the original task.
- Where the challenge changed the conclusion, use the revised position.
- Where it did not, keep the original position and say briefly why the challenge did not change it.
- If the disagreement is unresolved, state it plainly. Do not hide it inside a merged sentence.
- The second round gathered no new external evidence. Do not describe anything as verified, confirmed or validated on the strength of the specialists agreeing with each other.`;
}
