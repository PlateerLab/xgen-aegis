/**
 * Ask the Aegis server (server/, LLM tool calling) and get the same Answer shape as the graph-only `ask`.
 * The server names actions by id; they are matched back to the actions the item allows here.
 * When the server cannot be reached, the graph-only answer is returned instead.
 */

import { ask as askLocal, type Answer, type Words } from './ask.ts';
import type { Aegis } from './aegis.ts';
import type { Finding } from './rules.ts';

interface ServerAnswer {
  text: string;
  found: string[];
  list: string[];
  findings: string[];
  proposals: { target: string; action: string; label: string; reason: string }[];
}

export async function askServer(url: string, aegis: Aegis, findings: Finding[], question: string, opt: { selected?: string | null; history?: { role: string; text: string }[]; labels?: Record<string, string>; words?: Words; timeoutMs?: number } = {}): Promise<Answer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opt.timeoutMs ?? 45000);
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: question, selected: opt.selected ?? null, history: opt.history ?? [] }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`server ${r.status}`);
    const s = (await r.json()) as ServerAnswer;
    const g = aegis.graph;
    return {
      text: s.text,
      found: s.found.filter((x) => g.has(x)),
      list: s.list.filter((x) => g.has(x)),
      findings: findings.filter((f) => s.findings.includes(f.rule)),
      proposals: s.proposals.flatMap((p) => {
        const action = aegis.actionsFor(p.target).find((a) => a.id === p.action);
        return action ? [{ target: p.target, action, reason: p.reason }] : [];
      }),
    };
  } catch {
    return askLocal(aegis, findings, question, opt.labels, opt.words);
  } finally {
    clearTimeout(timer);
  }
}
