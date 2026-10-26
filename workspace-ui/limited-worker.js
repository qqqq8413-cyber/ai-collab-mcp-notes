import { readerIcon, markdownHTML } from './reader.generated.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=v=>v===null||v===undefined?'未知／尚無資料':'US$'+(v/1000000).toFixed(6);
const duration=v=>v===null||v===undefined?'尚未量得':(v/1000).toFixed(1)+' 秒';
const when=v=>v?new Date(v).toLocaleString('zh-TW',{hour12:false}):'—';
const labels={PREPARED:'計畫已保存，尚未執行',RUNNING:'請求進行中',COMPLETED:'成果已保存',CANCELLED:'已取消',TIMED_OUT:'送出前已逾時',
  BLOCKED:'條件不符合',UNCERTAIN:'結果不確定，禁止重送',FAILED:'執行失敗',RESULT_REQUIRES_RECONCILIATION:'成果待人工核對'};
export const AGENT_LABELS={'claude-code-reader':'Claude Code 唯讀分析','limited-readme-worker':'README 審查 Worker'};
const AGENT_NOTES={'claude-code-reader':'隔離工作區只放固定版本 README.md；只有 Read、Glob、Grep；最多 3 輪模型請求',
  'limited-readme-worker':'一次 Messages API 請求，不使用工具'};
const messages={EXE_HOLD:'目前未開放正式執行，沒有送出模型請求。',PRICE_QUOTE_EXPIRED:'價格證據已過期，請待系統更新後重新準備。',
  PRICE_NOT_VERIFIED:'目前無法確認價格，不能準備執行。',INPUT_POLICY_LEGACY_REQUIRES_REPLAN:'舊計畫不會自動升級。請建立新工作，產生新的 A3 計畫與未核發許可。',OBSERVATION_ID_CONFLICT:'操作識別衝突，請重新開啟準備畫面。',
  APPROVAL_REQUIRED:'請先勾選批准這項工作與費用上限。',APPROVAL_DOES_NOT_MATCH_COST:'批准的費用上限與系統計算的不同，請重新整理後再批准。',
  WORK_ALREADY_STARTED_OR_TERMINAL:'這項工作已經開始或已經結束，不會重送。',WORKER_LEASE_BUSY:'另一個執行正在進行，請稍後再試。',
  GOAL_BINDING_MISMATCH:'任務內容與計畫不一致，沒有執行。',
  TOTAL_COST_LIMIT:'累積預算上限不足以容納這項工作的最壞預留；已完成工作的預留不會退回。沒有執行。'};
const offline=e=>e?.evidenceClass==='OFFLINE_SYNTHETIC'&&e.startAvailable===true;
export const modeText=e=>!e?'讀取中…':offline(e)?'OFFLINE_SYNTHETIC 演練：不呼叫模型':e.startAvailable?'可執行':'正式執行：EXE HOLD';
export function workerHTML(){return `<section id="limited-worker" class="ai-preparation" aria-label="交付任務">
  <header class="auto-head"><h2>交付任務</h2><span class="auto-lock worker-mode">讀取中…</span></header>
  <p class="worker-message" role="status" aria-live="polite">讀取準備條件…</p>
  <form class="auto-form worker-create"><label class="worker-objective">要 AI 完成什麼<textarea name="objective" maxlength="2000" rows="3" required></textarea></label>
    <label>可用資料<span class="worker-scope">CHIEF 的固定版本 README.md，最多 16KB</span></label>
    <label>指定 Agent<select name="agentId"><option value="claude-code-reader">${AGENT_LABELS['claude-code-reader']}</option><option value="limited-readme-worker">${AGENT_LABELS['limited-readme-worker']}</option></select></label>
    <label>費用上限<span class="worker-scope">單次及累積最多 US$1；每項工作的預留上限顯示在工作卡片上，批准前可確認</span></label>
    <label>時間上限<span class="worker-scope">300 秒；README 審查一次請求，Claude Code 最多 3 輪；零重試</span></label>
    <p class="worker-delivery">資料上限：README 16,384 bytes、工作內容 2,000 UTF-16 units。超限拒絕，不截斷文件。</p>
    <p class="worker-delivery">交付：繁體中文 Markdown 報告。只讀文件，不修改程式、Git 或部署。</p>
    <button class="auto-button" type="submit">${readerIcon('add')} 建立工作與計畫</button></form>
  <details class="worker-existing"><summary>使用已建立的目標</summary><a data-worker-goal>查看工作清單</a>
    <form class="auto-form worker-form" hidden><label>既有目標<select name="goalId" required></select></label>
      <button class="auto-button" type="submit">${readerIcon('add')} 準備計畫</button></form></details>
  <div class="worker-jobs"></div><div class="worker-efficiency"></div></section>`;}
function startHTML(j,exec,approved,data){
  if(exec.startAvailable&&j.state==='PREPARED'&&data.totalReservedMicroUsd+j.maximumReservationMicroUsd>data.totalCeilingMicroUsd)
    return `<p class="auto-error worker-budget">剩餘預算不足：累積上限 ${usd(data.totalCeilingMicroUsd)}，已保守預留 ${usd(data.totalReservedMicroUsd)}，這項工作需要預留 ${usd(j.maximumReservationMicroUsd)}。已完成工作的預留不會退回，所以不能批准。</p>`;
  if(exec.startAvailable&&j.state==='PREPARED'){const ok=approved.has(j.id);
    return `<label class="worker-approve"><input type="checkbox" data-approve="${j.id}" ${ok?'checked':''}> 我批准這項工作，並同意最多預留 ${usd(j.maximumReservationMicroUsd)}</label>
      <button class="auto-button" data-worker-start="${j.id}" data-max="${j.maximumReservationMicroUsd}" ${ok?'':'disabled'}>${readerIcon('play')} 批准並執行</button>`;}
  if(exec.startAvailable)return '';
  return `<button class="auto-button" disabled title="EXE HOLD；本輪沒有付費執行授權">${readerIcon('play')} 啟動執行 · LOCKED</button>`;}
export function jobsHTML(data,approved=new Set()){const exec=data.execution??{evidenceClass:'LIVE_PROVIDER',startAvailable:false,authorizationSteps:[]};
  return `<dl class="auto-facts"><div><dt>持久化總預算</dt><dd>${usd(data.totalCeilingMicroUsd)}</dd></div>
  <div><dt>已保守預留，含不確定請求</dt><dd>${usd(data.totalReservedMicroUsd)}</dd></div></dl>
  ${!exec.startAvailable&&exec.authorizationSteps?.length?`<details class="worker-authorization"><summary>正式執行還需要的授權步驟</summary><ol>${exec.authorizationSteps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol></details>`:''}`
  +data.jobs.map(j=>`<article class="ai-plan" data-job="${j.id}">
    <header class="auto-head"><h3>${esc(j.objective)}</h3><span class="auto-lock">${esc(labels[j.effectiveState]??j.effectiveState)}</span></header>
    ${j.evidenceClass==='OFFLINE_SYNTHETIC'?'<p class="auto-deferred">OFFLINE_SYNTHETIC：隔離合成測試，不是真實模型成果。</p>':''}
    <dl class="auto-facts"><div><dt>工作編號</dt><dd>${esc(j.id.slice(0,12))}</dd></div>
      <div><dt>Agent</dt><dd>${esc(AGENT_LABELS[j.contract.agentId]??j.contract.agentId)}</dd></div>
      <div><dt>資料</dt><dd>固定版本 README.md · ${j.contract.sourceBytes} bytes</dd></div><div><dt>成果</dt><dd>唯讀繁體中文報告</dd></div>
      <div><dt>開始</dt><dd>${when(j.startedAt)}</dd></div><div><dt>結束</dt><dd>${when(j.finishedAt)}</dd></div>
      <div><dt>最壞費用預留，非實際費用</dt><dd>${usd(j.maximumReservationMicroUsd)}</dd></div>
      <div><dt>實際 usage 計算費用，非帳單</dt><dd>${usd(j.actualCostMicroUsd)}</dd></div>
      <div><dt>usage</dt><dd>${j.usage?`輸入 ${j.usage.inputTokens}、輸出 ${j.usage.outputTokens} tokens`:'尚無'}</dd></div>
      <div><dt>正式授權</dt><dd>${offline(exec)?'OFFLINE_SYNTHETIC 演練紀錄，不是 Human 授權':j.authorityStatus==='ARCHIVED_BINDING_VALID'?'限定文件綁定有效，仍需完整許可':'尚未取得有效限定授權'}</dd></div></dl>
    <p class="auto-deferred">${offline(exec)?`OFFLINE_SYNTHETIC 演練 Host：完整經過受信啟用、Controller、Journal 與隔離工作區；不呼叫模型，成果不是 AI 分析。${esc(AGENT_NOTES[j.contract.agentId]??'')}。`:'可信執行 Host：EXE HOLD，尚未開放執行。帳戶模型尚未驗證。'}</p>
    ${offline(exec)?'':`<h4>啟動前檢查：尚未符合</h4><ul class="worker-checks">${(j.readiness?.checks??[]).map(c=>`<li><strong>${esc(c.title)}</strong><p>${esc(c.nextStep)}</p></li>`).join('')}</ul>`}
    <div class="auto-actions"><button class="auto-button" data-worker-act="CHECK" data-id="${j.id}">${readerIcon('refresh')} 檢查準備狀態</button>
      ${startHTML(j,exec,approved,data)}
      <button class="auto-button" data-worker-act="CANCEL" data-id="${j.id}" ${['PREPARED','RUNNING'].includes(j.state)?'':'disabled'}>${readerIcon('cancel')} 取消工作</button>
      ${['UNCERTAIN','RESULT_REQUIRES_RECONCILIATION'].includes(j.effectiveState)?`<button class="auto-button" data-worker-act="RECONCILE" data-id="${j.id}">${readerIcon('refresh')} 提出人工核對</button>`:''}</div>
    ${j.reason?`<p class="auto-error">工作停止，原因：${esc(messages[j.reason]??j.reason)}</p>`:''}
    <details data-evidence="${j.id}"><summary>進階證據與審查封包</summary>
      <p>${offline(exec)?'OFFLINE_SYNTHETIC 演練：以下是操作紀錄，不是 Human Authority。':'EXE HOLD。以下皆為操作紀錄與待審資料，不是 Human Authority。'}</p>
      <p>${j.contract.inputPolicy?.revision==='A3'?'A3 使用位元組與字數資源限制，已取消嚴格 4,096 input token 要求。':'歷史契約仍保留原輸入政策，不會自動取得 A3 資格；請建立新工作。'}</p>
      <p>每次模型請求的輸入以 200,000 tokens、輸出以 2,048 tokens 預留費用；${j.contract.agentId==='claude-code-reader'?'Claude Code 最多 3 輪請求，預留為三倍':'一次請求'}；零重試、300 秒。</p>
      <p>目前 Controller ${esc(j.driver.state)}；Journal ${esc(j.invocations.map(i=>i.state).join(', ')||'尚無 Invocation')}。</p>
      <p>帳戶模型 ${esc(j.modelAccountAvailability)}；來源與版本由系統綁定，不需手動填寫。</p>
      <pre>${esc(JSON.stringify({input:j.input,proposal:j.reviewPacket,events:j.events},null,2))}</pre></details>
    ${j.report?`<section class="worker-report"><h4>${j.resultApplied?'可核對成果':'成果尚未通過完整核對'}</h4>${markdownHTML(j.report)}</section>`:'<p>尚無模型成果。</p>'}</article>`).join('');}
export function efficiencyHTML(e){if(!e)return '';return `<details data-efficiency><summary>效率量測與證據界線</summary>
  <p>${e.evidenceClasses.includes('OFFLINE_SYNTHETIC')?'OFFLINE_SYNTHETIC：含測試觀察，不能當作正式產品效率證據。':'本機操作觀察，不等同完整人工投入時間。'}</p>
  <dl class="auto-facts"><div><dt>初次開啟到首份計畫</dt><dd>${duration(e.setup.firstPlanReadyMs)}</dd></div>
    <div><dt>完整授權設定時間</dt><dd>尚未完成，EXE HOLD</dd></div><div><dt>已記錄操作次數</dt><dd>${e.recordedOperatorActions}</dd></div>
    <div><dt>程序啟動紀錄</dt><dd>${e.runtimeStarts.length}</dd></div></dl>
  <p>只計算收到的操作；瀏覽器計時由客戶端回報，未觀察時間未知。${e.dropped?'部分舊量測已超出保存視窗。':''}</p>
  ${e.tasks.map(t=>`<p>建立計畫：${duration(t.formToPlanMs)}；Goal 到可核對成果：${duration(t.goalToVerifiedResultMs)}；恢復紀錄：${t.recoveries}。</p>`).join('')}
  <p>尚未與直接操作 AI 做同工作、同資料、同模型的成對比較，沒有節省時間或品質提升結論。</p></details>`;}
export function attachWorker({projectId,source,root}){
  root.dataset.projectId=projectId;
  const message=root.querySelector('.worker-message'),form=root.querySelector('.worker-form'),create=root.querySelector('.worker-create'),jobs=root.querySelector('.worker-jobs'),metrics=root.querySelector('.worker-efficiency'),mode=root.querySelector('.worker-mode');
  root.querySelector('[data-worker-goal]').href=`#/p/${encodeURIComponent(projectId)}/now`;
  if(!source.limitedWorker){message.textContent='限定 Worker 尚未接通；沒有執行能力。';create.querySelector('button').disabled=true;mode.textContent='未接通';return;}
  // Approval checkboxes survive the 3-second refresh; a job leaves the set once it has started or ended.
  const approved=new Set();let execution=null;
  const show=data=>{if(!root.isConnected)return;execution=data.execution??null;mode.textContent=modeText(execution);
    for(const id of approved)if(!data.jobs.some(j=>j.id===id&&j.state==='PREPARED'))approved.delete(id);
    const opened=new Set([...jobs.querySelectorAll('details[open]')].map(d=>d.dataset.evidence));
    jobs.innerHTML=jobsHTML(data,approved);for(const d of jobs.querySelectorAll('details'))d.open=opened.has(d.dataset.evidence);
    const open=metrics.querySelector('details')?.open;metrics.innerHTML=efficiencyHTML(data.efficiency);if(open)metrics.querySelector('details').open=true;};
  root.addEventListener('worker-plan-saved',e=>{show(e.detail.data);
    message.textContent=offline(e.detail.data.execution)?'計畫已保存。確認費用上限、勾選批准後按「批准並執行」。':'工作與計畫已保存，等待審查，沒有送出模型請求。';
    jobs.querySelector(`[data-job="${e.detail.jobId}"]`)?.scrollIntoView({block:'start',behavior:'smooth'});});
  const explain=e=>messages[e.code]??e.message;
  const observe=(event,interactionId,requestId=crypto.randomUUID())=>source.prepareWorker(projectId,{kind:'OBSERVE',requestId,event,interactionId});
  let reading=false,interactionId=crypto.randomUUID(),startedAt=null,startObservation=null,pendingGoal=null,completedForm=false;
  const begin=()=>{if(startedAt===null){startedAt=performance.now();startObservation=observe('TASK_FORM_STARTED',interactionId).catch(e=>{message.textContent=explain(e);});}return startObservation;};
  create.elements.objective.addEventListener('focus',begin);
  create.elements.objective.addEventListener('input',()=>{if(completedForm){interactionId=crypto.randomUUID();startedAt=null;startObservation=null;pendingGoal=null;completedForm=false;void begin();}});
  void(async()=>{try{const data=await source.limitedWorker(projectId),queue=await source.queue(projectId);if(!root.isConnected)return;
    show(data);form.elements.goalId.innerHTML=queue.goals.map(g=>`<option value="${esc(g.goalId)}">${esc(g.text)}</option>`).join('');form.hidden=!queue.goals.length;
    message.textContent=offline(data.execution)?'OFFLINE_SYNTHETIC 演練 Host：輸入任務、選擇 Agent、建立計畫，勾選批准後即可執行；不呼叫模型，成果不是 AI 分析。'
      :'A3 準備模式：採位元組與字數限制，工作與審查資料可保存；正式執行仍鎖定，不會呼叫模型。';
    const key='chief.worker.setup.'+projectId;let id=sessionStorage.getItem(key);if(!id){id=crypto.randomUUID();sessionStorage.setItem(key,id);}await observe('SETUP_OPENED',id,id);
  }catch(e){message.textContent=explain(e);}})();
  const prepare=async goalId=>{const ms=startedAt===null?undefined:Math.round(performance.now()-startedAt);
    return source.prepareWorker(projectId,{requestId:crypto.randomUUID(),goalId,agentId:create.elements.agentId.value,interactionId,...(ms!==undefined&&ms<=86400000?{clientElapsedMs:ms}:{})});};
  create.addEventListener('submit',async e=>{e.preventDefault();e.stopPropagation();const button=create.querySelector('button'),text=create.elements.objective.value.trim();if(!text||button.disabled)return;button.disabled=true;
    try{await begin();if(!pendingGoal||pendingGoal.text!==text){const response=await source.addGoal(projectId,text);pendingGoal={text,goalId:response.goal.goalId};}
      const data=await prepare(pendingGoal.goalId);completedForm=true;
      const liveRoot=document.querySelector('#limited-worker'),job=data.jobs.find(j=>j.contract.goalId===pendingGoal.goalId);
      if(liveRoot?.dataset.projectId===projectId&&job)liveRoot.dispatchEvent(new CustomEvent('worker-plan-saved',{detail:{data,jobId:job.id}}));
    }catch(e){message.textContent=explain(e);}finally{button.disabled=false;}});
  form.addEventListener('submit',async e=>{e.preventDefault();e.stopPropagation();const button=form.querySelector('button');button.disabled=true;
    try{await begin();const data=await prepare(form.elements.goalId.value);show(data);const j=data.jobs.find(j=>j.contract.goalId===form.elements.goalId.value);
      message.textContent=j?.contract.inputPolicy?.revision==='A3'?(offline(data.execution)?'計畫已保存。勾選批准後按「批准並執行」。':'計畫已保存，尚未授權或執行。'):'這是歷史計畫，未升級或執行。請建立新工作以準備 A3 計畫。';}catch(e){message.textContent=explain(e);}finally{button.disabled=false;}});
  root.addEventListener('change',e=>{const box=e.target.closest('[data-approve]');if(!box)return;
    if(box.checked)approved.add(box.dataset.approve);else approved.delete(box.dataset.approve);
    const start=jobs.querySelector(`[data-worker-start="${box.dataset.approve}"]`);if(start)start.disabled=!box.checked;});
  root.addEventListener('click',async e=>{const s=e.target.closest('[data-worker-start]');
    if(s){if(s.disabled)return;s.disabled=true;const id=s.dataset.workerStart;message.textContent='已批准，執行中…';
      try{const data=await source.workerAction(projectId,id,{action:'START',requestId:crypto.randomUUID(),approval:{maxReservationMicroUsd:Number(s.dataset.max)}});
        approved.delete(id);show(data);const j=data.jobs.find(j=>j.id===id);
        message.textContent=j?.state==='COMPLETED'?`完成：${AGENT_LABELS[j.contract.agentId]??'Agent'} 的成果已保存，顯示在下方工作卡片。`:`執行結束：${labels[j?.effectiveState]??j?.effectiveState??'狀態未知'}。`;
      }catch(err){message.textContent=explain(err);s.disabled=false;}
      return;}
    const b=e.target.closest('[data-worker-act]');if(!b||b.disabled)return;b.disabled=true;
    try{show(await source.workerAction(projectId,b.dataset.id,{action:b.dataset.workerAct,requestId:crypto.randomUUID()}));message.textContent=b.dataset.workerAct==='RECONCILE'?'已登記人工核對需求；未重送請求或退回預留。':offline(execution)?'操作已保存。':'操作已保存，未取得執行授權。';}
    catch(err){message.textContent=explain(err);}finally{b.disabled=false;}});
  const timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return;}if(reading||document.hidden)return;reading=true;
    void source.limitedWorker(projectId).then(show).catch(e=>message.textContent=explain(e)).finally(()=>reading=false);},3000);
}
