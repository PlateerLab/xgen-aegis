import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapter, seed } from '../../../examples/demo/host.ts';
import { RULES } from '../../../examples/demo/rules.ts';
import { ask, evaluate, load, pathHit, pathKin, pathParams, pathUnder, rowsOf, sameFamily, toSearchGraph, trimList } from '../src/index.ts';

const SHARE_RULE = RULES[0];

test('paths: contract templates against concrete API paths', () => {
  assert.ok(pathHit('/api/admin/agents/{agentId}', '/api/admin/agents/a1'));
  assert.ok(pathHit('/api/x/${id}/y', '/api/x/7/y'));
  assert.ok(!pathHit('/api/admin/agents/{agentId}', '/api/admin/agents/list/x'));
  assert.ok(pathUnder('/api/admin/roles/{roleId}/users', '/api/admin/roles'));
  assert.ok(!pathUnder('/api/admin/roles', '/api/admin/roles'));
  // list and single item are the same resource family; only the /api/<area> prefix in common is not
  assert.ok(pathKin('/api/admin/agents/{agentId}', '/api/admin/agents/list'));
  assert.ok(!pathKin('/api/admin/models', '/api/admin/agents/list'));
  assert.deepEqual(pathParams('/api/a/{x}/b/:y'), ['x', 'y']);
});

test('provenance: which source makes which type, found by dropping each source', async () => {
  const a = await load(adapter(seed()));
  assert.deepEqual(new Set(a.provenance.feeds.agents), new Set(['Agent', 'Tool']));
  assert.equal(a.provenance.lost.agents.Agent, 3);
  assert.equal(a.provenance.lost.agents.Tool, 3);
  assert.deepEqual(a.provenance.feeds.models, ['Model']);
  // a source that only changes values (none here) would be in feeds but not in lost
  assert.equal(a.provenance.lost.models.Model, 2);
});

test('screens: each type gets the screen that manages it, in the host menu order', async () => {
  const a = await load(adapter(seed()));
  const home = (t: string) => a.screenOf(t)?.menu;
  assert.equal(home('Agent'), 'Agent operations > Agents');
  assert.equal(home('Tool'), 'Agent operations > Agents');
  // the dashboard reads models too, but the models screen is focused on them
  assert.equal(home('Model'), 'Settings > Models');
  assert.equal(home('User'), 'Users & access > Users');
  assert.equal(home('ApprovalRule'), 'Approval > Approval rules');
  assert.equal(home('TokenPolicy'), 'Agent operations > Token limits');
  // the dashboard shows agents and models but is home to nothing
  const dash = a.menus.find((m) => m.menu === 'Overview > Dashboard');
  assert.ok(dash && dash.types.includes('Agent') && !dash.primary);
  assert.deepEqual(a.menus.map((m) => m.menu), [
    'Overview > Dashboard', 'Agent operations > Agents', 'Agent operations > Token limits', 'Users & access > Users', 'Approval > Approval rules', 'Settings > Models', 'System > System logs',
    'System > Audit log', 'System > Cache',
  ]);
  // the owner dropdown on the agents page reads the user list, but the agents page does not show users
  assert.ok(!a.menus.find((m) => m.menu === 'Agent operations > Agents')!.types.includes('User'));
  assert.equal(home('ErrorGroup'), 'System > System logs');
  assert.equal(home('Service'), 'System > System logs');
  assert.equal(a.screenOf('Agent')?.route, '/admin?view=agents');
});

test('provenance: a summary that adds a value to a few items does not own the type', async () => {
  const a = await load(adapter(seed()));
  // the usage summary only knows the agents that were called (1 of 3)
  assert.deepEqual(a.provenance.feeds.usage, ['Agent']);
  assert.deepEqual(a.provenance.lost.usage, {});
  assert.ok(!rowsOf(a.provenance, 'usage', 'Agent'));
  assert.ok(rowsOf(a.provenance, 'agents', 'Agent'));
  assert.equal(a.graph.get('agent:a1')!.props.calls, 1200);
});

test('screen lists: a screen no source covers is read through get(), with only safe columns', async () => {
  const a = await load(adapter(seed()));
  const audit = a.screenOf('List_audit_log')!;
  assert.equal(audit.menu, 'System > Audit log');
  assert.equal(a.label('List_audit_log'), 'Audit log');
  const rows = a.graph.ofType('List_audit_log');
  assert.deepEqual(rows.map((x) => x.title), ['Audit log #1', 'Audit log #2']);
  // mail and free text are dropped, ids, flags and short words stay
  assert.deepEqual(rows[0].props, { id: 'e1', at: '2026-11-27T09:00:00Z', user_id: 'u2', action: 'agent.share', ok: true });
  // id columns link to the item they point at
  assert.deepEqual(a.graph.out(rows[1].id, 'refersTo').map((x) => x.id), ['user:u3']);
  // lists of screens an adapter source already covers are read and dropped (same resource family, that source makes items)
  assert.deepEqual(a.coveredLists, ['list:agents', 'list:models', 'list:users', 'list:approval-rules', 'list:token-policies', 'list:system-logs', 'list:dashboard']);
  // the export button is not a list
  assert.equal(a.urls['list:audit-log'], '/api/admin/audit/events');
});

test('screen lists: rows keyed by their own id only, no titles when rows carry what people wrote', () => {
  const t = trimList({ items: [{ uuid: 'x1', name: 'Nightly sync', owner_id: 'u1', share: { admin: true }, cpu: { usage: 3 }, token: 's3cret', note: 'hi' }], pagination: { total: 40 } })!;
  assert.equal(t.total, 40);
  assert.deepEqual(t.rows[0], { key: 'x1', title: 'Nightly sync', fields: { uuid: 'x1', owner_id: 'u1', 'cpu.usage': 3 } });
  const authored = trimList([{ id: 7, title: 'Question about billing', question: 'why?', status: 'open' }])!;
  assert.deepEqual(authored.rows[0], { key: '7', title: null, fields: { id: 7, status: 'open' } });
  assert.equal(trimList({ ok: true }), null);
  assert.ok(sameFamily('/api/admin/agents/list', '/api/admin/agents/42'));
  assert.ok(!sameFamily('/api/admin/audit/events', '/api/admin/logs/errors'));
});

test('actions: every write API of every screen, bound to rows or to the screen', async () => {
  const a = await load(adapter(seed()));
  const acts = (menu: string) => a.actionsOf(a.menus.find((m) => m.menu === menu)!).map((x) => [x.label, x.types]);
  // the agents source makes agents and tools; the action's operation names the agent
  assert.deepEqual(acts('Agent operations > Agents'), [['Shared', ['Agent']], ['Delete', ['Agent']]]);
  // a screen with nothing to list keeps its action, on the screen itself
  const cache = a.menus.find((m) => m.menu === 'System > Cache')!;
  assert.deepEqual(cache.types, []);
  assert.deepEqual(a.collectionActions(cache).map((x) => [x.label, x.kind, x.input, x.risky]), [['Clear cache', 'run', 'none', true]]);
});

test('actions: read from the contracts, bound to the item key', async () => {
  const a = await load(adapter(seed()));
  const acts = a.actionsFor('agent:a1');
  assert.deepEqual(acts.map((x) => [x.label, x.kind, x.input, x.risky]), [['Shared', 'update', 'toggle', false], ['Delete', 'delete', 'none', true]]);
  assert.deepEqual(a.actionsFor('rule:agent.share').map((x) => x.label), ['Approval required']);
  assert.deepEqual(a.actionsFor('user:u2').map((x) => [x.label, x.input]), [['Role', 'choice']]);
  // models have no write API in their contract; tools are derived items with no host key
  assert.deepEqual(a.actionsFor('model:m2'), []);
  assert.deepEqual(a.actionsFor('tool:web'), []);
  const limits = a.screenOf('TokenPolicy')!;
  assert.deepEqual(a.collectionActions(limits).map((x) => [x.label, x.kind]), [['New policy', 'create']]);
});

test('approval: nothing runs until approved; approved calls go through the adapter', async () => {
  const state = seed();
  const ad = adapter(state);
  let a = await load(ad);
  const share = a.actionsFor('agent:a1').find((x) => x.label === 'Shared')!;
  const p = a.propose(share, 'agent:a1', false, 'shared agent on an external model');
  assert.equal(p.status, 'proposed');
  assert.deepEqual(p.params, { agentId: 'a1' });
  assert.equal(state.agents.find((x) => x.id === 'a1')!.shared, true);

  const rejected = await a.decide(p, false, 'reviewer');
  assert.equal(rejected.status, 'rejected');
  assert.equal(state.agents.find((x) => x.id === 'a1')!.shared, true);

  const applied = await a.decide(a.propose(share, 'agent:a1', false), true, 'reviewer');
  assert.equal(applied.status, 'applied');
  a = await load(ad);
  assert.equal(a.graph.get('agent:a1')!.props.shared, false);

  // deciding twice does nothing
  assert.equal((await a.decide(applied, true)).status, 'applied');

  // a host error is kept on the proposal
  const gone = a.propose(share, 'agent:a1', true);
  state.agents = state.agents.filter((x) => x.id !== 'a1');
  const failed = await a.decide(gone, true);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /not found/);
});

test('rules: findings name what to close them with, and close after an approved action', async () => {
  const state = seed();
  const ad = adapter(state);
  let a = await load(ad);
  const [f] = evaluate(a.graph, [SHARE_RULE]);
  assert.equal(f.rule, 'share-without-approval');
  assert.deepEqual(f.affected, ['rule:agent.share', 'agent:a1', 'agent:a3']);
  const close = a.actionsFor(f.affected[0]).find((x) => f.closeWith!.includes(x.label))!;
  await a.decide(a.propose(close, f.affected[0], true), true);
  a = await load(ad);
  assert.deepEqual(evaluate(a.graph, [SHARE_RULE]), []);
});

test('an adapter without call() only proposes', async () => {
  const { call: _drop, ...readOnly } = adapter(seed());
  const a = await load(readOnly);
  const act = a.actionsFor('agent:a2')[0];
  const r = await a.decide(a.propose(act, 'agent:a2', true), true);
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /only proposes/);
});

test('ask: says what it found, lists what was asked, offers the actions that close gaps', async () => {
  const ad = adapter(seed());
  const a = await load(ad);
  const fs = evaluate(a.graph, [SHARE_RULE]);
  const r = ask(a, fs, 'Which tools does Reportwriter use?', ad.labels);
  assert.deepEqual(r.found, ['agent:a1']);
  assert.deepEqual(r.list, ['tool:web', 'tool:files']);
  assert.match(r.text, /Found "Report writer"/);
  assert.match(r.text, /Tool 2/);
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.proposals.map((p) => [p.target, p.action.label]), [['rule:agent.share', 'Approval required']]);

  const types = ask(a, fs, 'how many token limit entries', ad.labels);
  assert.deepEqual(types.found, []);
  assert.deepEqual(types.list, ['policy:p1']);

  assert.equal(ask(a, fs, 'open approval rules', ad.labels).open?.menu, 'Approval > Approval rules');
  // a gap named in the question (what the chat's "fix it" sends): what it affects and the action that closes it, with its value
  const all = evaluate(a.graph, RULES);
  const fix = ask(a, all, `Fix this: ${all[0].title}`, ad.labels);
  assert.deepEqual(fix.findings.map((f) => f.rule), ['share-without-approval']);
  assert.deepEqual(fix.proposals.map((p) => [p.target, p.action.label, p.input]), [['rule:agent.share', 'Approval required', true]]);
  const none = ask(a, fs, 'zzz', ad.labels);
  assert.deepEqual([none.found, none.list], [[], []]);
  assert.match(none.text, /No item/);
});

test('search graph export carries labels, home screens, actions and gaps', async () => {
  const ad = adapter(seed());
  const a = await load(ad);
  const sg = toSearchGraph(a, evaluate(a.graph, [SHARE_RULE]));
  assert.deepEqual(sg.types.ApprovalRule, { label: 'Approval rule', screen: 'Approval > Approval rules' });
  assert.deepEqual(sg.nodes.find((n) => n.id === 'rule:agent.share')!.actions.map((x) => x.label), ['Approval required']);
  assert.ok(sg.edges.some(([s, p, o]) => s === 'agent:a1' && p === 'uses' && o === 'model:m2'));
  assert.equal(sg.gaps[0].affected.length, 3);
});

test('logs are items too: an agent failure traces to the error group and the service behind it', async () => {
  const ad = adapter(seed());
  const a = await load(ad);
  const r = ask(a, [], 'why is Policy checker failing? error group', ad.labels);
  assert.deepEqual(r.found, ['agent:a2']);
  assert.deepEqual(r.list, ['error:error|ConnectionError|search_index']);
  const err = a.graph.get(r.list[0])!;
  assert.equal(err.props.count, 3);
  assert.deepEqual(a.graph.out(err.id, 'raisedBy').map((x) => [x.title, x.props.healthy]), [['vector-store', false]]);
  // the same error group hits another agent too
  assert.deepEqual(a.graph.out(err.id, 'hits').map((x) => x.title).sort(), ['Policy checker', 'Report writer']);
});
