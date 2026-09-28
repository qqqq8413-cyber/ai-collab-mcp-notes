import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { packetHash } from './dist/automation/packet.js';
import { NodeProcessExecutor, parseProcessRequest } from './dist/automation/process-executor.js';
import { readBranch } from './dist/automation/repository-reality.js';
import { ClaudeCodeImplementationAdapter, FILE_TOOLS, claudeArguments, modelFileScope } from './dist/automation/live/claude-code-implementation.js';
import { CodexArchitectReviewAdapter, REQUIRED_DISABLED_FEATURES, codexArguments } from './dist/automation/live/codex-architect-review.js';
import { GitHubCliRepositoryRealityPort } from './dist/automation/live/github-cli-reality.js';
import { createLiveAutomation } from './dist/automation/live/composition.js';

// Offline only: every process is a fake that validates the request it is given with the
// real executor's request parser, and answers from a scripted world. No model, CLI, or
// network is reached.

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const T = '2026-09-28T00:00:00.000Z';
const REPO = 'synthetic/example', BRANCH = 'work/synthetic-1';
const clock = { now: () => T };
const CLAUDE = { executable: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', destination: 'api.anthropic.com', timeoutMs: 600_000,
  maxTurns: 40, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 };
const CODEX = { executable: 'codex', provider: 'openai', model: 'gpt-5.5-codex', destination: 'api.openai.com', timeoutMs: 600_000,
  maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000, maxResultBytes: 100_000, disabledFeatures: [] };
const tests = [];
const sandboxAvailable = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const check = (name, fn) => tests.push([name, fn]);
function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chief-live-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
function packet(overrides = {}) {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A, targetBranch: BRANCH,
    objective: 'Offline live-adapter fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [{ commandId: 'build', executable: 'npm', args: ['run', 'build'], cwd: '.', classification: 'OFFLINE_VALIDATION' },
      { commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, CLAUDE.destination, CODEX.destination], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: true, providers: [CLAUDE.provider, CODEX.provider], models: [CLAUDE.model, CODEX.model], maxCalls: 6, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
      maxParallelImplementationAgents: 1 }, ...overrides };
}
const ok = (stdout = '') => ({ outcome: 'EXITED', exitCode: 0, signal: null, stdout, stderr: '', durationMs: 1 });
const fail = (stderr = 'failed', exitCode = 1) => ({ outcome: 'EXITED', exitCode, signal: null, stdout: '', stderr, durationMs: 1 });
const claudeOk = (report = { status: 'COMPLETED', reason: 'done' }, extra = {}) => ok(JSON.stringify({ type: 'result', subtype: 'success',
  is_error: false, structured_output: report, modelUsage: { [CLAUDE.model]: {} }, ...extra }));
/** The git subcommand after any leading `-c key=value` pairs. */
function subcommand(args) {
  let index = 0;
  while (args[index] === '-c') index += 2;
  return { name: args[index], rest: args.slice(index + 1) };
}

// The base tree every fake worktree is checked out with: in-scope files, a protected file
// and a confidential directory inside the read area, and content outside it.
const BASE_FILES = Object.freeze({ 'package.json': '{}\n', 'README.md': 'readme\n', '.gitignore': '/node_modules/\n',
  '.github/workflows/ci.yml': 'ci\n', 'src/automation/runner.ts': 'export const runner = 1;\n', 'src/automation/bridge.ts': 'export const bridge = 1;\n',
  'src/automation/.env': 'SENTINEL_ENV=1\n', 'src/automation/CASE-001/notes.md': 'confidential\n', 'src/automation.ts': 'sibling\n',
  'src/context/secret.ts': 'OUT-OF-SCOPE-SENTINEL\n', 'src/stress-test/session.ts': 'stress\n' });
const CLAUDE_ENV = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
/** Every entry under a directory (symlinks as entries, never followed), skipping a top-level .git. */
function listFiles(root) {
  const out = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (path === '.git') continue;
      if (entry.isDirectory()) walk(path); else out.push(path);
    }
  };
  walk('');
  return out.sort();
}
const change = (path, content) => (root) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };

/** A scripted repository, agent, reviewer, and validation boundary behind fake executors. */
function world(dir, overrides = {}) {
  const state = { remote: { [BRANCH]: null }, head: B, reviewHead: undefined, reviewStatus: '', tree: 'package.json\nsrc\n',
    files: BASE_FILES, modes: {}, ignored: [], status: undefined, raw: undefined, edit: change('src/automation/runner.ts', 'export const runner = 2;\n'),
    seen: undefined, validation: {}, isolation: undefined, diffCheck: true, pushLands: true, afterPush: undefined, beforePush: undefined,
    claude: () => claudeOk(), review: { decision: 'ACCEPT', findings: [], evidenceReferences: ['git diff base..HEAD'], correction: null },
    codex: undefined, ...overrides };
  const calls = [];
  let lsRemoteCount = 0;
  const statusOf = (worktree) => {
    const now = listFiles(worktree).filter((path) => !state.ignored.includes(path));
    const lines = [];
    for (const path of now) {
      if (!(path in state.files)) lines.push(`?? ${path}`);
      else if (readFileSync(join(worktree, path), 'utf8') !== state.files[path]) lines.push(` M ${path}`);
    }
    for (const path of Object.keys(state.files)) if (!now.includes(path) && !existsSync(join(worktree, path))) lines.push(` D ${path}`);
    return lines;
  };
  const respond = (request) => {
    if (request.executable === 'git') {
      assert.deepEqual(request.args.slice(0, 2), ['-c', 'core.hooksPath=/dev/null']);
      const { name, rest } = subcommand(request.args.slice(2));
      switch (name) {
        case 'ls-remote': {
          lsRemoteCount += 1;
          if (lsRemoteCount === 2 && state.beforePush) state.beforePush(state);
          const ref = rest.at(-1);
          const sha = state.remote[ref.replace('refs/heads/', '')];
          return ok(sha ? `${sha}\t${ref}\n` : '');
        }
        case 'fetch': return ok();
        case 'worktree': {
          mkdirSync(rest[2], { recursive: true });
          writeFileSync(join(rest[2], '.git'), 'gitdir: /nonexistent/worktree-metadata\n');
          for (const [path, content] of Object.entries(state.files)) change(path, content)(rest[2]);
          return ok();
        }
        case 'ls-files': return ok(Object.keys(state.files).map((path) => `${state.modes[path] ?? '100644'} ${'1'.repeat(40)} 0\t${path}\0`).join(''));
        case 'status': return ok(request.args.includes('-z') ? state.status ?? statusOf(request.cwd).map((line) => `${line}\0`).join('') : state.reviewStatus);
        case 'add': return ok();
        case 'diff': {
          if (!request.args.includes('--raw')) return state.diffCheck ? ok() : fail('trailing whitespace');
          if (state.raw !== undefined) return ok(state.raw);
          return ok(statusOf(request.cwd).map((line) => {
            const path = line.slice(3);
            const [from, to, sha, code] = line.startsWith('??') ? ['000000', '100644', '0', 'A'] : line.startsWith(' D') ? ['100644', '000000', '1', 'D'] : ['100644', '100644', '1', 'M'];
            return `:${from} ${to} ${sha.repeat(40)} ${'2'.repeat(40)} ${code}\0${path}\0`;
          }).join(''));
        }
        case 'commit': return ok();
        case 'rev-parse': return ok(`${state.reviewHead ?? state.head}\n`);
        case 'push': state.pushed = rest; if (state.pushLands) state.remote[BRANCH] = state.head; state.afterPush?.(state); return state.pushLands ? ok() : fail('rejected');
        case 'ls-tree': return ok(state.tree);
        default: throw new Error(`unexpected git ${name}`);
      }
    }
    if (request.executable === 'claude') {
      state.seen = listFiles(request.cwd);
      state.edit?.(request.cwd);
      return state.claude(request);
    }
    if (request.executable === 'codex') {
      if (state.codex) return state.codex(request, state);
      const output = request.args[request.args.indexOf('--output-last-message') + 1];
      writeFileSync(output, typeof state.review === 'string' ? state.review : JSON.stringify(state.review));
      return ok();
    }
    throw new Error(`unexpected executable ${request.executable}: validation must never reach the ordinary executor`);
  };
  const executor = { calls, async run(request) { parseProcessRequest(request); calls.push(request); return respond(request); } };
  const validations = [];
  const validation = { async runOffline(request) {
    assert.ok(request.cwd === request.workspace || request.cwd.startsWith(`${request.workspace}/`));
    validations.push({ ...request, copy: listFiles(request.workspace), gitMetadata: existsSync(join(request.workspace, '.git')) });
    if (state.isolation) return { isolation: 'UNAVAILABLE', reason: state.isolation };
    return { isolation: 'ENFORCED', result: state.validation[request.args.join(' ')] ?? ok() };
  } };
  const named = (executable, sub) => calls.filter((call) => call.executable === executable &&
    (sub === undefined || subcommand(call.args.slice(2)).name === sub));
  return { state, executor, calls, named, validation, validations };
}
function setup(dir, kind, overrides = {}, packetOverrides = {}, deliveryOverrides = {}) {
  const repositoryPath = join(dir, 'repo'), worktreeRoot = join(dir, 'worktrees');
  mkdirSync(repositoryPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  const journal = new FileInvocationJournal(join(dir, 'journal'), clock);
  const w = world(dir, overrides);
  const git = { executable: 'git', remote: 'origin', repositoryPath, worktreeRoot, timeoutMs: 60_000, maxOutputBytes: 1_000_000 };
  const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir };
  const p = packet(packetOverrides);
  const base = { runId: 'run-1', sliceId: 'slice-1', implementationIteration: 1, packet: p, packetHash: packetHash(p) };
  const scope = kind === 'IMPLEMENTATION' ? CLAUDE : CODEX;
  const invocationId = journal.prepare({ runId: 'run-1', sliceId: 'slice-1', packetId: p.packetId, packetHash: base.packetHash,
    occurrence: { sequence: 4, action: kind === 'IMPLEMENTATION' ? 'BEGIN_IMPLEMENTATION' : 'BEGIN_REMOTE_ACCEPTANCE', timestamp: T },
    actorKind: kind, provider: scope.provider, model: scope.model, destination: scope.destination, authorizationId: `auth-${kind}` }).invocationId;
  journal.start(invocationId, 10);
  const delivery = { ...git, commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' }, validationTimeoutMs: 60_000,
    validationMaxOutputBytes: 1_000_000, linkedDirectories: [], ...deliveryOverrides };
  const implementation = new ClaudeCodeImplementationAdapter({ claude: CLAUDE, git: delivery, environment },
    { executor: w.executor, validation: w.validation, journal, clock });
  const review = new CodexArchitectReviewAdapter({ codex: CODEX, git, environment }, { executor: w.executor, journal, clock });
  const input = { ...base, invocationId, ...(kind === 'ARCHITECT_REVIEW' ? { acceptanceFailures: 0,
    remoteSha: { repository: REPO, branch: BRANCH, sha: B, observedAt: T, source: 'GITHUB' } } : {}) };
  const worktree = join(worktreeRoot, invocationId);
  return { ...w, journal, implementation, review, input, invocationId, worktreeRoot, worktree, environment };
}
const deliveryCalls = (w) => w.calls.filter((call) => call.executable === 'git' && ['add', 'commit', 'push'].includes(subcommand(call.args.slice(2)).name));
const noDelivery = (w) => deliveryCalls(w).length + w.validations.length;
const adapterSettings = (dir) => ({ claude: CLAUDE, git: { executable: 'git', remote: 'origin', repositoryPath: dir, worktreeRoot: dir, timeoutMs: 1,
  maxOutputBytes: 1, commitAuthor: { name: 'a', email: 'b' }, validationTimeoutMs: 1, validationMaxOutputBytes: 1, linkedDirectories: [] }, environment: {} });
const refusedValidation = { async runOffline() { throw new Error('ran'); } };

/**
 * The decision of a generated rule set under the pinned Claude Code release's file-tool
 * semantics: a matching deny rule refuses; reads are allowed in the working directory,
 * which holds the read scope only (restricted mode refuses reads outside it); writes need
 * a matching Edit allow rule (dontAsk, nobody answers prompts). Read rules govern Glob and
 * Grep, and Edit rules govern Write. Patterns are gitignore-shaped and case-insensitive.
 */
function ruleMatches(pattern, path) {
  let body = pattern.startsWith('./') ? pattern.slice(2) : pattern.startsWith('**/') ? pattern.slice(3) : null;
  if (body === null) return false;
  const inside = body.endsWith('/**');
  if (inside) body = body.slice(0, -3);
  const source = body.split('/').map((part) => part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('/');
  return new RegExp(`^${pattern.startsWith('./') ? '' : '(?:.*/)?'}${source}${inside ? '/.+' : '(?:/.*)?'}$`, 'i').test(path);
}
const kindOf = (tool) => (['Read', 'Glob', 'Grep'].includes(tool) ? 'Read' : 'Edit');
const ruleHit = (rules, tool, path) => rules.some((rule) => {
  const parsed = /^(Read|Edit)\((.+)\)$/.exec(rule);
  return parsed !== null && parsed[1] === kindOf(tool) && ruleMatches(parsed[2], path);
});
function decision(scope, tool, path) {
  if (ruleHit(scope.deny, tool, path)) return 'DENY';
  if (kindOf(tool) === 'Read') return scope.readAreas.some((area) => path === area || path.startsWith(`${area}/`)) ? 'ALLOW' : 'DENY';
  return ruleHit(scope.allow, tool, path) ? 'ALLOW' : 'DENY';
}
const fileScope = (overrides = {}) => modelFileScope({ readAreas: ['src/automation'], writeAreas: ['src/automation'],
  forbidden: ['src/stress-test', 'src/automation/generated'], linked: ['node_modules'], repositoryPaths: Object.keys(BASE_FILES), ...overrides });

// ---------------------------------------------------------------- Claude Code implementation adapter
check('Claude command: file tools only, path-scoped rules, dontAsk, restricted, no prompts, no Bash, no bypass', () => {
  const scope = fileScope();
  const args = claudeArguments(CLAUDE, scope);
  const value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ['-p', '--restricted', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual([value('--output-format'), value('--model'), value('--max-turns'), value('--permission-prompts'), value('--permission-mode')],
    ['json', CLAUDE.model, '40', 'none', 'dontAsk']);
  assert.deepEqual(JSON.parse(value('--json-schema')).required, ['status', 'reason']);
  assert.equal(value('--tools'), 'Read,Glob,Grep,Edit,Write');
  assert.equal(value('--disallowedTools'), 'Bash,WebFetch,WebSearch');
  const settings = JSON.parse(value('--settings'));
  assert.deepEqual(Object.keys(settings), ['permissions']);
  assert.deepEqual(settings.permissions, { allow: [...scope.allow], deny: [...scope.deny], disableBypassPermissionsMode: 'disable' });
  for (const rule of settings.permissions.allow) assert.match(rule, /^(Read|Edit)\(\.\/[A-Za-z0-9._@+/-]+(\/\*\*)?\)$/, rule);
  for (const tool of [...FILE_TOOLS, 'Bash']) {
    assert.ok(!settings.permissions.allow.includes(tool) && !args.includes(tool), `bare ${tool}`);
    assert.ok(!settings.permissions.allow.some((rule) => rule.startsWith(`${tool}(*`) || rule === `${tool}()`), tool);
  }
  assert.ok(!settings.permissions.allow.some((rule) => rule.startsWith('Bash')));
  assert.doesNotMatch(args.join(' '), /dangerously|bypassPermissions|acceptEdits|--allowedTools|--add-dir|--fallback-model|--mcp-config|--bare|Bash\(/);
  for (const allow of [[...scope.allow, 'Read'], [...scope.allow, 'Edit'], [...scope.allow, 'Write'], ['Edit(./**)'], ['Read(**)'], ['Bash(npm test)']]) {
    assert.throws(() => claudeArguments(CLAUDE, { ...scope, allow }), /name a path/, allow.at(-1));
  }
  assert.throws(() => claudeArguments({ ...CLAUDE, model: 'fable' }, scope));
});
check('generated rules: in-scope reads and writes are permitted; everything else is denied', () => {
  const scope = fileScope();
  for (const tool of ['Read', 'Glob', 'Grep']) {
    assert.equal(decision(scope, tool, 'src/automation/runner.ts'), 'ALLOW', tool);
    for (const outside of ['src/context/secret.ts', 'README.md', 'package.json', 'src/automation.ts', 'src/stress-test/session.ts']) {
      assert.equal(decision(scope, tool, outside), 'DENY', `${tool} ${outside}`);
      assert.ok(ruleHit(scope.deny, tool, outside), `a deny rule names ${outside}`);
    }
  }
  for (const tool of ['Edit', 'Write']) {
    assert.equal(decision(scope, tool, 'src/automation/runner.ts'), 'ALLOW', tool);
    assert.equal(decision(scope, tool, 'src/automation/new/file.ts'), 'ALLOW', tool);
    for (const outside of ['src/context/secret.ts', 'README.md', 'src/new.ts', 'src/automation/generated/x.ts', 'src/stress-test/session.ts']) {
      assert.equal(decision(scope, tool, outside), 'DENY', `${tool} ${outside}`);
    }
  }
  const correction = fileScope({ writeAreas: ['src/automation/runner.ts'] });
  assert.equal(decision(correction, 'Read', 'src/automation/bridge.ts'), 'ALLOW');
  for (const tool of ['Edit', 'Write']) {
    assert.equal(decision(correction, tool, 'src/automation/runner.ts'), 'ALLOW');
    assert.equal(decision(correction, tool, 'src/automation/bridge.ts'), 'DENY', 'read-only in a correction');
  }
  const denied = ['.git/config', 'src/automation/.git/HEAD', '.github/workflows/ci.yml', 'src/automation/.env', 'src/automation/.env.local',
    'src/automation/key.pem', 'src/automation/id_ed25519', 'src/automation/.npmrc', 'src/automation/.netrc', '.gitmodules', 'src/automation/.gitattributes',
    'node_modules/zod/index.js', 'node_modules', 'src/automation/CASE-001/notes.md', 'src/automation/case_001.md', 'src/automation/Case001/x'];
  for (const path of denied) {
    for (const tool of FILE_TOOLS) assert.equal(decision(scope, tool, path), 'DENY', `${tool} ${path}`);
    assert.ok(ruleHit(scope.deny, 'Read', path) && ruleHit(scope.deny, 'Edit', path), `deny rules name ${path}`);
  }
});
check('a scope that cannot be stated as path rules fails closed', () => {
  const refused = [{ readAreas: ['src/auto mation'] }, { readAreas: ['src/*'] }, { readAreas: ['.'] }, { readAreas: [''] }, { readAreas: ['../x'] },
    { readAreas: ['.github'] }, { readAreas: ['src/automation/CASE-001'] }, { readAreas: ['node_modules/zod'] }, { readAreas: [] },
    { writeAreas: ['src/other'] }, { writeAreas: [] }, { forbidden: ['src'] }, { forbidden: ['src/automation/gen erated'] },
    { repositoryPaths: [...Object.keys(BASE_FILES), 'my notes.txt'] }, { repositoryPaths: ['src/(x)/a.ts'] }];
  for (const overrides of refused) assert.equal(typeof fileScope(overrides), 'string', JSON.stringify(overrides));
  assert.equal(typeof fileScope({ forbidden: ['docs/**', 'src/stress-test'] }), 'object', 'an unexpressible forbidden entry outside the write scope needs no rule');
  assert.equal(typeof fileScope({ repositoryPaths: [...Object.keys(BASE_FILES), 'docs/my notes.txt'] }), 'object', 'named by its safe prefix');
});
check('the adapter refuses an unexpressible scope before any model call', withDir(async (dir) => {
  const early = setup(join(dir, 'e'), 'IMPLEMENTATION', {}, { allowedAreas: ['src/*'] });
  const result = await early.implementation.execute(early.input);
  assert.deepEqual([result.status, /not safely expressible/.test(result.reason)], ['ARCHITECTURE_STOP', true]);
  assert.equal(early.calls.length, 0);
  const tree = setup(join(dir, 't'), 'IMPLEMENTATION', { files: { ...BASE_FILES, 'my notes.txt': 'x\n' } });
  assert.equal((await tree.implementation.execute(tree.input)).status, 'ARCHITECTURE_STOP');
  assert.equal(tree.named('claude').length + noDelivery(tree), 0);
  for (const mode of ['120000', '160000']) {
    const link = setup(join(dir, mode), 'IMPLEMENTATION', { modes: { 'src/automation/bridge.ts': mode } });
    const linked = await link.implementation.execute(link.input);
    assert.deepEqual([linked.status, /non-regular entry src\/automation\/bridge.ts/.test(linked.reason)], ['ARCHITECTURE_STOP', true], mode);
    assert.equal(link.named('claude').length + noDelivery(link), 0, mode);
  }
}));
check('the model workspace holds exactly the read scope: no Git metadata, protected, confidential, or linked path', withDir(async (dir) => {
  const deps = join(dir, 'deps');
  mkdirSync(deps);
  const s = setup(dir, 'IMPLEMENTATION', {}, {}, { linkedDirectories: [{ path: 'node_modules', source: deps }] });
  assert.equal((await s.implementation.execute(s.input)).status, 'COMPLETED');
  const claude = s.named('claude')[0];
  assert.equal(claude.cwd, `${s.worktree}.model`);
  assert.deepEqual(s.state.seen, ['src/automation/bridge.ts', 'src/automation/runner.ts']);
  assert.deepEqual(claude.env, { ...s.environment, ...CLAUDE_ENV });
  assert.match(claude.stdin, /only the repository files inside this packet's read scope: \["src\/automation"\]/);
  assert.doesNotMatch(claude.stdin, /OUT-OF-SCOPE-SENTINEL|SENTINEL_ENV|confidential/);
  const settings = JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]);
  for (const path of ['node_modules/x.js', 'src/context/secret.ts', '.github/workflows/ci.yml', 'src/automation/CASE-001/notes.md']) {
    assert.ok(ruleHit(settings.permissions.deny, 'Read', path), path);
  }
  // Linked dependencies exist only in the validation copy, created after the model exited.
  assert.ok(!existsSync(join(s.worktree, 'node_modules')) && !existsSync(join(`${s.worktree}.model`, 'node_modules')));
  assert.equal(readlinkSync(join(`${s.worktree}.validation`, 'node_modules')), deps);
  assert.deepEqual(s.validations.map((call) => call.readOnlyPaths), [[deps], [deps]]);
}));
check('Claude delivery: validation isolated on a disposable copy, exact work-branch push, no force, never main; no SHA reported', withDir(async (dir) => {
  const s = setup(dir, 'IMPLEMENTATION');
  const result = await s.implementation.execute(s.input);
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(Object.keys(result).sort(), ['status', 'validationEvidence']);
  assert.ok(!JSON.stringify(result).includes(B));
  assert.ok(result.validationEvidence.includes('validation test: exit 0 (isolated: network denied, filesystem confined)'));
  assert.deepEqual(s.state.pushed, ['--no-verify', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  assert.equal(readFileSync(join(s.worktree, 'src/automation/runner.ts'), 'utf8'), 'export const runner = 2;\n');
  assert.deepEqual(s.validations.map((call) => call.args.join(' ')), ['run build', 'test']);
  for (const call of s.validations) {
    assert.deepEqual([call.workspace, call.cwd, call.temporaryDirectory, call.env], [`${s.worktree}.validation`, `${s.worktree}.validation`,
      `${s.worktree}.tmp`, s.environment]);
    assert.ok(call.copy.includes('src/automation/runner.ts') && call.copy.includes('src/context/secret.ts') && !call.gitMetadata);
  }
  assert.equal(s.named('npm').length, 0);
  const worktree = s.named('git', 'worktree')[0].args;
  assert.deepEqual(worktree.slice(-4), ['add', '--detach', s.worktree, A]);
  for (const call of s.calls) {
    const text = call.args.join(' ');
    assert.doesNotMatch(text, /--force|force-with-lease|(^|\s)-f(\s|$)|\+HEAD|\+refs|refs\/heads\/main|--mirror|--delete|--all(\s|$)/, text);
  }
  assert.ok(s.named('claude').length === 1 && s.named('git', 'push').length === 1);
}));
check('scope violations in the model workspace block delivery: outside, forbidden, protected, confidential, and non-regular', withDir(async (dir) => {
  const cases = [
    [change('src/other/file.ts', 'x'), 'ARCHITECTURE_STOP'], [change('src/stress-test/session.ts', 'x'), 'ARCHITECTURE_STOP'],
    [change('.github/workflows/ci.yml', 'x'), 'HUMAN_STOP'], [change('src/automation/.env', 'x'), 'HUMAN_STOP'], [change('.gitmodules', 'x'), 'HUMAN_STOP'],
    [change('src/automation/CASE-001/leak.md', 'x'), 'HUMAN_STOP'], [change('node_modules/evil.js', 'x'), 'ARCHITECTURE_STOP'],
    [(root) => { rmSync(join(root, 'src/automation/bridge.ts')); change('src/other/bridge.ts', 'x')(root); }, 'ARCHITECTURE_STOP'],
    [(root) => symlinkSync('/etc/hosts', join(root, 'src/automation/link')), 'HUMAN_STOP']];
  for (const [index, [edit, expected]] of cases.entries()) {
    const s = setup(join(dir, String(index)), 'IMPLEMENTATION', { edit });
    const result = await s.implementation.execute(s.input);
    assert.equal(result.status, expected, `${index}: ${result.reason}`);
    assert.match(result.reason, /scope violation|non-regular/, String(index));
    assert.equal(noDelivery(s), 0, String(index));
    assert.deepEqual(listFiles(s.worktree), Object.keys(BASE_FILES).sort(), 'nothing carried');
  }
  const empty = setup(join(dir, 'empty'), 'IMPLEMENTATION', { edit: undefined });
  assert.deepEqual(await empty.implementation.execute(empty.input), { status: 'SOFT_STOP', reason: 'implementation produced no changes' });
}));
check('a change Git does not see (an ignored path) is never validated or delivered', withDir(async (dir) => {
  const s = setup(dir, 'IMPLEMENTATION', { edit: (root) => { change('src/automation/runner.ts', 'v2\n')(root); change('src/automation/cache.log', 'x')(root); },
    ignored: ['src/automation/cache.log'] });
  const result = await s.implementation.execute(s.input);
  assert.deepEqual([result.status, /differs from what Git sees/.test(result.reason)], ['ARCHITECTURE_STOP', true]);
  assert.equal(noDelivery(s), 0);
}));
check('deletions and executable bits are carried exactly', withDir(async (dir) => {
  const s = setup(dir, 'IMPLEMENTATION', { edit: (root) => { rmSync(join(root, 'src/automation/bridge.ts')); change('src/automation/tool.sh', '#!/bin/sh\n')(root);
    chmodSync(join(root, 'src/automation/tool.sh'), 0o755); } });
  assert.equal((await s.implementation.execute(s.input)).status, 'COMPLETED');
  assert.ok(!existsSync(join(s.worktree, 'src/automation/bridge.ts')));
  assert.equal(statSync(join(s.worktree, 'src/automation/tool.sh')).mode & 0o777, 0o755);
}));
check('failed or unavailable validation, a failed diff check, or a staged link blocks commit and push', withDir(async (dir) => {
  const failed = setup(join(dir, 'v'), 'IMPLEMENTATION', { validation: { test: fail('REPOSITORY-CONTENT-SENTINEL printed by model code') } });
  const result = await failed.implementation.execute(failed.input);
  assert.deepEqual(result, { status: 'SOFT_STOP', reason: 'validation test failed: EXITED exit 1' });
  assert.equal(deliveryCalls(failed).length, 0);
  assert.match(readFileSync(join(`${failed.worktree}.logs`, 'validation-1.log'), 'utf8'), /REPOSITORY-CONTENT-SENTINEL/);
  const unavailable = setup(join(dir, 'u'), 'IMPLEMENTATION', { isolation: 'the Seatbelt profile could not be applied' });
  const refused = await unavailable.implementation.execute(unavailable.input);
  assert.deepEqual([refused.status, /isolation unavailable/.test(refused.reason)], ['HUMAN_STOP', true]);
  assert.deepEqual([unavailable.validations.length, deliveryCalls(unavailable).length, unavailable.named('npm').length], [1, 0, 0]);
  const check = setup(join(dir, 'c'), 'IMPLEMENTATION', { diffCheck: false });
  assert.equal((await check.implementation.execute(check.input)).status, 'SOFT_STOP');
  assert.equal(check.named('git', 'push').length, 0);
  for (const mode of ['120000', '160000']) {
    const linked = setup(join(dir, mode), 'IMPLEMENTATION', { raw: `:000000 ${mode} ${'0'.repeat(40)} ${'2'.repeat(40)} A\0src/automation/runner.ts\0` });
    assert.equal((await linked.implementation.execute(linked.input)).status, 'HUMAN_STOP');
    assert.equal(linked.named('git', 'commit').length + linked.named('git', 'push').length, 0);
  }
}));
check('a moved work branch blocks the model call, or the push', withDir(async (dir) => {
  const early = setup(join(dir, 'early'), 'IMPLEMENTATION', { remote: { [BRANCH]: C } });
  assert.equal((await early.implementation.execute(early.input)).status, 'ARCHITECTURE_STOP');
  assert.equal(early.named('claude').length, 0);
  const late = setup(join(dir, 'late'), 'IMPLEMENTATION', { beforePush: (state) => { state.remote[BRANCH] = C; } });
  const result = await late.implementation.execute(late.input);
  assert.deepEqual([result.status, /moved before push/.test(result.reason)], ['ARCHITECTURE_STOP', true]);
  assert.equal(late.named('git', 'push').length, 0);
}));
check('a push that did not land stops for a human; an unexplained remote state is uncertain', withDir(async (dir) => {
  const rejected = setup(join(dir, 'r'), 'IMPLEMENTATION', { pushLands: false });
  assert.equal((await rejected.implementation.execute(rejected.input)).status, 'HUMAN_STOP');
  const odd = setup(join(dir, 'o'), 'IMPLEMENTATION', { afterPush: (state) => { state.remote[BRANCH] = C; } });
  await assert.rejects(odd.implementation.execute(odd.input), /uncertain/);
}));
check('Claude failures, non-success, substitution, and its own stop reports never deliver', withDir(async (dir) => {
  const cases = [
    [() => fail('model not available'), 'HUMAN_STOP'],
    [() => ({ ...ok(), outcome: 'TIMED_OUT', exitCode: null, signal: 'SIGTERM' }), 'HUMAN_STOP'],
    [() => ok('not json'), 'HUMAN_STOP'],
    [() => claudeOk(undefined, { subtype: 'error_max_turns', is_error: true }), 'HUMAN_STOP'],
    [() => claudeOk(undefined, { modelUsage: { 'claude-other-model': {} } }), 'HUMAN_STOP'],
    [() => claudeOk({ status: 'COMPLETED', reason: 'done', sha: C }), 'HUMAN_STOP'],
    [() => claudeOk({ status: 'ARCHITECTURE_STOP', reason: 'packet conflicts with repository' }), 'ARCHITECTURE_STOP'],
    [() => claudeOk({ status: 'SOFT_STOP', reason: 'could not fix test' }), 'SOFT_STOP'],
  ];
  for (const [index, [claude, expected]] of cases.entries()) {
    const s = setup(join(dir, String(index)), 'IMPLEMENTATION', { claude });
    assert.equal((await s.implementation.execute(s.input)).status, expected, String(index));
    assert.equal(noDelivery(s), 0, String(index));
    assert.equal(readFileSync(join(s.worktree, 'src/automation/runner.ts'), 'utf8'), BASE_FILES['src/automation/runner.ts'], String(index));
  }
}));
check('delivery the packet does not grant is refused before any process runs', withDir(async (dir) => {
  const s = setup(dir, 'IMPLEMENTATION', {}, { networkAuthorization: { level: 'READ_EXTERNAL_API',
    destinations: [BRANCH, CLAUDE.destination, CODEX.destination], purpose: 'fixture', budget: 1 } });
  const result = await s.implementation.execute(s.input);
  assert.deepEqual([result.status, /PUSH_WORK_BRANCH|CREATE_WORK_BRANCH|COMMIT_WORK_BRANCH/.test(result.reason)], ['ARCHITECTURE_STOP', true]);
  assert.equal(s.calls.length, 0);
}));
check('a correction iteration starts from the rejected SHA, reads the packet scope, and writes only its correction areas', withDir(async (dir) => {
  const correction = { correctionPacketId: 'c2', originalPacketId: 'packet-1', originalPacketHash: packetHash(packet()), rejectedSha: B,
    reviewerFindings: ['f'], allowedCorrectionAreas: ['src/automation/runner.ts'], unchangedInvariantReferences: ['human authority retained'],
    expectedBaseSha: B, correctionIteration: 2, maxCorrectionIteration: 3 };
  const s = setup(dir, 'IMPLEMENTATION', { remote: { [BRANCH]: B }, head: C });
  const result = await s.implementation.execute({ ...s.input, implementationIteration: 2, correction });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(s.named('git', 'fetch')[0].args.at(-1), B);
  assert.equal(s.named('git', 'worktree')[0].args.at(-1), B);
  const claude = s.named('claude')[0];
  assert.match(claude.stdin, /rejection of b{40}/);
  assert.deepEqual(s.state.seen, ['src/automation/bridge.ts', 'src/automation/runner.ts']);
  const permissions = JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]).permissions;
  assert.deepEqual(permissions.allow.filter((rule) => rule.startsWith('Edit')), ['Edit(./src/automation/runner.ts)', 'Edit(./src/automation/runner.ts/**)']);
  const outside = setup(join(dir, 'x'), 'IMPLEMENTATION', { remote: { [BRANCH]: B }, edit: change('src/automation/bridge.ts', 'x') });
  assert.equal((await outside.implementation.execute({ ...outside.input, implementationIteration: 2, correction })).status, 'ARCHITECTURE_STOP');
  assert.equal(noDelivery(outside), 0);
  const moved = setup(join(dir, 'm'), 'IMPLEMENTATION', { remote: { [BRANCH]: null } });
  assert.equal((await moved.implementation.execute({ ...moved.input, implementationIteration: 2, correction })).status, 'ARCHITECTURE_STOP');
}));
check('Claude adapter refuses aliases, unbounded turns, and a missing validation boundary at composition', withDir((dir) => {
  for (const model of ['opus', 'latest', 'claude-latest', 'default', 'sonnet', '']) {
    assert.throws(() => new ClaudeCodeImplementationAdapter({ ...adapterSettings(dir), claude: { ...CLAUDE, model } },
      { executor: {}, validation: refusedValidation, journal: {}, clock }), undefined, model);
  }
  assert.throws(() => new ClaudeCodeImplementationAdapter(adapterSettings(dir), { executor: {}, journal: {}, clock }), /isolation boundary/);
  assert.throws(() => new ClaudeCodeImplementationAdapter(adapterSettings(dir), { executor: {}, validation: {}, journal: {}, clock }), /isolation boundary/);
}));
check('Claude adapter dispatches nothing without a STARTED invocation bound to it', withDir(async (dir) => {
  const cases = [
    (s) => ({ ...s.input, invocationId: undefined }),
    (s) => { const id = s.journal.prepare({ ...s.journal.get(s.invocationId).identity, occurrence: { sequence: 8, action: 'BEGIN_IMPLEMENTATION', timestamp: T } }).invocationId; return { ...s.input, invocationId: id }; },
    (s) => ({ ...s.input, runId: 'run-2' }),
    (s) => ({ ...s.input, packetHash: 'e'.repeat(64) }),
  ];
  for (const [index, build] of cases.entries()) {
    const s = setup(join(dir, String(index)), 'IMPLEMENTATION');
    await assert.rejects(s.implementation.execute(build(s)), /refuses/);
    assert.equal(s.calls.length, 0, String(index));
  }
  const review = setup(join(dir, 'review'), 'ARCHITECT_REVIEW');
  const wrongKind = new ClaudeCodeImplementationAdapter(adapterSettings(dir), { executor: review.executor, validation: review.validation,
    journal: review.journal, clock });
  await assert.rejects(wrongKind.execute(review.input), /refuses/);
  assert.equal(review.calls.length, 0);
}));
check('real local git: a model change travels through a real worktree to an exact work-branch push', withDir(async (dir) => {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const run = (cwd, ...args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const origin = join(dir, 'origin.git'), seed = join(dir, 'seed'), clone = join(dir, 'clone'), deps = join(dir, 'deps');
  for (const path of [seed, deps, join(dir, 'worktrees')]) mkdirSync(path);
  run(dir, 'init', '-q', '--bare', origin);
  run(seed, 'init', '-q');
  for (const [path, content] of Object.entries(BASE_FILES)) change(path, content)(seed);
  run(seed, 'add', '-A');
  run(seed, 'commit', '-q', '-m', 'base');
  const base = run(seed, 'rev-parse', 'HEAD');
  run(seed, 'push', '-q', origin, 'HEAD:refs/heads/main');
  run(dir, 'clone', '-q', origin, clone);
  const journal = new FileInvocationJournal(join(dir, 'journal'), clock);
  const p = packet({ expectedBaseSha: base });
  const invocationId = journal.prepare({ runId: 'run-1', sliceId: 'slice-1', packetId: p.packetId, packetHash: packetHash(p),
    occurrence: { sequence: 4, action: 'BEGIN_IMPLEMENTATION', timestamp: T }, actorKind: 'IMPLEMENTATION', provider: CLAUDE.provider,
    model: CLAUDE.model, destination: CLAUDE.destination, authorizationId: 'auth' }).invocationId;
  journal.start(invocationId, 10);
  let seen;
  const real = new NodeProcessExecutor();
  const executor = { async run(request) {
    if (request.executable !== 'claude') return real.run(request);
    seen = listFiles(request.cwd);
    change('src/automation/runner.ts', 'export const runner = 2;\n')(request.cwd);
    return claudeOk();
  } };
  const validations = [];
  const validation = { async runOffline(request) {
    validations.push({ files: listFiles(request.workspace), gitMetadata: existsSync(join(request.workspace, '.git')) });
    return { isolation: 'ENFORCED', result: ok() };
  } };
  const adapter = new ClaudeCodeImplementationAdapter({ claude: CLAUDE, environment: env, git: { executable: 'git', remote: 'origin',
    repositoryPath: clone, worktreeRoot: join(dir, 'worktrees'), timeoutMs: 60_000, maxOutputBytes: 1_000_000,
    commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' }, validationTimeoutMs: 60_000, validationMaxOutputBytes: 1_000_000,
    linkedDirectories: [{ path: 'node_modules', source: deps }] } }, { executor, validation, journal, clock });
  const result = await adapter.execute({ runId: 'run-1', sliceId: 'slice-1', implementationIteration: 1, packet: p, packetHash: packetHash(p), invocationId });
  assert.equal(result.status, 'COMPLETED', result.reason);
  assert.deepEqual(seen, ['src/automation/bridge.ts', 'src/automation/runner.ts']);
  assert.ok(validations.length === 2 && validations[0].files.includes('node_modules') && validations[0].files.includes('src/context/secret.ts'));
  assert.equal(validations[0].gitMetadata, false, 'the validation copy carries no Git metadata');
  assert.ok(existsSync(join(dir, 'worktrees', invocationId, '.git')), 'the delivery worktree keeps its own');
  const pushed = run(origin, 'rev-parse', `refs/heads/${BRANCH}`);
  assert.equal(run(origin, 'rev-parse', `${pushed}^`), base);
  assert.equal(run(origin, 'diff', '--name-only', base, pushed), 'src/automation/runner.ts');
  assert.equal(run(origin, 'show', `${pushed}:src/automation/runner.ts`), 'export const runner = 2;');
  assert.equal(run(origin, 'rev-parse', 'refs/heads/main'), base);
}));

// ---------------------------------------------------------------- Codex architect review adapter
check('Codex command: read-only, approvals never, no web, no project docs, isolated, exact model, output schema', () => {
  const args = codexArguments(CODEX, { worktree: '/w', schema: '/s.json', output: '/o.json' });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'exec');
  assert.deepEqual([value('--model'), value('--sandbox'), value('--cd'), value('--output-schema'), value('--output-last-message'), args.at(-1)],
    [CODEX.model, 'read-only', '/w', '/s.json', '/o.json', '-']);
  const configs = args.flatMap((arg, index) => (args[index - 1] === '--config' ? [arg] : []));
  assert.deepEqual(configs, ['approval_policy="never"', 'web_search="disabled"', 'project_doc_max_bytes=0']);
  const disabled = args.flatMap((arg, index) => (args[index - 1] === '--disable' ? [arg] : []));
  for (const feature of REQUIRED_DISABLED_FEATURES) assert.ok(disabled.includes(feature), feature);
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral']) assert.ok(args.includes(flag), flag);
  assert.doesNotMatch(args.join(' '), /full-auto|workspace-write|danger-full-access|dangerously|approve-for-me|--search|--oss|--add-dir|--enable|--profile|on-request/);
  assert.throws(() => codexArguments({ ...CODEX, model: 'latest' }, { worktree: '/w', schema: '/s', output: '/o' }));
});
check('Codex adapter dispatches nothing without a STARTED review invocation bound to it', withDir(async (dir) => {
  const s = setup(dir, 'ARCHITECT_REVIEW');
  await assert.rejects(s.review.review({ ...s.input, invocationId: undefined }), /refuses/);
  await assert.rejects(s.review.review({ ...s.input, packetHash: 'e'.repeat(64) }), /refuses/);
  const impl = setup(join(dir, 'impl'), 'IMPLEMENTATION');
  const reviewer = new CodexArchitectReviewAdapter({ codex: CODEX, git: { executable: 'git', remote: 'origin', repositoryPath: dir,
    worktreeRoot: dir, timeoutMs: 1, maxOutputBytes: 1 }, environment: {} }, { executor: impl.executor, journal: impl.journal, clock });
  await assert.rejects(reviewer.review({ ...impl.input, acceptanceFailures: 0, remoteSha: { repository: REPO, branch: BRANCH, sha: B,
    observedAt: T, source: 'GITHUB' } }), /refuses/);
  assert.equal(s.calls.length + impl.calls.length, 0);
}));
check('the adapter binds every trusted decision field; the model supplies only review content', withDir(async (dir) => {
  const s = setup(dir, 'ARCHITECT_REVIEW', { reviewHead: B });
  const bundle = await s.review.review(s.input);
  assert.deepEqual(bundle, { decision: { reviewId: `review-${s.invocationId.slice(0, 24)}`, actor: 'GPT_ARCHITECT', packetId: 'packet-1',
    packetHash: s.input.packetHash, reviewedSha: B, decision: 'ACCEPT', findings: [], evidenceReferences: ['git diff base..HEAD'], issuedAt: T } });
  const codex = s.named('codex')[0];
  assert.equal(codex.cwd, join(s.worktreeRoot, s.invocationId));
  assert.deepEqual(s.named('git', 'worktree')[0].args.slice(-4), ['add', '--detach', join(s.worktreeRoot, s.invocationId), B]);
  assert.deepEqual(s.named('git', 'fetch').map((call) => call.args.at(-1)), [B, A]);
  assert.deepEqual(JSON.parse(readFileSync(codex.args[codex.args.indexOf('--output-schema') + 1], 'utf8')).required,
    ['decision', 'findings', 'evidenceReferences', 'correction']);
  for (const field of ['packetId', 'packetHash', 'reviewedSha', 'actor', 'issuedAt', 'reviewId', 'humanAuthorization', 'authorization']) {
    const forged = setup(join(dir, field), 'ARCHITECT_REVIEW', { reviewHead: B, review: { decision: 'ACCEPT', findings: [], evidenceReferences: ['x'],
      correction: null, [field]: field === 'actor' ? 'HUMAN' : C } });
    assert.deepEqual(await forged.review.review(forged.input), { stop: 'ARCHITECTURE_STOP', reason: 'review answer does not match the review schema' }, field);
  }
}));
check('malformed or contradictory review answers stop for the architect', withDir(async (dir) => {
  const cases = [['not json', 'not JSON'], [{ decision: 'MAYBE', findings: [], evidenceReferences: ['x'], correction: null }, 'schema'],
    [{ decision: 'ACCEPT', findings: [], evidenceReferences: [], correction: null }, 'schema'],
    [{ decision: 'ACCEPT', findings: [], evidenceReferences: ['x'] }, 'schema'],
    [{ decision: 'ACCEPT', findings: [], evidenceReferences: ['x'], correction: { allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: ['i'] } }, 'ACCEPT carried a correction'],
    [{ decision: 'REJECT', findings: [], evidenceReferences: ['x'], correction: null }, 'REJECT carried no findings']];
  for (const [index, [review, reason]] of cases.entries()) {
    const s = setup(join(dir, String(index)), 'ARCHITECT_REVIEW', { reviewHead: B, review });
    const bundle = await s.review.review(s.input);
    assert.equal(bundle.stop, 'ARCHITECTURE_STOP', String(index));
    assert.match(bundle.reason, new RegExp(reason), String(index));
  }
  const silent = setup(join(dir, 'silent'), 'ARCHITECT_REVIEW', { reviewHead: B, codex: () => ok() });
  assert.deepEqual(await silent.review.review(silent.input), { stop: 'ARCHITECTURE_STOP', reason: 'review answer is missing or not JSON' });
}));
check('a correction takes every binding field from the controller input, only its areas from the model', withDir(async (dir) => {
  const s = setup(dir, 'ARCHITECT_REVIEW', { reviewHead: B, review: { decision: 'REJECT', findings: ['missing test'], evidenceReferences: ['test file'],
    correction: { allowedCorrectionAreas: ['src/automation/runner.ts'], unchangedInvariantReferences: ['human authority retained'] } } });
  const bundle = await s.review.review(s.input);
  assert.deepEqual(bundle.correction, { correctionPacketId: 'correction-packet-1-2', originalPacketId: 'packet-1', originalPacketHash: s.input.packetHash,
    rejectedSha: B, reviewerFindings: ['missing test'], allowedCorrectionAreas: ['src/automation/runner.ts'],
    unchangedInvariantReferences: ['human authority retained'], expectedBaseSha: B, correctionIteration: 2, maxCorrectionIteration: 3 });
  assert.equal(bundle.decision.decision, 'REJECT');
}));
check('the reviewer writes nothing: a changed workspace or head stops, and the adapter runs no git write', withDir(async (dir) => {
  const dirty = setup(join(dir, 'd'), 'ARCHITECT_REVIEW', { reviewHead: B, reviewStatus: ' M src/automation/runner.ts\n' });
  assert.deepEqual(await dirty.review.review(dirty.input), { stop: 'ARCHITECTURE_STOP', reason: 'the reviewer changed the review workspace' });
  const moved = setup(join(dir, 'm'), 'ARCHITECT_REVIEW', { reviewHead: C });
  assert.equal((await moved.review.review(moved.input)).stop, 'ARCHITECTURE_STOP');
  const clean = setup(join(dir, 'c'), 'ARCHITECT_REVIEW', { reviewHead: B });
  await clean.review.review(clean.input);
  assert.deepEqual([...new Set(clean.named('git').map((call) => subcommand(call.args.slice(2)).name))].sort(),
    ['fetch', 'ls-tree', 'rev-parse', 'status', 'worktree']);
}));
check('repository agent configuration in the reviewed tree blocks the review; a failed run stops for a human', withDir(async (dir) => {
  for (const name of ['.codex', '.agents']) {
    const s = setup(join(dir, name), 'ARCHITECT_REVIEW', { reviewHead: B, tree: `package.json\n${name}\nsrc\n` });
    assert.equal((await s.review.review(s.input)).stop, 'ARCHITECTURE_STOP');
    assert.equal(s.named('codex').length, 0);
  }
  const failed = setup(join(dir, 'f'), 'ARCHITECT_REVIEW', { reviewHead: B, codex: () => fail('model unavailable') });
  assert.equal((await failed.review.review(failed.input)).stop, 'HUMAN_STOP');
}));

// ---------------------------------------------------------------- GitHub CLI repository reality
function gh(dir, routes, clockOverride = clock) {
  const calls = [];
  const executor = { calls, runSync(request) {
    parseProcessRequest(request);
    calls.push(request);
    const route = routes(request.args.at(-1));
    const [status, body] = route ?? [404, { message: 'Not Found' }];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { outcome: 'EXITED', exitCode: status === 200 ? 0 : 1, signal: null, durationMs: 1, stderr: '',
      stdout: `HTTP/2.0 ${status} Status\ncontent-type: application/json\n\n${text}` };
  } };
  const port = new GitHubCliRepositoryRealityPort({ executable: 'gh', repository: REPO, workflowName: 'CI', requiredCheckName: 'test',
    requiredCheckAppId: 15368, timeoutMs: 10_000, maxOutputBytes: 1_000_000, maxObservationAgeMs: 60_000, workingDirectory: dir },
  { executor, clock: clockOverride, environment: { PATH: process.env.PATH ?? '/usr/bin' } });
  return { port, calls };
}
const ref = (branch, sha) => [200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }];
const run = (overrides = {}) => ({ id: 1, name: 'CI', head_sha: B, head_branch: BRANCH, event: 'push', status: 'completed',
  conclusion: 'success', check_suite_id: 77, ...overrides });
const checkRun = (overrides = {}) => ({ name: 'test', head_sha: B, status: 'completed', conclusion: 'success', check_suite: { id: 77 },
  app: { id: 15368 }, ...overrides });
function ciRoutes(runs, checks) {
  return (path) => path.startsWith(`repos/${REPO}/actions/runs?`) ? [200, { workflow_runs: runs }]
    : path.startsWith(`repos/${REPO}/commits/${B}/check-runs?`) ? [200, { check_runs: checks }] : undefined;
}

check('GitHub branch facts are exact, primed before the controller reads them, and never served late', withDir((dir) => {
  const { port, calls } = gh(dir, (path) => path === `repos/${REPO}/git/ref/heads/${BRANCH}` ? ref(BRANCH, B) : undefined);
  assert.throws(() => port.observeBranch(REPO, BRANCH), /not observed/);
  assert.equal(calls.length, 0);
  port.primeBranch(REPO, BRANCH);
  assert.deepEqual(readBranch(port, REPO, BRANCH, Date.parse(T)), { repository: REPO, branch: BRANCH, sha: B, observedAt: T, source: 'GITHUB' });
  let now = T;
  const aged = gh(dir, (path) => path.endsWith(BRANCH) ? ref(BRANCH, B) : undefined, { now: () => now });
  aged.port.primeBranch(REPO, BRANCH);
  now = '2026-09-28T00:01:00.001Z';
  assert.throws(() => aged.port.observeBranch(REPO, BRANCH), /too old/);
  const wrong = gh(dir, () => ref('work/other', B));
  assert.throws(() => wrong.port.primeBranch(REPO, BRANCH), /exact commit ref/);
  const tag = gh(dir, () => [200, { ref: `refs/heads/${BRANCH}`, object: { sha: B, type: 'tag' } }]);
  assert.throws(() => tag.port.primeBranch(REPO, BRANCH));
}));
check('comparison parses ahead/behind, detects main-only commits, and proves the head', withDir((dir) => {
  const answer = (overrides) => () => [200, { base_commit: { sha: A }, merge_base_commit: { sha: A }, ahead_by: 2, behind_by: 0, total_commits: 2,
    commits: [{ sha: C }, { sha: B }], ...overrides }];
  const fresh = gh(dir, answer({}));
  fresh.port.primeComparison(REPO, A, B);
  assert.deepEqual(fresh.port.compare(REPO, A, B), { repository: REPO, baseSha: A, headSha: B, aheadBy: 2, behindBy: 0, hasBaseOnlyCommits: false, observedAt: T });
  const diverged = gh(dir, answer({ behind_by: 1 }));
  diverged.port.primeComparison(REPO, A, B);
  assert.equal(diverged.port.compare(REPO, A, B).hasBaseOnlyCommits, true);
  for (const bad of [{ commits: [{ sha: C }, { sha: C }] }, { total_commits: 300 }, { base_commit: { sha: C } }, { ahead_by: -1 }, { ahead_by: '2' }]) {
    assert.throws(() => gh(dir, answer(bad)).port.primeComparison(REPO, A, B), undefined, JSON.stringify(bad));
  }
}));
check('CI is bound to the exact SHA, branch, run, and check suite', withDir((dir) => {
  const noise = [run({ id: 2, head_sha: C }), run({ id: 3, head_branch: 'main' }), run({ id: 4, name: 'Other' })];
  const bound = gh(dir, ciRoutes([...noise, run()], [checkRun({ check_suite: { id: 99 }, conclusion: 'failure' }), checkRun()]));
  bound.port.primeCi(REPO, BRANCH, B);
  assert.deepEqual(bound.port.observeCi(REPO, BRANCH, B), { repository: REPO, branch: BRANCH, sha: B, workflowStatus: 'SUCCESS',
    requiredCheckName: 'test', requiredCheckStatus: 'SUCCESS', observedAt: T });
  const onlyOthers = gh(dir, ciRoutes(noise, [checkRun()]));
  assert.throws(() => onlyOthers.port.primeCi(REPO, BRANCH, B), /No CI run for exactly/);
  const otherApp = gh(dir, ciRoutes([run()], [checkRun({ app: { id: 1 } })]));
  assert.throws(() => otherApp.port.primeCi(REPO, BRANCH, B), /missing/);
  assert.throws(() => bound.port.observeCi(REPO, BRANCH, C), /not observed/);
}));
check('pending stays pending, failure stays failure, and missing or ambiguous CI fails closed', withDir((dir) => {
  const status = (runs, checks) => { const { port } = gh(dir, ciRoutes(runs, checks)); port.primeCi(REPO, BRANCH, B); return port.observeCi(REPO, BRANCH, B); };
  assert.equal(status([run({ status: 'in_progress', conclusion: null })], [checkRun()]).workflowStatus, 'PENDING');
  assert.equal(status([run()], [checkRun({ status: 'queued', conclusion: null })]).requiredCheckStatus, 'PENDING');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'action_required']) {
    assert.equal(status([run({ conclusion })], [checkRun({ conclusion })]).workflowStatus, 'FAILURE', conclusion);
  }
  assert.throws(() => gh(dir, ciRoutes([], [checkRun()])).port.primeCi(REPO, BRANCH, B), /No CI run/);
  assert.throws(() => gh(dir, ciRoutes([run(), run({ id: 9 })], [checkRun()])).port.primeCi(REPO, BRANCH, B), /Ambiguous/);
  assert.throws(() => gh(dir, ciRoutes([run()], [])).port.primeCi(REPO, BRANCH, B), /missing/);
  assert.throws(() => gh(dir, ciRoutes([run()], [checkRun(), checkRun()])).port.primeCi(REPO, BRANCH, B), /Ambiguous/);
}));
check('protection is read exactly; a refused or failed read is never a protection fact', withDir((dir) => {
  const read = (status, body) => { const { port } = gh(dir, () => [status, body]); port.primeProtection(REPO, 'main'); return port.observeProtection(REPO, 'main'); };
  assert.deepEqual(read(200, { required_status_checks: { contexts: ['test'] } }), { repository: REPO, branch: 'main', protected: true, requiredChecks: ['test'], observedAt: T });
  assert.deepEqual(read(200, {}).requiredChecks, []);
  assert.equal(read(404, { message: 'Branch not protected' }).protected, false);
  for (const [status, body] of [[403, { message: 'Resource not accessible by integration' }], [401, { message: 'Bad credentials' }],
    [404, { message: 'Not Found' }], [500, { message: 'error' }], [200, '{broken']]) {
    assert.throws(() => gh(dir, () => [status, body]).port.primeProtection(REPO, 'main'), undefined, String(status));
  }
}));
check('every GitHub command is one read-only GET; bad names and other repositories never reach gh', withDir((dir) => {
  const { port, calls } = gh(dir, (path) => path.includes('git/ref') ? ref(BRANCH, B) : path.includes('compare')
    ? [200, { base_commit: { sha: A }, merge_base_commit: { sha: A }, ahead_by: 1, behind_by: 0, total_commits: 1, commits: [{ sha: B }] }]
    : path.includes('protection') ? [200, { required_status_checks: { contexts: ['test'] } }] : ciRoutes([run()], [checkRun()])(path));
  port.primeBranch(REPO, BRANCH); port.primeComparison(REPO, A, B); port.primeCi(REPO, BRANCH, B); port.primeProtection(REPO, 'main');
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 4), ['api', '--method', 'GET', '--include']);
    assert.equal(call.args.length, 5);
    assert.doesNotMatch(call.args.join(' '), /POST|PATCH|PUT|DELETE|--field|-f |-F |--input|--raw-field/);
  }
  const before = calls.length;
  for (const branch of ['../main', 'a b', 'x;rm', '/abs', 'trailing/', 'a//b']) assert.throws(() => port.primeBranch(REPO, branch), undefined, branch);
  assert.throws(() => port.primeBranch('other/repo', BRANCH), /one configured repository/);
  assert.throws(() => port.primeCi(REPO, BRANCH, 'nope'));
  assert.equal(calls.length, before);
  const malformed = gh(dir, () => [200, '{"ref":']);
  assert.throws(() => malformed.port.primeBranch(REPO, BRANCH), /malformed JSON/);
}));

// ---------------------------------------------------------------- composition
function config(dir, overrides = {}) {
  return { repository: REPO, controllerStoreDirectory: join(dir, 'store'), journalDirectory: join(dir, 'journal'),
    environment: { allow: ['PATH', 'HOME'] }, claude: CLAUDE, codex: CODEX,
    git: { executable: 'git', remote: 'origin', repositoryPath: join(dir, 'repo'), worktreeRoot: join(dir, 'worktrees'), timeoutMs: 60_000,
      maxOutputBytes: 1_000_000, commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' }, validationTimeoutMs: 60_000,
      validationMaxOutputBytes: 1_000_000, linkedDirectories: [] },
    offlineValidation: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' },
    github: { executable: 'gh', workflowName: 'CI', requiredCheckName: 'test', requiredCheckAppId: 15368, timeoutMs: 10_000,
      maxOutputBytes: 1_000_000, maxObservationAgeMs: 60_000 },
    liveCallAuthorizations: { IMPLEMENTATION: grant('IMPLEMENTATION'), ARCHITECT_REVIEW: grant('ARCHITECT_REVIEW') }, ...overrides };
}
function grant(kind) {
  const scope = kind === 'IMPLEMENTATION' ? CLAUDE : CODEX;
  return { authorizationId: `auth-live-${kind.toLowerCase()}`, actorRole: 'HUMAN', operation: 'LIVE_PROVIDER_MODEL_CALL', target: scope.destination,
    runId: 'run-1', packetId: 'packet-1', scope: { provider: scope.provider, model: scope.model, destination: scope.destination }, issuedAt: T,
    reason: 'GRANT-TEXT-SENTINEL fresh human authorization' };
}
check('composition refuses implicit, aliased, or secret-bearing configuration', withDir((dir) => {
  const deps = { clock, environmentSource: { PATH: '/bin', HOME: dir, OPENAI_API_KEY: 'sk-x' }, executor: { run() { throw new Error('ran'); } },
    syncExecutor: { runSync() { throw new Error('ran'); } } };
  for (const bad of [config(dir, { claude: { ...CLAUDE, model: 'opus' } }), config(dir, { codex: { ...CODEX, model: 'latest' } }),
    config(dir, { environment: { allow: ['PATH', 'OPENAI_API_KEY'] } }), config(dir, { environment: { allow: ['GH_TOKEN'] } }),
    { ...config(dir), apiKey: 'sk-x' }, config(dir, { claude: { ...CLAUDE, maxTurns: 0 } }),
    config(dir, { claude: { ...CLAUDE, timeoutMs: Number.POSITIVE_INFINITY } }), config(dir, { claude: { ...CLAUDE, fallbackModel: 'x' } }),
    config(dir, { git: { ...config(dir).git, repositoryPath: 'relative' } }), config(dir, { claude: { ...CLAUDE, exposeValidationCommands: true } }),
    config(dir, { offlineValidation: { runtimeReadPaths: ['relative'], searchPath: '/usr/bin' } }), config(dir, { offlineValidation: undefined })]) {
    assert.throws(() => createLiveAutomation(bad, deps));
  }
  const { claude, ...missing } = config(dir);
  assert.throws(() => createLiveAutomation(missing, deps));
}));
check('importing and composing the live automation starts no process', withDir((dir) => {
  mkdirSync(join(dir, 'repo'));
  const script = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    let started = 0;
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      const original = cp[name]; cp[name] = (...args) => { started += 1; return original(...args); };
    }
    syncBuiltinESMExports();
    const { createLiveAutomation } = await import(${JSON.stringify(new URL('./dist/automation/live/composition.js', import.meta.url).href)});
    let live, refused;
    try { live = createLiveAutomation(${JSON.stringify(config(dir))}, { clock: { now: () => ${JSON.stringify(T)} }, environmentSource: { PATH: '/bin', HOME: ${JSON.stringify(dir)} } }); }
    catch (error) { refused = error.message; }
    process.stdout.write(JSON.stringify({ started, refused, frozen: live && Object.isFrozen(live), keys: live && Object.keys(live).sort() }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.started, 0);
  // Composition needs the production validation boundary; where it is missing, nothing is composed.
  if (sandboxAvailable) assert.deepEqual(outcome, { started: 0, frozen: true, keys: ['controller', 'journal', 'reality', 'runner'] });
  else assert.match(outcome.refused, /isolation \(macOS Seatbelt\) is unavailable/);
}));
check('without the Seatbelt boundary there is no fallback: composition refuses', withDir((dir) => {
  mkdirSync(join(dir, 'repo'));
  let ran = 0;
  const deps = { clock, environmentSource: { PATH: '/bin', HOME: dir }, executor: { async run() { ran += 1; } }, syncExecutor: { runSync() { ran += 1; } } };
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.throws(() => createLiveAutomation(config(dir), { ...deps, platform }), /isolation \(macOS Seatbelt\) is unavailable/, platform);
  }
  assert.equal(ran, 0);
}));
check('an offline run through the full live composition reaches ACCEPTED with SHA truth from GitHub', withDir(async (dir) => {
  mkdirSync(join(dir, 'repo'));
  mkdirSync(join(dir, 'worktrees'));
  const w = world(dir, { reviewHead: B });
  const github = { calls: [], runSync(request) {
    parseProcessRequest(request);
    this.calls.push(request);
    const sha = w.state.remote[BRANCH];
    const body = sha ? { ref: `refs/heads/${BRANCH}`, object: { sha, type: 'commit' } } : { message: 'Not Found' };
    return { outcome: 'EXITED', exitCode: sha ? 0 : 1, signal: null, durationMs: 1, stderr: '',
      stdout: `HTTP/2.0 ${sha ? 200 : 404} X\n\n${JSON.stringify(body)}` };
  } };
  const live = createLiveAutomation(config(dir), { clock, environmentSource: { PATH: process.env.PATH, HOME: dir, OPENAI_API_KEY: 'sk-never' },
    executor: w.executor, syncExecutor: github, offlineValidation: w.validation });
  assert.equal(w.calls.length + github.calls.length, 0);
  live.controller.createRun('run-1', 'slice-1', REPO);
  live.controller.enterArchitecture('run-1', { id: 'architect', role: 'GPT_ARCHITECT' });
  live.controller.issuePacket('run-1', { id: 'architect', role: 'GPT_ARCHITECT' }, packet());
  const result = await live.runner.drive('run-1', 12);
  assert.deepEqual([result.outcome, result.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  const run = live.controller.get('run-1');
  assert.deepEqual([run.remoteSha.sha, run.acceptance.reviewedSha], [B, B]);
  assert.deepEqual(live.journal.list('run-1').map((record) => [record.identity.actorKind, record.state]).sort(),
    [['ARCHITECT_REVIEW', 'APPLIED'], ['IMPLEMENTATION', 'APPLIED']]);
  assert.deepEqual([w.named('claude').length, w.named('codex').length, w.named('git', 'push').length, w.validations.length], [1, 1, 1, 2]);
  assert.ok(github.calls.length >= 3 && github.calls.every((call) => call.args[2] === 'GET'));
  assert.ok(w.calls.every((call) => !('OPENAI_API_KEY' in call.env)));
  const stored = readdirSync(join(dir, 'journal')).map((name) => readFileSync(join(dir, 'journal', name), 'utf8')).join('\n');
  assert.doesNotMatch(stored, /GRANT-TEXT-SENTINEL|sk-never/);
}));
check('live production sources carry no bypass, force, main push, secret literal, or logging', () => {
  const sources = ['process-executor.ts', 'invocation-journal.ts', 'file-invocation-journal.ts', 'runner.ts', 'offline-validation.ts',
    'live/common.ts', 'live/seatbelt-validation.ts',
    'live/claude-code-implementation.ts', 'live/codex-architect-review.ts', 'live/github-cli-reality.ts', 'live/composition.ts']
    .map((name) => [name, readFileSync(`src/automation/${name}`, 'utf8')]);
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /--dangerously|dangerously-skip|bypassPermissions|--full-auto|workspace-write|danger-full-access/, name);
    assert.doesNotMatch(source, /--force|force-with-lease|\+refs\/|\+HEAD|refs\/heads\/main|push[^\n]*['"`]main/, name);
    assert.doesNotMatch(source, /console\.|process\.stdout|process\.stderr|sk-[A-Za-z0-9]{8}|ghp_|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN/, name);
    assert.doesNotMatch(source, /shell:\s*true|bash -lc|\beval\(|--fallback-model|--oss/, name);
  }
  const composition = readFileSync('src/automation/live/composition.ts', 'utf8');
  assert.equal(composition.match(/createLiveAutomation\(/g).length, 1);
});

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
