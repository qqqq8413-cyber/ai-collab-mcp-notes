import { readerIcon, markdownHTML } from './reader.generated.js';
// M2-0: tasks for the Human's own official Claude Code (Claude Pro subscription). CHIEF keeps the queue; Claude Code
// claims and finishes tasks through the local CHIEF MCP server, and the result appears here by itself.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = v => v ? new Date(v).toLocaleString('zh-TW', { hour12: false }) : '—';
export const SUB_LABELS = { PENDING: '等待 Claude Code 領取', RUNNING: 'Claude Code 處理中', COMPLETED: '已完成', FAILED: '失敗', CANCELLED: '已取消' };
const messages = { OBJECTIVE_REQUIRED: '請輸入任務內容。', OBJECTIVE_TOO_LONG: '任務內容最多 2,000 字。', TASK_LIMIT: '任務數量已達上限（200）。',
  TASK_ALREADY_FINISHED: '這個任務已經結束，不能取消。', TASK_STORE_BUSY: '任務佇列忙碌中，請再試一次。', TASK_STORE_INTEGRITY: '任務資料無法通過完整性檢查；沒有修改任何資料。',
  SUBSCRIPTION_TASKS_UNAVAILABLE: '這個 Host 沒有接上 Claude Code 任務佇列。請用 npm run workspace:m2 啟動。' };
const explain = e => messages[e?.code] ?? e?.message ?? String(e);

export function subscriptionHTML() {
  return `<section id="subscription-tasks" class="ai-preparation" aria-label="交給 Claude Code">
  <header class="auto-head"><h2>交給 Claude Code</h2><span class="auto-lock sub-mode">讀取中…</span></header>
  <p class="sub-message" role="status" aria-live="polite">讀取任務…</p>
  <form class="auto-form sub-create"><label class="worker-objective">要 Claude Code 完成什麼<textarea name="objective" maxlength="2000" rows="4" required></textarea></label>
    <p class="worker-delivery">由你自己登入的官方 Claude Code（Claude Pro 訂閱）領取並完成。CHIEF 不呼叫任何 API、不讀取或傳遞金鑰。Claude Code 只唯讀這個專案的檔案；完成後報告會自動出現在下方。</p>
    <button class="auto-button" type="submit">${readerIcon('add')} 建立任務</button></form>
  <details class="sub-runner"><summary>怎麼讓 Claude Code 處理任務</summary><div class="sub-runner-body"><p>讀取中…</p></div></details>
  <div class="sub-tasks"></div></section>`;
}

export function runnerHTML(executor) {
  const r = executor?.runner;
  if (!r) return '<p>這個 Host 沒有提供 Claude Code 啟動方式。</p>';
  return `<p>先確認 Claude Code 用 Pro 訂閱登入（在 Claude Code 輸入 <code>/status</code>），並在 claude.ai 關閉「額外使用額度」。請在一般的 macOS Terminal 視窗執行。</p>
    <h4>一次處理目前所有待辦任務</h4><pre>${esc(r.processOnce)}</pre>
    <p>啟動前會檢查：沒有 API 計費變數、登入方式是 Claude 訂閱、佇列有待辦任務。任一不符就不啟動。</p>
    <h4>或：互動模式持續處理</h4><pre>${esc(r.mcpAdd)}\n${esc(r.interactive)}</pre><p>進入 Claude Code 後輸入：</p><pre>${esc(r.loop)}</pre>
    <p>每一輪 /loop 都會用到一點 Pro 額度（即使佇列是空的）。只想處理一次時，用上面的「一次處理」。</p>`;
}

export function tasksHTML(data) {
  if (!data.tasks.length) return '<p class="auto-deferred">尚無任務。</p>';
  return data.tasks.map(t => `<article class="ai-plan" data-sub-task="${esc(t.taskId)}">
    <header class="auto-head"><h3>${esc(t.objective)}</h3><span class="auto-lock" data-state="${esc(t.state)}">${esc(t.state)} · ${esc(SUB_LABELS[t.state] ?? t.state)}</span></header>
    <dl class="auto-facts"><div><dt>任務編號</dt><dd>${esc(t.taskId.slice(0, 8))}</dd></div>
      <div><dt>處理者</dt><dd>官方 Claude Code（你的 Claude 訂閱）</dd></div>
      <div><dt>資料（唯讀）</dt><dd>${esc(t.source.repository)} · ${esc(t.source.readme)}${t.source.commitSha ? ` @ ${esc(t.source.commitSha.slice(0, 12))}` : ''}</dd></div>
      <div><dt>建立</dt><dd>${when(t.createdAt)}</dd></div><div><dt>領取</dt><dd>${when(t.claimedAt)}</dd></div><div><dt>結束</dt><dd>${when(t.finishedAt)}</dd></div></dl>
    ${t.failure ? `<p class="auto-error">停止原因：${esc(t.failure.code)}${t.failure.detail ? ` — ${esc(t.failure.detail)}` : ''}</p>` : ''}
    ${t.state === 'RUNNING' ? '<p class="auto-deferred">Claude Code 正在處理。若 Claude Code 已關閉或額度用完，任務不會自動重做；可以取消後重新建立。</p>' : ''}
    ${['PENDING', 'RUNNING'].includes(t.state) ? `<div class="auto-actions"><button class="auto-button" data-sub-cancel="${esc(t.taskId)}">${readerIcon('cancel')} 取消任務</button></div>` : ''}
    ${t.report ? `<section class="worker-report"><h4>Claude Code 的報告</h4>${markdownHTML(t.report)}</section>` : ''}</article>`).join('');
}

export function attachSubscription({ projectId, source, root }) {
  if (!root) return;
  const message = root.querySelector('.sub-message'), create = root.querySelector('.sub-create'), list = root.querySelector('.sub-tasks'),
    mode = root.querySelector('.sub-mode'), runner = root.querySelector('.sub-runner-body');
  if (!source.subscriptionTasks) { message.textContent = '此模式沒有接上 Claude Code 任務佇列。'; create.querySelector('button').disabled = true; mode.textContent = '未接通'; return; }
  let last = '', reading = false, runnerShown = false;
  const show = data => {
    if (!root.isConnected) return;
    mode.textContent = 'Pro 訂閱 · 不呼叫 API';
    if (!runnerShown) { runner.innerHTML = runnerHTML(data.executor); runnerShown = true; }
    const snapshot = JSON.stringify(data.tasks);
    if (snapshot === last) return;
    last = snapshot; list.innerHTML = tasksHTML(data);
  };
  const load = () => source.subscriptionTasks(projectId).then(show);
  void load().then(() => { message.textContent = '輸入任務後按「建立任務」，再啟動 Claude Code（方法見「怎麼讓 Claude Code 處理任務」）。狀態每 3 秒自動更新。'; },
    e => { // A Host without the queue (M0 rehearsal, the trusted Host) shows nothing of it.
      if (e?.code === 'SUBSCRIPTION_TASKS_UNAVAILABLE') { clearInterval(timer); root.remove(); return; }
      message.textContent = explain(e); mode.textContent = '未接通'; create.querySelector('button').disabled = true; });
  create.addEventListener('submit', async e => {
    e.preventDefault(); e.stopPropagation();
    const button = create.querySelector('button'), objective = create.elements.objective.value.trim();
    if (!objective || button.disabled) return;
    button.disabled = true;
    try { const data = await source.createSubscriptionTask(projectId, { objective }); show(data); create.reset();
      message.textContent = '任務已建立（PENDING）。現在啟動 Claude Code，它會領取這個任務，完成後報告會自動顯示。'; }
    catch (err) { message.textContent = explain(err); }
    finally { button.disabled = false; }
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-sub-cancel]'); if (!b || b.disabled) return;
    b.disabled = true;
    try { show(await source.subscriptionTaskAction(projectId, b.dataset.subCancel, { action: 'CANCEL' })); message.textContent = '任務已取消；Claude Code 之後回報的結果不會被接受。'; }
    catch (err) { message.textContent = explain(err); b.disabled = false; }
  });
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    if (reading || document.hidden) return;
    reading = true;
    void load().catch(err => { message.textContent = explain(err); }).finally(() => { reading = false; });
  }, 3000);
}
