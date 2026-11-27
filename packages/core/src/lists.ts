/**
 * Screens with no adapter source still show something: the list their contract reads. Aegis reads that list (GET only, through
 * the adapter's `get`), keeps the rows as items of the screen's own type and links them to items they point at. Nothing here knows
 * a host's resources by name: candidates come from the contract (role table first), columns are kept or dropped by what a column
 * is (ids, numbers, flags, short words), and a list that repeats a resource another source already makes is dropped.
 *
 * Privacy: lists can hold what people wrote and who they are. Columns that look like secrets, contact details, free text, names
 * or request/response bodies are dropped; a row is keyed only by its own id; a list whose rows carry authored text gets no row titles.
 */

import type { Item, Link, Snapshot } from './graph.ts';
import type { RawRead } from './provenance.ts';
import { pathParams, type Screen } from './screens.ts';

/** Source keys of screen lists start with this. */
export const LIST = 'list:';

export interface ListRow {
  key: string | null;
  title: string | null;
  fields: Record<string, string | number | boolean>;
}

export interface ScreenList {
  screen: string;
  title: string;
  menu: string[] | null;
  rows: ListRow[];
  total: number;
  /** The screen also writes (it is a settings page, not only a viewer). */
  writes: boolean;
}

export interface ListOptions {
  /** Rows kept per list. */
  rows?: number;
  /** Mask a kept string value (e.g. replace account names). Default: as is. */
  mask?: (v: string) => string;
  /** Show row titles. Off for a public deployment: rows are numbered instead. */
  named?: boolean;
}

// columns that are not kept: secrets, contact details, free text, names, addresses and paths, bodies and logs, infrastructure names
const DROP = new RegExp(
  [
    'pass|secret|token|credential|api_?key|private|e-?mail|mail|phone|tel|(^|_)ip($|_)|addr',
    'content|message|body|question|answer|text|prompt|memo|note|comment|reason|desc|detail',
    'url|uri|host|path|file|name|nick|display|author|creator|_by$|owner|evidence|payload|query|sql|header|cookie|session',
    'subject|title|label|value|config|env|log|error|trace|pod|node|worker|instance|container|cluster|namespace',
    'input|output|summary|preview|sample|snippet|response|request|result_text|keyword|meta|publisher',
  ].join('|'),
  'i',
);
// a nested object whose keys are themselves names (roles, users, groups) is not flattened
const KEYED = /perm|share|role|user|member|acl|group|owner|grant|allow|deny/i;
// rows carrying what people wrote: no titles at all
const AUTHORED = /question|answer|content|message|inquiry|feedback|comment|body/i;
const PERSON = /user_?name|full_?name|display_name|owner_name|nickname|author|creator/i;
const TITLE = ['name', 'title', 'label', 'display_name'];
const SKIP = /export|excel|download|stream|\/count$/i;
const ROLE_ORDER: Record<string, number> = { table: 0, row: 1, grid: 1, heading: 2, region: 3, tab: 4 };
const isId = (k: string) => k === 'id' || /(_id|\.id|[a-z]Id)$/.test(k);

/** List GETs a screen's contract calls (no path param, not an export or a stream), table first, up to three. */
export function listPaths(screen: Screen): string[] {
  return screen.apis
    .filter((a) => String(a.method).toUpperCase() === 'GET' && !pathParams(a.path).length && !SKIP.test(a.path))
    .sort((a, b) => (ROLE_ORDER[String(a.role ?? '')] ?? 9) - (ROLE_ORDER[String(b.role ?? '')] ?? 9))
    .map((a) => a.path)
    .filter((p, i, xs) => xs.indexOf(p) === i)
    .slice(0, 3);
}

function flatRow(x: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!prefix && !KEYED.test(k)) Object.assign(out, flatRow(v as Record<string, unknown>, `${k}.`));
    } else if (!Array.isArray(v)) out[prefix + k] = v;
  }
  return out;
}

/** A list response (array, or an object holding one) → rows with only the columns that are safe to show. */
export function trimList(body: unknown, opts: ListOptions = {}): { rows: ListRow[]; total: number } | null {
  const mask = opts.mask ?? ((v: string) => v);
  let rows: unknown[] | null = null;
  let total: number | null = null;
  if (Array.isArray(body)) rows = body;
  else if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    rows = (Object.values(b).find((v) => Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') as unknown[]) ?? null;
    const pg = (b.pagination && typeof b.pagination === 'object' ? b.pagination : {}) as Record<string, unknown>;
    total = typeof b.total === 'number' ? b.total : typeof pg.total === 'number' ? pg.total : null;
  }
  const objs = (rows ?? []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  if (!objs.length) return null;
  const authored = objs.slice(0, 20).some((r) => Object.keys(r).some((k) => AUTHORED.test(k)));
  const out = objs.slice(0, opts.rows ?? 30).map((r) => {
    const f = flatRow(r);
    const own = ['id', 'uuid'].find((k) => f[k] !== undefined && f[k] !== null && f[k] !== '');
    const tk = authored ? undefined : TITLE.find((k) => typeof f[k] === 'string' && (f[k] as string).length > 0 && (f[k] as string).length <= 50 && !(f[k] as string).includes('\n') && !PERSON.test(k));
    const fields: ListRow['fields'] = {};
    for (const [k, v] of Object.entries(f)) {
      if (Object.keys(fields).length >= 14) break;
      if (v === null || v === undefined || v === '') continue;
      if (isId(k)) fields[k] = typeof v === 'number' || typeof v === 'boolean' ? v : mask(String(v)).slice(0, 64);
      else if (DROP.test(k)) continue;
      else if (typeof v === 'boolean' || typeof v === 'number') fields[k] = v;
      else if (typeof v === 'string' && v.length <= 40 && !v.includes('\n')) fields[k] = mask(v);
    }
    return { key: own ? mask(String(f[own])) : null, title: tk ? mask(String(f[tk])) : null, fields };
  });
  return { rows: out, total: total ?? objs.length };
}

/** Read the list of every screen the host menu places (GET only). Failures and non-lists are skipped. */
export async function readLists(get: (path: string) => Promise<unknown>, screens: Screen[], opts: ListOptions = {}): Promise<RawRead> {
  const data: RawRead['data'] = {};
  const urls: RawRead['urls'] = {};
  for (const s of screens.filter((x) => x.menu)) {
    for (const path of listPaths(s)) {
      let body: unknown;
      try {
        body = await get(path);
      } catch {
        continue;
      }
      const t = trimList(body, opts);
      if (!t) continue;
      const list: ScreenList = { screen: s.id, title: s.title, menu: s.menu, rows: t.rows, total: t.total, writes: s.apis.some((a) => String(a.method).toUpperCase() !== 'GET') };
      data[LIST + s.id] = list;
      urls[LIST + s.id] = path;
      break;
    }
  }
  return { data, urls };
}

export const listType = (screenId: string) => `List_${screenId.replace(/[^A-Za-z0-9]/g, '_')}`;

/**
 * Screen lists in a raw read → items (one type per screen) and links to the items their id columns point at. A column
 * `agent_id` (or `agentId`) with value a1 links to the one item whose host key is a1 and whose type or source is called agent.
 */
export function listGraph(raw: RawRead, graph: Snapshot, opts: ListOptions = {}): Snapshot & { labels: Record<string, string> } {
  const items: Item[] = [];
  const links: Link[] = [];
  const labels: Record<string, string> = {};
  const byKey = new Map<string, Item[]>();
  for (const it of graph.items) if (it.ref) byKey.set(String(it.ref.key), [...(byKey.get(String(it.ref.key)) ?? []), it]);
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of Object.entries(raw.data)) {
    const list = v as ScreenList | undefined;
    if (!k.startsWith(LIST) || !list?.rows?.length) continue;
    const type = listType(list.screen);
    labels[type] = list.title;
    list.rows.forEach((r, i) => {
      const id = `${k}:${r.key ?? i + 1}`;
      items.push({ id, type, title: r.title && opts.named !== false ? r.title : `${list.title} #${i + 1}`, props: { ...r.fields }, ref: r.key ? { source: k, key: r.key } : undefined });
      for (const [f, x] of Object.entries(r.fields)) {
        if (f === 'id' || !isId(f)) continue;
        const stem = flat(f.replace(/(_id|\.id|Id)$/, ''));
        const hit = (byKey.get(String(x)) ?? []).filter((it) => stem.length >= 3 && (flat(it.type).includes(stem) || flat(it.ref!.source).includes(stem) || stem.includes(flat(it.type))));
        if (hit.length === 1) links.push({ type: 'refersTo', from: id, to: hit[0].id });
      }
    });
  }
  return { items, links, labels };
}

const segs = (p: string) => p.split('?')[0].replace(/\/+$/, '').split('/');
/** Same resource family, either way round: equal up to the last segment of the shorter path, and past the /api/<area> prefix. */
export function sameFamily(a: string, b: string): boolean {
  const x = segs(a), y = segs(b);
  let n = 0;
  while (n < Math.min(x.length, y.length) && x[n] === y[n]) n++;
  return n >= Math.max(Math.min(x.length, y.length) - 1, 4);
}

/**
 * Lists that repeat a resource another source already makes (same family, and that source makes items: dropping it loses some).
 * They are removed from the raw read in place; the keys removed are returned.
 */
export function dropCoveredLists(raw: RawRead, toGraph: (raw: RawRead) => Snapshot): string[] {
  const own = (s: Snapshot) => s.items.filter((x) => !x.id.startsWith(LIST)).length;
  const base = own(toGraph(raw));
  const makes = new Map<string, boolean>();
  const made = (k: string) => {
    if (!makes.has(k)) {
      let n: number;
      try {
        n = own(toGraph({ ...raw, data: { ...raw.data, [k]: undefined } }));
      } catch {
        n = -1;
      }
      makes.set(k, n < base);
    }
    return makes.get(k)!;
  };
  const dup = Object.keys(raw.urls).filter((s) => s.startsWith(LIST) && Object.keys(raw.urls).some((k) => !k.startsWith(LIST) && sameFamily(raw.urls[s], raw.urls[k]) && made(k)));
  for (const s of dup) {
    delete raw.data[s];
    delete raw.urls[s];
  }
  return dup;
}
