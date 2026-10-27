import { authorityBodyHash, parseAuthorityDocument, sealAuthorityRecord, type AuthorityDocumentV1, type ClassDelegationVerifier, type ClassDerivationV1,
  type JsonObject } from '../automation/authority/document.js';
// M1-R1: the limited worker reaches the R4P document module only through this file (and activation-set.ts's body hash).
export { CLASS_DELEGATION_RULE, isAuthorityPrincipalRef, type ClassDelegationVerifier, type ClassDerivationV1 } from '../automation/authority/document.js';
import { contractOf, hash, SCOPE, checkQuote, packetFor, parseContract, inputFacts, type Contract } from './contract.js';
import type { GovernedActivationCore } from '../automation/activation-core.js';
import { packetHash } from '../automation/packet.js';
import type { WorkerStore } from './store.js';
import { parseAuthorization, authorizationBinds } from '../automation/policy.js';
import type { GovernedReadModelV1 } from '../automation/read-model/governed-read-model.js';
import type { ControllerRun, ImplementationPacket } from '../automation/types.js';
import type { InvocationRecord } from '../automation/invocation-journal.js';
import { liveEligibility, publishActivationSet, verifyActivationSet, type SignaturePolicyVersion } from './activation-set.js';

function boundGrant(raw:unknown,c:Contract,packet:ImplementationPacket,operation:string,target:string,now:string) {
  const grant=parseAuthorization(raw),at=Date.parse(now);
  if(!Number.isFinite(at)||!grant||!authorizationBinds(grant,{role:'HUMAN',operation,target,runId:c.runId,packetId:packet.packetId,scope:SCOPE})||
    !grant.expiresAt||Date.parse(grant.issuedAt)>at||Date.parse(grant.expiresAt)<=at||Date.parse(grant.expiresAt)-Date.parse(grant.issuedAt)>3600000)
    throw new Error('LIMITED_PERMIT_NOT_BOUND_OR_EXPIRED');
  return grant;
}
/**
 * M1-R1 (R-1): the packet's archived record class decides how it is verified. DIRECT_AUTHORITY: the Architect's own
 * document (unchanged check). CLASS_DERIVED_AUTHORITY: a Host-derived run packet, admitted only by the explicit
 * class-delegation rule; without one it is refused, whatever principal it states.
 */
export function verifyPacketProvenance(record: { recordClass: string; issuer: { role: string; principalRef: string }; derivation?: ClassDerivationV1; version: number },
  packet: ImplementationPacket, classDelegation: ClassDelegationVerifier | undefined, code: string): void {
  if (record.recordClass === 'DIRECT_AUTHORITY' && record.derivation === undefined) return;
  if (record.recordClass !== 'CLASS_DERIVED_AUTHORITY' || !record.derivation || !classDelegation) throw new Error(code);
  classDelegation({ issuer: record.issuer, derivation: record.derivation, version: record.version }, packet);
}
export function verifyPermit(c: Contract, input: { grant: unknown; liveGrant: unknown; model: GovernedReadModelV1; packet: ImplementationPacket;
  humanPrincipalRef: string; architectPrincipalRef:string; now: string; classDelegation?: ClassDelegationVerifier }) {
  const { packet, model } = input, grant = parseAuthorization(input.grant);
  if (hash(contractOf(packet)) !== hash(c)) throw new Error('CONTRACT_PACKET_MISMATCH');
  const run = model.runs.find(r => r.runId === c.runId);
  if (!run || run.repository !== c.repository || run.sliceId !== packet.sliceId || run.anomalies.length || model.anomalies.length) throw new Error('RUN_BINDING_MISMATCH');
  const packets=model.authority.filter(f=>f.ref.kind==='IMPLEMENTATION_PACKET'&&f.ref.authorityId===packet.packetId),
    exact=packets.filter(f=>f.bodyHash===authorityBodyHash(packet as unknown as JsonObject));
  if(exact.length!==1||exact[0].issuer.role!=='GPT_ARCHITECT'||exact[0].issuer.principalRef!==input.architectPrincipalRef||
    packets.some(f=>f.ref.version>exact[0].ref.version))throw new Error('PACKET_AUTHORITY_NOT_CURRENT');
  verifyPacketProvenance({ ...exact[0], version: exact[0].ref.version }, packet, input.classDelegation, 'PACKET_AUTHORITY_DERIVED_WITHOUT_DELEGATION');
  const verify = (raw: unknown, operation: string, target: string) => {
    const parsed = boundGrant(raw,c,packet,operation,target,input.now);
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

/**
 * M1-B / M1-R1: the three documents of one passkey-approved run, drafted deterministically from the approval window.
 * The packet is CLASS_DERIVED_AUTHORITY: derived from the contract (packetFor) under the Architect's standing class
 * acceptance, which its `derivation` names; its issuer is the accepting Architect principal as delegator, and it is
 * never filed as the Architect's direct authority. The two grants are the Human's (DIRECT_AUTHORITY), valid only inside
 * the window the Human signed. The trusted Host preserves them only after it verified the Human's assertion over a
 * payload that names all three exact record hashes and the acceptance hash; drafting alone writes and grants nothing.
 */
export function draftRunDocuments(c: Contract, packet: ImplementationPacket, input: { architectPrincipalRef: string; humanPrincipalRef: string;
  issuedAt: string; expiresAt: string; nonce: string; derivation: ClassDerivationV1 }): [AuthorityDocumentV1, AuthorityDocumentV1, AuthorityDocumentV1] {
  if (hash(contractOf(packet)) !== hash(c)) throw new Error('CONTRACT_PACKET_MISMATCH');
  const key = hash([hash(c), input.nonce]).slice(0, 24);
  const grant = (operation: string, target: string, authorizationId: string) => ({ authorizationId, actorRole: 'HUMAN', operation, target,
    runId: c.runId, packetId: packet.packetId, scope: { ...SCOPE, egressDestinations: [...SCOPE.egressDestinations] }, issuedAt: input.issuedAt,
    expiresAt: input.expiresAt, reason: 'M1 single run approved by the Human with a passkey in the CHIEF Workspace' });
  const document = (kind: 'IMPLEMENTATION_PACKET' | 'AUTHORIZATION', authorityId: string, body: unknown) => parseAuthorityDocument({ schemaVersion: 1,
    recordClass: kind === 'IMPLEMENTATION_PACKET' ? 'CLASS_DERIVED_AUTHORITY' : 'DIRECT_AUTHORITY', kind, authorityId, version: 1, issuedAt: input.issuedAt,
    issuer: kind === 'IMPLEMENTATION_PACKET' ? { role: 'GPT_ARCHITECT', principalRef: input.architectPrincipalRef } : { role: 'HUMAN', principalRef: input.humanPrincipalRef },
    subject: { repository: c.repository, sliceId: packet.sliceId }, supersedes: null, body,
    ...(kind === 'IMPLEMENTATION_PACKET' ? { derivation: { ...input.derivation } } : {}) });
  return [document('IMPLEMENTATION_PACKET', packet.packetId, packet),
    document('AUTHORIZATION', `m1-live-${key}`, grant('LIVE_PROVIDER_MODEL_CALL', 'live-provider-model-call', `m1-live-${key}`)),
    document('AUTHORIZATION', `m1-limited-${key}`, grant('LIMITED_README_WORKER', hash(c), `m1-limited-${key}`))];
}
/** The record hash a document will have once preserved (the Authority Archive seals the same way). */
export const recordHashOf = (document: AuthorityDocumentV1) => sealAuthorityRecord(document).recordHash;

/** Trusted-host integration candidate. No writer factory, dispatch, credential or Workspace route. */
export function limitedActivationCandidate(options: {
  core: GovernedActivationCore; store: WorkerStore; readModel(): GovernedReadModelV1;
  humanPrincipalRef: string; architectPrincipalRef: string; now(): string;
  identity(): { sha: string; codeHash: string; clean: boolean };
  readSource(c: Contract): { sha: string; path: string; text: string };
  readGoal(c: Contract): string;
  preserveIssued?:(documents:readonly AuthorityDocumentV1[])=>void;
  /** M1-B: the signing policy of the set this activation commits (S1_UNSIGNED_V0 when absent). */
  signaturePolicy?:SignaturePolicyVersion;
  /** M1-R1: the explicit class-delegation rule; without it a CLASS_DERIVED_AUTHORITY packet is refused. */
  classDelegation?:ClassDelegationVerifier;
}) {
  return Object.freeze({ stage(id: string, rawBundle: unknown, rawLimitedDocument: unknown) {
    const job=options.store.read().jobs.find(j=>j.id===id);
    if(!job||job.state!=='PREPARED'||job.generationClaimed||job.reservedMicroUsd)throw new Error('ACTIVATION_JOB_NOT_PREPARED');
    const c=parseContract(job.contract),identity=options.identity();
    if(!identity.clean||identity.sha!==c.implementationSha||identity.codeHash!==c.workerCodeHash)throw new Error('ACTIVATION_IMPLEMENTATION_CHANGED');
    if(c.inputPolicy?.revision!=='A2'&&c.inputPolicy?.revision!=='A3')throw new Error('ACTIVATION_POLICY_REPLAN_REQUIRED');
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
    // R-1: a Host-derived packet passes only the explicit class-delegation rule; a direct one as before.
    verifyPacketProvenance(packetDocument,packet,options.classDelegation,'ACTIVATION_PACKET_DERIVED_WITHOUT_DELEGATION');
    if(options.preserveIssued){
      if(c.inputPolicy?.revision!=='A3')throw new Error('ACTIVATION_POLICY_REPLAN_REQUIRED');
      boundGrant(liveDocument.body,c,packet,'LIVE_PROVIDER_MODEL_CALL','live-provider-model-call',options.now());
      boundGrant(limitedDocument.body,c,packet,'LIMITED_README_WORKER',hash(c),options.now());
      for(const doc of[packetDocument,liveDocument,limitedDocument]){
        const versions=model.authority.filter(f=>f.ref.kind===doc.kind&&f.ref.authorityId===doc.authorityId),latest=versions.sort((a,b)=>b.ref.version-a.ref.version)[0];
        const sealed=sealAuthorityRecord(doc);
        if(doc.subject.repository!==c.repository||doc.subject.sliceId!==packet.sliceId||Date.parse(doc.issuedAt)>Date.parse(options.now())||
          (doc.kind==='AUTHORIZATION'&&(doc.issuer.role!=='HUMAN'||doc.issuer.principalRef!==position.humanPrincipalRef))||
          (!latest&&(doc.version!==1||doc.supersedes!==null))||
          (latest&&!(latest.ref.recordHash===sealed.recordHash||doc.version===latest.ref.version+1&&hash(doc.supersedes)===hash(latest.ref))))
          throw new Error('ACTIVATION_ISSUED_DOCUMENT_INVALID');
      }
      // Complete incoming documents were validated first. Existing trusted preservation, never issuance.
      options.preserveIssued([packetDocument,liveDocument,limitedDocument]);
    }
    const current=options.readModel();
    // Only previously preserved, exact, current documents can reach the existing core.
    for(const doc of[packetDocument,liveDocument,limitedDocument]){
      const record=sealAuthorityRecord(doc),versions=current.authority.filter(f=>f.ref.kind===doc.kind&&f.ref.authorityId===doc.authorityId);
      if(!versions.some(f=>f.ref.recordHash===record.recordHash)||versions.some(f=>f.ref.version>doc.version)||Date.parse(doc.issuedAt)>Date.parse(options.now()))throw new Error('ACTIVATION_DOCUMENT_NOT_CURRENTLY_ARCHIVED');
    }
    verifyPermit(c,{grant:limitedDocument.body,liveGrant:liveDocument.body,model:current,packet,humanPrincipalRef:options.humanPrincipalRef,architectPrincipalRef:options.architectPrincipalRef,now:options.now(),
      classDelegation:options.classDelegation});
    // S1: all three documents are durably archived, current and verified; only now is their ACTIVATION_SET
    // committed (idempotent), and the committed set is re-derived and re-verified before the Controller moves.
    const setInput={contract:c,packet,model:current,liveGrant:liveDocument.body,limitedGrant:limitedDocument.body,signaturePolicy:options.signaturePolicy};
    publishActivationSet(options.store.directory,setInput);
    const set=verifyActivationSet(options.store.directory,{...setInput,model:options.readModel()});
    const result=options.core.activate(target,{implementationPacket:packetDocument,liveCallAuthorizations:[liveDocument]});
    if(result.packet.packetHash!==packetHash(packet)||result.state!=='PACKET_READY')throw new Error('ACTIVATION_RESULT_MISMATCH');
    return {recordClass:'OPERATIONAL_RECORD' as const,stage:result,executionEligible:false as const,activationSet:set,liveEligibility:liveEligibility(set),
      blockers:['EXE_HOLD',...(c.inputPolicy?.revision==='A3'?[]:['INPUT_LIMIT_DECISION_REQUIRED']),'H1_H9_NOT_GRANTED','ACTIVATION_SET_UNSIGNED'],
      notice:'Staging archived documents is not execution authorization. No Driver or Worker was invoked.'};
  }});
}
