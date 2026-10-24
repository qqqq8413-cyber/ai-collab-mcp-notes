import { EXE, checkQuote, hash, maximumCost, packetFor, type Contract } from './contract.js';
import { packetHash } from '../automation/packet.js';

const guidance: Record<string,{title:string;nextStep:string;owner:string}> = {
  EXE_HOLD:{title:'正式執行尚未開放',nextStep:'先交 Architect 審查；本輪不解除執行鎖定。',owner:'Architect / Human'},
  INPUT_LIMIT_DECISION_REQUIRED:{title:'歷史契約仍保留舊輸入政策，不能直接執行',nextStep:'請建立新工作，由系統產生 A3 計畫與許可草案。舊許可不會自動取得新資格。',owner:'Human / System'},
  INPUT_POLICY_LEGACY_REQUIRES_REPLAN:{title:'舊計畫需重新準備',nextStep:'保留舊證據，從目前版本建立新目標與計畫。',owner:'Human'},
  H1_H9_NOT_GRANTED:{title:'尚未取得正式執行許可',nextStep:'經既有治理流程核發限定許可；工作紀錄與按鈕點擊都不是授權。',owner:'Human'},
  ACCOUNT_MODEL_UNVERIFIED:{title:'帳戶模型與 API 尚未查驗',nextStep:'正式許可後，由可信 Host 檢查指定帳戶；不要在工作表單貼入金鑰。',owner:'System / Human'},
  PRICE_QUOTE_EXPIRED:{title:'價格證據已過期',nextStep:'重新取得官方價格並準備新計畫；不能沿用過期許可。',owner:'System'},
  IMPLEMENTATION_NOT_ACCEPTED_OR_CHANGED:{title:'版本已變更或尚未固定',nextStep:'待目前版本提交並完成審查後，建立新計畫，舊契約不得沿用。',owner:'Architect / System'},
  LIMITED_PERMIT_MISSING_OR_INVALID:{title:'限定授權尚未核對通過',nextStep:'系統準備審查封包，由既有治理流程保存正式文件；使用者不必填寫雜湊。',owner:'Human / Architect'},
  CONTROLLER_NOT_READY:{title:'尚待治理啟用',nextStep:'以同一份封包完成既有 activation，不能繞過 Controller。',owner:'Architect'},
  TOTAL_COST_LIMIT:{title:'保守預留額度不足',nextStep:'不要重設預算或重送；先核對已使用與不確定請求的證據。',owner:'Human'},
  UNCERTAIN_NO_REPLAY:{title:'上次請求結果不確定',nextStep:'提出人工核對，查看供應商紀錄與本機證據；不重試、不自動退還預留。',owner:'Human'},
  WORK_ALREADY_TERMINAL:{title:'這個工作不能再次執行',nextStep:'保留紀錄；需要另一項工作時另建目標，不重放這個 Run。',owner:'Human'},
};
export function readiness(conditions: readonly string[]) {
  return {recordClass:'OPERATIONAL_RECORD',state:'REVIEW_ONLY_PRODUCTION_HOLD',canStart:false,
    checks:[...new Set(conditions)].map(code=>({code,...(guidance[code]??{title:'條件尚未核對',nextStep:'查看進階證據並交由治理流程核對。',owner:'System'})}))};
}
/** Derived review material only. No authority documents, activation writes or execution capability. */
export function activationCandidate(c:Contract,sliceId:string,objective:string) {
  const packet=packetFor(c,sliceId);
  return {schemaVersion:1,state:'UNISSUED_NOT_AUTHORITY',recordClass:'OPERATIONAL_RECORD',exe:EXE,
    summary:{objective,source:'指定版本 README.md，最多 16KB',agent:'README Worker',delivery:'繁體中文 Markdown 文件審查報告，不修改程式',
      maximumCostMicroUsd:c.maxCostMicroUsd,totalCeilingMicroUsd:c.totalCostMicroUsd,reservationMicroUsd:maximumCost(c),
      inputDecision:c.inputPolicy?.revision==='A3'?'A3：README 16,384 bytes、Goal 2,000 UTF-16 units、完整 request 131,072 bytes；不宣稱精確輸入 token 上限':'歷史嚴格 4,096 契約未升級；需建立新 Goal／Run／A3 契約及許可',
      timeoutSeconds:c.timeoutSeconds,inputProofStatus:c.inputPolicy?.revision==='A3'?'ENFORCEABLE_RESOURCE_LIMITS_NOT_TOKEN_PROOF':'BLOCKED_NO_PROVIDER_GUARANTEE'},
    contract:c,contractHash:hash(c),implementationPacket:packet,packetHash:packetHash(packet),
    authority:{implementationPacket:null,liveProviderGrant:null,limitedWorkerGrant:null},issuedAt:null,expiresAt:null,maxValiditySeconds:3600,
    hostReadiness:{state:'TRUSTED_HOST_CANDIDATE_REQUIRES_ARCHITECT_REVIEW',productionExecution:'HOLD',providerAccount:'UNVERIFIED_NO_ACCOUNT_REQUEST',
      authorityOrigin:'EXTERNALLY_ISSUED_DOCUMENTS_ONLY',canIssueAuthority:false,lastLocalGuard:'AFTER_SOCKET_READY_BEFORE_WRITE'},
    requiredHumanOperations:['LIVE_PROVIDER_MODEL_CALL','LIMITED_README_WORKER'],limitedPermitTarget:hash(c),
    activationPath:'Existing governed activation core -> Authority Archive -> Controller PACKET_READY -> Execution Driver',
    constraint:'No Workspace issuance; trusted governance must preserve separately issued exact documents. Activation alone does not release HOLD.'};
}
export function planConditions(c:Contract,now:string,identity:{sha:string;codeHash:string;clean:boolean},reserved:number) {
  const conditions=['EXE_HOLD','H1_H9_NOT_GRANTED','ACCOUNT_MODEL_UNVERIFIED'];
  if(c.inputPolicy?.revision!=='A3')conditions.push(c.inputPolicy?'INPUT_LIMIT_DECISION_REQUIRED':'INPUT_POLICY_LEGACY_REQUIRES_REPLAN');
  if(c.inputPolicy&&c.inputPolicy.revision!=='A3')conditions.push('INPUT_POLICY_LEGACY_REQUIRES_REPLAN');
  try{checkQuote(c.quote,now);}catch{conditions.push('PRICE_QUOTE_EXPIRED');}
  if(!identity.clean||identity.sha!==c.implementationSha||identity.codeHash!==c.workerCodeHash)conditions.push('IMPLEMENTATION_NOT_ACCEPTED_OR_CHANGED');
  if(reserved+maximumCost(c)>c.totalCostMicroUsd)conditions.push('TOTAL_COST_LIMIT');
  return conditions;
}
