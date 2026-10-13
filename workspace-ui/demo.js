// DEMO data source: explicitly enabled with ?demo=1 and labelled on screen.
// Everything lives in this page's memory. It never calls the Workspace server, never
// writes the LIVE goal queue, and every id it makes starts with "demo-".

const PROJECTS = [
  { projectId: 'demo-candidate', displayName: '示範：候選人平台', repository: '示範資料（沒有連到任何 repository）' },
  { projectId: 'demo-site', displayName: '示範：嶼光官網', repository: '示範資料（沒有連到任何 repository）' },
];
const SAMPLE = { 'demo-candidate': ['繼續做候選人平台，做到可以上線', '整理候選人資料欄位，列出缺少的部分'], 'demo-site': [] };
// 協作室 fixture (WS-P1): a short AI collaboration record for one demo project, minutes after a start time; the other
// project has none, so the room's empty state shows too. None of this happened. Every id starts with "demo-", and the
// room labels it as demo data.
const CHIEF = { actor: 'Chief', role: '統籌' };
const IMPLEMENTER = { actor: 'Claude', role: '實作' };
const REVIEWER = { actor: 'GPT', role: '審查' };
const SYS = { actor: '系統' };
// [minute, type, from, to, body, evidence] — `to` names who a message was sent to (UI-C1); an escalation goes to the Human.
const ROOM = [
  [0, 'SYSTEM', SYS, null, '示範工作「修正登入逾時」開始協作。'],
  [1, 'HANDOFF', CHIEF, ['Claude', 'GPT'], '「修正登入逾時」交給 Claude 實作，GPT 負責審查。範圍只限登入流程。'],
  [2, 'PROPOSAL', IMPLEMENTER, ['Chief', 'GPT'], '收到。我會先處理 auth middleware，不修改 database schema。'],
  [3, 'QUESTION', REVIEWER, ['Claude'], 'refresh token 的現有行為要保留嗎？'],
  [4, 'RESPONSE', IMPLEMENTER, ['GPT'], '保留。只調整 access token 過期時的判斷。'],
  [5, 'AGREEMENT', REVIEWER, ['Claude'], '好，那就不動 database schema，保留 refresh token 行為。'],
  [12, 'HANDOFF', IMPLEMENTER, ['GPT'], '第一版完成了，交給你審查。', [{ kind: 'COMMIT', sha: '3f9c2a1e5b7d' }]],
  [15, 'CHALLENGE', REVIEWER, ['Claude'], '我發現一個問題：expired refresh token 會提前被拒絕。', [{ kind: 'FILE', path: 'src/auth/middleware.ts', lines: '84–112' }]],
  [17, 'RESPONSE', IMPLEMENTER, ['GPT'], '你說得對。我改成在 authorization stage 才拒絕。'],
  [19, 'EVIDENCE', IMPLEMENTER, ['GPT'], '改好了，auth 測試也重跑了。', [{ kind: 'COMMIT', sha: '8d04be97c1a2' }]],
  [22, 'EVIDENCE', REVIEWER, ['Claude', 'Chief'], '我重新驗證過，全部通過。', [{ kind: 'TESTS', label: 'auth', passed: 18, failed: 0 }]],
  [23, 'AGREEMENT', REVIEWER, ['Claude'], '同意：expired refresh token 改在 authorization stage 才拒絕。'],
  [24, 'PROPOSAL', REVIEWER, ['Claude'], '要不要順便把 /session 的回傳格式改成新版？這會改到 public API contract。'],
  [25, 'RESPONSE', IMPLEMENTER, ['GPT', 'Chief'], '這超出這次的範圍，我們不能自己決定。Chief，要請你問一下。'],
  [26, 'ESCALATION', CHIEF, null, 'Claude 和 GPT 無法自行決定要不要修改 public API contract，需要你決定。'],
];
function roomOf(projectId, start) {
  if (projectId !== 'demo-candidate') return [];
  return ROOM.map(([minute, type, who, to, body, evidence], index) => ({
    id: `demo-ev-${String(index + 1).padStart(2, '0')}`, projectId, goalId: 'demo-goal-auth', ...who, ...(to ? { to } : {}), type, body,
    timestamp: new Date(start + minute * 60_000).toISOString(), ...(evidence ? { evidence } : {}),
  }));
}

export function createDemoSource({ now = () => new Date().toISOString() } = {}) {
  let counter = 0;
  const id = () => `demo-${String(++counter).padStart(4, '0')}`;
  const queues = new Map();
  const listeners = new Set();
  const emit = (name, data) => { for (const listener of listeners) listener(name, data); };
  for (const project of PROJECTS) {
    const queue = { projectId: project.projectId, revision: 0, goals: [], history: [] };
    for (const text of SAMPLE[project.projectId]) add(queue, text);
    queues.set(project.projectId, queue);
  }
  function add(queue, text) {
    const at = now();
    const goal = { goalId: id(), projectId: queue.projectId, text, createdAt: at, status: 'QUEUED',
      classification: 'DEMO_SAMPLE', authority: 'NON_AUTHORITATIVE', execution: 'NOT_STARTED' };
    queue.goals.push(goal);
    queue.history.push({ sequence: queue.history.length + 1, at, kind: 'GOAL_ADDED', goal: { goalId: goal.goalId, text, createdAt: at } });
    queue.revision = queue.history.length;
    return goal;
  }
  const start = Date.parse(now()) - 30 * 60_000;
  const rooms = new Map(PROJECTS.map((project) => [project.projectId, roomOf(project.projectId, start)]));
  const view = (queue) => structuredClone({ ...queue, provenance: 'DEMO_SAMPLE', authority: 'NON_AUTHORITATIVE' });
  const get = (projectId) => {
    const queue = queues.get(projectId);
    if (!queue) throw new Error('示範資料裡沒有這個專案');
    return queue;
  };

  return Object.freeze({
    mode: 'demo',
    projects: async () => ({ provenance: 'DEMO_SAMPLE', projects: PROJECTS.map((project) => ({ ...project, queued: get(project.projectId).goals.length })) }),
    queue: async (projectId) => view(get(projectId)),
    async addGoal(projectId, text) {
      const queue = get(projectId);
      const clean = String(text ?? '').trim();
      if (!clean) throw new Error('請先輸入目標');
      const goal = add(queue, clean);
      const data = { projectId, revision: queue.revision, at: goal.createdAt, goal: structuredClone(goal) };
      emit('goal.created', data);
      return data;
    },
    async reorder(projectId, order) {
      const queue = get(projectId);
      const byId = new Map(queue.goals.map((goal) => [goal.goalId, goal]));
      if (order.length !== queue.goals.length || order.some((goalId) => !byId.has(goalId))) throw new Error('順序不正確');
      queue.goals = order.map((goalId) => byId.get(goalId));
      const at = now();
      queue.history.push({ sequence: queue.history.length + 1, at, kind: 'QUEUE_REORDERED', order: [...order] });
      queue.revision = queue.history.length;
      const data = { projectId, revision: queue.revision, at, order: [...order] };
      emit('queue.reordered', data);
      return data;
    },
    async removeGoal(projectId, goalId) {
      const queue = get(projectId);
      if (!queue.goals.some((goal) => goal.goalId === goalId)) throw new Error('找不到這個目標');
      queue.goals = queue.goals.filter((goal) => goal.goalId !== goalId);
      const at = now();
      queue.history.push({ sequence: queue.history.length + 1, at, kind: 'GOAL_REMOVED', goalId });
      queue.revision = queue.history.length;
      const data = { projectId, revision: queue.revision, at, goalId };
      emit('goal.removed', data);
      return data;
    },
    // G1-WE1-R0: demo never reads production governance; there is no execution status here and no request is made.
    async executionStatus(projectId) {
      get(projectId);
      return { provenance: 'DEMO_SAMPLE', demo: true };
    },
    async collaboration(projectId) {
      get(projectId);
      return { projectId, provenance: 'DEMO_SAMPLE', events: structuredClone(rooms.get(projectId)) };
    },
    subscribe(onEvent, onState) {
      listeners.add(onEvent);
      onState('demo');
      return () => listeners.delete(onEvent);
    },
  });
}
