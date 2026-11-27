/**
 * Host screens and how they attach to the graph.
 *
 * A host describes its admin screens with screen contracts: a title, a route, the menu it sits in and, per UI element,
 * the API it calls. Aegis never keeps a hand-written menu table. It reads the contracts, then links each screen to the
 * item types it manages by matching the screen's APIs against the APIs the adapter read the items from.
 */

import type { Provenance } from './provenance.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ScreenApi {
  method: HttpMethod | string;
  /** Path template, params as {name}, ${name} or :name. */
  path: string;
  operation?: string | null;
  /** What the element does: read, create, update, delete, manage ... (from the contract). */
  action?: string | null;
  /** Element label shown in the host, e.g. "Approval required". */
  name?: string | null;
  /** Element role, e.g. switch, combobox, button, textbox. Tells what input an action takes. */
  role?: string | null;
}

export interface Screen {
  id: string;
  title: string;
  description?: string;
  /** Route inside the host, e.g. /admin?view=approval-policy. */
  route: string;
  /** [category, page] in the host menu, null when the host menu tree does not place it. */
  menu: string[] | null;
  /** Position in the host menu (smaller first). */
  order?: number;
  apis: ScreenApi[];
}

export interface Menu {
  /** "Category > Page", or the page alone when the host gives no category. */
  menu: string;
  route?: string;
  /** Item types this screen manages. */
  types: string[];
  /** Types for which this is the home screen. */
  primary?: string[];
  /** Screen ids merged into this menu entry. */
  screens: string[];
}

const segs = (p: string) => p.split('?')[0].replace(/\/+$/, '').split('/');
const isParam = (s: string) => /^(\{.*\}|\$\{.*\}|:\w+|<.*>|\[.*\])$/.test(s);

/** A contract path template matches a concrete path segment by segment. */
export function pathHit(template: string, path: string): boolean {
  const a = segs(template), b = segs(path);
  return a.length === b.length && a.every((s, i) => s === b[i] || isParam(s));
}

/** The template is below the path (a sub-resource of it). */
export function pathUnder(template: string, path: string): boolean {
  const a = segs(template), b = segs(path);
  return a.length > b.length && b.every((x, i) => x === a[i] || isParam(a[i]));
}

/** Same resource family: differs from the path only in its last segment (list vs single), or below it. */
export function pathKin(template: string, path: string): boolean {
  const a = segs(template), b = segs(path);
  let n = 0;
  while (n < Math.min(a.length, b.length) && (a[n] === b[n] || isParam(a[n]))) n++;
  return n >= Math.max(b.length - 1, 4);
}

/** Path params of a template, in order. */
export function pathParams(template: string): string[] {
  return segs(template).filter(isParam).map((s) => s.replace(/^\$?\{|\}$|^:|^<|>$|^\[|\]$/g, ''));
}

export const menuName = (s: Screen) => (s.menu ? s.menu.join(' > ') : s.title);

/**
 * Link screens to item types.
 *
 * A screen is linked to a source when it reads that source's API (GET, same path) or works on a sub-resource of it.
 * For each type the home screen is chosen by, in order:
 *   1. the source closest to the type (the one that creates most of its items; sources that only change values come after,
 *      narrower first, so a root list that touches every type does not win),
 *   2. a screen that writes to that source (the management screen, not a viewer),
 *   3. a screen that handles more of that source's APIs,
 *   4. a screen with fewer sources (focused on the type), then more APIs overall (the general screen of that resource).
 */
export function linkScreens(screens: Screen[], prov: Provenance, urls: Record<string, string>): Menu[] {
  const { feeds, lost } = prov;
  const dist = (k: string, t: string) =>
    !feeds[k]?.includes(t) ? Infinity : lost[k]?.[t] ? (100000 - lost[k][t]) * 100 + feeds[k].length : 1e8 + feeds[k].length;

  interface Work { menu: string; route: string; order: number; sources: string[]; apis: ScreenApi[]; screens: string[]; types: string[]; primary: string[] }
  const byMenu = new Map<string, Work>();
  for (const s of screens) {
    const keys = Object.keys(feeds).filter((k) => urls[k] && s.apis.some((a) => (a.method === 'GET' && pathHit(a.path, urls[k])) || pathUnder(a.path, urls[k])));
    if (!keys.some((k) => feeds[k].length)) continue;
    const name = menuName(s);
    const m = byMenu.get(name) ?? { menu: name, route: s.route, order: s.order ?? 9999, sources: [], apis: [], screens: [], types: [], primary: [] };
    m.sources = [...new Set([...m.sources, ...keys])];
    m.apis.push(...s.apis);
    m.screens.push(s.id);
    m.order = Math.min(m.order, s.order ?? 9999);
    byMenu.set(name, m);
  }
  const menus = [...byMenu.values()];
  const writes = (m: Work, k: string) => m.apis.some((a) => a.method !== 'GET' && pathKin(a.path, urls[k]));
  const handles = (m: Work, k: string) => m.apis.filter((a) => pathKin(a.path, urls[k])).length;
  const near = (m: Work, t: string) => Math.min(...m.sources.map((k) => dist(k, t)));

  const allTypes = new Set(Object.values(feeds).flat());
  for (const t of allTypes) {
    const ranked = menus.map((m) => ({ m, d: near(m, t) })).filter((x) => x.d < Infinity);
    if (!ranked.length) continue;
    const best = Math.min(...ranked.map((x) => x.d));
    const home = (m: Work) => m.sources.filter((k) => dist(k, t) === best);
    const w = (m: Work) => Number(home(m).some((k) => writes(m, k)));
    const h = (m: Work) => home(m).reduce((n, k) => n + handles(m, k), 0);
    const top = ranked
      .filter((x) => x.d === best)
      .sort((a, b) => w(b.m) - w(a.m) || h(b.m) - h(a.m) || a.m.sources.length - b.m.sources.length || b.m.apis.length - a.m.apis.length);
    top.forEach((x) => x.m.types.push(t));
    top[0].m.primary.push(t);
  }
  return menus
    .filter((m) => m.types.length)
    .sort((a, b) => a.order - b.order)
    .map((m) => ({ menu: m.menu, route: m.route, types: m.types, primary: m.primary.length ? m.primary : undefined, screens: m.screens }));
}

/** The screen an item type is managed in: its home screen, else any screen showing it. */
export function screenOf(menus: Menu[], type: string): Menu | undefined {
  return menus.find((m) => m.primary?.includes(type)) ?? menus.find((m) => m.types.includes(type));
}
