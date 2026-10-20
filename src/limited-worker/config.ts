import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseAuthorization } from '../automation/policy.js';

const copies = z.strictObject({ schemaVersion: z.literal(1), liveCallGrant: z.unknown(), limitedGrant: z.unknown() });
/** These are operational copies, never an import or issuance to the Authority Archive. */
export function loadGrantCopies(path: string | undefined) {
  if (!path) return { liveCallGrant: null, limitedGrant: null };
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > 32768 || (s.mode & 0o077) || process.getuid && s.uid !== process.getuid()) throw new Error('GRANT_COPY_FILE_UNSAFE');
    const raw = copies.parse(JSON.parse(readFileSync(fd, 'utf8')));
    const liveCallGrant = parseAuthorization(raw.liveCallGrant), limitedGrant = parseAuthorization(raw.limitedGrant);
    if (liveCallGrant?.actorRole !== 'HUMAN' || liveCallGrant.operation !== 'LIVE_PROVIDER_MODEL_CALL' || limitedGrant?.actorRole !== 'HUMAN' || limitedGrant.operation !== 'LIMITED_README_WORKER') throw new Error('GRANT_COPY_INVALID');
    return { liveCallGrant, limitedGrant };
  } finally { closeSync(fd); }
}
