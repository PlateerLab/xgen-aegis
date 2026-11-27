/**
 * Which host source makes which item type, found by experiment instead of a hand-written table.
 *
 * Drop one source from the raw read, run the adapter again, and see what changes: types whose items disappear
 * are made by that source, types whose values change are fed by it. A root list (every item hangs off it) changes
 * nearly every type, so callers weigh sources by how narrow they are (see linkScreens). A source whose rows are the items
 * of a type either makes them or changes most of them; a summary that only adds a count to a few items does not (see rowsOf).
 */

import type { Item, Snapshot } from './graph.ts';

export interface RawRead {
  /** Source key → response (already trimmed by the adapter). */
  data: Record<string, unknown>;
  /** Source key → API path it was read from (no host, no query). */
  urls: Record<string, string>;
}

export interface Provenance {
  /** Source key → types whose items change (appear, disappear or change values) without it. */
  feeds: Record<string, string[]>;
  /** Source key → type → number of items that disappear without it. */
  lost: Record<string, Record<string, number>>;
  /** Source key → type → share of the type's items that disappear or change without it (0..1). */
  rows: Record<string, Record<string, number>>;
}

/** The rows of source k are items of type t: it makes some of them, or changes most of them. */
export const rowsOf = (prov: Provenance, k: string, t: string): boolean => !!prov.lost[k]?.[t] || (prov.rows[k]?.[t] ?? 0) >= 0.5;

function signature(items: Item[]) {
  const ids: Record<string, Set<string>> = {};
  const all: Record<string, string[]> = {};
  const item = new Map<string, string>();
  for (const o of items) {
    const j = JSON.stringify([o.id, o.title, o.props]);
    (ids[o.type] ??= new Set()).add(o.id);
    (all[o.type] ??= []).push(j);
    item.set(o.id, j);
  }
  return { ids, item, all: Object.fromEntries(Object.entries(all).map(([t, xs]) => [t, xs.sort().join('\n')])) };
}

export function discoverProvenance(toGraph: (raw: RawRead) => Snapshot, raw: RawRead): Provenance {
  const base = signature(toGraph(raw).items);
  const feeds: Provenance['feeds'] = {};
  const lost: Provenance['lost'] = {};
  const rows: Provenance['rows'] = {};
  for (const k of Object.keys(raw.urls)) {
    let n: ReturnType<typeof signature>;
    try {
      n = signature(toGraph({ ...raw, data: { ...raw.data, [k]: undefined } }).items);
    } catch {
      // An adapter that cannot run without this source tells us nothing about it
      continue;
    }
    feeds[k] = Object.keys(base.all).filter((t) => n.all[t] !== base.all[t]);
    lost[k] = Object.fromEntries(
      Object.entries(base.ids)
        .map(([t, xs]) => [t, [...xs].filter((x) => !n.ids[t]?.has(x)).length] as const)
        .filter(([, v]) => v > 0),
    );
    rows[k] = Object.fromEntries(feeds[k].map((t) => [t, [...base.ids[t]].filter((x) => n.item.get(x) !== base.item.get(x)).length / base.ids[t].size]));
  }
  return { feeds, lost, rows };
}
