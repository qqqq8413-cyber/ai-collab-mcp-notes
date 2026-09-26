import assert from 'node:assert/strict';
import { assessExecution, validateExecutionRequest, canonicalCapabilitySource } from './dist/execution/admission.js';
import { resolveProviderBinding } from './dist/execution/executors.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  PASS ${name}`); };
const request = (overrides = {}) => ({ executionId: 'e', attemptId: 'a', provider: 'openai', requestedModel: 'synthetic', input: 'x', parameters: {}, ...overrides });
const cap = (readiness) => ({ providerSupport: readiness === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'SUPPORTED',
  runtimeEnablement: readiness === 'UNSUPPORTED' ? 'DISABLED' : 'ENABLED', readiness,
  evidence: [{ source: 'synthetic-capability' }] });
const param = (constraint, readiness = 'VERIFIED') => ({ readiness, constraint, evidence: [{ source: 'synthetic-parameter' }] });
const source = (capability = cap('VERIFIED'), parameter = param({ kind: 'FIXED', value: 0, explicitTransmission: 'ALLOWED' })) => ({
  getModelProfile: (provider, model) => ({ status: 'FOUND', profile: { provider, model } }),
  getCapabilityAssessment: () => ({ status: 'FOUND', assessment: capability }),
  getParameterAssessment: () => ({ status: 'FOUND', assessment: parameter }),
});
const assess = (req, src = source()) => assessExecution(req, resolveProviderBinding(req, ''), src);
const decision = (value, constraint, readiness) => assess(request({ parameters: { temperature: { value } } }), source(cap('VERIFIED'), param(constraint, readiness))).parameters[0];

check('strict request schema rejects malformed and extra data', () => {
  const bad = [
    { executionId: '' }, { attemptId: '' }, { provider: 'other' }, { input: 1 }, { requestedModel: '' },
    { requestedModel: undefined }, { parameters: { top_p: { value: 1 } } },
    { parameters: { temperature: { value: Infinity } } }, { parameters: { temperature: { value: 1, extra: 2 } } },
    { retrieval: { enabled: true, extra: 1 } }, { origin: { runId: '' } }, { origin: { other: 'x' } },
    { stage: 'other' }, { surprise: true },
    { parameters: new Map() },
  ];
  for (const item of bad) assert.throws(() => validateExecutionRequest(request(item)), TypeError);
  validateExecutionRequest(request({ parameters: { temperature: { value: 0 } }, retrieval: { enabled: false } }));
});
check('requirements derive only from explicit intent', () => {
  assert.deepEqual(assess(request()).capabilities, []);
  assert.deepEqual(assess(request({ retrieval: { enabled: false } })).capabilities, []);
  assert.deepEqual(assess(request({ systemInstruction: '' })).capabilities.map((x) => x.capability), ['system_prompt']);
  assert.deepEqual(assess(request({ retrieval: { enabled: true } })).capabilities.map((x) => x.capability), ['grounded_retrieval']);
});
check('capability readiness preserves VERIFIED / UNSUPPORTED / UNKNOWN / WIRED_UNVERIFIED', () => {
  for (const [readiness, status] of [['VERIFIED', 'ADMITTED'], ['UNSUPPORTED', 'REJECTED'], ['UNKNOWN', 'UNRESOLVED'], ['WIRED_UNVERIFIED', 'UNRESOLVED']]) {
    const result = assess(request({ systemInstruction: 'role' }), source(cap(readiness)));
    assert.equal(result.status, status);
    assert.deepEqual(result.capabilities[0].evidenceRefs, ['synthetic-capability']);
  }
});
check('canonical Gemini retrieval remains unverified, not permission', () => {
  const req = request({ provider: 'gemini', requestedModel: 'gemini-3.1-pro-preview', retrieval: { enabled: true } });
  assert.equal(assess(req, canonicalCapabilitySource).status, 'UNRESOLVED');
});
check('absent parameters are OMIT; explicit zero is FORWARD when verified', () => {
  assert.deepEqual(assess(request()).parameters.map((x) => x.disposition), ['OMIT', 'OMIT']);
  assert.equal(decision(0, { kind: 'FIXED', value: 0, explicitTransmission: 'ALLOWED' }).effectiveValue, 0);
});
check('FIXED and DISCRETE_VALUES accept exact values only', () => {
  for (const [value, constraint, expected] of [
    [0, { kind: 'FIXED', value: 0, explicitTransmission: 'ALLOWED' }, 'FORWARD'],
    [1, { kind: 'FIXED', value: 0, explicitTransmission: 'ALLOWED' }, 'REJECT'],
    [2, { kind: 'DISCRETE_VALUES', values: [1, 2], explicitTransmission: 'ALLOWED' }, 'FORWARD'],
    [3, { kind: 'DISCRETE_VALUES', values: [1, 2], explicitTransmission: 'ALLOWED' }, 'REJECT'],
  ]) assert.equal(decision(value, constraint).disposition, expected);
});
check('NUMERIC_RANGE respects inclusive and exclusive endpoints', () => {
  const lowerInclusive = { kind: 'NUMERIC_RANGE', min: 0, max: 1, minInclusive: true, maxInclusive: false, explicitTransmission: 'ALLOWED' };
  const upperInclusive = { ...lowerInclusive, minInclusive: false, maxInclusive: true };
  for (const [value, constraint, expected] of [
    [0, lowerInclusive, 'FORWARD'], [0, upperInclusive, 'REJECT'],
    [1, lowerInclusive, 'REJECT'], [1, upperInclusive, 'FORWARD'],
    [-1, lowerInclusive, 'REJECT'], [2, upperInclusive, 'REJECT'],
  ]) assert.equal(decision(value, constraint).disposition, expected);
});
check('explicit unsupported and disallowed reject; unknown evidence remains unknown', () => {
  assert.equal(decision(1, { kind: 'UNSUPPORTED', explicitTransmission: 'ALLOWED' }).disposition, 'REJECT');
  assert.equal(decision(1, { kind: 'FIXED', value: 1, explicitTransmission: 'DISALLOWED' }).disposition, 'REJECT');
  assert.equal(decision(1, { kind: 'UNKNOWN', explicitTransmission: 'ALLOWED' }).disposition, 'UNKNOWN');
  assert.equal(decision(1, { kind: 'FIXED', value: 1, explicitTransmission: 'UNKNOWN' }).disposition, 'UNKNOWN');
  assert.equal(decision(1, { kind: 'FIXED', value: 1, explicitTransmission: 'ALLOWED' }, 'WIRED_UNVERIFIED').disposition, 'UNKNOWN');
});
console.log(`${passed} passed, 0 failed`);
