// DEMO data source: explicitly enabled with ?demo=1 and labelled on screen.
// Everything lives in this page's memory. It never calls the Workspace server, never
// writes the LIVE goal queue, and every id it makes starts with "demo-".

const PROJECTS = [
  { projectId: 'demo-candidate', displayName: '示範：候選人平台', repository: '示範資料（沒有連到任何 repository）' },
  { projectId: 'demo-site', displayName: '示範：嶼光官網', repository: '示範資料（沒有連到任何 repository）' },
];
const SAMPLE = { 'demo-candidate': ['繼續做候選人平台，做到可以上線', '整理候選人資料欄位，列出缺少的部分'], 'demo-site': [] };

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
    subscribe(onEvent, onState) {
      listeners.add(onEvent);
      onState('demo');
      return () => listeners.delete(onEvent);
    },
  });
}
