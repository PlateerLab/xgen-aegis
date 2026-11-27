/**
 * Drop-in governance console for any host: give it an adapter (and your rules), get the host's own menu tree, the graph,
 * one chat box, and the host's screens opened over the graph (80% of it) with their actions. Approved actions run through the
 * adapter, then everything is read again. Saying yes in the chat approves a safe change whose value is decided; a risky one, or
 * one that still needs a value, opens its screen with the action ready instead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ask as askLocal, evaluate, load, type Aegis, type Answer, type Finding, type HostAdapter, type Proposal, type Rule, type Words } from '@xgen-aegis/core';
import { AegisChat, type ChatOpen, type ChatProposal, type ChatTurn } from './AegisChat.tsx';
import { AegisGraph } from './AegisGraph.tsx';
import { AegisScreen } from './AegisScreen.tsx';
import { UI, type UiWords } from './words.ts';

export interface AegisAppProps {
  adapter: HostAdapter;
  rules?: Rule[];
  /** Answer questions (e.g. through the LLM server). Defaults to the graph-only answer. */
  ask?(question: string, aegis: Aegis, findings: Finding[], history: ChatTurn[]): Promise<Answer>;
  /** Who approves from the chat (kept on the proposal). */
  user?: string;
  /** Wording of the graph-only answer. */
  answerWords?: Words;
  words?: UiWords;
  title?: string;
  hostBase?: string;
}

interface Open { menu: string; focus?: string | null; action?: string | null; input?: unknown; result?: ChatOpen['result']; id: number }

// display names of every type (adapter labels and screen-list titles), for the graph-only answer
const listLabels = (a: Aegis) => Object.fromEntries(a.graph.types().map((t) => [t, a.label(t)]));

export function AegisApp({ adapter, rules = [], ask, answerWords, words = UI, title = 'Aegis', hostBase, user = 'chat' }: AegisAppProps) {
  const [aegis, setAegis] = useState<Aegis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [notes, setNotes] = useState<{ id: number; text: string }[]>([]);
  const [cats, setCats] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      setAegis(await load(adapter));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [adapter]);
  useEffect(() => { void reload(); }, [reload]);

  const findings = useMemo(() => (aegis ? evaluate(aegis.graph, rules) : []), [aegis, rules]);
  // the host menu tree, as the host orders it
  const tree = useMemo(() => {
    const m = new Map<string, { page: string; menu: string }[]>();
    for (const x of aegis?.menus ?? []) {
      const [cat, page] = x.menu.includes(' > ') ? x.menu.split(' > ') : ['', x.menu];
      m.set(cat, [...(m.get(cat) ?? []), { page, menu: x.menu }]);
    }
    return [...m.entries()];
  }, [aegis]);

  if (error) return <div className="aegis-app aegis-pad">{error}</div>;
  if (!aegis) return <div className="aegis-app aegis-pad">{words.thinking}</div>;

  const openTarget = (t: ChatOpen) => {
    const item = t.focus ? aegis.graph.get(t.focus) : undefined;
    // an answer's items open on the screen of the type most of them are
    const counts = new Map<string, number>();
    (t.result?.ids ?? []).forEach((id) => { const x = aegis.graph.get(id); if (x) counts.set(x.type, (counts.get(x.type) ?? 0) + 1); });
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // the screen that holds the action (an item can show on several), else the item's home screen
    const menu = t.menu ?? (item && t.action ? aegis.menus.find((m) => m.types.includes(item.type) && aegis.actionsOf(m).some((a) => a.id === t.action))?.menu : undefined) ?? (item ? aegis.screenOf(item.type)?.menu : undefined) ?? (top ? aegis.screenOf(top)?.menu : undefined);
    if (item) setSelected(item.id);
    if (menu) setOpen({ menu, focus: item?.id ?? null, action: t.action ?? null, input: t.input, result: t.result, id: Date.now() });
  };
  const outcome = (r: Proposal) => {
    const what = `${r.action.label}${r.target ? ` · ${aegis.graph.get(r.target)?.title ?? r.target}` : ''}${r.input !== undefined ? ` → ${String(r.input)}` : ''}`;
    return `${r.status === 'applied' ? words.applied : r.status === 'rejected' ? words.rejected : words.failed}: ${what}${r.error ? ` (${r.error})` : ''}`;
  };
  const decide = async (p: Proposal, approve: boolean) => {
    const r = await aegis.decide(p, approve, user);
    setProposals((ps) => ps.map((x) => (x.id === p.id ? r : x)));
    setNotes((n) => [...n, { id: Date.now(), text: outcome(r) }]);
    if (r.status === 'applied') await reload();
  };
  // yes from the chat: a safe change with its value runs now; a risky one or one without a value waits on its screen
  const applyFromChat = async (c: ChatProposal): Promise<string> => {
    const needs = c.action.input !== 'none' && c.input === undefined;
    if (c.action.risky || needs) {
      openTarget({ focus: c.target, action: c.action.id, input: c.input });
      return `${words.proposed} ${c.action.label} · ${aegis.graph.get(c.target)?.title ?? c.target}`;
    }
    const r = await aegis.decide(aegis.propose(c.action, c.target, c.input, c.reason), true, user);
    setProposals((ps) => [...ps, r]);
    if (r.status === 'applied') await reload();
    return outcome(r);
  };
  const menu = open ? aegis.menus.find((m) => m.menu === open.menu) : undefined;

  return (
    <div className="aegis-app">
      <nav className="aegis-nav" aria-label={words.menu}>
        <div className="aegis-nav-title">{title}</div>
        <button type="button" className={`aegis-nav-self ${open ? '' : 'on'}`} onClick={() => { setOpen(null); setFocus(null); }}>{words.self}</button>
        {tree.map(([cat, pages]) => (
          <div key={cat || '_'} className="aegis-nav-sec">
            {cat && <button type="button" className="aegis-nav-cat" aria-expanded={cats.has(cat)} onClick={() => setCats((s) => { const n = new Set(s); if (n.has(cat)) n.delete(cat); else n.add(cat); return n; })}>{cat}</button>}
            {(!cat || cats.has(cat)) && pages.map((p) => (
              <button key={p.menu} type="button" className={`aegis-nav-item ${open?.menu === p.menu ? 'on' : ''}`} onClick={() => {
                const m = aegis.menus.find((x) => x.menu === p.menu)!;
                setFocus(new Set(m.types.flatMap((t) => aegis.graph.ofType(t).map((x) => x.id))));
                setOpen({ menu: p.menu, id: Date.now() });
              }}>{p.page}</button>
            ))}
          </div>
        ))}
      </nav>
      <main className="aegis-stage">
        <AegisGraph aegis={aegis} findings={findings} focus={focus} selected={selected} onSelect={(id) => setSelected(id)} onClear={() => { setFocus(null); setSelected(null); }} />
        {menu && open && (
          <AegisScreen key={open.id} aegis={aegis} menu={menu} findings={findings} proposals={proposals} focus={open.focus} action={open.action} input={open.input} result={open.result} hostBase={hostBase} words={words}
            onPropose={(p) => { setProposals((ps) => [...ps, p]); setNotes((n) => [...n, { id: Date.now(), text: `${words.proposed} ${p.action.label}` }]); }}
            onDecide={(p, ok) => void decide(p, ok)} onSelect={setSelected} onClose={() => setOpen(null)} />
        )}
      </main>
      <aside className="aegis-side">
        <AegisChat aegis={aegis} words={words} notes={notes} onFocus={(ids) => setFocus(ids.length ? new Set(ids) : null)} onSelect={setSelected} onOpen={openTarget} onApply={applyFromChat}
          ask={(q, history) => (ask ? ask(q, aegis, findings, history) : Promise.resolve(askLocal(aegis, findings, q, { ...listLabels(aegis), ...adapter.labels }, answerWords)))} />
      </aside>
    </div>
  );
}
