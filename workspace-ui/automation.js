import { readerIcon } from './reader.generated.js';
import { aiPilotHTML, attachAiPilot } from './ai-pilot.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = iso => iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—';
const status = { QUEUED: '排隊中', DEFERRED: '預算延後', READY: '就緒', RUNNING: '執行中', WAITING_FOR_HUMAN: '等待你決定', COMPLETED: '已完成', FAILED: '失敗', CANCELLED: '已取消', HOLD: 'HOLD' };
const modes = { MANUAL: '手動', SCHEDULED: '週期', EVENT_DRIVEN: '事件觸發' };
const history = new Map(), drafts = new Map();
let mounted = null, reading = false;
let roomSummary = null;
const button = (action, label, icon, id, disabled = false) => `<button type="button" class="auto-button" data-auto-act="${action}" data-id="${id}" title="${label}" ${disabled ? 'disabled' : ''}>${readerIcon(icon)}<span>${label}</span></button>`;
const external = (url, label) => {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://github.com' || !u.pathname.startsWith('/qqqq8413-cyber/ai-collab-mcp-notes/actions/runs/') || u.username || u.password) return esc(label);
    return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  } catch { return esc(label); }
};
function resultHTML(result) {
  if (!result) return '';
  return `<p>${esc(result.source)} · 產出 ${time(result.observedAt)} · 來源觀察 ${time(result.sourceObservedAt ?? result.observedAt)}</p>
    ${result.sourceRunId ? `<p>來源執行：${esc(result.sourceRunId)}</p>` : ''}
    ${result.failures.map(f => `<p class="auto-error">${esc(f)}</p>`).join('')}
    <ul>${result.snapshot.map(r => `<li>${external(r.url, `${r.name} #${r.number}`)} · attempt ${r.attempt}<p><code>${esc(r.sha)}</code> · ${esc(r.branch)}</p><p>${esc(r.status)} / ${esc(r.conclusion ?? '尚無結果')}</p>${r.jobs.map(j => `<p>${esc(j.name)} · ${esc(j.platform)} · ${esc(j.conclusion ?? j.status)}</p>`).join('')}</li>`).join('')}</ul>`;
}

export function automationHTML() {
  return `<section class="auto-page" id="automation" aria-label="自動化">
    <header class="auto-head"><div><h1>自動化</h1><p>CHIEF CI WATCH</p></div><span class="auto-lock">AI 執行 · HOLD</span></header>
    <div class="auto-message" role="status"></div>
    ${aiPilotHTML()}
    <details class="auto-create" open><summary>新增自動化工作</summary><form id="auto-form" class="auto-form">
      <label>工作名稱<input name="name" maxlength="100" required value="CHIEF CI WATCH"></label>
      <label>工作類型<select name="type"><option value="CI_WATCH">GitHub CI 監看</option><option value="CI_REPORT">CI 狀態摘要（本機）</option></select></label>
      <label>執行方式<select name="mode"><option value="MANUAL">手動</option><option value="SCHEDULED">週期</option><option value="EVENT_DRIVEN">CI 狀態變更後</option></select></label>
      <label>週期間隔（秒；建議 300）<input name="intervalSeconds" type="number" min="60" max="86400" value="300" required></label>
      <label>手動重試上限<input name="maxRetries" type="number" min="0" max="2" value="1" required></label>
      <label>摘要來源<select name="sourceTaskId"><option value="">選擇 CI WATCH</option></select></label>
      <button class="btn" type="submit">${readerIcon('add')} 建立工作</button>
    </form></details>
    <div class="auto-results" aria-live="polite"><p>讀取工作紀錄…</p></div>
  </section>`;
}

function display(root, data) {
  if (root.dataset.taskCount === undefined || root.dataset.taskCount === '0' && data.tasks.length) root.querySelector('.auto-create').open = data.tasks.length === 0;
  root.dataset.taskCount = String(data.tasks.length);
  const selected = root.querySelector('[name=sourceTaskId]').value;
  const source = root.querySelector('[name=sourceTaskId]');
  source.innerHTML = '<option value="">選擇 CI WATCH</option>' + data.tasks.filter(t => t.type === 'CI_WATCH').map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  source.value = selected;
  const before = new Set([...root.querySelectorAll('details[open]')].map(d => d.dataset.key));
  const main = root.querySelector('.auto-results');
  const old = JSON.stringify(data);
  if (root.dataset.snapshot === old) return;
  root.dataset.snapshot = old;
  const tasks = data.tasks.map(t => {
    const runs = data.runs.filter(r => r.taskId === t.id), last = runs.at(-1);
    const busy = runs.some(r => ['RUNNING', 'QUEUED', 'DEFERRED'].includes(r.state));
    return `<article class="auto-task" data-task="${t.id}"><header><div><h2>${esc(t.name)}</h2><p>${t.type === 'CI_WATCH' ? 'GitHub Actions' : '本機已驗證 CI 紀錄'} · ${modes[t.mode]} · ${t.enabled ? '已啟用' : '未啟用'}</p></div><span class="auto-state" data-state="${t.state}">${status[t.state]}</span></header>
      <dl class="auto-facts"><div><dt>最後更新</dt><dd>${time(t.updatedAt)}</dd></div><div><dt>下次執行／待辦恢復</dt><dd>${time(t.budgetDeferral?.until ?? t.nextDueAt)}</dd></div><div><dt>讀取頻率</dt><dd>${t.mode === 'SCHEDULED' ? `每 ${t.intervalSeconds} 秒` : modes[t.mode]}</dd></div><div><dt>需要你決策</dt><dd>否（唯讀工作）</dd></div></dl>
      ${t.budgetDeferral ? `<p class="auto-deferred">GitHub 讀取額度不足；延至 ${time(t.budgetDeferral.until)}。不是執行失敗。</p>` : ''}
      <div class="auto-actions">${button('RUN', t.type === 'CI_WATCH' ? '立即檢查' : '產生摘要', 'refresh', t.id, busy)}${t.mode !== 'MANUAL' ? button(t.enabled ? 'PAUSE' : 'ENABLE', t.enabled ? '暫停排程' : '啟用監測', t.enabled ? 'pause' : 'play', t.id) : ''}${button('STOP', '停止執行', 'stop', t.id, !busy && !t.enabled)}${button('CANCEL', '取消待辦', 'cancel', t.id, !runs.some(r => ['QUEUED', 'DEFERRED'].includes(r.state)))}${button('RETRY', '重試', 'retry', t.id, !last || last.state !== 'FAILED' || last.retryCount >= t.maxRetries)}</div>
      ${last?.error ? `<p class="auto-error">${esc(last.error)}</p>` : ''}
      ${last?.result ? `<p class="auto-outcome">最近檢查：${time(last.result.observedAt)} · ${last.result.snapshot.length} 個 CI · ${last.result.firstBaseline ? '初次基線' : `${last.result.changed} 項變更`}${last.result.failures.length ? ` · ${last.result.failures.length} 項異常` : ''}</p>` : ''}
      <details data-key="task-${t.id}"><summary>執行紀錄（${runs.length}）</summary><ol class="auto-runs">${[...runs].reverse().map(r => `<li><b>${status[r.state]}</b> · ${esc(r.trigger)} · ${time(r.createdAt)}<p>啟動 ${time(r.startedAt)} · 結束 ${time(r.endedAt)}</p><p>${esc(r.steps.join(' → '))}</p>${r.error ? `<p class="auto-error">${esc(r.error)}</p>` : ''}<details data-key="run-${r.id}"><summary>證據與識別資訊</summary><code>${r.id}</code><p>OPERATIONAL_RECORD · 非授權紀錄</p><p>${esc(r.occurrence)}</p>${resultHTML(r.result)}</details></li>`).join('')}</ol></details>
    </article>`;
  }).join('');
  const ci = [...data.ci].sort((a, b) => b.id - a.id).map(r => `<article class="auto-ci"><header><h3>${external(r.url, `${r.name} #${r.number}`)}</h3><span>${esc(r.status)} / ${esc(r.conclusion ?? '尚無結果')}</span></header><p>${esc(r.branch)} · attempt ${r.attempt} · ${time(r.updatedAt)}</p><code>${esc(r.sha)}</code><ul>${r.jobs.map(j => `<li>${external(j.url, j.name)} <span>${esc(j.platform)} · ${esc(j.status)} / ${esc(j.conclusion ?? '尚無結果')}</span>${j.requiredMacSkip ? '<b class="auto-error">必要 macOS 檢查被跳過</b>' : ''}${j.steps.filter(s => s.conclusion && s.conclusion !== 'success').map(s => `<p>${esc(s.name)}: ${esc(s.conclusion)}</p>`).join('')}</li>`).join('')}</ul></article>`).join('');
  main.innerHTML = `${data.fault ? `<p class="auto-error">${esc(data.fault)}</p>` : ''}${data.budget ? `<dl class="auto-facts" aria-label="GitHub 讀取預算"><div><dt>滾動一小時額度（所有專案共用）</dt><dd>剩餘 ${data.budget.remaining} / ${data.budget.limit}</dd></div><div><dt>下次可讀取</dt><dd>${data.budget.nextAvailableAt ? time(data.budget.nextAvailableAt) : '目前可用'}</dd></div></dl>` : ''}<section><h2 class="auto-section-title">工作（${data.tasks.length}）</h2>${tasks || '<p>尚未建立自動化工作。</p>'}</section>
    <section><h2 class="auto-section-title">GitHub CI 結果</h2>${ci || '<p>尚未讀取 GitHub。</p>'}</section>
    <details data-key="changes"><summary>狀態觀察紀錄（${data.changes.length}）</summary><ol class="auto-runs">${[...data.changes].reverse().map(c => `<li>${time(c.observedAt)} · CI ${c.ciRunId} · ${esc(c.kind)}<p>${esc(c.before ?? '無先前觀察')} → ${esc(c.after)}</p></li>`).join('')}</ol></details>
    <details data-key="operations"><summary>操作紀錄（${data.operations.length}）</summary><ol class="auto-runs">${[...data.operations].reverse().map(o => `<li>${time(o.at)} · ${esc(o.action)}<p>Task ${esc(o.taskId)}</p><code>${esc(o.requestId)}</code></li>`).join('')}</ol></details>`;
  for (const d of main.querySelectorAll('details')) if (before.has(d.dataset.key)) d.open = true;
}

function constrain(root) {
  const form = root.querySelector('#auto-form'), type = form.elements.type.value;
  const event = form.elements.mode.querySelector('[value=EVENT_DRIVEN]');
  event.disabled = type === 'CI_WATCH';
  if (event.disabled && form.elements.mode.value === 'EVENT_DRIVEN') form.elements.mode.value = 'MANUAL';
  form.elements.sourceTaskId.disabled = type !== 'CI_REPORT';
  form.elements.sourceTaskId.required = type === 'CI_REPORT';
  form.elements.intervalSeconds.disabled = form.elements.mode.value !== 'SCHEDULED';
}

async function refresh() {
  if (reading || !mounted?.root.isConnected || document.hidden) return;
  const current = mounted; reading = true;
  try {
    const data = await current.source.automations(current.projectId);
    history.set(current.projectId, data);
    if (current.root.isConnected) { display(current.root, data); current.root.querySelector('.auto-message').textContent = ''; }
  } catch (e) { if (current.root.isConnected) current.root.querySelector('.auto-message').textContent = e.message; }
  finally { reading = false; }
}

export function attachAutomation({ projectId, source, root }) {
  if (!root || mounted?.root === root) return;
  mounted = { projectId, source, root };
  attachAiPilot({ projectId, source, root: root.querySelector('#ai-pilot') });
  const form = root.querySelector('#auto-form');
  const draft = drafts.get(projectId);
  if (draft) for (const [name, value] of Object.entries(draft)) if (form.elements[name] && name !== 'sourceTaskId') form.elements[name].value = value;
  if (!source.automations) { root.querySelector('.auto-message').textContent = '此模式未接上自動化；不會讀取或執行。'; form.hidden = true; return; }
  const cache = history.get(projectId); if (cache) display(root, cache);
  if (draft?.sourceTaskId) form.elements.sourceTaskId.value = draft.sourceTaskId;
  constrain(root);
  const remember = () => drafts.set(projectId, Object.fromEntries([...form.elements].filter(el => el.name).map(el => [el.name, el.value])));
  form.addEventListener('input', remember);
  form.addEventListener('change', () => { constrain(root); remember(); });
  form.addEventListener('submit', async e => {
    e.preventDefault(); e.stopPropagation();
    const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    try {
      const input = { requestId: crypto.randomUUID(), name: form.elements.name.value, type: form.elements.type.value,
        mode: form.elements.mode.value, intervalSeconds: Number(form.elements.intervalSeconds.value), maxRetries: Number(form.elements.maxRetries.value),
        ...(form.elements.type.value === 'CI_REPORT' ? { sourceTaskId: form.elements.sourceTaskId.value } : {}) };
      const data = await source.createAutomation(projectId, input); history.set(projectId, data); display(root, data);
      root.querySelector('.auto-message').textContent = '已建立；週期與事件監測預設未啟用。';
    } catch (error) { root.querySelector('.auto-message').textContent = error.message; }
    finally { submit.disabled = false; }
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-auto-act]'); if (!b || b.disabled) return;
    b.disabled = true;
    try {
      const data = await source.automationAction(projectId, b.dataset.id, { action: b.dataset.autoAct, requestId: crypto.randomUUID() });
      history.set(projectId, data); display(root, data); root.querySelector('.auto-message').textContent = '操作已記錄。';
    } catch (error) { root.querySelector('.auto-message').textContent = error.message; b.disabled = false; }
  });
  void refresh();
}
setInterval(() => { void refresh(); }, 2000);

export function attachAutomationSummary({ projectId, source, root }) {
  if (!root || roomSummary?.root === root) return;
  roomSummary = { projectId, source, root };
  void refreshSummary();
}
async function refreshSummary() {
  const current = roomSummary;
  if (!current?.root.isConnected || !current.source.automations || document.hidden || current.reading) return;
  current.reading = true;
  try {
    const data = await current.source.automations(current.projectId);
    if (!current.root.isConnected) return;
    const last = data.runs.at(-1), task = data.tasks.find(t => t.id === last?.taskId);
    current.root.innerHTML = `<a href="#/p/${encodeURIComponent(current.projectId)}/automation">自動化紀錄</a><span>${last ? `${esc(task?.name ?? '工作')} · ${status[last.state]} · ${time(last.endedAt ?? last.startedAt ?? last.createdAt)}` : '尚無執行紀錄'}</span><small>OPERATIONAL_RECORD · 非授權</small>`;
  } catch {
    if (current.root.isConnected) current.root.textContent = '自動化紀錄未接通；AI 公開回覆紀錄不受影響。';
  } finally { current.reading = false; }
}
setInterval(() => { void refreshSummary(); }, 3000);
