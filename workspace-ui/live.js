// LIVE data source: the local Workspace server, same origin, /api/v0 only.
// Every value shown in LIVE mode comes from here. Demo data is never loaded in this mode.

const API = '/api/v0';
const enc = encodeURIComponent;

export function createLiveSource({ fetchImpl = globalThis.fetch.bind(globalThis), EventSourceImpl = globalThis.EventSource } = {}) {
  async function call(method, path, body) {
    const headers = { 'X-Chief-Workspace': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(`${API}${path}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `Workspace 伺服器回應 ${response.status}`);
      error.code = data?.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return Object.freeze({
    mode: 'live',
    projects: () => call('GET', '/projects'),
    queue: (projectId) => call('GET', `/projects/${enc(projectId)}/goals`),
    addGoal: (projectId, text) => call('POST', `/projects/${enc(projectId)}/goals`, { text }),
    reorder: (projectId, order, expectedRevision) => call('POST', `/projects/${enc(projectId)}/goals/order`, { order, expectedRevision }),
    removeGoal: (projectId, goalId) => call('DELETE', `/projects/${enc(projectId)}/goals/${enc(goalId)}`),
    // WS-P1 has no execution, so nothing produces AI collaboration events: LIVE answers with none, without a request,
    // and 協作室 shows its empty state. Only a future, Architect-approved read model may supply events here.
    collaboration: async (projectId) => ({ projectId, provenance: 'NONE', events: [] }),
    /** onEvent(name, data) for hello / goal.created / queue.reordered / goal.removed; onState('connecting' | 'open' | 'retrying'). */
    subscribe(onEvent, onState) {
      const stream = new EventSourceImpl(`${API}/stream`);
      onState('connecting');
      stream.addEventListener('hello', (event) => { onState('open'); onEvent('hello', JSON.parse(event.data)); });
      for (const name of ['goal.created', 'queue.reordered', 'goal.removed']) {
        stream.addEventListener(name, (event) => onEvent(name, JSON.parse(event.data)));
      }
      stream.onerror = () => onState('retrying');
      return () => stream.close();
    },
  });
}
