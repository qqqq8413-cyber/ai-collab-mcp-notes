import type { Observation } from './store.js';

const span=(a:string|undefined,b:string|undefined)=>{
  if(!a||!b)return null;const ms=Date.parse(b)-Date.parse(a);return Number.isSafeInteger(ms)&&ms>=0?ms:null;
};
export function efficiency(observations:readonly Observation[],dropped:number,jobs:readonly {
  id:string;comparisonKey:string;goalCreatedAt:string;state:string;reason:string|null;resultApplied:boolean;verifiedAt:string|null;
  evidenceClass:string;events:readonly{at:string;kind:string}[] }[]) {
  const setup=observations.find(o=>o.kind==='SETUP_OPENED'),firstPlan=observations.find(o=>o.kind==='PLAN_READY');
  return {recordClass:'OPERATIONAL_RECORD',coverage:dropped?'BOUNDED_WINDOW_WITH_DROPS':'OBSERVED_WINDOW',dropped,
    evidenceClasses:[...new Set([...observations.map(o=>o.evidenceClass),...jobs.map(j=>j.evidenceClass)])],
    productEfficiencyProven:false,comparisonBaseline:null,
    setup:{firstOpenedAt:setup?.at??null,firstPlanReadyAt:firstPlan?.at??null,firstPlanReadyMs:span(setup?.at,firstPlan?.at),
      fullyAuthorizedSetupMs:null,status:'INCOMPLETE_EXE_HOLD'},
    recordedOperatorActions:observations.filter(o=>['PLAN_READY','PLAN_REUSED','CHECK','START_REFUSED','CANCEL','RECONCILIATION_REQUESTED'].includes(o.kind)).length,
    operatorIdentityClaim:'Observed local-session actions, not authenticated Human time or a complete intervention count',
    tasks:jobs.map(j=>{const ready=observations.find(o=>o.jobId===j.id&&o.kind==='PLAN_READY');
      const start=ready?.interactionId?observations.find(o=>o.interactionId===ready.interactionId&&o.kind==='TASK_FORM_STARTED'):undefined;
      return {jobId:j.id,comparisonKey:j.comparisonKey,evidenceClass:j.evidenceClass,formToPlanMs:span(start?.at,ready?.at),clientReportedFormMs:ready?.clientElapsedMs??null,
        clientTimingTrust:'BROWSER_REPORTED_NOT_AUTHORITY',goalToVerifiedResultMs:j.resultApplied?span(j.goalCreatedAt,j.verifiedAt??undefined):null,
        verifiedAt:j.resultApplied?j.verifiedAt:null,state:j.state,reason:j.reason,
        blockedAttempts:observations.filter(o=>o.jobId===j.id&&o.kind==='START_REFUSED').map(o=>({at:o.at,reason:o.reason})),
        recoveries:j.events.filter(e=>e.kind==='UNCERTAIN_NO_REPLAY').length};}),
    runtimeStarts:observations.filter(o=>o.kind==='RUNTIME_START').map(o=>o.at),
    comparisonDesign:{sameTaskRequired:true,sameSourceModelDeliveryRequired:true,setupSeparateFromTask:true,unobservedTime:null,
      directAiHumanTimeMs:null,qualityAndRework:'Not measured; require independently verified real outputs and paired observations'}};
}
