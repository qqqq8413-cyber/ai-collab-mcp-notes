import assert from 'node:assert/strict';
import {
  CHIEF_SYSTEM_PROMPT,
  MISSION_CHAR_LIMIT,
  SPECIALIST_CAP,
  buildPlanningPrompt,
} from './dist/agents/chief.js';

const workers = [
  { id: 'business_strategist', provider: 'claude', role: 'Business Strategist — 商業模式、財務邏輯' },
  { id: 'market_researcher', provider: 'gemini', role: 'Market Analyst — 市場情報', evidenceCapable: true },
];

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
    failed++;
  }
}

console.log('\nStanding brief (system prompt)');

check('states who the Chief is and what it optimises for', () => {
  assert.match(CHIEF_SYSTEM_PROMPT, /You are the Chief of Staff/);
  assert.match(CHIEF_SYSTEM_PROMPT, /minimum sufficient\ncollaboration/);
  assert.match(CHIEF_SYSTEM_PROMPT, /NOT to maximise thinking, agents, or output/);
});

check('says to choose by capability, not by model', () => {
  assert.match(CHIEF_SYSTEM_PROMPT, /never by which model happens to\nprovide it/);
  assert.match(CHIEF_SYSTEM_PROMPT, /no specialist is entitled to\nappear/);
});

check('tells the Chief its judgement is bounded, not replaced', () => {
  // The counterpart of "bounded and auditable, not deterministic": two sound plans for
  // the same task may differ, and the Chief should not be chasing repeatability.
  assert.match(CHIEF_SYSTEM_PROMPT, /bound your judgement; they do not replace it/);
  assert.match(CHIEF_SYSTEM_PROMPT, /Two sound plans for the\nsame task may differ/);
});

check('carries the complexity definitions with their caps', () => {
  assert.match(CHIEF_SYSTEM_PROMPT, /"simple" \(at most 1 specialist\)/);
  assert.match(CHIEF_SYSTEM_PROMPT, /"normal" \(at most 3 specialists\)/);
  assert.match(CHIEF_SYSTEM_PROMPT, /"deep" \(at most 4 specialists\)/);
  assert.match(CHIEF_SYSTEM_PROMPT, /company annual strategy/, 'the §14 examples must survive');
});

check('carries all nine planning rules', () => {
  for (let n = 1; n <= 9; n++) {
    assert.match(CHIEF_SYSTEM_PROMPT, new RegExp(`^${n}\\. `, 'm'), `rule ${n} missing`);
  }
  assert.match(CHIEF_SYSTEM_PROMPT, /AT MOST ONE mission per specialist/);
  assert.match(CHIEF_SYSTEM_PROMPT, /under 600 characters/);
});

check('the split introduced no new numeric constraint', () => {
  // Guards against the split quietly becoming a recalibration of planning behaviour.
  assert.deepEqual(SPECIALIST_CAP, { simple: 1, normal: 3, deep: 4 });
  assert.equal(MISSION_CHAR_LIMIT, 600);
});

console.log('\nPer-task prompt');

const prompt = buildPlanningPrompt('Grow revenue next year.', workers);

check('carries the task, the roster and the output schema', () => {
  assert.match(prompt, /Grow revenue next year\./);
  assert.match(prompt, /- agentId: business_strategist \| role: Business Strategist/);
  assert.match(prompt, /- agentId: market_researcher \| role: Market Analyst/);
  assert.match(prompt, /"complexity": "simple" \| "normal" \| "deep"/);
  assert.match(prompt, /No prose, no markdown fences/);
});

check('does not repeat the standing brief', () => {
  assert.doesNotMatch(prompt, /You are the Chief of Staff/);
  assert.doesNotMatch(prompt, /Planning rules \(hard constraints\)/);
  assert.doesNotMatch(prompt, /Complexity levels/);
});

check('the roster hides which model backs each specialist', () => {
  // Capability-first is enforced structurally, not just asserted in the brief: the Chief
  // cannot prefer or avoid a specialist by its model, because it never sees one.
  assert.doesNotMatch(prompt, /claude/i);
  assert.doesNotMatch(prompt, /gemini/i);
  assert.doesNotMatch(prompt, /openai|gpt/i);
  assert.doesNotMatch(prompt, /evidenceCapable/);
});

console.log('\nBudget constraints');

check('no budget block when no budget is given', () => {
  assert.doesNotMatch(prompt, /Budget constraints for this run/);
});

check('each budget field appears only when set', () => {
  const only = buildPlanningPrompt('t', workers, { maxSpecialists: 2 });
  assert.match(only, /Use at most 2 specialists/);
  assert.doesNotMatch(only, /estimated total cost/);
  assert.doesNotMatch(only, /should finish within/);

  const all = buildPlanningPrompt('t', workers, {
    maxSpecialists: 2,
    maxCostUsd: 1.5,
    maxLatencySeconds: 300,
  });
  assert.match(all, /Use at most 2 specialists/);
  assert.match(all, /under US\$1\.5/);
  assert.match(all, /within 300 seconds/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
