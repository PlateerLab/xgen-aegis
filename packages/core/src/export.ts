/**
 * The graph as one JSON file for the search server (server/): items with their attributes and the actions they allow,
 * links, and control gaps. The server indexes it with OmniFuse and lets an LLM read it through tools.
 */

import type { Action } from './actions.ts';
import type { Aegis } from './aegis.ts';
import type { Finding } from './rules.ts';

export interface SearchGraph {
  readAt: string;
  types: Record<string, { label: string; screen?: string }>;
  /** `now`: the item's current value of what a toggle or choice action sets (the attribute its label names), when there is one. */
  nodes: { id: string; type: string; title: string; attrs: [string, string][]; actions: { id: string; label: string; kind: string; input: string; now?: string }[] }[];
  edges: [string, string, string][];
  gaps: { id: string; title: string; severity: string; fix: string; affected: string[]; closeWith?: string[]; closeValue?: unknown }[];
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v));
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The attribute a toggle or choice action sets: the longest attribute name inside its label or operation ("Approval required" → required). */
export function settingOf(props: Record<string, unknown>, a: Action): string | undefined {
  if (a.input !== 'toggle' && a.input !== 'choice') return undefined;
  const text = flat(`${a.label} ${a.operation ?? ''}`);
  return Object.keys(props).filter((k) => flat(k).length >= 3 && text.includes(flat(k)) && typeof props[k] !== 'object').sort((x, y) => y.length - x.length)[0];
}

export function toSearchGraph(aegis: Aegis, findings: Finding[]): SearchGraph {
  const g = aegis.graph;
  return {
    readAt: aegis.readAt,
    types: Object.fromEntries(g.types().map((t) => [t, { label: aegis.label(t), screen: aegis.screenOf(t)?.menu }])),
    nodes: g.items.map((it) => ({
      id: it.id,
      type: it.type,
      title: it.title,
      attrs: Object.entries(it.props).filter(([, v]) => show(v) !== '').map(([k, v]) => [k, show(v)] as [string, string]),
      actions: aegis.actionsFor(it).map((a) => {
        const k = settingOf(it.props, a);
        return { id: a.id, label: a.label, kind: a.kind, input: a.input, ...(k ? { now: show(it.props[k]) } : {}) };
      }),
    })),
    edges: g.links.map((l) => [l.from, l.type, l.to]),
    gaps: findings.map((f) => ({ id: f.rule, title: f.title, severity: f.severity, fix: f.fix, affected: f.affected, closeWith: f.closeWith, ...(f.closeValue !== undefined ? { closeValue: f.closeValue } : {}) })),
  };
}
