import assert from 'node:assert/strict';
import { createConsultationCoordinator, snapshotConsultationRequest } from './dist/consultation/coordinator.js';
import { consultationInputFingerprint } from './dist/consultation/fingerprint.js';

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`  PASS ${name}`); }
const binding = (overrides = {}) => ({ deliberationStateId: 'state-1', sessionId: 'session-1',
  artifactHash: 'artifact-hash', authorContextHash: 'context-hash', attemptId: 'attempt-1',
  decisionId: 'decision-1', questionId: 'question-1', route: 'ADD_REVIEWER',
  inputRefs: [{ kind: 'FINDING', id: 'finding-1' }, { kind: 'SEMANTIC_ISSUE', id: 'issue-1' }], ...overrides });
const request = (overrides = {}) => ({ attemptId: 'attempt-1', consultantRoleId: 'second-reader',
  provider: 'openai', requestedModel: 'synthetic-model', input: 'review this', parameters: {}, ...overrides });
const success = (req) => ({ kind: 'EXECUTED', admission: { policy: 'E0-R3_ADMISSION_V1', status: 'ADMITTED',
  reason: 'LOCAL_ADMISSION_PASSED', capabilities: [], parameters: [] },
  binding: { provider: req.provider, requestedModel: req.requestedModel, effectiveModel: req.requestedModel, resolutionBasis: 'EXPLICIT' },
  executionLatencyMs: 7, result: { outcome: 'SUCCESS', executionId: req.executionId, attemptId: req.attemptId,
    requestedProvider: req.provider, requestedModel: req.requestedModel, effectiveProvider: req.provider,
    effectiveModel: req.requestedModel, output: { text: 'raw provider output' } } });
function harness(port = { resolve: () => binding() }, execute = async (req) => success(req)) {
  const calls = [];
  return { calls, coordinator: createConsultationCoordinator(port, {
    async execute(req) { calls.push(req); return execute(req); },
  }) };
}

await check('strict request rejects malformed values, extra authority, peer, and retrieval fields before route resolution', async () => {
  const forbidden = ['consultationId', 'executionId', 'executorId', 'authorization', 'executor', 'registry',
    'sessionId', 'artifactHash', 'authorContextHash', 'decisionId', 'questionId', 'route', 'RouteOutcome',
    'peerOutput', 'peerOutputs', 'previousConsultationOutput', 'consensus', 'vote', 'verdict', 'retrieval'];
  let resolved = 0; const h = harness({ resolve() { resolved++; return binding(); } });
  for (const key of forbidden) await assert.rejects(() => h.coordinator.consult(request({ [key]: 'caller-owned' })), TypeError);
  await assert.rejects(() => h.coordinator.consult(request({ retrieval: { enabled: true } })), TypeError);
  for (const invalid of [null, {}, request({ consultantRoleId: '' }), request({ provider: 'other' }),
    request({ requestedModel: '' }), request({ parameters: { temperature: { value: NaN } } }),
    request({ parameters: { temperature: { value: 0, extra: true } } })]) {
    await assert.rejects(() => h.coordinator.consult(invalid), TypeError);
  }
  const getter = request(); Object.defineProperty(getter, 'attemptId', { get() { throw Error('getter ran'); } });
  await assert.rejects(() => h.coordinator.consult(getter), TypeError);
  const hidden = request(); Object.defineProperty(hidden, 'hidden', { value: 1 });
  await assert.rejects(() => h.coordinator.consult(hidden), TypeError);
  assert.equal(resolved, 0); assert.equal(h.calls.length, 0);
});

await check('explicit zero survives and generated IDs are nonempty, distinct, and not caller supplied', async () => {
  const h = harness();
  const rec = await h.coordinator.consult(request({ parameters: { temperature: { value: 0 } } }));
  assert.match(rec.consultationId, /^[0-9a-f-]{36}$/); assert.match(rec.executionId, /^[0-9a-f-]{36}$/);
  assert.notEqual(rec.consultationId, rec.executionId);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].executionId, rec.executionId);
  assert.equal(h.calls[0].parameters.temperature.value, 0);
  assert.equal(h.calls[0].retrieval, undefined); assert.equal(rec.structuredPeerContext, 'NONE');
  assert.equal(rec.consultationKind, 'ADD_REVIEWER'); assert.equal(rec.provenanceStatus, 'STABLE');
  assert.equal(rec.boundaryResult.result.output.text, 'raw provider output');
  assert.equal(Object.hasOwn(rec, 'routeOutcome'), false);
});

await check('request and binding snapshots resist caller mutation during an awaited execution', async () => {
  const original = request({ parameters: { max_output_tokens: { value: 0 } } });
  const firstBinding = binding(); let resolved = 0; let release; let enter;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const h = harness({ resolve() { resolved++; return resolved === 1 ? firstBinding : binding(); } },
    async (req) => { enter(); await gate; return success(req); });
  const pending = h.coordinator.consult(original);
  await entered;
  original.attemptId = 'changed'; original.consultantRoleId = 'changed'; original.input = 'changed';
  original.parameters.max_output_tokens.value = 9;
  firstBinding.inputRefs[0].id = 'changed'; firstBinding.route = 'REPLICATE';
  release(); const rec = await pending;
  assert.equal(rec.routeBinding.route, 'ADD_REVIEWER');
  assert.equal(rec.routeBinding.inputRefs[0].id, 'finding-1');
  assert.equal(rec.consultantRoleId, 'second-reader'); assert.equal(rec.boundaryResult.result.attemptId, 'attempt-1');
  assert.equal(h.calls[0].parameters.max_output_tokens.value, 0); assert.equal(resolved, 2);
  assert.equal(Object.isFrozen(rec), true); assert.equal(Object.isFrozen(rec.routeBinding.inputRefs[0]), true);
});

await check('fake boundary result is detached; outcome remains an execution fact', async () => {
  let source;
  const h = harness(undefined, async (req) => { source = success(req); return source; });
  const rec = await h.coordinator.consult(request());
  source.result.output.text = 'tampered'; source.admission.status = 'REJECTED';
  assert.equal(rec.boundaryResult.result.output.text, 'raw provider output');
  assert.equal(rec.boundaryResult.admission.status, 'ADMITTED');
  assert.equal(Object.isFrozen(rec.boundaryResult.result.output), true);
  assert.equal(Object.hasOwn(rec, 'finding'), false);
});

await check('post-binding mismatch after execution preserves the result with separate provenance uncertainty', async () => {
  let current = binding(); let release; let enter; let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const coordinator = createConsultationCoordinator({ resolve() { return current; } }, { async execute(req) {
    calls++; enter(); await gate; return success(req);
  } });
  const pending = coordinator.consult(request()); await entered;
  current = binding({ decisionId: 'decision-2' }); release();
  const rec = await pending;
  assert.equal(calls, 1); assert.equal(rec.provenanceStatus, 'PROVENANCE_UNCERTAIN');
  assert.equal(rec.boundaryResult.kind, 'EXECUTED'); assert.equal(rec.boundaryResult.result.outcome, 'SUCCESS');
  assert.equal(rec.routeBinding.decisionId, 'decision-1');
});

await check('post-binding failure after execution preserves result; non-executed mismatch fails closed', async () => {
  let reads = 0;
  const port = { resolve() { if (++reads === 2) throw Error('current state unavailable'); return binding(); } };
  const executed = await harness(port).coordinator.consult(request());
  assert.equal(executed.provenanceStatus, 'PROVENANCE_UNCERTAIN');
  assert.equal(executed.boundaryResult.kind, 'EXECUTED');
  const notExecuted = { kind: 'NOT_ADMITTED', admission: { policy: 'E0-R3_ADMISSION_V1', status: 'UNRESOLVED',
    reason: 'UNKNOWN_MODEL', capabilities: [], parameters: [] } };
  reads = 0;
  await assert.rejects(() => harness(port, async () => notExecuted).coordinator.consult(request()), /unavailable/);
  reads = 0;
  const changed = { resolve() { return ++reads === 1 ? binding() : binding({ questionId: 'other' }); } };
  await assert.rejects(() => harness(changed, async () => notExecuted).coordinator.consult(request()), /changed/);
});

await check('KNOWN_FAILURE and UNCERTAIN pass unchanged without retry or semantic classification', async () => {
  for (const outcome of ['KNOWN_FAILURE', 'UNCERTAIN']) {
    let calls = 0;
    const h = harness(undefined, async (req) => { calls++; const base = success(req);
      base.result = { ...base.result, outcome, output: undefined, error: { provider: req.provider,
        model: req.requestedModel, category: 'TRANSPORT', message: 'offline', dispatchState: 'UNKNOWN',
        completionState: outcome === 'KNOWN_FAILURE' ? 'FAILED' : 'UNKNOWN' } };
      return base;
    });
    const rec = await h.coordinator.consult(request());
    assert.equal(calls, 1); assert.equal(rec.provenanceStatus, 'STABLE');
    assert.equal(rec.boundaryResult.result.outcome, outcome);
    assert.equal(rec.boundaryResult.result.error.completionState, outcome === 'KNOWN_FAILURE' ? 'FAILED' : 'UNKNOWN');
    assert.equal(Object.hasOwn(rec, 'replicationResult'), false);
  }
});

await check('fingerprint binds optional presence, explicit zero, role, refs, and their ordering', async () => {
  const b = binding(); const a = snapshotConsultationRequest(request());
  const base = consultationInputFingerprint(a, b);
  assert.equal(base, consultationInputFingerprint(snapshotConsultationRequest(request()), binding()));
  for (const variant of [request({ consultantRoleId: 'other' }), request({ parameters: { temperature: { value: 0 } } }),
    request({ input: 'other' }), request({ requestedModel: undefined })]) {
    if (variant.requestedModel === undefined) delete variant.requestedModel;
    assert.notEqual(consultationInputFingerprint(snapshotConsultationRequest(variant), b), base);
  }
  assert.notEqual(consultationInputFingerprint(a, binding({ inputRefs: [...b.inputRefs].reverse() })), base);
});

console.log(`${passed} passed, 0 failed`);
