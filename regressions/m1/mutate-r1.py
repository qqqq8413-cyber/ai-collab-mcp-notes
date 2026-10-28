# M1-R1 fault injection: apply one mutation to compiled dist JS, run the named suites, restore. Expect >=1 FAIL per
# mutation, except entries marked REDUNDANT (a second layer covers the same property; reported, not counted as a miss).
# Run from anywhere after `npm run build`: python3 -u regressions/m1/mutate-r1.py [MR1 MR2 ...]
import subprocess, sys, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
R = lambda only: ('test-m1-r1-provenance.mjs', 'M1R1_ONLY', only)
G = ('test-governed-activation.mjs', None, None)
S = ('test-auto-p2-a4-s1.mjs', 'S1_ONLY', 'S1-M1R1')
M = ('test-m1-real-task-activation.mjs', None, None)
T = ('test-goal-execution-status.mjs', None, None)
M_ = [
 # R-1: the record class in the Authority Archive envelope
 ('MR1 activation core admits a derived packet without the rule', 'dist/automation/activation-core.js', "if (packetDocument.recordClass !== 'DIRECT_AUTHORITY') {", 'if (false) {', [G]),
 ('MR2 derived record need not carry a derivation', 'dist/automation/authority/document.js', 'if (derived !== (document.derivation !== undefined))', 'if (false)', [R('R-1 record')]),
 ('MR3 grants or later versions may be derived', 'dist/automation/authority/document.js', "if (derived && (document.kind !== 'IMPLEMENTATION_PACKET' || document.version !== 1))", 'if (false)', [R('R-1 record')]),
 ('MR4 provenance check passes a derived record without the rule', 'dist/limited-worker/governance.js',
  "if (record.recordClass !== 'CLASS_DERIVED_AUTHORITY' || !record.derivation || !classDelegation)\n        throw new Error(code);",
  "if (record.recordClass !== 'CLASS_DERIVED_AUTHORITY' || !record.derivation || !classDelegation)\n        return;", [R('R-1 governance'), S]),
 ('MR5 staging skips the provenance check', 'dist/limited-worker/governance.js', "verifyPacketProvenance(packetDocument, packet, options.classDelegation, 'ACTIVATION_PACKET_DERIVED_WITHOUT_DELEGATION');", '', [S]),
 ('MR6 verifyPermit skips the provenance check', 'dist/limited-worker/governance.js', "verifyPacketProvenance({ ...exact[0], version: exact[0].ref.version }, packet, input.classDelegation, 'PACKET_AUTHORITY_DERIVED_WITHOUT_DELEGATION');", '', [R('R-1 governance')]),
 ('MR7 run packet drafted as direct authority', 'dist/limited-worker/governance.js', "recordClass: kind === 'IMPLEMENTATION_PACKET' ? 'CLASS_DERIVED_AUTHORITY' : 'DIRECT_AUTHORITY'", "recordClass: 'DIRECT_AUTHORITY'", [R('R-1 record')]),
 # R-1: the explicit class-delegation rule
 ('MR8 rule ignores the issuer and version', 'dist/limited-worker/run-approval.js', "if (record.version !== 1 || record.issuer.role !== 'GPT_ARCHITECT' || record.issuer.principalRef !== a.architectPrincipalRef)", 'if (false)', [R('R-1 class-delegation')]),
 ('MR9 rule ignores which acceptance', 'dist/limited-worker/run-approval.js', " || d.acceptanceHash !== pinned)", ')', [R('R-1 class-delegation')]),
 ('MR10 rule ignores the class', 'dist/limited-worker/run-approval.js', 'if (d.classHash !== a.classHash || workerClassHash(c) !== a.classHash)', 'if (false)', [R('R-1 class-delegation')]),
 ('MR11 rule ignores the implementation SHA', 'dist/limited-worker/run-approval.js', 'if (d.implementationSha !== a.implementationSha || c.implementationSha !== a.implementationSha)', 'if (false)', [R('R-1 class-delegation')]),
 ('MR12 rule accepts a packet that is not exactly packetFor(its contract)', 'dist/limited-worker/run-approval.js',
  "catch {\n            return fail('DELEGATION_PACKET_NOT_DERIVED');\n        }", 'catch {\n            c = JSON.parse(packet.objective);\n        }', [R('R-1 class-delegation')]),
 # The standing acceptance record: source and version binding
 ('MR13 acceptance hash not domain separated', 'dist/limited-worker/run-approval.js', 'sha256(CLASS_ACCEPTANCE_DOMAIN + canonical(parsed.data))', 'sha256(canonical(parsed.data))', [R('R-1 standing')]),
 ('MR14 acceptance version chain not enforced', 'dist/limited-worker/run-approval.js', ".refine((a) => (a.acceptanceVersion === 1) === (a.supersedes === null), { message: 'ACCEPTANCE_VERSION_CHAIN' })", '', [R('R-1 standing')]),
 # Passkey approval: replay and substitution
 ('MR15 attestation ignores the pinned acceptance', 'dist/limited-worker/run-approval.js', ' ||\n            p.acceptanceHash !== approver.acceptanceHash)', ')', [R('WebAuthn replay')]),
 ('MR16 approval record copied to another job accepted', 'dist/limited-worker/run-approval.js', 'if (record.jobId !== jobId)', 'if (false)', [R('WebAuthn replay')]),
 ('MR17 approval binding ignores the derived record and acceptance fields', 'dist/limited-worker/live-runtime.js',
  "payload.packetRecordClass !== 'CLASS_DERIVED_AUTHORITY' || payload.packetRecordHash !== recordHashOf(documents[0]) || payload.acceptanceHash !== approver.acceptanceHash ||", '',
  [R('LIFT build: substituting')], 'REDUNDANT: setHash names the derived packet record, whose hash covers the derivation and acceptance hash'),
 # EXE HOLD and provider distinction
 ('MR18 runtime trusts the service for EXE HOLD', 'dist/limited-worker/live-runtime.js',
  ("if (EXE === 'HOLD')\n                fail('EXE_HOLD');\n            const a = eligible(c), job", "if (EXE === 'HOLD')\n                fail('EXE_HOLD');\n            const a = eligible(c);"),
  ('const a = eligible(c), job', 'const a = eligible(c);'), [R('HOLD copy')]),
 ('MR19 fake provider labelled as the public API', 'dist/limited-worker/transport.js', "const endpoint = options.requester ? 'INJECTED_TEST_REQUESTER' : 'ANTHROPIC_PUBLIC_API';", "const endpoint = 'ANTHROPIC_PUBLIC_API';", [M]),
 ('MR20 fake provider metadata counted as the account', 'dist/limited-worker/service.js', ": j.providerEndpoint === 'ANTHROPIC_PUBLIC_API' ? 'ACCOUNT_METADATA_VERIFIED' : 'TEST_REQUESTER_NOT_ACCOUNT',", ": 'ACCOUNT_METADATA_VERIFIED',", [M]),
 ('MR21 status view shows a derived packet as direct authority', 'dist/intake/goal-execution-status-bridge.js',
  "const classOf = (ref) => model.authority.find((fact) => fact.ref.recordHash === ref.recordHash)?.recordClass ?? 'DIRECT_AUTHORITY';", "const classOf = (ref) => 'DIRECT_AUTHORITY';", [T]),
]
only = set(sys.argv[1:])
ok = True
for entry in M_:
    name, path, old, new, suites = entry[:5]
    redundant = entry[5] if len(entry) > 5 else None
    if only and name.split()[0] not in only: continue
    pairs = list(zip(old, new)) if isinstance(old, tuple) else [(old, new)]
    src = open(path).read()
    if any(src.count(o) != 1 for o, _ in pairs): print(f'{name}: ANCHOR NOT UNIQUE ({[src.count(o) for o, _ in pairs]})'); ok = False; continue
    mutated = src
    for o, n in pairs: mutated = mutated.replace(o, n)
    open(path, 'w').write(mutated)
    fails, summaries = [], []
    try:
        for script, var, prefix in suites:
            env = dict(os.environ, **({var: prefix} if var else {}))
            r = subprocess.run(['node', script], capture_output=True, text=True, timeout=900, env=env)
            fails += [l.strip()[:110] for l in (r.stdout + r.stderr).splitlines() if l.strip().startswith('FAIL ')]
            s = [l for l in r.stdout.splitlines() if 'passed,' in l]
            summaries.append(f'{script}{"[" + prefix + "]" if prefix else ""}: {s[-1] if s else "(no summary, exit %s)" % r.returncode}')
    finally:
        open(path, 'w').write(src)
    verdict = 'CAUGHT' if fails else ('NOT CAUGHT (REDUNDANT: ' + redundant.split(': ', 1)[1] + ')' if redundant else 'NOT CAUGHT')
    print(f'{name}: {verdict} | ' + ' | '.join(summaries))
    for f in fails[:3]: print('    ' + f)
    ok = ok and (bool(fails) or bool(redundant))
print('ALL MUTATIONS CAUGHT (REDUNDANT ones reported)' if ok else 'SOME MUTATION NOT CAUGHT')
