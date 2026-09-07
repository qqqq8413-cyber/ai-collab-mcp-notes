/** Independent Python JSON-parser cross-check of raw-to-parsed preservation. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const candidates = JSON.parse(fs.readFileSync(path.join(DIR, 'CANDIDATES.json'), 'utf8')).candidates;
const sessions = JSON.parse(fs.readFileSync(path.join(DIR, 'SESSIONS.json'), 'utf8')).sessions;
const python = String.raw`
import json, re, sys
raw = sys.stdin.read()
trimmed = raw.strip()
m = re.fullmatch(r'\x60\x60\x60(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n\x60\x60\x60', trimmed, re.I)
payload = m.group(1) if m else trimmed
entries = json.loads(payload)
print(json.dumps([{'stratum': e['stratum'], 'text': e['text']} for e in entries], ensure_ascii=False))
`;

let checked = 0;
const problems = [];
for (const session of sessions) {
  if (session.outcome !== 'RESPONSE_PRESERVED') continue;
  const raw = fs.readFileSync(path.join(DIR, 'raw', `${session.actualAuthorSessionId}.txt`), 'utf8');
  const parsed = JSON.parse(execFileSync('python3', ['-c', python], { input: raw, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }));
  const expected = candidates.filter((candidate) => candidate.actualAuthorSessionId === session.actualAuthorSessionId);
  if (parsed.length !== expected.length) problems.push(`${session.actualAuthorSessionId}: count differs`);
  parsed.forEach((entry, index) => {
    const candidate = expected.find((item) => item.indexInResponse === index);
    if (!candidate || candidate.stratumDeclaredByAuthor !== entry.stratum || candidate.taskText !== entry.text
        || candidate.taskSha256 !== sha256(entry.text) || candidate.taskBytes !== Buffer.byteLength(entry.text, 'utf8')) {
      problems.push(`${session.actualAuthorSessionId}[${index}]: preservation mismatch`);
    } else checked += 1;
  });
}
const result = {
  implementation: 'independent Python standard-library JSON parser and hashlib-equivalent Node SHA recomputation',
  checked,
  extractedCandidatesExpected: candidates.length,
  acquisitionCandidatesExpected: 60,
  extractedRawToParsedPreservation: problems.length === 0 && checked === candidates.length
    ? `${checked}/${candidates.length}` : 'FAILED',
  acquisitionStatus: checked === 60 ? '60/60' : `INCOMPLETE_${checked}_OF_60`,
  problems,
};
fs.writeFileSync(path.join(DIR, 'CROSS_CHECK.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exit(result.extractedRawToParsedPreservation === `${candidates.length}/${candidates.length}` ? 0 : 1);
