import { readerIcon } from './reader.generated.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blockers = {
  SOURCE_GOAL_REMOVED: '原始目標已移除；保留草案但禁止準備或執行',
  EXE_HOLD: 'EXE 尚未解除 HOLD', H1_H9_NOT_GRANTED: '未取得正式 Human 授權',
  MODEL_BINDING_NOT_PROBED: '模型名稱僅為申請值，尚未驗證', COST_ENFORCEMENT_NOT_IMPLEMENTED: '費用硬上限尚未實作',
  SINGLE_TASK_ADAPTER_NOT_AVAILABLE: '缺少限定單次文件審查的執行 adapter',
  GOVERNANCE_NOT_CONFIGURED: '治理橋接未接通', ADMISSION_NOT_CONFIGURED: 'Run admission 未接通',
  AUTHORITY_STATUS_NOT_CONFIGURED: '授權狀態唯讀查詢未接通', DRIVER_NOT_COMPOSED: '執行 Driver 未啟用',
  INVOCATION_READER_NOT_COMPOSED: 'Invocation Journal 未接通（不是零次執行的證明）',
  IMPLEMENTATION_ADAPTER_REQUIRES_BRANCH_WRITES: '現有 Claude 實作角色需要分支寫入，與本次唯讀範圍不符',
  REVIEW_ADAPTER_REQUIRES_IMPLEMENTATION_LINEAGE: '現有 Codex 審查角色需要先有實作版本及審查封包',
};
export function aiPilotHTML() {
  return `<section id="ai-pilot" class="ai-preparation" aria-label="AI 工作準備">
    <header class="auto-head"><h2>AI 工作準備</h2><span class="auto-lock">EXE HOLD · 尚未啟動</span></header>
    <p class="ai-message" role="status">讀取限定工作…</p>
    <a data-ai-goal>建立目標</a>
    <form class="auto-form ai-form" hidden>
      <label>既有目標<select name="goalId" required></select></label>
      <label>指定 Agent<select name="agentId" required></select></label>
      <button class="auto-button" type="submit">${readerIcon('add')} 建立權限申請草案</button>
    </form>
    <div class="ai-plans"></div>
  </section>`;
}
export function aiPlansHTML(plans) {
  return plans.map(p => `<article class="ai-plan">
    <header class="auto-head"><h3>${esc(p.agent.name)} · ${esc(p.objective ?? '原始目標已移除')}</h3><span class="auto-lock">準備流程 · EXE HOLD</span></header>
    <dl class="auto-facts"><div><dt>模型申請值（未探測）</dt><dd>${esc(p.requestedModel)}</dd></div>
      <div><dt>治理紀錄</dt><dd>${esc(p.governance?.change?.changeId ?? '尚未建立')}</dd></div>
      <div><dt>Run</dt><dd>${esc(p.admission?.runId ?? '尚未建立')} · ${esc(p.execution?.status ?? '未接通')}</dd></div>
      <div><dt>實際 Invocation</dt><dd>${p.invocations === null ? '未接通' : `${p.invocations.length} 筆`}</dd></div></dl>
    <div class="auto-actions">
      <button class="auto-button" data-ai-action="PREPARE" data-id="${esc(p.requestId)}" ${p.sourceMissing ? 'disabled' : ''}>${readerIcon('add')} 準備受控工作（不執行）</button>
      <button class="auto-button" data-ai-action="CHECK" data-id="${esc(p.requestId)}">${readerIcon('refresh')} 檢查條件</button>
      <button class="auto-button" disabled title="EXE HOLD；草案不是正式授權">${readerIcon('play')} 啟動執行</button>
    </div>
    <h4>啟動阻礙</h4><ul>${p.blockers.map(b => `<li>${esc(blockers[b] ?? b)}</li>`).join('')}</ul>
    <details><summary>限定 Pilot Permit 草案 · 非授權</summary>
      <p>僅讀 README.md（上限 16KB），只寫隔離成果目錄；禁止原始碼／Git 寫入、push、部署及授權修改。</p>
      <p>申請上限 US$1，定價未知、硬上限未實作。最多一次模型呼叫，輸入 4096／輸出 2048 tokens，300 秒，零重試。有效期間待 Human 核發後一小時。</p>
      <pre>${esc(JSON.stringify(p.permit, null, 2))}</pre>
    </details>
    <details><summary>來源識別與進度</summary><p>OPERATIONAL_RECORD · 非授權</p><p>Goal ${esc(p.goalId)}</p><p>Plan ${esc(p.requestId)}</p><p>目標雜湊 ${esc(p.objectiveHash)}</p>
      <pre>${esc(JSON.stringify({ execution: p.execution, driverInspection: p.driverInspection, invocations: p.invocations }, null, 2))}</pre></details>
  </article>`).join('');
}
export function attachAiPilot({ projectId, source, root }) {
  const message = root.querySelector('.ai-message'), form = root.querySelector('form'), results = root.querySelector('.ai-plans');
  root.querySelector('[data-ai-goal]').href = `#/p/${encodeURIComponent(projectId)}/now`;
  if (!source.aiPilot) { message.textContent = 'AI 工作準備未接通；EXE HOLD。'; return; }
  const show = data => { if (root.isConnected) results.innerHTML = aiPlansHTML(data.plans); };
  let pending = null;
  void (async () => {
    try {
      const data = await source.aiPilot(projectId), queue = await source.queue(projectId);
      if (!root.isConnected) return;
      form.elements.goalId.innerHTML = queue.goals.map(g => `<option value="${esc(g.goalId)}">${esc(g.text)}</option>`).join('');
      form.elements.agentId.innerHTML = data.agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
      form.hidden = !queue.goals.length;
      message.textContent = queue.goals.length ? '權限申請草案 · 尚未核發；準備工作只建立 IDLE Run。' : '尚無目標。請先建立本次限定文件審查目標。';
      show(data);
    } catch (e) { if (root.isConnected) message.textContent = e.message; }
  })();
  form.addEventListener('submit', async e => {
    e.preventDefault(); e.stopPropagation();
    const button = form.querySelector('button'); button.disabled = true;
    const input = { goalId: form.elements.goalId.value, agentId: form.elements.agentId.value };
    if (!pending || pending.goalId !== input.goalId || pending.agentId !== input.agentId) pending = { ...input, requestId: crypto.randomUUID() };
    try { show(await source.createAiPilot(projectId, pending)); message.textContent = '草案已儲存；尚未授權或執行。'; }
    catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  root.addEventListener('click', async e => {
    const button = e.target.closest('[data-ai-action]'); if (!button || button.disabled) return;
    button.disabled = true;
    try {
      show(await source.aiPilotAction(projectId, button.dataset.id, { action: button.dataset.aiAction, requestId: crypto.randomUUID() }));
      message.textContent = button.dataset.aiAction === 'PREPARE' ? '受控工作已準備／查詢；實際狀態見 Run。EXE HOLD，本次操作沒有模型呼叫。' : '條件已重新查詢；EXE HOLD。';
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
