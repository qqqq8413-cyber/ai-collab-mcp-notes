import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeKeyOf } from './dist/automation/admission.js';
import { changeRefOf, objectiveHashOf, sourceKeyOf } from './dist/automation/change-mint.js';
import { openChangeMinter, openChangeRegistryReader } from './dist/automation/change-registry.js';
import { parseHumanPrincipalV1 } from './dist/identity/canonical.js';
import { parseHumanPrincipalV1 as workspacePrincipal } from './dist/workspace/config.js';

const T = '2026-10-07T09:00:00.000Z';
const GOAL_ID = 'goal-00000000-0000-4000-8000-000000000001';
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:local-owner' };
const source = (extra = {}) => ({ schemaVersion: 1, kind: 'WORKSPACE_GOAL', projectId: 'chief', goalId: GOAL_ID,
  createdAt: T, submittedBy: HUMAN, objective: 'Review the exact proposal.', ...extra });
const request = (extra = {}) => ({ repository: 'synthetic/example', source: source(), ...extra });
const identity = (extra = {}) => ({ kind: 'WORKSPACE_GOAL', projectId: 'chief', goalId: GOAL_ID, ...extra });
const clock = { now: () => T };
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalFiles = (root) => readdirSync(join(root, 'records')).filter((name) => name.endsWith('.json'));
let passed = 0, failed = 0;
async function check(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-cm1-'));
  try { await fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const errorCode = (code) => (error) => error?.code === code;

await check('A. an absent registry reads as empty without creating it', (dir) => {
  const root = join(dir, 'registry');
  assert.equal(openChangeRegistryReader(root).getBySource(identity()), undefined);
  assert.deepEqual(readdirSync(dir), []);
});

await check('B-F. a Goal mints one operational record with every exact canonical derivation', (dir) => {
  const root = join(dir, 'registry');
  const minter = openChangeMinter(root, clock);
  const record = minter.mint(request());
  const sourceKey = hash(`chief.change.source.v1\0WORKSPACE_GOAL\0chief\0${GOAL_ID}`);
  const objectiveHash = hash('chief.goal.objective.v1\0Review the exact proposal.');
  assert.equal(sourceKeyOf(identity()), sourceKey);
  assert.equal(objectiveHashOf(source().objective), objectiveHash);
  assert.equal(record.sourceKey, sourceKey);
  assert.equal(record.source.objectiveHash, objectiveHash);
  assert.equal(record.sliceId, `goal-${sourceKey}`);
  assert.deepEqual(changeRefOf(record), { kind: 'SLICE', changeId: `goal-${sourceKey}` });
  assert.equal(record.changeKey, changeKeyOf({ repository: 'synthetic/example', sliceId: record.sliceId }));
  assert.deepEqual({ schemaVersion: record.schemaVersion, kind: record.kind, recordClass: record.recordClass, ruleset: record.ruleset },
    { schemaVersion: 1, kind: 'CHANGE_MINT', recordClass: 'OPERATIONAL_RECORD', ruleset: 'CHIEF-GOV/1' });
  assert.equal(record.source.submittedBy.principalRef, HUMAN.principalRef);
  assert.equal(record.mintedAt, T);
  assert.equal(JSON.stringify(record).includes(source().objective), false, 'plaintext objective is not persisted');
  assert.deepEqual(canonicalFiles(root), [`${sourceKey}.json`]);
  assert.deepEqual(Object.keys(minter), ['mint']);
  assert.deepEqual(Object.keys(openChangeRegistryReader(root)), ['getBySource']);
  assert.strictEqual(workspacePrincipal, parseHumanPrincipalV1, 'D1 and CM1 share one Human parser');
});

await check('G-H. identical retries including after reopen return the same byte-identical Change', (dir) => {
  const root = join(dir, 'registry');
  const first = openChangeMinter(root, clock).mint(request());
  const file = join(root, 'records', `${first.sourceKey}.json`);
  const bytes = readFileSync(file, 'utf8');
  const second = openChangeMinter(root, { now: () => '2027-01-01T00:00:00.000Z' }).mint(request());
  assert.deepEqual(second, first);
  assert.deepEqual(openChangeRegistryReader(root).getBySource(identity()), first);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(canonicalFiles(root), [`${first.sourceKey}.json`]);
  first.source.submittedBy.principalRef = 'mutated-copy';
  assert.equal(openChangeRegistryReader(root).getBySource(identity()).source.submittedBy.principalRef, HUMAN.principalRef);
});

await check('I-L. changed binding facts conflict without altering the canonical file', (dir) => {
  const root = join(dir, 'registry'), minter = openChangeMinter(root, clock);
  const first = minter.mint(request());
  const file = join(root, 'records', `${first.sourceKey}.json`), bytes = readFileSync(file, 'utf8');
  for (const changed of [
    request({ source: source({ objective: 'Different objective' }) }),
    request({ source: source({ submittedBy: { ...HUMAN, principalRef: 'human:other' } }) }),
    request({ source: source({ createdAt: '2026-10-07T09:00:01.000Z' }) }),
    request({ repository: 'synthetic/other' }),
  ]) assert.throws(() => minter.mint(changed), errorCode('CHANGE_SOURCE_BINDING_CONFLICT'));
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.deepEqual(canonicalFiles(root), [`${first.sourceKey}.json`]);
});

await check('M-N. distinct goal or project identity gets a distinct source and slice', (dir) => {
  const minter = openChangeMinter(join(dir, 'registry'), clock);
  const first = minter.mint(request());
  const nextGoal = minter.mint(request({ source: source({ goalId: 'goal-00000000-0000-4000-8000-000000000002' }) }));
  const nextProject = minter.mint(request({ source: source({ projectId: 'other' }) }));
  assert.equal(new Set([first.sourceKey, nextGoal.sourceKey, nextProject.sourceKey]).size, 3);
  assert.equal(new Set([first.sliceId, nextGoal.sliceId, nextProject.sliceId]).size, 3);
});

await check('O-S. unattributed, caller-controlled identity and malformed source facts fail closed', (dir) => {
  const root = join(dir, 'registry'), minter = openChangeMinter(root, clock);
  assert.throws(() => minter.mint(request({ source: source({ submittedBy: null }) })), errorCode('UNATTRIBUTED_SOURCE'));
  for (const bad of [
    { ...request(), sliceId: 'fresh' }, { ...request(), changeKey: 'a'.repeat(64) },
    request({ source: source({ sliceId: 'fresh' }) }), request({ repository: 'not-a-repository' }),
    request({ source: source({ submittedBy: { ...HUMAN, kind: 'CONTROLLER' } }) }),
    request({ source: source({ submittedBy: { ...HUMAN, principalRef: ' bad' } }) }),
    request({ source: source({ goalId: '../escape' }) }), request({ source: source({ projectId: 'Bad' }) }),
  ]) assert.throws(() => minter.mint(bad), errorCode('INVALID_CHANGE_SOURCE'));
  assert.deepEqual(canonicalFiles(root), []);
});

await check('T-V. even resealed records with changed sourceKey, sliceId or changeKey fail closed', (dir) => {
  for (const field of ['sourceKey', 'sliceId', 'changeKey', 'objectiveHash', 'ruleset', 'extra']) {
    const root = join(dir, field), record = openChangeMinter(root, clock).mint(request());
    const file = join(root, 'records', `${record.sourceKey}.json`);
    const envelope = JSON.parse(readFileSync(file, 'utf8'));
    if (field === 'objectiveHash') envelope.record.source.objectiveHash = 'x';
    else if (field === 'extra') envelope.record.continuation = { runId: 'run-2' };
    else envelope.record[field] = field === 'ruleset' ? 'CHIEF-GOV/2' : 'f'.repeat(64);
    envelope.checksum = hash(JSON.stringify(envelope.record));
    writeFileSync(file, JSON.stringify(envelope));
    assert.throws(() => openChangeRegistryReader(root), errorCode('REGISTRY_INTEGRITY'), field);
    assert.throws(() => openChangeMinter(root, clock), errorCode('REGISTRY_INTEGRITY'), field);
  }
});

await check('W. symlinked root, records directory and canonical record fail closed without touching target', (dir) => {
  const target = join(dir, 'target'), alias = join(dir, 'alias');
  mkdirSync(target); symlinkSync(target, alias);
  assert.throws(() => openChangeRegistryReader(alias), errorCode('REGISTRY_INTEGRITY'));
  assert.throws(() => openChangeMinter(alias, clock), errorCode('REGISTRY_INTEGRITY'));
  const root = join(dir, 'registry'); mkdirSync(root, { mode: 0o700 });
  symlinkSync(target, join(root, 'records'));
  assert.throws(() => openChangeRegistryReader(root), errorCode('REGISTRY_INTEGRITY'));
  assert.deepEqual(readdirSync(target), []);
  unlinkSync(join(root, 'records'));
  const record = openChangeMinter(root, clock).mint(request());
  const file = join(root, 'records', `${record.sourceKey}.json`), bytes = readFileSync(file, 'utf8');
  const outside = join(dir, 'outside.json'); writeFileSync(outside, bytes);
  unlinkSync(file); symlinkSync(outside, file);
  assert.throws(() => openChangeRegistryReader(root), errorCode('REGISTRY_INTEGRITY'));
  assert.equal(readFileSync(outside, 'utf8'), bytes);
});

await check('foreign storage is refused before any registry mutation', (dir) => {
  const root = join(dir, 'foreign'); mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, 'chief.queue.json'), 'existing Workspace data');
  const before = readFileSync(join(root, 'chief.queue.json'), 'utf8');
  assert.throws(() => openChangeMinter(root, clock), errorCode('REGISTRY_INTEGRITY'));
  assert.deepEqual(readdirSync(root), ['chief.queue.json']);
  assert.equal(readFileSync(join(root, 'chief.queue.json'), 'utf8'), before);
});

await check('a leftover temp is ignored, while a bad canonical checksum fails closed', (dir) => {
  const root = join(dir, 'registry');
  const record = openChangeMinter(root, clock).mint(request());
  const file = join(root, 'records', `${record.sourceKey}.json`);
  writeFileSync(join(root, 'records', `${record.sourceKey}.00000000-0000-4000-8000-000000000001.tmp`), 'partial');
  assert.deepEqual(openChangeRegistryReader(root).getBySource(identity()), record);
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  envelope.record.repository = 'synthetic/other';
  writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => openChangeRegistryReader(root), errorCode('REGISTRY_INTEGRITY'));
});

await check('without exclusive link publication a mint fails with no fallback or canonical file', (dir) => {
  const root = join(dir, 'registry');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    fs.linkSync = () => { const error = new Error('unavailable'); error.code = 'EXDEV'; throw error; };
    syncBuiltinESMExports();
    const { openChangeMinter } = await import('./dist/automation/change-registry.js');
    try { openChangeMinter(process.argv[1]).mint(JSON.parse(process.argv[2])); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(request())],
    { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: 'PUBLICATION_UNAVAILABLE' });
  assert.deepEqual(canonicalFiles(root), []);
});

const childScript = `
  import { openChangeMinter } from './dist/automation/change-registry.js';
  const request = JSON.parse(process.argv[2]);
  try {
    const record = openChangeMinter(process.argv[1], { now: () => ${JSON.stringify(T)} }).mint(request);
    process.stdout.write(JSON.stringify({ ok: true, changeKey: record.changeKey, sliceId: record.sliceId }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
  }
`;
function child(root, request) {
  return new Promise((done, fail) => {
    const processHandle = spawn(process.execPath, ['--input-type=module', '-e', childScript, root, JSON.stringify(request)], { cwd: process.cwd() });
    let output = '', error = '';
    processHandle.stdout.on('data', (chunk) => { output += chunk; });
    processHandle.stderr.on('data', (chunk) => { error += chunk; });
    processHandle.on('error', fail);
    processHandle.on('exit', (code) => {
      if (code !== 0) fail(new Error(error || `child exited ${code}`));
      else { try { done(JSON.parse(output)); } catch { fail(new Error(`invalid child result: ${output}`)); } }
    });
  });
}

await check('X. twelve independent identical writers publish exactly one Change', async (dir) => {
  const root = join(dir, 'registry');
  const results = await Promise.all(Array.from({ length: 12 }, () => child(root, request())));
  assert.ok(results.every((item) => item.ok), JSON.stringify(results));
  assert.equal(new Set(results.map((item) => item.changeKey)).size, 1);
  assert.equal(canonicalFiles(root).length, 1);
});

await check('Y. twelve competing conflicting writers leave one winner and no overwrite', async (dir) => {
  const root = join(dir, 'registry');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    child(root, request({ source: source({ objective: `Objective ${i}` }) }))));
  assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((item) => !item.ok).every((item) => item.code === 'CHANGE_SOURCE_BINDING_CONFLICT'));
  assert.equal(canonicalFiles(root).length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
