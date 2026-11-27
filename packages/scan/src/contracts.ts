/**
 * Screen contracts → screens. Pure: give it the parsed contracts and the host's menu tree, get Screen[] back.
 *
 * Contract shape (one per admin screen, kept next to the screen in the host repo):
 *   { featureId, title, description?, route?, elements: [{ uiId, role, name, action, permissions: ['res:act'], api: { method, path, operation } | null }] }
 * Elements may sit anywhere inside the contract (under views, tabs ...); every object with a `uiId` counts.
 *
 * Menu tree (taxonomy): scope → categories → sections, each section listing the permission resources it guards. A screen is
 * placed under the category whose sections guard the resources its elements use most; the page name is the contract title.
 */

import type { Screen, ScreenApi } from '@xgen-aegis/core';

export interface ContractElement {
  uiId: string;
  role?: string;
  name?: string | null;
  action?: string | null;
  permissions?: string[];
  api?: { method?: string; path: string; operation?: string | null } | null;
}

export interface ScreenContract {
  featureId: string;
  title: string;
  description?: string;
  route?: string;
  elements?: ContractElement[];
  [k: string]: unknown;
}

export interface TaxonomySection { label: string; resources?: string[] }
export interface TaxonomyCategory { label: string; sections?: TaxonomySection[] }
export type Taxonomy = Record<string, { label?: string; categories?: TaxonomyCategory[] }>;

function walk(x: unknown, out: ContractElement[] = []): ContractElement[] {
  if (Array.isArray(x)) x.forEach((y) => walk(y, out));
  else if (x && typeof x === 'object') {
    if ('uiId' in x) out.push(x as ContractElement);
    Object.values(x).forEach((y) => walk(y, out));
  }
  return out;
}

export function screensFromContracts(contracts: ScreenContract[], taxonomy: Taxonomy = {}, routeOf?: (c: ScreenContract) => string | undefined): Screen[] {
  // permission resource → place in the menu (category, section, order)
  const place = new Map<string, { scope: string; path: [string, string]; order: number }>();
  let seq = 0;
  for (const [scope, s] of Object.entries(taxonomy)) {
    for (const c of s.categories ?? []) {
      for (const sec of c.sections ?? []) {
        seq++;
        for (const r of sec.resources ?? []) if (!place.has(r)) place.set(r, { scope, path: [c.label, sec.label], order: seq });
      }
    }
  }
  return contracts.map((c) => {
    const els = walk(c);
    const apis = new Map<string, ScreenApi>();
    for (const e of els) {
      if (!e.api || typeof e.api.path !== 'string') continue;
      const method = (e.api.method ?? 'GET').toUpperCase();
      const k = `${method} ${e.api.path}`;
      if (!apis.has(k)) apis.set(k, { method, path: e.api.path, operation: e.api.operation ?? null, action: e.action ?? null, name: e.name ?? null, role: e.role ?? null });
    }
    // the resource its elements use most, among those the menu tree knows
    const n = new Map<string, number>();
    for (const e of els) for (const p of e.permissions ?? []) {
      const r = String(p).split(':')[0];
      if (place.has(r)) n.set(r, (n.get(r) ?? 0) + 1);
    }
    const top = [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // no known permission: a menu section with the same name as the screen
    const at = top ? place.get(top) : [...place.values()].find((p) => p.path[1] === c.title);
    const scope = at?.scope ?? 'admin';
    return {
      id: c.featureId,
      title: c.title,
      description: c.description,
      route: routeOf?.(c) ?? c.route ?? `/${scope}?view=${c.featureId}`,
      menu: at ? [at.path[0], c.title] : null,
      order: at?.order ?? 9999,
      apis: [...apis.values()],
    };
  });
}
