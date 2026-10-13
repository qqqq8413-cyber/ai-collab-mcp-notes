// G1-WE1-R0: the read-only governed execution status of one goal, as the trusted host projects it.
// Pure: no DOM, no storage, no network (tested in test-workspace-ui.mjs). It only words what the server
// says. It never decides lifecycle or provenance itself, offers no execution, recovery or authorization
// control, shows no progress or agent activity, and never says AI is working: a status is an operational
// projection, not execution authority.

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const EXECUTION_LABELS = Object.freeze({
  GOAL_NOT_GOVERNED: '尚未建立正式治理變更',
  RUN_NOT_ADMITTED: '已建立正式變更，尚未建立執行任務',
  ROOT_PENDING: '執行任務建立中斷，等待人工重新建立',
  RUN_IDLE: '執行任務已建立，尚未開始',
  WAITING_PACKET: '等待正式工作文件',
  BLOCKED_AUTHORITY: '缺少必要授權',
  BLOCKED_PROVENANCE: '工作來源無法確認，已停止執行',
  WAITING_EXTERNAL_ACTOR: '等待其他角色處理',
  WAITING_HUMAN: '需要人工處理',
  IN_PROGRESS: '工作已有執行紀錄',
  TERMINAL: '工作流程已結束',
  GOVERNANCE_CONFLICT: '治理紀錄互相矛盾，已停止判讀',
});
const EXPLAIN = Object.freeze({
  GOAL_NOT_GOVERNED: '這個目標還沒有對應的正式變更紀錄，所以也沒有執行任務。',
  RUN_NOT_ADMITTED: '正式變更已存在，但還沒有建立它唯一的執行任務。',
  ROOT_PENDING: '上次建立執行任務時中斷，留下了待完成的登記。這裡不會自動補完。',
  RUN_IDLE: '執行任務存在，但還沒有進入架構階段，也沒有正式工作文件。',
  WAITING_PACKET: '已進入架構階段，還沒有發出正式工作文件。',
  BLOCKED_AUTHORITY: '這個任務依據的正式文件或授權，在授權封存裡找不到完全相符的版本。',
  WAITING_EXTERNAL_ACTOR: '下一步屬於 Architect、控制器或其他角色，不是這個畫面能代為處理的。',
  WAITING_HUMAN: '下一步只能由人工決定，例如恢復、授權或其他人工處理。',
  IN_PROGRESS: '這個任務已有受治理的執行紀錄。這不代表 AI 此刻正在運作。',
  TERMINAL: '流程結束不等於成果已交付或已驗收。',
  GOVERNANCE_CONFLICT: '治理儲存裡的紀錄彼此不一致。系統不會自動修復，需要人工檢查。',
});
// RP1-C1 blocks these on purpose. They are not errors to repair here, and nothing here forces past them.
export const PROVENANCE_EXPLAIN = Object.freeze({
  ACTIVATION_LINEAGE_MISSING: '這個任務不是經由正式啟動流程進入工作狀態。',
  ACTIVATION_LINEAGE_FOREIGN: '啟動這個任務的 Architect 身分與目前設定的不同。',
  ACTIVATION_PACKET_MISMATCH: '目前的工作文件與正式啟動時綁定的文件不一致。',
  PACKET_REISSUED: '工作文件在退回架構階段後被重新發出；目前沒有經過核准的重新啟動流程。',
  REVIEW_LINEAGE_FOREIGN: '驗收審查是由另一個 Architect 身分開始或決定的。',
  CORRECTION_LINEAGE_FOREIGN: '修正文件是由另一個 Architect 身分發出的。',
  CORRECTION_LINEAGE_UNBOUND: '修正文件不是緊接在它回應的退件之後發出（例如中間曾停止再恢復）。',
});
const DEAD_END = '這不是要自動修復的錯誤。要繼續，需要 Architect 另行決定一個能證明來源的恢復方式；這裡不提供強制繼續。';
const ATTENTION = Object.freeze({
  NONE: '不需要人工或 Architect 介入',
  HUMAN: '需要人工處理',
  ARCHITECT: '需要 Architect 處理',
  HUMAN_AND_ARCHITECT: '需要人工與 Architect 處理',
  AUTOMATED_ACTOR: '等待受治理的自動流程；這個 Workspace 無法啟動它',
});
const ROLE = Object.freeze({ HUMAN: '人工', GPT_ARCHITECT: 'Architect', CODEX_IMPLEMENTER: '實作代理', CONTROLLER: '控制器', GITHUB: 'GitHub' });
const ACTION = Object.freeze({
  ENTER_ARCHITECTURE: '進入架構階段', ISSUE_PACKET: '發出正式工作文件', BEGIN_IMPLEMENTATION: '開始實作',
  REPORT_IMPLEMENTATION_COMPLETE: '回報實作結果', RECORD_REMOTE_SHA: '記錄遠端版本', BEGIN_REMOTE_ACCEPTANCE: '開始驗收審查',
  ACCEPT_EXACT_SHA: '接受這個版本', REJECT_EXACT_SHA: '退回這個版本', ISSUE_CORRECTION_PACKET: '發出修正文件',
  AUTHORIZE_PROMOTION: '授權併入主線', MARK_PROMOTING: '開始併入主線', RECORD_PROMOTED_MAIN: '記錄主線版本',
  RECOVER_PROMOTED_MAIN: '核對主線版本', CLOSE_VERIFIED_RUN: '核對後結束流程', RECOVER_CLOSE: '核對後結束流程',
  RECONCILE_PENDING: '等待主線檢查結果', RECHECK_EXTERNAL_REALITY: '重新核對外部狀態', RESUME_HUMAN_STOP: '人工恢復',
  RESUME_SOFT_WITH_REPAIR: '修復後恢復', BUDGET_EXHAUSTED: '預算用盡停止', RETURN_TO_ARCHITECTURE: '回到架構階段', STOP: '停止',
});
const KIND = Object.freeze({ IMPLEMENTATION_PACKET: '正式工作文件', CORRECTION_PACKET: '修正文件', ACCEPTANCE_DECISION: '驗收決定',
  AUTHORIZATION: '人工授權' });
/** Statuses with no governed execution record yet: the queue's own wording stays true for them. */
export const NOT_STARTED = Object.freeze(['GOAL_NOT_GOVERNED', 'RUN_NOT_ADMITTED', 'ROOT_PENDING', 'RUN_IDLE', 'WAITING_PACKET']);

/** The goal's current wording on the stage: the queue wording until the governed status shows recorded execution. */
export function executionNow(entry) {
  const status = entry?.state === 'ready' ? entry.view?.status : undefined;
  return status && EXECUTION_LABELS[status] && !NOT_STARTED.includes(status) ? EXECUTION_LABELS[status] : '排隊中 · 尚未開始執行';
}

const refresh = '<button class="btn quiet exec-r" type="button" data-act="exec-refresh">重新讀取</button>';
const shell = (body, withRefresh = true) => `<section class="exec" aria-labelledby="exec-h"><header class="exec-h"><h2 class="lbl" id="exec-h">執行狀態</h2>${withRefresh ? refresh : ''}</header>${body}</section>`;

/** `entry`: { state: 'loading' | 'ready' | 'disabled' | 'demo' | 'error', view?, message? }. */
export function executionStatusHTML(entry) {
  if (!entry || entry.state === 'loading') return shell('<p class="exec-x">讀取中…</p>', false);
  if (entry.state === 'demo') return shell('<p class="exec-x">示範模式不讀取正式執行狀態。</p>', false);
  if (entry.state === 'disabled') return shell('<p class="exec-x">這個 Workspace 沒有啟用執行狀態檢視。工作清單照常可用。</p>', false);
  if (entry.state !== 'ready' || !entry.view || !EXECUTION_LABELS[entry.view.status]) {
    return shell(`<p class="exec-x">目前無法讀取執行狀態${entry.message ? `：${esc(entry.message)}` : '。'}</p>`);
  }
  const view = entry.view;
  const lines = [];
  const reason = view.status === 'BLOCKED_PROVENANCE' ? PROVENANCE_EXPLAIN[view.reason] : undefined;
  if (reason) lines.push(`<p class="exec-x">${esc(reason)}</p><p class="exec-x">${DEAD_END}</p>`);
  else lines.push(`<p class="exec-x">${EXPLAIN[view.status]}</p>`);
  const facts = [`<dt>需要誰</dt><dd>${esc(ATTENTION[view.attention] ?? view.attention)}</dd>`];
  if (view.reason) facts.push(`<dt>原因代碼</dt><dd><code>${esc(view.reason)}</code></dd>`);
  if (view.run) facts.push(`<dt>流程狀態</dt><dd><code>${esc(view.run.state)}</code>${view.run.terminal ? '（已結束）' : ''}</dd>`);
  if (view.nextMoves?.length) {
    facts.push(`<dt>下一步</dt><dd>${view.nextMoves.map((move) => `${esc(ACTION[move.action] ?? move.action)}（${esc(ROLE[move.role] ?? move.role)}）`).join('、')}</dd>`);
  }
  facts.push('<dt>能否呼叫 AI 模型</dt><dd>未評估：這裡沒有載入即時呼叫設定，不會宣稱可以執行</dd>');
  if (view.directAuthority?.length) {
    facts.push(`<dt>已封存的正式授權</dt><dd>${view.directAuthority.map((item) => `${esc(KIND[item.kind] ?? item.kind)} ${esc(item.authorityId)} 第 ${esc(item.version)} 版`).join('、')}</dd>`);
  }
  if (view.unresolvedAuthority?.length) {
    facts.push(`<dt>找不到相符版本</dt><dd>${view.unresolvedAuthority.map((item) => `${esc(KIND[item.kind] ?? item.kind)} ${esc(item.authorityId)}（<code>${esc(item.resolution)}</code>）`).join('、')}</dd>`);
  }
  if (view.operationalProvenance) {
    facts.push(`<dt>營運紀錄（不是授權）</dt><dd>${view.operationalProvenance.activationBound ? '有正式啟動綁定' : '沒有正式啟動綁定'}</dd>`);
  }
  return shell(`<p class="exec-s exec-${esc(view.status.toLowerCase().replace(/_/g, '-'))}">${EXECUTION_LABELS[view.status]}</p>${lines.join('')}
    <dl class="ctx exec-d">${facts.join('')}</dl><p class="exec-n">唯讀狀態，不是執行授權；這裡沒有啟動、恢復或授權的操作。</p>`);
}
