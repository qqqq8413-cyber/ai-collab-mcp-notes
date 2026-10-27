import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { constants, closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { M1_SIGNATURE_POLICY } from './activation-set.js';
import { CLASS_ACCEPTANCE_SCHEMA, WORKER_CLASS_SCHEMA, verifyRegistration } from './run-approval.js';
import { CLASS_DELEGATION_RULE } from './governance.js';

// M1-B one-time passkey enrollment, run by the Human:
//   npm run workspace:m1-passkey-enroll -- --out <absolute path> --human <principalRef> [--workspace-port 4876] [--port 4878]
// Open the printed http://localhost:<port>/ page, confirm with Touch ID (or the device PIN). The tool verifies the
// registration (user verification, RP ID localhost, the credential's own ES256 key) and writes an approver file
// draft (0600, never overwritten). The draft grants nothing: the Architect-accepted class hash and implementation
// SHA are placeholders that fail validation until the Human fills them in, and a live Host reads the file only when
// it is owned by root (`sudo chown root:wheel <file> && sudo chmod 644 <file>`). No private key leaves the device.

const PAGE = (port: number) => `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>CHIEF 通行金鑰登記</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;background:#0b0b0c;color:#eee}button{font:inherit;padding:10px 18px}</style>
<h1>CHIEF 通行金鑰登記</h1><p>這個通行金鑰只用來在 CHIEF 批准單一 Run。登記本身不授予任何權限。</p>
<button id="go">用 Touch ID 建立通行金鑰</button><p id="out" role="status"></p>
<script>
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const from=t=>Uint8Array.from(atob(t.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((t.length+3)%4)),c=>c.charCodeAt(0));
document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');
  try{if(location.origin!=='http://localhost:${port}')throw new Error('請從 http://localhost:${port}/ 開啟');
    const {challenge}=await (await fetch('/challenge')).json();
    const c=await navigator.credentials.create({publicKey:{challenge:from(challenge),rp:{id:'localhost',name:'CHIEF'},
      user:{id:crypto.getRandomValues(new Uint8Array(16)),name:'chief-human',displayName:'CHIEF Human'},
      pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{userVerification:'required',residentKey:'preferred'},attestation:'none',timeout:120000}});
    const r=c.response,body={credentialId:b64u(c.rawId),clientDataJSON:b64u(r.clientDataJSON),authenticatorData:b64u(r.getAuthenticatorData()),
      publicKeySpki:b64u(r.getPublicKey()),algorithm:r.getPublicKeyAlgorithm()};
    const res=await fetch('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    out.textContent=res.ok?'完成：'+(await res.json()).message:'失敗：'+(await res.text());
  }catch(e){out.textContent='沒有完成：'+(e&&e.message||e);}};
</script></html>`;

function main() {
  const args = process.argv.slice(2), allowed = ['--out', '--human', '--workspace-port', '--port'];
  if (args.length % 2 || new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2) throw new Error('INVALID_ARGS');
  for (let i = 0; i < args.length; i += 2) if (!allowed.includes(args[i]) || !args[i + 1]) throw new Error('INVALID_ARGS');
  const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const out = arg('--out'), human = arg('--human');
  if (!out || !isAbsolute(out) || resolve(out) !== out) throw new Error('OUT_MUST_BE_ABSOLUTE');
  if (!human || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(human)) throw new Error('HUMAN_PRINCIPAL_REQUIRED');
  const port = Number(arg('--port') ?? '4878'), workspacePort = Number(arg('--workspace-port') ?? '4876');
  for (const p of [port, workspacePort]) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('INVALID_PORT');
  const challenge = randomBytes(32), origin = `http://localhost:${port}`;
  let done = false;
  const server = createServer((req, res) => {
    const reply = (status: number, body: string, type = 'text/plain; charset=utf-8') => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (req.headers.host !== `localhost:${port}`) return reply(421, 'WRONG_HOST');
    if (req.method === 'GET' && req.url === '/') return reply(200, PAGE(port), 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/challenge') return reply(200, JSON.stringify({ challenge: challenge.toString('base64url') }), 'application/json');
    if (req.method !== 'POST' || req.url !== '/register' || req.headers.origin !== origin || done) return reply(403, 'REFUSED');
    let raw = '';
    req.on('data', (b: Buffer) => { raw += b; if (raw.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const passkey = verifyRegistration(JSON.parse(raw), { challenge, rpId: 'localhost', origins: [origin] });
        const draft = { schemaVersion: 1, kind: 'CHIEF_LIVE_RUN_APPROVER', policy: M1_SIGNATURE_POLICY.version, humanPrincipalRef: human,
          passkey: { rpId: passkey.rpId, origins: [`http://localhost:${workspacePort}`], credentialId: passkey.credentialId, publicKeySpki: passkey.publicKeySpki, algorithm: passkey.algorithm },
          // M1-R1: the standing ARCHITECT_CLASS_ACCEPTANCE record. Every FILL_IN value fails validation, so the draft grants nothing.
          architectAcceptance: { schema: CLASS_ACCEPTANCE_SCHEMA, recordClass: 'ARCHITECT_CLASS_ACCEPTANCE', delegationRule: CLASS_DELEGATION_RULE,
            architectPrincipalRef: 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE', agentId: 'limited-readme-worker', classSchema: WORKER_CLASS_SCHEMA,
            classHash: 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE', implementationSha: 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE', acceptanceVersion: 1, supersedes: null,
            source: { kind: 'ARCHITECT_REVIEW_DECISION', reviewRef: 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE', decisionSha256: 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE' },
            acceptedAt: 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE' }, approvalValiditySeconds: 600 };
        const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, JSON.stringify(draft, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
        done = true;
        console.log(`passkey enrolled: keyId ${passkey.keyId}; draft written to ${out} (fill architectAcceptance, then chown root)`);
        reply(200, JSON.stringify({ message: `已寫入設定草稿；keyId ${passkey.keyId.slice(0, 16)}…` }), 'application/json');
        setTimeout(() => server.close(), 200);
      } catch (error) { reply(400, error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'REGISTRATION_REFUSED'); }
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`CHIEF passkey enrollment: http://localhost:${port}/ | grants nothing; writes a draft to ${out}`));
}
try { main(); } catch (error) { console.error(error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'ENROLL_START_FAILED'); process.exit(1); }
