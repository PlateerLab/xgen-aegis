/**
 * The graph as one JSON file for the search server (server/): items with their attributes and the actions they allow,
 * links, and control gaps. The server indexes it with OmniFuse and lets an LLM read it through tools.
 */

import type { Aegis } from './aegis.ts';
import type { Finding } from './rules.ts';

export interface SearchGraph {
  readAt: string;
  types: Record<string, { label: string; screen?: string }>;
  nodes: { id: string; type: string; title: string; attrs: [string, string][]; actions: { id: string; label: string; kind: string; input: string }[] }[];
  edges: [string, string, string][];
  gaps: { id: string; title: string; severity: string; fix: string; affected: string[]; closeWith?: string[] }[];
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v));

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
      actions: aegis.actionsFor(it).map((a) => ({ id: a.id, label: a.label, kind: a.kind, input: a.input })),
    })),
    edges: g.links.map((l) => [l.from, l.type, l.to]),
    gaps: findings.map((f) => ({ id: f.rule, title: f.title, severity: f.severity, fix: f.fix, affected: f.affected, closeWith: f.closeWith })),
  };
}
