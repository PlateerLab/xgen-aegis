/**
 * Control gaps: rules over the graph. Rules are data you pass in (the host's governance policy), not built in.
 * A finding names the items it affects and, when an action can close it, which action label to look for.
 */

import type { Graph } from './graph.ts';

export type Severity = 'high' | 'medium' | 'low';

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  /** Why it matters and what to do, one or two sentences. */
  fix: string;
  /** Items that break the rule. */
  check(graph: Graph): string[];
  /** Words to find the action that closes it among an item's actions (matched against action labels). */
  closeWith?: string[];
}

export interface Finding {
  rule: string;
  title: string;
  severity: Severity;
  fix: string;
  affected: string[];
  closeWith?: string[];
}

export function evaluate(graph: Graph, rules: Rule[]): Finding[] {
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return rules
    .map((r) => ({ rule: r.id, title: r.title, severity: r.severity, fix: r.fix, affected: r.check(graph), closeWith: r.closeWith }))
    .filter((f) => f.affected.length)
    .sort((a, b) => order[a.severity] - order[b.severity] || b.affected.length - a.affected.length);
}
