/**
 * Which host source makes which item type, found by experiment instead of a hand-written table.
 *
 * Drop one source from the raw read, run the adapter again, and see what changes: types whose items disappear
 * are made by that source, types whose values change are fed by it. A root list (every item hangs off it) changes
 * nearly every type, so callers weigh sources by how narrow they are (see linkScreens).
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
}

function signature(items: Item[]) {
  const ids: Record<string, Set<string>> = {};
  const all: Record<string, string[]> = {};
  for (const o of items) {
    (ids[o.type] ??= new Set()).add(o.id);
    (all[o.type] ??= []).push(JSON.stringify([o.id, o.title, o.props]));
  }
  return { ids, all: Object.fromEntries(Object.entries(all).map(([t, xs]) => [t, xs.sort().join('\n')])) };
}

export function discoverProvenance(toGraph: (raw: RawRead) => Snapshot, raw: RawRead): Provenance {
  const base = signature(toGraph(raw).items);
  const feeds: Provenance['feeds'] = {};
  const lost: Provenance['lost'] = {};
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
  }
  return { feeds, lost };
}
