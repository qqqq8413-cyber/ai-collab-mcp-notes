import { authorityBodyHash, parseAuthorityDocument, sealAuthorityRecord, type JsonObject } from '../automation/authority/document.js';
import { contractOf, hash, SCOPE, checkQuote, packetFor, parseContract, inputFacts, type Contract } from './contract.js';
import type { GovernedActivationCore } from '../automation/activation-core.js';
import { packetHash } from '../automation/packet.js';
import type { WorkerStore } from './store.js';
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

/** Trusted-host integration candidate. No writer factory, dispatch, credential or Workspace route. */
export function limitedActivationCandidate(options: {
  core: GovernedActivationCore; store: WorkerStore; readModel(): GovernedReadModelV1;
  humanPrincipalRef: string; architectPrincipalRef: string; now(): string;
  identity(): { sha: string; codeHash: string; clean: boolean };
  readSource(c: Contract): { sha: string; path: string; text: string };
  readGoal(c: Contract): string;
}) {
  return Object.freeze({ stage(id: string, rawBundle: unknown, rawLimitedDocument: unknown) {
    const job=options.store.read().jobs.find(j=>j.id===id);
    if(!job||job.state!=='PREPARED'||job.generationClaimed||job.reservedMicroUsd)throw new Error('ACTIVATION_JOB_NOT_PREPARED');
    const c=parseContract(job.contract),identity=options.identity();
    if(!identity.clean||identity.sha!==c.implementationSha||identity.codeHash!==c.workerCodeHash)throw new Error('ACTIVATION_IMPLEMENTATION_CHANGED');
    if(c.inputPolicy?.revision!=='A2'||c.inputPolicy.decision!=='A2_D1_STRICT_4096')throw new Error('ACTIVATION_POLICY_REPLAN_REQUIRED');
    const source=options.readSource(c);
    if(source.sha!==c.sourceSha||source.path!==c.sourcePath||options.store.identity()!==c.storageIdentity)throw new Error('ACTIVATION_SOURCE_OR_STORAGE_CHANGED');
    inputFacts(c,options.readGoal(c),source.text);checkQuote(c.quote,options.now());
    if(!rawBundle||typeof rawBundle!=='object'||Array.isArray(rawBundle))throw new Error('ACTIVATION_BUNDLE_INVALID');
    const b=rawBundle as Record<string,unknown>;
    if(Object.keys(b).sort().join(',')!=='implementationPacket,liveCallAuthorizations'||!Array.isArray(b.liveCallAuthorizations)||b.liveCallAuthorizations.length!==1)throw new Error('ACTIVATION_BUNDLE_INVALID');
    const packetDocument=parseAuthorityDocument(b.implementationPacket),liveDocument=parseAuthorityDocument(b.liveCallAuthorizations[0]),limitedDocument=parseAuthorityDocument(rawLimitedDocument);
    const target={source:{kind:'WORKSPACE_GOAL' as const,projectId:c.projectId,goalId:c.goalId},runId:c.runId};
    const position=options.core.inspect(target),packet=packetFor(c,position.change.changeId),model=options.readModel();
    if(position.repository!==c.repository||position.humanPrincipalRef!==options.humanPrincipalRef)throw new Error('ACTIVATION_TARGET_MISMATCH');
    if(packetDocument.kind!=='IMPLEMENTATION_PACKET'||packetDocument.issuer.role!=='GPT_ARCHITECT'||packetDocument.issuer.principalRef!==options.architectPrincipalRef||
      hash(packetDocument.body)!==hash(packet)||liveDocument.kind!=='AUTHORIZATION'||limitedDocument.kind!=='AUTHORIZATION')throw new Error('ACTIVATION_DOCUMENT_MISMATCH');
    // Only previously preserved, exact, current documents can reach the existing core.
    for(const doc of[packetDocument,liveDocument,limitedDocument]){
      const record=sealAuthorityRecord(doc),versions=model.authority.filter(f=>f.ref.kind===doc.kind&&f.ref.authorityId===doc.authorityId);
      if(!versions.some(f=>f.ref.recordHash===record.recordHash)||versions.some(f=>f.ref.version>doc.version)||Date.parse(doc.issuedAt)>Date.parse(options.now()))throw new Error('ACTIVATION_DOCUMENT_NOT_CURRENTLY_ARCHIVED');
    }
    verifyPermit(c,{grant:limitedDocument.body,liveGrant:liveDocument.body,model,packet,humanPrincipalRef:options.humanPrincipalRef,now:options.now()});
    const result=options.core.activate(target,{implementationPacket:packetDocument,liveCallAuthorizations:[liveDocument]});
    if(result.packet.packetHash!==packetHash(packet)||result.state!=='PACKET_READY')throw new Error('ACTIVATION_RESULT_MISMATCH');
    return {recordClass:'OPERATIONAL_RECORD' as const,stage:result,executionEligible:false as const,
      blockers:['EXE_HOLD','INPUT_LIMIT_DECISION_REQUIRED','H1_H9_NOT_GRANTED'],
      notice:'Staging archived documents is not execution authorization. No Driver or Worker was invoked.'};
  }});
}
