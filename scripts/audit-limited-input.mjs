import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {API_VERSION,MODEL,hash,parseContract,inputFacts,messageBody,assertInputReady} from '../dist/limited-worker/contract.js';

/** Committed full public-source fixture: usable in shallow CI, never a production Git-source fallback. */
export function loadReadmeSnapshot(expected) {
  const c=parseContract(expected),seal=JSON.parse(readFileSync(new URL('../regressions/auto-p2-r1/readme-seal.json',import.meta.url),'utf8'));
  const bytes=readFileSync(new URL('../regressions/auto-p2-r1/pinned-readme.md',import.meta.url));
  if(seal.sourceSha!==c.sourceSha||seal.path!==c.sourcePath||seal.bytes!==c.sourceBytes||seal.sha256!==c.sourceHash||
    bytes.length!==c.sourceBytes||hash(bytes)!==c.sourceHash)throw new Error('OFFLINE_SNAPSHOT_BINDING_MISMATCH');
  return {text:bytes.toString('utf8'),sha:c.sourceSha,hash:c.sourceHash,bytes:bytes.length,path:c.sourcePath};
}

/** Offline request inventory, NOT a tokenizer, proof certificate or execution admission port. */
export function auditLimitedInput(contract,goal,source) {
  const c=parseContract(contract),body=messageBody(c,goal,source),facts=inputFacts(c,goal,source);
  let reason=null;
  try{assertInputReady(c);}catch(error){reason=error.message;}
  if(reason!=='INPUT_LIMIT_DECISION_REQUIRED')throw new Error('UNEXPECTED_INPUT_GUARD_REQUIRES_REVIEW');
  return {schemaVersion:1,status:'BLOCKED_NO_PROVABLE_INPUT_BOUND',evidenceClass:'OFFLINE_REQUEST_INVENTORY',
    model:MODEL,apiVersion:API_VERSION,requestedHardLimitTokens:4096,runtimeReason:reason,
    ...facts,canDispatch:false,providerCalls:0,
    requestShape:{keys:Object.keys(body).sort(),messageCount:body.messages.length,roles:body.messages.map(m=>m.role),
      toolsPresent:Object.hasOwn(body,'tools'),cacheControlPresent:Object.hasOwn(body,'cache_control'),
      thinking:body.thinking,outputLimit:body.max_tokens,stream:body.stream,serviceTier:body.service_tier},
    missingProof:['Model-specific tokenizer and transformation bound','Complete role/framing/provider overhead bound',
      'Count-to-generation consistency with a documented finite error bound, or provider-enforced input cap'],
    notice:'Bytes and hashes describe the exact local request. They are not token bounds. No content is truncated or normalized.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--evidence')throw new Error('USAGE: --evidence OUTPUT_JSON');
  const prior=JSON.parse(readFileSync(new URL('../regressions/auto-p2-a2/browser-acceptance.json',import.meta.url),'utf8')).worker.jobs[0];
  const source=loadReadmeSnapshot(prior.contract),result=auditLimitedInput(prior.contract,prior.objective,source.text);
  writeFileSync(args[1],JSON.stringify({...result,sourceSha:source.sha,sourceHash:source.hash,
    fixture:'Committed A2 OFFLINE_SYNTHETIC objective plus sealed complete public Git README snapshot; not a live Git-source acceptance',
    note:'This is the base request inventory, not a newly authorized R1 contract or live provider acceptance.'},null,2));
  console.log(JSON.stringify({status:result.status,sourceBytes:result.sourceBytes,requestUtf8Bytes:result.requestUtf8Bytes,providerCalls:0}));
}
