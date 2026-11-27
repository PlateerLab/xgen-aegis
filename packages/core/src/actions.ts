/**
 * What can be done, read from the host's screen contracts: every element that calls a write API (POST, PUT, PATCH, DELETE)
 * is an action. Aegis proposes actions, a person approves them, and the adapter performs the call in the host.
 * Nothing here knows a host's resources by name.
 */

import type { Item } from './graph.ts';
import { rowsOf, type Provenance } from './provenance.ts';
import { pathKin, pathParams, type Menu, type Screen } from './screens.ts';

export type ActionKind = 'create' | 'update' | 'delete' | 'run';
export type ActionInput = 'none' | 'toggle' | 'choice' | 'text';

export interface Action {
  id: string;
  screen: string;
  label: string;
  method: string;
  path: string;
  operation?: string | null;
  kind: ActionKind;
  /** What the person gives, from the element role (switch → toggle, combobox → choice, textbox → text). */
  input: ActionInput;
  params: string[];
  /** Deleting or running something cannot be taken back by flipping a value. */
  risky: boolean;
  /** Item types whose rows this action works on (the item key fills the last path param). Empty: an action on the screen itself. */
  types: string[];
}

const KIND: Record<string, ActionKind> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
const INPUT: Record<string, ActionInput> = { switch: 'toggle', checkbox: 'toggle', combobox: 'choice', listbox: 'choice', radiogroup: 'choice', textbox: 'text', spinbutton: 'text' };

/** Write actions of one screen (one per method + path, labelled by the element that calls it). */
export function actionsOf(screen: Screen): Action[] {
  const out = new Map<string, Action>();
  for (const a of screen.apis) {
    const method = String(a.method).toUpperCase();
    if (method === 'GET') continue;
    const key = `${method} ${a.path}`;
    if (out.has(key)) continue;
    const verb = /run|execute|trigger|test|sync|clear|reset|flush|purge|restart|refresh|retry|reindex|rebuild/i.test(String(a.operation ?? '')) ? 'run' : KIND[method] ?? 'run';
    out.set(key, {
      id: `${screen.id}:${key}`,
      screen: screen.id,
      label: a.name || a.operation || key,
      method,
      path: a.path,
      operation: a.operation ?? null,
      kind: verb,
      input: INPUT[String(a.role ?? '')] ?? (verb === 'delete' || verb === 'run' ? 'none' : 'text'),
      params: pathParams(a.path),
      risky: verb === 'delete' || verb === 'run',
      types: [],
    });
  }
  return [...out.values()];
}

/**
 * Every write action of every screen, bound to what it works on. An action with a path param works on the rows of the screen's
 * types whose source is the same resource (a source whose rows are that type's items, see rowsOf). When a root source makes
 * several types at once, the type whose name is in the action's operation or path wins, else the type that source makes most of.
 * An action with no path param, or none that matches, is an action on the screen itself (create, run, settings of the page).
 * A write API several screens share (one "save setting" endpoint behind switches on many pages) changes only the rows each page
 * is about, which the contract does not say: it works on rows only on the home screen of the type, elsewhere on the screen.
 * `names` gives the words a type goes by (its id and display label by default).
 */
export function bindActions(menus: Menu[], screens: Screen[], prov: Provenance, urls: Record<string, string>, names: (type: string) => string[] = (t) => [t]): Map<string, Action[]> {
  const makes = (t: string) => Object.keys(prov.feeds).filter((k) => urls[k] && prov.feeds[k].includes(t) && rowsOf(prov, k, t));
  const norm = (a: Action) => `${a.method} ${a.path.replace(/\$?\{[^}]*\}|:\w+/g, '{}')}`;
  const sharedBy = new Map<string, number>();
  for (const m of menus) new Set(screens.filter((s) => m.screens.includes(s.id)).flatMap(actionsOf).map(norm)).forEach((k) => sharedBy.set(k, (sharedBy.get(k) ?? 0) + 1));
  const out = new Map<string, Action[]>();
  for (const m of menus) {
    const seen = new Set<string>();
    const labels = new Set<string>();
    const acts: Action[] = [];
    for (const a of screens.filter((s) => m.screens.includes(s.id)).flatMap(actionsOf)) {
      const key = `${a.method} ${a.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let types = a.params.length ? m.types.filter((t) => makes(t).some((k) => pathKin(a.path, urls[k]))) : [];
      if (types.length && (sharedBy.get(norm(a)) ?? 0) > 1) types = types.filter((t) => m.primary?.includes(t));
      if (types.length > 1) {
        const text = `${a.operation ?? ''} ${a.path}`.toLowerCase();
        const named = types.filter((t) => names(t).some((n) => n.length >= 3 && text.includes(n.toLowerCase().replace(/\s+/g, ''))));
        if (named.length) types = named;
        else {
          const srcs = Object.keys(urls).filter((k) => pathKin(a.path, urls[k]));
          const score = (t: string) => Math.max(0, ...srcs.map((k) => prov.lost[k]?.[t] ?? 0));
          types = [types.reduce((x, y) => (score(y) > score(x) ? y : x))];
        }
      }
      // two elements with the same label on one screen: tell them apart by what they call
      const label = labels.has(a.label) ? `${a.label} (${a.operation || a.method})` : a.label;
      labels.add(label);
      acts.push({ ...a, label, types });
    }
    out.set(m.menu, acts);
  }
  return out;
}

/** Actions on one item: the bound actions of the screens showing its type. The item needs a host key to fill the path. */
export function actionsFor(item: Item, menus: Menu[], bound: Map<string, Action[]>): Action[] {
  if (!item.ref) return [];
  const seen = new Set<string>();
  return menus
    .filter((m) => m.types.includes(item.type))
    .flatMap((m) => bound.get(m.menu) ?? [])
    .filter((a) => a.types.includes(item.type) && !seen.has(a.id) && seen.add(a.id));
}

/** Actions on a screen itself (create, run, page settings: not bound to a row). */
export function collectionActions(menu: Menu, bound: Map<string, Action[]>): Action[] {
  return (bound.get(menu.menu) ?? []).filter((a) => !a.types.length);
}

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'failed';

export interface Proposal {
  id: string;
  action: Action;
  target?: string;
  /** Path params filled from the target's key. */
  params: Record<string, string>;
  /** What the person gave (a toggle value, a choice, text). The adapter turns it into the host request body. */
  input?: unknown;
  reason?: string;
  status: ProposalStatus;
  decidedBy?: string;
  result?: unknown;
  error?: string;
}

let seq = 0;

/** Make a proposal. Nothing runs until a person approves it. */
export function propose(action: Action, target?: Item, input?: unknown, reason?: string): Proposal {
  const params: Record<string, string> = {};
  if (target?.ref && action.params.length) params[action.params[action.params.length - 1]] = target.ref.key;
  return { id: `p${++seq}`, action, target: target?.id, params, input, reason, status: 'proposed' };
}

/** Fill a path template with params. */
export function fillPath(path: string, params: Record<string, string>): string {
  return path.replace(/\$?\{(\w+)\}|:(\w+)/g, (m, a, b) => encodeURIComponent(params[a ?? b] ?? m));
}

/**
 * Approve or reject a proposal. On approval the host call runs once; its result or error is kept on the proposal.
 * `run` is the adapter's call (method, filled path, input, action).
 */
export async function decide(p: Proposal, approve: boolean, run: (method: string, path: string, input: unknown, action: Action) => Promise<unknown>, by?: string): Promise<Proposal> {
  if (p.status !== 'proposed') return p;
  if (!approve) return { ...p, status: 'rejected', decidedBy: by };
  try {
    const result = await run(p.action.method, fillPath(p.action.path, p.params), p.input, p.action);
    return { ...p, status: 'applied', decidedBy: by, result };
  } catch (e) {
    return { ...p, status: 'failed', decidedBy: by, error: e instanceof Error ? e.message : String(e) };
  }
}
