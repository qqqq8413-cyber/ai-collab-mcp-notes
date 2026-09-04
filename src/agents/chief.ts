import type { Complexity, PlanningBudget, Worker } from '../modes/orchestrator.js';

/**
 * Caps on how many specialists the Chief may recruit at each complexity level.
 * Without these the Chief over-decomposes: the same task planned twice produced
 * 6 missions one run and 13 the next, doubling latency and cost unpredictably.
 */
export const SPECIALIST_CAP: Record<Complexity, number> = {
  simple: 1,
  normal: 3,
  deep: 4,
};

export const MISSION_CHAR_LIMIT = 600;

/**
 * Who the Chief is and how it works — the part that does not change between tasks.
 *
 * Split out from the per-task prompt so the two can be reasoned about separately: this is
 * the standing brief, while `buildPlanningPrompt` carries one job's task, roster, budget
 * and output format.
 *
 * The wording of the principles, complexity definitions and planning rules is carried
 * over unchanged from the single prompt that preceded it. This split is a separation of
 * concerns, NOT a recalibration — no rule was added here to make planning more
 * repeatable. The observed 2-vs-3 specialist variance on deep tasks is discretion working
 * as intended, and tightening the prompt until the plan stops moving would be hardcoding
 * the answer while claiming to route dynamically.
 */
export const CHIEF_SYSTEM_PROMPT = `You are the Chief of Staff coordinating a team of AI specialists.

Your job is NOT to maximise thinking, agents, or output. Your job is minimum sufficient
collaboration: reach a good decision using the fewest specialists and the smallest
context that will still produce a high-quality answer.

Choose specialists by the capability the task needs, never by which model happens to
provide it. A model's name is not a qualification, and no specialist is entitled to
appear.

The limits below bound your judgement; they do not replace it. Two sound plans for the
same task may differ. Plan the job in front of you rather than reproducing a previous
answer.

Complexity levels — classify the task into exactly one:
- "simple" (at most ${SPECIALIST_CAP.simple} specialist): calculation, formatting, a short summary,
  handling a single piece of information.
- "normal" (at most ${SPECIALIST_CAP.normal} specialists): quote analysis, script evaluation, a business
  proposal, an ordinary project decision.
- "deep" (at most ${SPECIALIST_CAP.deep} specialists): company annual strategy, major investment,
  high-risk contract, financial strategy, large brand project.

Planning rules (hard constraints):
1. First decide whether this task genuinely needs more than one specialist.
2. Classify complexity using the levels above. Judge by what is at stake, not by how much
   text the answer needs.
3. List the capabilities this task actually requires, then choose specialists for those capabilities.
4. Assign AT MOST ONE mission per specialist. Never split one specialist's work into several
   micro-tasks — give one coherent mission that names the areas it must cover.
5. Do not recruit a specialist whose capabilities this task does not need.
6. Every mission description must be under ${MISSION_CHAR_LIMIT} characters.
7. Do not request research or output that will not change the final decision.
8. Do not have two specialists investigate the same question.
9. Set requiresRedTeam to true only when you expect high-value disagreement worth an extra
   round of challenge. Default to false.`;

/** The task at hand: what to plan, who is available, what it must cost, what to return. */
export function buildPlanningPrompt(
  task: string,
  workers: Worker[],
  budget?: PlanningBudget
): string {
  const roster = workers.map((w) => `- agentId: ${w.id} | role: ${w.role}`).join('\n');

  const budgetLines: string[] = [];
  if (budget?.maxSpecialists !== undefined) {
    budgetLines.push(`- Use at most ${budget.maxSpecialists} specialists, regardless of complexity.`);
  }
  if (budget?.maxCostUsd !== undefined) {
    budgetLines.push(`- Keep the estimated total cost of this run under US$${budget.maxCostUsd}.`);
  }
  if (budget?.maxLatencySeconds !== undefined) {
    budgetLines.push(`- The whole run should finish within ${budget.maxLatencySeconds} seconds.`);
  }
  const budgetBlock = budgetLines.length
    ? `\nBudget constraints for this run:\n${budgetLines.join('\n')}\n`
    : '';

  return `Task:
${task}

Available specialists:
${roster}
${budgetBlock}
Respond with ONLY a JSON object in exactly this shape:
{
  "complexity": "simple" | "normal" | "deep",
  "requiredCapabilities": ["capability", ...],
  "assignments": [
    { "agentId": "<id from the roster>", "mission": "...", "priority": "high" | "medium" | "low" }
  ],
  "requiresRedTeam": false,
  "reason": "why this is the minimum sufficient collaboration for this task"
}
No prose, no markdown fences, just the JSON object.`;
}
