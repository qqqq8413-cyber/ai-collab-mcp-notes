# S1 fault injection: apply one mutation to compiled dist JS, run the S1 suite, restore. Expect >=1 FAIL per mutation.
import subprocess, sys, os
# Run from anywhere after `npm run build`: python3 regressions/auto-p2-a4-p0-s1/mutate.py
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
M = [
 ('M1 takeover skips nonce re-check', 'dist/limited-worker/store.js', 'if (current?.nonce !== prior.nonce) {', 'if (false) {'),
 ('M2 takeover token not exclusive', 'dist/limited-worker/store.js', "tokenFd = openSync(token, 'wx', 0o600);", "tokenFd = openSync(token, 'w', 0o600);"),
 ('M3 PID liveness ignored', 'dist/limited-worker/store.js', 'if (!prior || alive(prior.pid))', 'if (!prior)'),
 ('M4 release ignores nonce', 'dist/limited-worker/store.js', 'if (current?.nonce === nonce)', 'if (current)'),
 ('M5 write.lock auto-removed', 'dist/limited-worker/store.js', "throw new Error('WORKER_STORE_WRITE_LOCK_HELD');", "{ unlinkSync(lock); return this.update(fn); }"),
 ('M6 worker skips set check', 'dist/limited-worker/adapter.js', "if (d.requireActivationSet || d.transport.kind === 'LIVE_PROVIDER') {", 'if (false) {'),
 ('M7 member need not be archived', 'dist/limited-worker/activation-set.js', 'if (exact.length !== 1)', 'if (false)'),
 ('M8 member need not be current', 'dist/limited-worker/activation-set.js', 'if (versions.some((fact) => fact.ref.version > exact[0].ref.version))', 'if (false)'),
 ('M9 publish ignores conflict', 'dist/limited-worker/activation-set.js', 'if (existing.setHash !== setHash)', 'if (false)'),
 ('M10 verify skips stored hash', 'dist/limited-worker/activation-set.js', "if (stored.setHash !== setHash || activationSetHash(stored.set) !== setHash)", 'if (false)'),
]
ok = True
for name, path, old, new in M:
    src = open(path).read()
    if src.count(old) != 1: print(f'{name}: ANCHOR NOT UNIQUE ({src.count(old)})'); ok = False; continue
    open(path, 'w').write(src.replace(old, new))
    try:
        r = subprocess.run(['node', 'test-auto-p2-a4-s1.mjs'], capture_output=True, text=True, timeout=600)
    finally:
        open(path, 'w').write(src)
    fails = [l.strip()[:110] for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith('FAIL ')]
    summary = [l for l in r.stdout.splitlines() if 'passed,' in l]
    print(f'{name}: {"CAUGHT" if fails else "NOT CAUGHT"} {summary[-1] if summary else "(no summary, exit %s)" % r.returncode}')
    for f in fails[:4]: print('    ' + f)
    ok = ok and bool(fails)
print('ALL MUTATIONS CAUGHT' if ok else 'SOME MUTATION NOT CAUGHT')
