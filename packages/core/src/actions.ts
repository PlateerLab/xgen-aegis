/**
 * What can be done, read from the host's screen contracts: every element that calls a write API (POST, PUT, PATCH, DELETE)
 * is an action. Aegis proposes actions, a person approves them, and the adapter performs the call in the host.
 * Nothing here knows a host's resources by name.
 */

import type { Item } from './graph.ts';
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
    const verb = /run|execute|trigger|test|sync/i.test(String(a.operation ?? '')) ? 'run' : KIND[method] ?? 'run';
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
    });
  }
  return [...out.values()];
}

/**
 * Actions that apply to one item: write actions of the screens that manage its type, on the same resource the item was read
 * from, that take exactly one path param (filled with the item's key). Collection actions (no param) are left to the screen.
 */
export function actionsFor(item: Item, screens: Screen[], menus: Menu[], urls: Record<string, string>): Action[] {
  const url = item.ref ? urls[item.ref.source] : undefined;
  if (!url) return [];
  const ids = new Set(menus.filter((m) => m.types.includes(item.type)).flatMap((m) => m.screens));
  return screens
    .filter((s) => ids.has(s.id))
    .flatMap(actionsOf)
    .filter((a) => a.params.length === 1 && pathKin(a.path, url));
}

/** Actions on a screen's collection itself (create and the like: no path param). */
export function collectionActions(menu: Menu, screens: Screen[]): Action[] {
  return screens.filter((s) => menu.screens.includes(s.id)).flatMap(actionsOf).filter((a) => a.params.length === 0);
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
  if (target?.ref && action.params.length === 1) params[action.params[0]] = target.ref.key;
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
