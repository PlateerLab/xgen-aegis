/**
 * One call to plug Aegis into a host: read through the adapter, read the lists of screens no source covers, build the graph,
 * find which source makes which type, link the host's screens to types, and bind every write action of every screen.
 * Re-run `load()` whenever the host may have changed.
 */

import { actionsFor, bindActions, collectionActions, decide, propose, type Action, type Proposal } from './actions.ts';
import type { HostAdapter } from './adapter.ts';
import { Graph, type Item, type Snapshot } from './graph.ts';
import { dropCoveredLists, listGraph, readLists } from './lists.ts';
import { discoverProvenance, type Provenance, type RawRead } from './provenance.ts';
import { linkScreens, screenOf, type Menu, type Screen } from './screens.ts';

export interface Aegis {
  graph: Graph;
  screens: Screen[];
  menus: Menu[];
  provenance: Provenance;
  urls: RawRead['urls'];
  readAt: string;
  /** Screen lists dropped because another source already makes that resource. */
  coveredLists: string[];
  /** Display name of an item type (adapter labels, screen titles for screen lists, else the type). */
  label(type: string): string;
  /** Home screen of an item type. */
  screenOf(type: string): Menu | undefined;
  /** Every write action of a screen, bound to the types whose rows it works on (empty types: an action on the screen). */
  actionsOf(menu: Menu): Action[];
  /** Actions one item allows (from its screens' contracts). */
  actionsFor(item: Item | string): Action[];
  /** Actions on a screen itself (create, run, page settings). */
  collectionActions(menu: Menu): Action[];
  propose(action: Action, target?: Item | string, input?: unknown, reason?: string): Proposal;
  /** Approve (runs the host call through the adapter) or reject. */
  decide(p: Proposal, approve: boolean, by?: string): Promise<Proposal>;
}

export async function load(adapter: HostAdapter): Promise<Aegis> {
  const [raw, screens] = await Promise.all([adapter.read(), adapter.screens()]);
  // screens the adapter does not read still have a list: read it (GET only) and keep the rows as items of that screen
  if (adapter.get) {
    const lists = await readLists((p) => adapter.get!(p), screens, adapter.lists);
    Object.assign(raw.data, lists.data);
    Object.assign(raw.urls, lists.urls);
  }
  const listLabels: Record<string, string> = {};
  const toGraph = (r: RawRead): Snapshot => {
    const base = adapter.toGraph(r);
    const l = listGraph(r, base, adapter.lists);
    Object.assign(listLabels, l.labels);
    return { items: [...base.items, ...l.items], links: [...base.links, ...l.links] };
  };
  const coveredLists = adapter.get ? dropCoveredLists(raw, toGraph) : [];
  const graph = new Graph(toGraph(raw));
  const provenance = discoverProvenance(toGraph, raw);
  const menus = linkScreens(screens, provenance, raw.urls);
  const label = (t: string) => adapter.labels?.[t] ?? listLabels[t] ?? t;
  const bound = bindActions(menus, screens, provenance, raw.urls, (t) => [t, label(t)]);
  const item = (x: Item | string | undefined) => (typeof x === 'string' ? graph.get(x) : x);
  return {
    graph,
    screens,
    menus,
    provenance,
    urls: raw.urls,
    readAt: new Date().toISOString(),
    coveredLists,
    label,
    screenOf: (type) => screenOf(menus, type),
    actionsOf: (m) => bound.get(m.menu) ?? [],
    actionsFor: (x) => {
      const it = item(x);
      return it ? actionsFor(it, menus, bound) : [];
    },
    collectionActions: (m) => collectionActions(m, bound),
    propose: (action, target, input, reason) => propose(action, item(target), input, reason),
    decide: (p, approve, by) => {
      if (approve && !adapter.call) return Promise.resolve({ ...p, status: 'failed' as const, error: 'This adapter only proposes: it has no call().' });
      return decide(p, approve, (m, path, input, action) => adapter.call!(m, path, input, action), by);
    },
  };
}
