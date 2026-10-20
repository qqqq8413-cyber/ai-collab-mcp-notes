import { readerIcon, markdownHTML } from './reader.generated.js';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const usd = v => v === null || v === undefined ? '未知／尚無資料' : 'US$' + (v / 1000000).toFixed(6);
const labels = { PREPARED:'計畫已保存，未執行', RUNNING:'實際請求進行中', COMPLETED:'結果已保存', CANCELLED:'已取消',
  TIMED_OUT:'逾時，未送出生成請求', BLOCKED:'條件不符合', UNCERTAIN:'遠端狀態不確定，不重送', FAILED:'執行失敗', RESULT_REQUIRES_RECONCILIATION:'結果待治理核對，非已驗收' };
export function workerHTML() {
  return `<section id="limited-worker" class="ai-preparation" aria-label="限定 AI Worker"><header class="auto-head"><h2>限定 README Worker</h2><span class="auto-lock">EXE HOLD</span></header>
    <p class="worker-message" role="status">讀取執行條件…</p><a data-worker-goal>建立工作目標</a>
    <form class="auto-form worker-form" hidden><label>既有目標<select name="goalId" required></select></label>
      <label>指定 Agent<select name="agentId"><option value="limited-readme-worker">README Worker</option></select></label>
      <button type="submit" class="auto-button">${readerIcon('add')} 準備執行計畫</button></form><div class="worker-jobs"></div></section>`;
}
export function jobsHTML(data) {
  return `<dl class="auto-facts"><div><dt>總額上限</dt><dd>${usd(data.totalCeilingMicroUsd)}</dd></div><div><dt>保守預留（含不確定請求）</dt><dd>${usd(data.totalReservedMicroUsd)}</dd></div></dl>` +
    data.jobs.map(j => `<article class="ai-plan"><header class="auto-head"><h3>${esc(j.objective)}</h3><span class="auto-lock">${esc(labels[j.effectiveState] ?? j.effectiveState)}</span></header>
    ${j.evidenceClass === 'OFFLINE_SYNTHETIC' ? '<p class="auto-deferred">離線合成測試，非真實 AI 執行</p>' : ''}
    <dl class="auto-facts"><div><dt>精確模型</dt><dd>${esc(j.contract.model)}</dd></div><div><dt>正式授權</dt><dd>${j.authorityStatus === 'ARCHIVED_BINDING_VALID' ? 'Archive 綁定有效；仍需完整執行許可' : '未取得有效限定授權'}</dd></div>
      <div><dt>Provider / API</dt><dd>Anthropic / 2023-06-01</dd></div>
      <div><dt>來源</dt><dd>README.md · ${j.contract.sourceBytes} bytes</dd></div><div><dt>帳戶模型可用性</dt><dd>${j.modelAccountAvailability === 'ACCOUNT_METADATA_VERIFIED' ? '已查驗帳戶 metadata' : '未查驗（沒有帳戶 API 呼叫）'}</dd></div>
      <div><dt>輸入預留上界／輸出限制</dt><dd>200,000 / 2,048 tokens</dd></div><div><dt>模型生成請求／重試</dt><dd>最多 1 / 0</dd></div>
      <div><dt>費用最壞情況預留</dt><dd>${usd(j.maximumReservationMicroUsd)}</dd></div><div><dt>實際 usage 計算費用</dt><dd>${usd(j.actualCostMicroUsd)}</dd></div>
      <div><dt>時限</dt><dd>300 秒，授權更早到期則提前中止</dd></div><div><dt>Controller / Journal</dt><dd>${esc(j.driver.state)} / ${esc(j.invocations.map(i=>i.state).join(', ') || '尚無 Invocation')}</dd></div></dl>
    <div class="auto-actions"><button class="auto-button" data-worker-act="CHECK" data-id="${j.id}">${readerIcon('refresh')} 檢查執行條件</button>
      <button class="auto-button" ${data.exe === 'AUTHORIZED' && j.authorityStatus === 'ARCHIVED_BINDING_VALID' && j.driver.readiness === 'READY' && j.state === 'PREPARED' ? `data-worker-act="START" data-id="${j.id}"` : 'disabled'} title="EXE HOLD，未授權不能執行">${readerIcon('play')} 啟動執行${data.exe === 'AUTHORIZED' ? '' : ' · LOCKED'}</button>
      <button class="auto-button" data-worker-act="CANCEL" data-id="${j.id}" ${['PREPARED','RUNNING'].includes(j.state) ? '' : 'disabled'}>${readerIcon('cancel')} 取消工作</button></div>
    ${j.reason ? `<p class="auto-error">${esc(j.reason)}</p>` : ''}
    <details><summary>條件與證據</summary><ul>${j.conditions.map(c=>`<li>${esc(c)}</li>`).join('')}</ul>
      <p>來源 SHA ${esc(j.contract.sourceSha)}</p><p>來源雜湊 ${esc(j.contract.sourceHash)}</p><p>Worker SHA ${esc(j.contract.implementationSha)}</p><p>Run ${esc(j.contract.runId)}</p>
      <p>定價檢查時間 ${esc(j.contract.quote.checkedAt)}；有效至 ${esc(j.contract.quote.validUntil)}</p>
      <p>官方基礎價格 US$1 / US$5 每百萬 input / output tokens；僅標準模式、無工具、無快取或額外功能。</p>
      <ol>${j.events.map(e=>`<li>${esc(e.at)} · ${esc(e.kind)}</li>`).join('')}</ol></details>
    ${j.report ? `<section class="worker-report"><h4>成果${j.resultApplied ? '' : '（尚未完成治理核對）'}</h4>${markdownHTML(j.report)}</section>` : '<p>尚無模型成果。</p>'}</article>`).join('');
}
export function attachWorker({ projectId, source, root }) {
  const message = root.querySelector('.worker-message'), form = root.querySelector('form'), jobs = root.querySelector('.worker-jobs');
  root.querySelector('[data-worker-goal]').href = `#/p/${encodeURIComponent(projectId)}/now`;
  if (!source.limitedWorker) { message.textContent = '限定 Worker 未接通；EXE HOLD。'; return; }
  const show = data => { if (root.isConnected) jobs.innerHTML = jobsHTML(data); };
  let reading = false;
  const refresh = async () => {
    if (reading || !root.isConnected || document.hidden) return; reading = true;
    try { show(await source.limitedWorker(projectId)); } catch(e) { if(root.isConnected) message.textContent = e.message; } finally { reading = false; }
  };
  void (async () => { try {
    const data = await source.limitedWorker(projectId), queue = await source.queue(projectId); if(!root.isConnected) return;
    show(data); form.elements.goalId.innerHTML = queue.goals.map(g=>`<option value="${esc(g.goalId)}">${esc(g.text)}</option>`).join(''); form.hidden = !queue.goals.length;
    message.textContent = data.quote ? '官方文件已核對；帳戶可用性與真實模型執行尚未驗證。EXE HOLD。' : '定價未核實，禁止準備或執行。';
  } catch(e) { message.textContent=e.message; } })();
  form.addEventListener('submit', async e => { e.preventDefault(); e.stopPropagation(); const b=form.querySelector('button'); b.disabled=true;
    try { show(await source.prepareWorker(projectId,{ requestId:crypto.randomUUID(),goalId:form.elements.goalId.value,agentId:'limited-readme-worker' })); message.textContent='限定計畫已保存；未授權、未執行。'; }
    catch(e) {message.textContent=e.message;} finally{b.disabled=false;}
  });
  root.addEventListener('click',async e=>{const b=e.target.closest('[data-worker-act]');if(!b||b.disabled)return;b.disabled=true;
    try{show(await source.workerAction(projectId,b.dataset.id,{action:b.dataset.workerAct,requestId:crypto.randomUUID()}));message.textContent='條件／操作已記錄，EXE HOLD。';}
    catch(e){message.textContent=e.message;}finally{b.disabled=false;}
  });
  const timer=setInterval(()=>{if(!root.isConnected){clearInterval(timer);return;}void refresh();},3000);
}
