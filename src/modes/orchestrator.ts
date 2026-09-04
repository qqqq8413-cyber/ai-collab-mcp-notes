import { z } from 'zod';
import { callProvider } from '../providers/index.js';
import type { RetrievalResult } from '../providers/types.js';
import type { ProviderName } from '../config.js';
import { deriveExecutionPolicy, type ExecutionPolicy } from '../agents/policy.js';
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

export async function runOrchestrator(options: OrchestratorOptions) {
  const { task, orchestrator, workers, synthesizer = orchestrator, budget, call = callProvider } = options;
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
  const workersMs = Date.now() - workersStart;

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

  const synthesisStart = Date.now();
  const succeeded = workerResults.filter((r) => r.output !== undefined);
  const synthesisPrompt = `Original task:
${task}

Results from each specialist:
${succeeded
    .map((r) => `### ${r.agentId}\nMission: ${r.mission}\nResult: ${r.output}`)
    .join('\n\n')}
${
  report.status === 'DEGRADED'
    ? `\nNote: ${report.failedWorkers} specialist(s) failed and are missing from the above ` +
      `(${report.failures.map((f) => f.agentId).join(', ')}). Do not invent their contribution. ` +
      `Answer from what is present, and say plainly where the answer is thin because of it.\n`
    : ''
}
Synthesize these results into a single, coherent final answer to the original task.`;
  const finalResult = await call(synthesizer.provider, synthesisPrompt, {
    model: synthesizer.model,
  });
  const synthesisMs = Date.now() - synthesisStart;

  return {
    plan,
    planningAdjustments,
    workerResults,
    report,
    finalOutput: buildOutputBanner(report) + finalResult.text,
    timings: {
      planningMs,
      workersMs,
      synthesisMs,
      totalMs: Date.now() - startedAt,
    },
  };
}
