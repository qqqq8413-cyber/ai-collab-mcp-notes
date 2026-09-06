/**
 * Offline validation of the M2B-PROTOCOL-0.3 amendment (Option 3'-H).
 *
 * Two jobs. First, assert the amendment says what GPT decided — the mapping, the
 * invariant, the pool, the waves, the F4 authority, the claim boundary. Second, assert the
 * design document and these constants agree, in both directions, so a later edit to one
 * cannot quietly diverge from the other.
 *
 * Nothing here calls a provider. Nothing here authorizes one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  PROTOCOL_VERSION, SUPERSEDED_VERSION, AMENDMENT_NAME,
  ROLE_PROVIDER_MAP, CHIEF_PIN, routingFor, cd1TargetInvariantHolds,
  TARGET_PROVIDER_ROTATION, ARCHETYPE_SLOTS, RESERVE_SLOTS, ACQUISITION_POOL_SIZE,
  WAVES, slotsForWave, ONE_ATTEMPT_PER_TASK, ELIGIBILITY_CRITERIA,
  F4_AUTHORITY, fillsArchetypeSlot, SAME_DECISION_DIFFERENT_REASONING_IS_NOT_CONFLICT,
  NEGATIVE_CONTROL, FORBIDDEN_CLAIMS, CLAIM_BOUNDARY,
} from './protocol/amendment-0-3.mjs';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DESIGN = readFileSync(join(ROOT, 'M2_EFFECTIVENESS_EXPERIMENT.md'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nProtocol version and provenance');

check('the protocol is at 0.3 and names the version it supersedes', () => {
  assert.equal(PROTOCOL_VERSION, 'M2B-PROTOCOL-0.3');
  assert.equal(SUPERSEDED_VERSION, 'M2B-PROTOCOL-0.2');
  assert.ok(DESIGN.includes('M2B-PROTOCOL-0.3'), 'the design document declares 0.3');
});

check('v0.2 provenance is preserved, not deleted', () => {
  // The whole point of an amendment rather than a rewrite: the superseded design has to
  // stay readable, or the reasoning that produced it becomes unauditable.
  assert.ok(DESIGN.includes('M2B-PROTOCOL-0.2'), 'v0.2 is still named');
  assert.ok(DESIGN.includes('v0.2 變更摘要'), 'the v0.2 change summary survives');
  assert.ok(DESIGN.includes('Harness Review Clarification'), 'the v0.2 harness amendment survives');
  assert.ok(DESIGN.includes('## 15.3 推薦:Option 3′'), "the original Option 3' section survives");
});

check('the amendment is named in the design document', () => {
  assert.ok(DESIGN.includes("Option 3′-H"), 'the amendment name appears');
  assert.equal(AMENDMENT_NAME, "Option 3'-H — Heterogeneous Round1");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nRound 1 provider mapping');

check('the role-provider mapping is exactly the authorized one', () => {
  assert.deepEqual(ROLE_PROVIDER_MAP.business_strategist, { provider: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(ROLE_PROVIDER_MAP.market_researcher, { provider: 'gemini', model: 'gemini-3.1-pro-preview' });
  assert.deepEqual(ROLE_PROVIDER_MAP.brand_creative, { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(CHIEF_PIN, { provider: 'openai', model: 'gpt-5' });
});

check('the mapping covers exactly the three registered specialists', () => {
  assert.deepEqual(Object.keys(ROLE_PROVIDER_MAP).sort(), ['brand_creative', 'business_strategist', 'market_researcher']);
});

check('the mapping is global — routing is a function of the agent alone', () => {
  // A mapping that took a fixture would reintroduce exactly the collinearity it replaces.
  assert.equal(routingFor.length, 1, 'routingFor takes only an agentId');
  const source = readFileSync(join(ROOT, 'experiments/m2b/protocol/amendment-0-3.mjs'), 'utf8');
  const body = source.split('export function routingFor')[1].split('\n}')[0];
  assert.ok(!/fixture/i.test(body), 'routing must not consult a fixture');
});

check('each of the three providers is used exactly once across the roles', () => {
  const providers = Object.values(ROLE_PROVIDER_MAP).map((p) => p.provider).sort();
  assert.deepEqual(providers, ['claude', 'gemini', 'openai']);
});

check('an unmapped agent is refused rather than defaulted', () => {
  assert.throws(() => routingFor('nobody'), /no role-provider pin/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nC / D-1 target invariant');

check('C and D-1 resolve to the same provider and model for every specialist', () => {
  for (const agentId of Object.keys(ROLE_PROVIDER_MAP)) {
    assert.ok(cd1TargetInvariantHolds(agentId), agentId);
  }
});

check('the invariant holds structurally, whichever specialist the Gate selects', () => {
  // Under Option 3' the target provider was known before the Gate ran. Under 3'-H it is
  // decided by the Gate's selection — but both arms target the same selected agent, so the
  // pairing is still provider-constant. That property is what the estimand depends on.
  for (const selected of Object.keys(ROLE_PROVIDER_MAP)) {
    const c = routingFor(selected);
    const d1 = routingFor(selected);
    assert.deepEqual(c, d1, `selected target ${selected}`);
  }
});

check('two different targets may differ, which is why rotation is only observed', () => {
  assert.notDeepEqual(routingFor('business_strategist'), routingFor('brand_creative'));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTarget-provider rotation is demoted');

check('rotation is secondary observed coverage, never a selection criterion', () => {
  assert.equal(TARGET_PROVIDER_ROTATION.isSelectionCriterion, false);
  assert.match(TARGET_PROVIDER_ROTATION.status, /SECONDARY/);
  assert.match(TARGET_PROVIDER_ROTATION.rule, /never be chosen, kept or dropped/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAcquisition pool and waves');

check('the pool is three archetypes of three, nine in total', () => {
  assert.deepEqual(Object.keys(ARCHETYPE_SLOTS).sort(), ['EVIDENCE_INTERPRETATION', 'EXECUTION_CONSTRAINT', 'STRATEGY']);
  for (const slots of Object.values(ARCHETYPE_SLOTS)) assert.equal(slots.length, 3);
  assert.equal(Object.values(ARCHETYPE_SLOTS).flat().length, ACQUISITION_POOL_SIZE);
  assert.equal(new Set(Object.values(ARCHETYPE_SLOTS).flat()).size, 9, 'slot ids are unique');
});

check('the third task of each archetype is the reserve', () => {
  assert.deepEqual([...RESERVE_SLOTS], ['S3', 'E3', 'I3']);
  for (const [, slots] of Object.entries(ARCHETYPE_SLOTS)) {
    assert.ok(RESERVE_SLOTS.includes(slots[2]), `${slots[2]} is a reserve`);
  }
});

check('the waves partition the pool, one slot per archetype per wave', () => {
  assert.equal(WAVES.length, 3);
  assert.deepEqual(WAVES.flat().sort(), Object.values(ARCHETYPE_SLOTS).flat().sort());
  assert.equal(new Set(WAVES.flat()).size, 9, 'no slot appears in two waves');
});

check('a later wave attempts only archetypes that are still unfilled', () => {
  assert.deepEqual(slotsForWave(0, []), ['S1', 'E1', 'I1']);
  assert.deepEqual(slotsForWave(1, ['STRATEGY']), ['E2', 'I2']);
  assert.deepEqual(slotsForWave(1, ['STRATEGY', 'EXECUTION_CONSTRAINT']), ['I2']);
  assert.deepEqual(slotsForWave(2, ['STRATEGY', 'EXECUTION_CONSTRAINT', 'EVIDENCE_INTERPRETATION']), [],
    'a fully filled set attempts nothing further');
});

check('a filled archetype is never re-attempted for a better version of itself', () => {
  // Spending a one-shot reserve task to improve a slot that is already closed would be
  // cherry-picking with extra steps.
  assert.deepEqual(slotsForWave(2, ['STRATEGY']), ['E3', 'I3']);
});

check('every task gets exactly one Round 1 attempt', () => {
  assert.equal(ONE_ATTEMPT_PER_TASK, true);
});

check('no acquisition task text exists yet — authoring them is a later round', () => {
  // This round amends the protocol. Generating the nine candidates now would be doing the
  // next authorization's work before it exists.
  const source = readFileSync(join(ROOT, 'experiments/m2b/protocol/amendment-0-3.mjs'), 'utf8');
  for (const slot of Object.values(ARCHETYPE_SLOTS).flat()) {
    assert.ok(!new RegExp(`${slot}\\s*:\\s*['"\`]`).test(source), `${slot} must not carry task text`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nEligibility and formal F4');

check('F1 through F7 are unchanged', () => {
  assert.deepEqual([...ELIGIBILITY_CRITERIA], ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
  for (const line of [
    'F1  complexity = deep',
    'F2  Round 1 成功的 specialist ≥ 2',
    'F3  RunStatus = SUCCESS',
    'F4  Round 1 文本中存在可辨識的跨專家、會影響決策的分歧',
    'F5  fixture 自身提供足夠資訊',
    'F6  不依賴即時網路資料',
    'F7  核心決策不依賴大量 deterministic arithmetic',
  ]) {
    assert.ok(DESIGN.includes(line), `unchanged: ${line}`);
  }
});

check('formal F4 is authored by a fresh clean-room A2 during acquisition', () => {
  assert.match(F4_AUTHORITY.author, /fresh clean-room Gemini session A2/);
  assert.equal(F4_AUTHORITY.authoredDuring, 'acquisition');
  assert.deepEqual([...F4_AUTHORITY.outputFields], ['materialConflict', 'conflictArchetype', 'summary', 'passageIds']);
});

check('A2 may not see the intended archetype, the Gate, the arms or the gold', () => {
  for (const forbidden of ['intended archetype', 'Gate output', 'arm outputs', 'gold issues']) {
    assert.ok(F4_AUTHORITY.mustNotSee.includes(forbidden), forbidden);
    assert.ok(!F4_AUTHORITY.maySee.includes(forbidden), `${forbidden} must not also be visible`);
  }
});

check('a slot is filled only by a material conflict of the preregistered archetype', () => {
  assert.equal(fillsArchetypeSlot({ materialConflict: true, conflictArchetype: 'STRATEGY' }, 'STRATEGY'), true);
  assert.equal(fillsArchetypeSlot({ materialConflict: false, conflictArchetype: 'STRATEGY' }, 'STRATEGY'), false,
    'no conflict cannot fill a slot');
  assert.equal(fillsArchetypeSlot({ materialConflict: true, conflictArchetype: 'EXECUTION_CONSTRAINT' }, 'STRATEGY'), false,
    'a conflict of the wrong archetype cannot fill the slot it was not preregistered for');
});

check('same decision by different reasoning is not automatically a material conflict', () => {
  assert.equal(SAME_DECISION_DIFFERENT_REASONING_IS_NOT_CONFLICT, true);
  assert.ok(DESIGN.includes('相同決策 + 不同推理'), 'the rule is stated in the design document');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nNegative control');

check('fxr-08 is reused, not re-run, and assessed by the same A2', () => {
  assert.equal(NEGATIVE_CONTROL.fixtureId, 'fxr-08');
  assert.equal(NEGATIVE_CONTROL.rerun, false);
  assert.match(NEGATIVE_CONTROL.assessedBy, /same clean-room A2/);
  assert.equal(NEGATIVE_CONTROL.expected.materialConflict, false);
  assert.match(NEGATIVE_CONTROL.onUnexpectedTrue, /STOP/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nBias register and claim boundary');

check('X14 records that collinearity is reduced, not removed', () => {
  const row = DESIGN.split('| **X14**')[1].split('\n')[0];
  assert.ok(/reduced|降低/.test(row), 'X14 says collinearity is reduced');
  assert.ok(/residual|殘留/.test(row), 'X14 keeps the residual role-provider coupling on the record');
});

check('X18 exists and is stated as a plausible contributor, not a demonstrated cause', () => {
  assert.ok(DESIGN.includes('**X18**'), 'X18 is registered');
  const row = DESIGN.split('| **X18**')[1].split('\n')[0];
  assert.ok(/Heterogeneous Prior Friction/.test(row), 'X18 is named');
  assert.ok(/plausible|可能|尚未證實/.test(row), 'X18 is hedged');
  assert.ok(!/已證明|proven|demonstrated cause/.test(row), 'X18 must not claim a demonstrated cause');
});

check('the forbidden claims are all registered', () => {
  assert.deepEqual([...FORBIDDEN_CLAIMS], [
    'pure peer-information value',
    'homogeneous deployment generalization',
    'cross-provider generalization',
    'provider heterogeneity caused the observed conflict',
  ]);
  for (const claim of FORBIDDEN_CLAIMS) {
    assert.ok(DESIGN.includes(claim), `the design document lists: ${claim}`);
  }
});

check('neither acquisition nor pilot may carry an effectiveness claim', () => {
  assert.equal(CLAIM_BOUNDARY.fixtureAcquisition, 'NO EFFECTIVENESS CLAIM');
  assert.match(CLAIM_BOUNDARY.pilot, /DOES NOT ANSWER EFFECTIVENESS/);
  assert.match(CLAIM_BOUNDARY.formalCGreaterThanD1, /preregistered heterogeneous fixture population/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
