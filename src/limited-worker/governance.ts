import { authorityBodyHash, type JsonObject } from '../automation/authority/document.js';
import { contractOf, hash, SCOPE, checkQuote, type Contract } from './contract.js';
import { parseAuthorization, authorizationBinds } from '../automation/policy.js';
import type { GovernedReadModelV1 } from '../automation/read-model/governed-read-model.js';
import type { ControllerRun, ImplementationPacket } from '../automation/types.js';
import type { InvocationRecord } from '../automation/invocation-journal.js';

export function verifyPermit(c: Contract, input: { grant: unknown; liveGrant: unknown; model: GovernedReadModelV1; packet: ImplementationPacket;
  humanPrincipalRef: string; now: string }) {
  const { packet, model } = input, grant = parseAuthorization(input.grant), now = Date.parse(input.now);
  if (hash(contractOf(packet)) !== hash(c)) throw new Error('CONTRACT_PACKET_MISMATCH');
  const run = model.runs.find(r => r.runId === c.runId);
  if (!run || run.repository !== c.repository || run.sliceId !== packet.sliceId || run.anomalies.length || model.anomalies.length) throw new Error('RUN_BINDING_MISMATCH');
  const verify = (raw: unknown, operation: string, target: string) => {
    const parsed = parseAuthorization(raw);
    if (!parsed || !authorizationBinds(parsed, { role: 'HUMAN', operation, target, runId: c.runId, packetId: packet.packetId, scope: SCOPE }) ||
      !parsed.expiresAt || Date.parse(parsed.issuedAt) > now || Date.parse(parsed.expiresAt) <= now || Date.parse(parsed.expiresAt) - Date.parse(parsed.issuedAt) > 3600000) throw new Error('LIMITED_PERMIT_NOT_BOUND_OR_EXPIRED');
    const versions = model.authority.filter(f => f.ref.kind === 'AUTHORIZATION' && f.ref.authorityId === parsed.authorizationId);
    const facts = versions.filter(f => f.bodyHash === authorityBodyHash(parsed as unknown as JsonObject));
    if (facts.length !== 1 || facts[0].issuer.role !== 'HUMAN' || facts[0].issuer.principalRef !== input.humanPrincipalRef ||
      facts[0].subject.repository !== c.repository || facts[0].subject.sliceId !== packet.sliceId ||
      versions.some(v => v.ref.version > facts[0].ref.version)) throw new Error('LIMITED_PERMIT_NOT_ARCHIVED_OR_SUPERSEDED');
    return facts[0].ref;
  };
  verify(input.liveGrant, 'LIVE_PROVIDER_MODEL_CALL', 'live-provider-model-call');
  const ref = verify(grant, 'LIMITED_README_WORKER', hash(c));
  checkQuote(c.quote, input.now); return ref;
}
export function verifyInvocation(c: Contract, packet: ImplementationPacket, run: ControllerRun, record: InvocationRecord | undefined) {
  const last = run.audit.at(-1);
  if (run.runId !== c.runId || run.repository !== c.repository || run.state !== 'IMPLEMENTING' || run.implementationIterations !== 1 ||
    !last || last.action !== 'BEGIN_IMPLEMENTATION' || !record || record.state !== 'STARTED' || record.identity.runId !== c.runId ||
    record.identity.packetId !== packet.packetId || record.identity.packetHash !== run.activePacketHash ||
    record.identity.actorKind !== 'IMPLEMENTATION' || record.identity.provider !== SCOPE.provider || record.identity.model !== SCOPE.model ||
    JSON.stringify(record.identity.egressDestinations) !== JSON.stringify(SCOPE.egressDestinations) ||
    record.identity.occurrence.sequence !== last.sequence || record.identity.occurrence.timestamp !== last.timestamp ||
    record.identity.occurrence.action !== last.action || hash(contractOf(packet)) !== hash(c)) throw new Error('INVOCATION_NOT_GOVERNED');
}
