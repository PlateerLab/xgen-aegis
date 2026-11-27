/**
 * One call to plug Aegis into a host: read through the adapter, build the graph, find which source makes which type,
 * link the host's screens to types, and expose actions on items. Re-run `load()` whenever the host may have changed.
 */

import { actionsFor, collectionActions, decide, propose, type Action, type Proposal } from './actions.ts';
import type { HostAdapter } from './adapter.ts';
import { Graph, type Item } from './graph.ts';
import { discoverProvenance, type Provenance, type RawRead } from './provenance.ts';
import { linkScreens, screenOf, type Menu, type Screen } from './screens.ts';

export interface Aegis {
  graph: Graph;
  screens: Screen[];
  menus: Menu[];
  provenance: Provenance;
  urls: RawRead['urls'];
  readAt: string;
  /** Display name of an item type (adapter labels, else the type). */
  label(type: string): string;
  /** Home screen of an item type. */
  screenOf(type: string): Menu | undefined;
  /** Actions one item allows (from its screens' contracts). */
  actionsFor(item: Item | string): Action[];
  /** Actions on a screen's collection (create ...). */
  collectionActions(menu: Menu): Action[];
  propose(action: Action, target?: Item | string, input?: unknown, reason?: string): Proposal;
  /** Approve (runs the host call through the adapter) or reject. */
  decide(p: Proposal, approve: boolean, by?: string): Promise<Proposal>;
}

export async function load(adapter: HostAdapter): Promise<Aegis> {
  const [raw, screens] = await Promise.all([adapter.read(), adapter.screens()]);
  const graph = new Graph(adapter.toGraph(raw));
  const provenance = discoverProvenance((r) => adapter.toGraph(r), raw);
  const menus = linkScreens(screens, provenance, raw.urls);
  const item = (x: Item | string | undefined) => (typeof x === 'string' ? graph.get(x) : x);
  return {
    graph,
    screens,
    menus,
    provenance,
    urls: raw.urls,
    readAt: new Date().toISOString(),
    label: (t) => adapter.labels?.[t] ?? t,
    screenOf: (type) => screenOf(menus, type),
    actionsFor: (x) => {
      const it = item(x);
      return it ? actionsFor(it, screens, menus, raw.urls) : [];
    },
    collectionActions: (m) => collectionActions(m, screens),
    propose: (action, target, input, reason) => propose(action, item(target), input, reason),
    decide: (p, approve, by) => {
      if (approve && !adapter.call) return Promise.resolve({ ...p, status: 'failed' as const, error: 'This adapter only proposes: it has no call().' });
      return decide(p, approve, (m, path, input, action) => adapter.call!(m, path, input, action), by);
    },
  };
}
