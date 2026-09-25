import assert from 'node:assert/strict';
import {
  MODEL_REGISTRY,
  getCapabilityAssessment,
  getModelProfile,
  getParameterAssessment,
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
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message.split('\n')[0]}`);
    failed++;
  }
}

check('rich model keeps UNKNOWN distinct from UNSUPPORTED', () => {
  const unknown = getCapabilityAssessment('gemini', 'gemini-3.1-pro-preview', 'streaming');
  const unknownState = {
    providerSupport: 'UNKNOWN',
    runtimeEnablement: 'UNKNOWN',
    readiness: 'UNKNOWN',
  };
  const unsupported = {
    providerSupport: 'UNSUPPORTED',
    runtimeEnablement: 'DISABLED',
    readiness: 'UNSUPPORTED',
  };
  assert.equal(unknown.status, 'MISSING_ASSESSMENT');
  assert.equal(unknownState.providerSupport, 'UNKNOWN');
  assert.notDeepEqual(unknownState, unsupported);
});

check('legacy boolean helpers fail closed for unknown models', () => {
  assert.equal(providerSupports('gemini', 'grounded_retrieval', 'gemini-99-unreleased'), false);
  assert.equal(providerCouldSupport('gemini', 'grounded_retrieval', 'gemini-99-unreleased'), false);
});

check('unknown model and missing capability have distinct lookup results', () => {
  assert.equal(getCapabilityAssessment('gemini', 'gemini-99-unreleased', 'streaming').status, 'UNKNOWN_MODEL');
  assert.equal(getCapabilityAssessment('gemini', 'gemini-3.1-pro-preview', 'streaming').status, 'MISSING_ASSESSMENT');
  assert.equal(getModelProfile('gemini', 'gemini-99-unreleased').status, 'UNKNOWN_MODEL');
});

check('Gemini retrieval remains runtime enabled while Claude and OpenAI stay unwired', () => {
  assert.equal(providerSupports('gemini', 'grounded_retrieval'), true);
  assert.equal(providerSupports('claude', 'grounded_retrieval'), false);
  assert.equal(providerSupports('openai', 'grounded_retrieval'), false);
  assert.equal(providerCouldSupport('claude', 'grounded_retrieval'), true);
  assert.equal(providerCouldSupport('openai', 'grounded_retrieval'), true);
  assert.deepEqual(
    unwiredCapabilities().map(({ profile, capability }) => `${profile.provider}/${capability}`).sort(),
    ['claude/grounded_retrieval', 'openai/grounded_retrieval']
  );
  assert.equal(modelsWithCapability('grounded_retrieval').length, 1);
});

check('parameter constraints represent unsupported, fixed, range, discrete, and unknown', () => {
  const constraints = [
    { kind: 'UNSUPPORTED', explicitTransmission: 'DISALLOWED' },
    { kind: 'FIXED', value: 1, explicitTransmission: 'ALLOWED' },
    { kind: 'NUMERIC_RANGE', min: 0, max: 1, minInclusive: true, maxInclusive: false, explicitTransmission: 'ALLOWED' },
    { kind: 'DISCRETE_VALUES', values: [0, 0.5, 1], explicitTransmission: 'ALLOWED' },
    { kind: 'UNKNOWN', explicitTransmission: 'UNKNOWN' },
  ];
  assert.deepEqual(constraints.map(({ kind }) => kind), [
    'UNSUPPORTED', 'FIXED', 'NUMERIC_RANGE', 'DISCRETE_VALUES', 'UNKNOWN',
  ]);
});

check('Claude temperature is wired but not verified and transmission remains unknown', () => {
  const result = getParameterAssessment('claude', 'claude-sonnet-5', 'temperature');
  assert.equal(result.status, 'FOUND');
  assert.equal(result.assessment.readiness, 'WIRED_UNVERIFIED');
  assert.equal(result.assessment.constraint.kind, 'UNKNOWN');
  assert.equal(result.assessment.constraint.explicitTransmission, 'UNKNOWN');
  assert.notEqual(result.assessment.readiness, 'VERIFIED');
  const sources = result.assessment.evidence.map(({ source }) => source);
  assert(sources.includes('src/providers/claude.ts'));
  assert(sources.includes('44d5fe9465fc9551174d69278415058b605cc8b6'));
  assert(sources.includes('cf074c2c640559eb40a578f921b82438b2e7fd96'));
  assert(result.assessment.evidence.every(({ kind, limitations }) =>
    kind === 'repository_fact' && limitations.length > 0));
});

check('missing parameter assessment is distinct from an explicit unsupported constraint', () => {
  const result = getParameterAssessment('gemini', 'gemini-3.1-pro-preview', 'temperature');
  assert.equal(result.status, 'FOUND');
  assert.equal(result.assessment.constraint.kind, 'UNKNOWN');
  assert.equal(getParameterAssessment('gemini', 'gemini-3.1-pro-preview', 'missing_parameter').status, 'MISSING_ASSESSMENT');
  const explicitUnsupported = { kind: 'UNSUPPORTED', explicitTransmission: 'DISALLOWED' };
  assert.notEqual(explicitUnsupported.kind, result.assessment.constraint.kind);
});

check('registry profiles carry separate parameter assessments and preserve missing pricing', () => {
  assert(MODEL_REGISTRY.every(({ parameters }) => parameters.temperature && parameters.max_output_tokens));
  assert.equal(modelsMissingPricing().length, MODEL_REGISTRY.length);
  const result = getModelProfile('claude', 'claude-sonnet-5');
  assert.equal(result.status, 'FOUND');
  if (result.status === 'FOUND') {
    result.profile.capabilities.reasoning.notes = 'caller mutation';
  }
  assert.notEqual(MODEL_REGISTRY[0].capabilities.reasoning.notes, 'caller mutation');
});

check('model identity, not provider brand, controls capability lookup', () => {
  assert.equal(getCapabilityAssessment('openai', 'claude-sonnet-5', 'grounded_retrieval').status, 'UNKNOWN_MODEL');
  assert.equal(providerSupports('openai', 'grounded_retrieval', 'claude-sonnet-5'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
