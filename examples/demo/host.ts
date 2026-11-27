/**
 * A small stand-in host for the example and the tests: an admin backend with agents, models, users, approval rules and
 * token policies, its own screen contracts, and an adapter for it. Aegis knows none of these names; it learns them through
 * the adapter and the contracts.
 */

import type { Action, HostAdapter, Item, Link, RawRead, Screen, ScreenApi } from '../../packages/core/src/index.ts';
import { screensFromContracts, type ScreenContract, type Taxonomy } from '../../packages/scan/src/contracts.ts';

type Row = Record<string, unknown>;

export interface HostState {
  agents: Row[];
  models: Row[];
  users: Row[];
  rules: Row[];
  policies: Row[];
  /** Recent error log lines and service health (what the console's system screens show). */
  logs: Row[];
  services: Row[];
  /** Calls per agent (a summary: only agents that were used appear). */
  usage: Row[];
  /** Audit events. No adapter source reads them: Aegis reads the audit screen's list itself. */
  audit: Row[];
}

export function seed(): HostState {
  return {
    users: [
      { id: 'u1', name: 'User 1', role: 'admin' },
      { id: 'u2', name: 'User 2', role: 'maker' },
      { id: 'u3', name: 'User 3', role: 'staff' },
    ],
    models: [
      { id: 'm1', name: 'in-house-llm', provider: 'self-hosted', external: false },
      { id: 'm2', name: 'cloud-llm', provider: 'cloud', external: true },
    ],
    agents: [
      { id: 'a1', name: 'Report writer', owner: 'u2', model: 'm2', tools: ['web', 'files'], shared: true },
      { id: 'a2', name: 'Policy checker', owner: 'u2', model: 'm1', tools: ['files'], shared: false },
      { id: 'a3', name: 'Shell helper', owner: 'u3', model: 'm2', tools: ['shell', 'web'], shared: true },
    ],
    rules: [
      { action: 'agent.share', required: false },
      { action: 'agent.deploy', required: true },
    ],
    policies: [{ id: 'p1', target: 'u3', limit: 100000 }],
    services: [
      { name: 'api', healthy: true },
      { name: 'vector-store', healthy: false },
      { name: 'model-gateway', healthy: true },
    ],
    logs: [
      { at: '2026-11-27T09:10:00Z', level: 'error', service: 'vector-store', fn: 'search_index', exc: 'ConnectionError', agent: 'a2', msg: 'vector store unreachable' },
      { at: '2026-11-27T09:12:00Z', level: 'error', service: 'vector-store', fn: 'search_index', exc: 'ConnectionError', agent: 'a2', msg: 'vector store unreachable' },
      { at: '2026-11-27T09:20:00Z', level: 'error', service: 'vector-store', fn: 'search_index', exc: 'ConnectionError', agent: 'a1', msg: 'vector store unreachable' },
      { at: '2026-11-27T08:00:00Z', level: 'error', service: 'model-gateway', fn: 'call_model', exc: 'TimeoutError', agent: 'a1', msg: 'upstream model timed out after 60s' },
      { at: '2026-11-27T07:30:00Z', level: 'warning', service: 'api', fn: 'load_agent', exc: '', agent: 'a3', msg: 'agent definition not found, using last version' },
    ],
    usage: [{ agent: 'a1', calls: 1200 }],
    audit: [
      { id: 'e1', at: '2026-11-27T09:00:00Z', user_id: 'u2', action: 'agent.share', ok: true, email: 'user2@example.com', message: 'shared the report writer with everyone' },
      { id: 'e2', at: '2026-11-27T09:30:00Z', user_id: 'u3', action: 'agent.deploy', ok: false, email: 'user3@example.com', message: 'deploy without approval' },
    ],
  };
}

/** The host's REST handler (what its own screens call). */
export function handler(state: HostState) {
  const find = (rows: Row[], key: string, v: string) => rows.find((r) => String(r[key]) === v);
  return async (method: string, path: string, input?: unknown): Promise<unknown> => {
    const [p] = path.split('?');
    const body = (input ?? {}) as Row;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === '/api/admin/agents/list') return { items: state.agents };
    if (method === 'GET' && p === '/api/admin/models') return state.models;
    if (method === 'GET' && p === '/api/admin/users/all') return { users: state.users };
    if (method === 'GET' && p === '/api/admin/approval/rules') return state.rules;
    if (method === 'GET' && p === '/api/admin/tokens/policies') return state.policies;
    if (method === 'GET' && p === '/api/admin/logs/errors') return { logs: state.logs };
    if (method === 'GET' && p === '/api/admin/system/services') return state.services;
    if (method === 'GET' && p === '/api/admin/agents/usage') return state.usage;
    if (method === 'GET' && p === '/api/admin/audit/events') return { events: state.audit, total: state.audit.length };
    if (method === 'POST' && p === '/api/admin/cache/clear') return { ok: true };
    if (method === 'PUT' && (m = p.match(/^\/api\/admin\/agents\/([^/]+)$/))) {
      const a = find(state.agents, 'id', m[1]);
      if (!a) throw new Error('agent not found');
      Object.assign(a, body);
      return a;
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/admin\/agents\/([^/]+)$/))) {
      state.agents = state.agents.filter((a) => a.id !== m![1]);
      return { ok: true };
    }
    if (method === 'PUT' && (m = p.match(/^\/api\/admin\/approval\/rules\/([^/]+)$/))) {
      const r = find(state.rules, 'action', decodeURIComponent(m[1]));
      if (!r) throw new Error('rule not found');
      Object.assign(r, body);
      return r;
    }
    if (method === 'POST' && p === '/api/admin/tokens/policies') {
      const row = { id: `p${state.policies.length + 1}`, ...body };
      state.policies.push(row);
      return row;
    }
    if (method === 'PUT' && (m = p.match(/^\/api\/admin\/users\/([^/]+)\/role$/))) {
      const u = find(state.users, 'id', m[1]);
      if (!u) throw new Error('user not found');
      u.role = body.role;
      return u;
    }
    throw new Error(`no route ${method} ${p}`);
  };
}

const el = (name: string, role: string, api: ScreenApi | null, permissions: string[]) => ({ uiId: name, role, name, action: api && api.method !== 'GET' ? 'manage' : 'read', permissions, api });

/** The host's screen contracts (written next to each screen in the host's own repo). */
export const CONTRACTS: ScreenContract[] = [
  {
    featureId: 'agents', title: 'Agents', route: '/admin?view=agents',
    elements: [
      el('Agent table', 'table', { method: 'GET', path: '/api/admin/agents/list', operation: 'listAgents' }, ['admin.agents:read']),
      el('Shared', 'switch', { method: 'PUT', path: '/api/admin/agents/{agentId}', operation: 'updateAgent' }, ['admin.agents:manage']),
      el('Delete', 'button', { method: 'DELETE', path: '/api/admin/agents/{agentId}', operation: 'deleteAgent' }, ['admin.agents:manage']),
      el('Owner filter', 'combobox', { method: 'GET', path: '/api/admin/users/all', operation: 'listUsers' }, ['admin.agents:read']),
    ],
  },
  {
    featureId: 'models', title: 'Models', route: '/admin?view=models',
    elements: [el('Model table', 'table', { method: 'GET', path: '/api/admin/models', operation: 'listModels' }, ['admin.models:read'])],
  },
  {
    featureId: 'users', title: 'Users', route: '/admin?view=users',
    elements: [
      el('User table', 'table', { method: 'GET', path: '/api/admin/users/all', operation: 'listUsers' }, ['admin.users:read']),
      el('Role', 'combobox', { method: 'PUT', path: '/api/admin/users/{userId}/role', operation: 'setRole' }, ['admin.users:manage']),
    ],
  },
  {
    featureId: 'approval-rules', title: 'Approval rules', route: '/admin?view=approval-rules',
    elements: [
      el('Rule table', 'table', { method: 'GET', path: '/api/admin/approval/rules', operation: 'listRules' }, ['admin.approval:read']),
      el('Approval required', 'switch', { method: 'PUT', path: '/api/admin/approval/rules/{action}', operation: 'setRule' }, ['admin.approval:manage']),
    ],
  },
  {
    featureId: 'token-policies', title: 'Token limits', route: '/admin?view=token-policies',
    elements: [
      el('Policy table', 'table', { method: 'GET', path: '/api/admin/tokens/policies', operation: 'listPolicies' }, ['admin.tokens:read']),
      el('New policy', 'button', { method: 'POST', path: '/api/admin/tokens/policies', operation: 'createPolicy' }, ['admin.tokens:manage']),
    ],
  },
  {
    featureId: 'system-logs', title: 'System logs', route: '/admin?view=system-logs',
    elements: [
      el('Error log table', 'table', { method: 'GET', path: '/api/admin/logs/errors', operation: 'listErrors' }, ['admin.system:read']),
      el('Service status', 'region', { method: 'GET', path: '/api/admin/system/services', operation: 'listServices' }, ['admin.system:read']),
    ],
  },
  {
    // A dashboard that reads several lists but manages none of them
    featureId: 'dashboard', title: 'Dashboard', route: '/admin?view=dashboard',
    elements: [
      el('Agents card', 'region', { method: 'GET', path: '/api/admin/agents/list', operation: 'listAgents' }, ['admin.dashboard:read']),
      el('Models card', 'region', { method: 'GET', path: '/api/admin/models', operation: 'listModels' }, ['admin.dashboard:read']),
      el('Usage card', 'region', { method: 'GET', path: '/api/admin/agents/usage', operation: 'agentUsage' }, ['admin.dashboard:read']),
    ],
  },
  {
    // No adapter source: Aegis reads this screen's list itself (through adapter.get) and keeps only the safe columns
    featureId: 'audit-log', title: 'Audit log', route: '/admin?view=audit-log',
    elements: [
      el('Event table', 'table', { method: 'GET', path: '/api/admin/audit/events', operation: 'listEvents' }, ['admin.audit:read']),
      el('Export', 'button', { method: 'GET', path: '/api/admin/audit/events/export', operation: 'exportEvents' }, ['admin.audit:read']),
    ],
  },
  {
    // Nothing to list, one thing to do: the screen still shows up with its action
    featureId: 'cache', title: 'Cache', route: '/admin?view=cache',
    elements: [el('Clear cache', 'button', { method: 'POST', path: '/api/admin/cache/clear', operation: 'clearCache' }, ['admin.cache:manage'])],
  },
];

/** The host's menu tree with the permission resources each menu guards. */
export const TAXONOMY: Taxonomy = {
  admin: {
    categories: [
      { label: 'Overview', sections: [{ label: 'Dashboard', resources: ['admin.dashboard'] }] },
      { label: 'Agent operations', sections: [{ label: 'Agents', resources: ['admin.agents'] }, { label: 'Token limits', resources: ['admin.tokens'] }] },
      { label: 'Users & access', sections: [{ label: 'Users', resources: ['admin.users'] }] },
      { label: 'Approval', sections: [{ label: 'Approval rules', resources: ['admin.approval'] }] },
      { label: 'Settings', sections: [{ label: 'Models', resources: ['admin.models'] }] },
      { label: 'System', sections: [{ label: 'System logs', resources: ['admin.system'] }, { label: 'Audit log', resources: ['admin.audit'] }, { label: 'Cache', resources: ['admin.cache'] }] },
    ],
  },
};

// What the person gives on each action → the host request body (host knowledge, so it lives in the adapter)
const BODY: Record<string, (input: unknown) => unknown> = {
  updateAgent: (v) => ({ shared: v === true || v === 'true' }),
  setRule: (v) => ({ required: v === true || v === 'true' }),
  setRole: (v) => ({ role: String(v) }),
  createPolicy: (v) => {
    const [target, limit] = String(v).split(/[ ,:]+/);
    return { target, limit: Number(limit) || 100000 };
  },
};

const SOURCES: Record<string, string> = {
  agents: '/api/admin/agents/list',
  models: '/api/admin/models',
  users: '/api/admin/users/all',
  rules: '/api/admin/approval/rules',
  policies: '/api/admin/tokens/policies',
  logs: '/api/admin/logs/errors',
  services: '/api/admin/system/services',
  usage: '/api/admin/agents/usage',
};

/** The adapter: the only code that knows this host. */
export function adapter(state: HostState): HostAdapter & { screensSync(): Screen[] } {
  const call = handler(state);
  const screensSync = () => screensFromContracts(CONTRACTS, TAXONOMY);
  return {
    async read(): Promise<RawRead> {
      const data: Record<string, unknown> = {};
      for (const [k, url] of Object.entries(SOURCES)) data[k] = await call('GET', url);
      return { data, urls: { ...SOURCES } };
    },
    toGraph(raw) {
      const d = raw.data as Record<string, any>;
      const items: Item[] = [];
      const links: Link[] = [];
      const add = (it: Item) => { if (!items.some((x) => x.id === it.id)) items.push(it); };
      for (const u of d.users?.users ?? []) add({ id: `user:${u.id}`, type: 'User', title: u.name, props: { role: u.role }, ref: { source: 'users', key: u.id } });
      for (const m of d.models ?? []) add({ id: `model:${m.id}`, type: 'Model', title: m.name, props: { provider: m.provider, external: m.external }, ref: { source: 'models', key: m.id } });
      const calls = new Map<string, number>((d.usage ?? []).map((u: any) => [u.agent, u.calls]));
      for (const a of d.agents?.items ?? []) {
        add({ id: `agent:${a.id}`, type: 'Agent', title: a.name, props: { shared: a.shared, ...(calls.has(a.id) ? { calls: calls.get(a.id) } : {}) }, ref: { source: 'agents', key: a.id } });
        links.push({ type: 'owns', from: `user:${a.owner}`, to: `agent:${a.id}` });
        links.push({ type: 'uses', from: `agent:${a.id}`, to: `model:${a.model}` });
        for (const t of a.tools ?? []) {
          add({ id: `tool:${t}`, type: 'Tool', title: t, props: {} });
          links.push({ type: 'calls', from: `agent:${a.id}`, to: `tool:${t}` });
        }
      }
      for (const r of d.rules ?? []) add({ id: `rule:${r.action}`, type: 'ApprovalRule', title: r.action, props: { required: r.required }, ref: { source: 'rules', key: r.action } });
      for (const p of d.policies ?? []) {
        add({ id: `policy:${p.id}`, type: 'TokenPolicy', title: `Limit ${p.limit}`, props: { limit: p.limit }, ref: { source: 'policies', key: p.id } });
        links.push({ type: 'limits', from: `policy:${p.id}`, to: `user:${p.target}` });
      }
      // Logs and health are items too: error groups (same level, exception and function) linked to the agents they hit and the
      // service they came from, so the chat can answer "why is this agent failing" without opening server logs
      for (const v of d.services ?? []) add({ id: `service:${v.name}`, type: 'Service', title: v.name, props: { healthy: v.healthy } });
      const groups = new Map<string, any[]>();
      for (const x of d.logs?.logs ?? []) groups.set(`${x.level}|${x.exc}|${x.fn}`, [...(groups.get(`${x.level}|${x.exc}|${x.fn}`) ?? []), x]);
      for (const [key, xs] of groups) {
        const [level, exc, fn] = key.split('|');
        const id = `error:${key}`;
        const at = xs.map((x) => x.at).sort();
        add({ id, type: 'ErrorGroup', title: `${exc || level} · ${fn}`, props: { level, count: xs.length, lastAt: at[at.length - 1], sample: xs[0].msg } });
        for (const ag of new Set(xs.map((x) => x.agent))) links.push({ type: 'hits', from: id, to: `agent:${ag}` });
        for (const sv of new Set(xs.map((x) => x.service))) links.push({ type: 'raisedBy', from: id, to: `service:${sv}` });
      }
      return { items, links: links.filter((l) => items.some((x) => x.id === l.from) && items.some((x) => x.id === l.to)) };
    },
    labels: { ApprovalRule: 'Approval rule', TokenPolicy: 'Token limit', ErrorGroup: 'Error group' },
    async screens() {
      return screensSync();
    },
    screensSync,
    call: (method: string, path: string, input: unknown, action?: Action) => call(method, path, action?.operation && BODY[action.operation] ? BODY[action.operation](input) : input),
    // GET only: Aegis reads the lists of screens no source covers (the audit log here)
    get: (path: string) => call('GET', path),
  };
}
