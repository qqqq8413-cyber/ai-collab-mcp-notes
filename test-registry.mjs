import assert from 'node:assert/strict';
import {
  AGENT_REGISTRY,
  listAgents,
  resolveWorker,
  resolveRoster,
} from './dist/agents/registry.js';
import {
  MODEL_REGISTRY,
  modelsMissingPricing,
  modelsWithCapability,
  providerCouldSupport,
  providerSupports,
  unwiredCapabilities,
} from './dist/models/capabilities.js';

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

console.log('\nAgent registry');

check('an id expands to a full specialist', () => {
  const w = resolveWorker('market_researcher');
  assert.equal(w.id, 'market_researcher');
  assert.equal(w.provider, 'gemini');
  assert.match(w.role, /Market \/ Research Analyst/);
});

check('a non-evidence agent does not claim to be one', () => {
  assert.notEqual(resolveWorker('business_strategist').evidenceCapable, true);
  assert.notEqual(resolveWorker('brand_creative').evidenceCapable, true);
});

check('every registry entry has an id matching its key', () => {
  for (const [key, agent] of Object.entries(AGENT_REGISTRY)) {
    assert.equal(agent.id, key, `registry key "${key}" does not match its id "${agent.id}"`);
  }
});

check('listAgents returns every registered agent', () => {
  assert.equal(listAgents().length, Object.keys(AGENT_REGISTRY).length);
});

console.log('\nOverrides and inline specialists');

check('a partial object overrides only the fields it names', () => {
  const w = resolveWorker({ id: 'market_researcher', provider: 'openai' });
  assert.equal(w.provider, 'openai', 'provider should be overridden');
  assert.match(w.role, /Market \/ Research Analyst/, 'unnamed fields come from the registry');
});

check('a full inline definition works for an unregistered specialist', () => {
  const w = resolveWorker({ id: 'legal_reviewer', provider: 'claude', role: 'Contract risk.' });
  assert.equal(w.id, 'legal_reviewer');
  assert.equal(w.provider, 'claude');
  assert.equal(w.role, 'Contract risk.');
});

check('the pre-registry call shape still works unchanged', () => {
  // Callers written before the registry passed full objects for registered agents too.
  const w = resolveWorker({
    id: 'market_researcher',
    provider: 'gemini',
    role: 'Market / Research Analyst',
  });
  assert.equal(w.provider, 'gemini');
  assert.equal(w.role, 'Market / Research Analyst');
});

console.log('\nEvidence capability is derived, not asserted');

check('only runtime-enabled retrieval counts, not what a vendor offers', () => {
  assert.equal(providerSupports('gemini', 'grounded_retrieval'), true, 'wired up');
  assert.equal(providerSupports('claude', 'grounded_retrieval'), false, 'not wired up');
  assert.equal(providerSupports('openai', 'grounded_retrieval'), false, 'not wired up');
  // The vendors do offer it; that must never be enough on its own.
  assert.equal(providerCouldSupport('claude', 'grounded_retrieval'), true);
  assert.equal(providerCouldSupport('openai', 'grounded_retrieval'), true);
  assert.deepEqual(
    unwiredCapabilities().map((g) => `${g.profile.provider}/${g.capability}`).sort(),
    ['claude/grounded_retrieval', 'openai/grounded_retrieval']
  );
  assert.equal(modelsWithCapability('grounded_retrieval').length, 1);
});

check('intent plus runtime capability is what grants evidenceCapable', () => {
  assert.equal(AGENT_REGISTRY.market_researcher.providesEvidence, true, 'intent is declared');
  assert.equal(resolveWorker('market_researcher').evidenceCapable, true, 'and the model can');
});

check('the same intent on a provider without retrieval is refused and reported', () => {
  const { workers, warnings } = resolveRoster([
    { id: 'market_researcher', provider: 'claude' },
  ]);
  assert.equal(workers[0].evidenceCapable, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /market_researcher/);
  assert.match(warnings[0], /no grounded_retrieval capability/);
});

check('a caller cannot force the capability on an unretrieving provider', () => {
  const { workers, warnings } = resolveRoster([
    { id: 'wishful_researcher', provider: 'openai', role: 'Research.', providesEvidence: true },
  ]);
  assert.equal(workers[0].evidenceCapable, false);
  assert.equal(warnings.length, 1);
});

check('the model brand alone never confers evidence capability', () => {
  // A specialist bound to Gemini but not meant to gather evidence must stay ordinary.
  // Guards against a `provider === "gemini" -> evidenceCapable` shortcut.
  const { workers, warnings } = resolveRoster([
    { id: 'gemini_writer', provider: 'gemini', role: 'Draft copy.' },
  ]);
  assert.equal(workers[0].provider, 'gemini');
  assert.equal(workers[0].evidenceCapable, false);
  assert.deepEqual(warnings, []);
});

check('an unknown model is not given the benefit of the doubt', () => {
  const { workers, warnings } = resolveRoster([
    {
      id: 'future_researcher',
      provider: 'gemini',
      model: 'gemini-99-unreleased',
      role: 'Research.',
      providesEvidence: true,
    },
  ]);
  assert.equal(workers[0].evidenceCapable, false, 'unlisted model is one nobody has checked');
  assert.equal(warnings.length, 1);
});

check('specialists not meant to gather evidence produce no warning', () => {
  const { warnings } = resolveRoster(['business_strategist', 'brand_creative']);
  assert.deepEqual(warnings, []);
});

check('pricing is still unverified everywhere, so cost tracking cannot invent numbers', () => {
  assert.equal(modelsMissingPricing().length, MODEL_REGISTRY.length);
});

console.log('\nErrors');

check('an unknown id fails loudly and lists what is available', () => {
  assert.throws(() => resolveWorker('marketing_researcher'), (err) => {
    assert.match(err.message, /Unknown agent "marketing_researcher"/);
    assert.match(err.message, /business_strategist/);
    return true;
  });
});

check('an unregistered id without provider or role is rejected', () => {
  assert.throws(() => resolveWorker({ id: 'legal_reviewer' }), /Unknown agent/);
  assert.throws(() => resolveWorker({ id: 'legal_reviewer', provider: 'claude' }), /Unknown agent/);
});

check('a duplicated specialist in one roster is rejected', () => {
  assert.throws(
    () => resolveRoster(['market_researcher', { id: 'market_researcher', provider: 'openai' }]),
    /Duplicate specialist "market_researcher"/
  );
});

console.log('\nRoster resolution');

check('a roster of ids resolves to distinct specialists', () => {
  const { workers } = resolveRoster(['business_strategist', 'market_researcher', 'brand_creative']);
  assert.equal(workers.length, 3);
  assert.deepEqual(
    workers.map((w) => w.provider),
    ['claude', 'gemini', 'openai']
  );
});

check('ids and inline definitions can be mixed in one roster', () => {
  const { workers } = resolveRoster([
    'business_strategist',
    { id: 'legal_reviewer', provider: 'openai', role: 'Contract risk.' },
  ]);
  assert.deepEqual(workers.map((w) => w.id), ['business_strategist', 'legal_reviewer']);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
