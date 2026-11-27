/**
 * One chat box to steer everything: ask, see what was found, highlight it in the graph, and act on the answer right there.
 * A proposal shows what it changes (now → new). Apply it with the button or just say yes; say no to drop it. A safe change with
 * a decided value runs at once; anything else opens the host screen with the action ready. An answer that finds control gaps but
 * proposes nothing offers one "fix it" button that asks for the fix. Each answer is scrolled so its question sits at the top.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { settingOf, type Aegis, type Answer } from '@xgen-aegis/core';
import { UI, type UiWords } from './words.ts';

export type ChatProposal = Answer['proposals'][number];

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** The proposals of an answer, so a short follow-up ("make it off instead") can change them. */
  proposals?: { target: string; action: string; label: string; value?: unknown }[];
}

export interface AegisChatProps {
  aegis: Aegis;
  ask(question: string, history: ChatTurn[]): Promise<Answer>;
  onFocus?(ids: string[]): void;
  onSelect?(id: string): void;
  /** Open the host screen of an item (or a menu), optionally with an action ready on it. */
  onOpen?(target: { menu?: string; focus?: string; action?: string; input?: unknown }): void;
  /** Apply a proposal (the person said yes). Resolves to what happened, shown in the chat. */
  onApply?(p: ChatProposal): Promise<string>;
  /** Messages pushed from outside (e.g. the result of an approval). */
  notes?: { id: number; text: string }[];
  words?: UiWords;
}

type State = 'open' | 'done' | 'dropped' | 'stale';
interface Msg { id: number; me: boolean; text: string; a?: Answer; pending?: boolean; states?: State[] }

const LIST = 8;
const show = (v: unknown) => (v === undefined || v === null || v === '' ? '–' : typeof v === 'boolean' ? String(v) : String(v));

export function AegisChat({ aegis, ask, onFocus, onSelect, onOpen, onApply, notes = [], words = UI }: AegisChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [all, setAll] = useState<Set<number>>(new Set());
  const log = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<number>());
  const anchor = useRef<number | null>(null);
  const seq = useRef(0);
  const next = () => Date.now() * 10 + (seq.current++ % 10);

  // keep the question of the newest answer at the top, so the answer reads without scrolling
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    const at = anchor.current !== null ? el.querySelector<HTMLElement>(`[data-msg="${anchor.current}"]`) : null;
    if (at) el.scrollTop = at.offsetTop - el.offsetTop - 8;
    else el.scrollTop = el.scrollHeight;
  }, [msgs]);
  useEffect(() => {
    const fresh = notes.filter((n) => !seen.current.has(n.id));
    fresh.forEach((n) => seen.current.add(n.id));
    if (fresh.length) setMsgs((m) => [...m, ...fresh.map((n) => ({ id: n.id, me: false, text: n.text }))]);
  }, [notes]);

  const say = (text: string) => setMsgs((m) => [...m, { id: next(), me: false, text }]);
  const setState = (id: number, i: number, st: State) =>
    setMsgs((m) => m.map((x) => (x.id === id && x.states ? { ...x, states: x.states.map((s, k) => (k === i ? st : s)) } : x)));

  const apply = async (m: Msg, i: number) => {
    const p = m.a!.proposals[i];
    setState(m.id, i, 'done');
    if (onApply) say(await onApply(p));
    else onOpen?.({ focus: p.target, action: p.action.id, input: p.input });
  };

  const send = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setQ('');
    const id = next();
    anchor.current = id;
    // a yes or a no to the open proposals of the last answer is handled here, not asked again
    const last = [...msgs].reverse().find((x) => !x.me && x.a);
    const open = last?.states?.map((s, i) => (s === 'open' ? i : -1)).filter((i) => i >= 0) ?? [];
    if (last && open.length && (words.yes.test(t) || words.no.test(t))) {
      setMsgs((m) => [...m, { id, me: true, text: t }]);
      if (words.no.test(t)) {
        open.forEach((i) => setState(last.id, i, 'dropped'));
        say(words.dropped);
      } else for (const i of open) await apply(last, i);
      return;
    }
    const history: ChatTurn[] = msgs.filter((x) => !x.pending && (x.me || x.a)).slice(-6).map((x) => ({
      role: x.me ? 'user' : 'assistant',
      text: x.text,
      ...(x.a?.proposals.length ? { proposals: x.a.proposals.map((p) => ({ target: p.target, action: p.action.id, label: p.action.label, ...(p.input !== undefined ? { value: p.input } : {}) })) } : {}),
    }));
    setMsgs((m) => [...m, { id, me: true, text: t }, { id: id + 1, me: false, text: words.thinking, pending: true }]);
    let a: Answer;
    try {
      a = await ask(t, history);
    } catch (e) {
      a = { text: String(e instanceof Error ? e.message : e), found: [], list: [], findings: [], proposals: [] };
    }
    // proposals of earlier answers are no longer the latest: they stay visible but cannot be applied
    setMsgs((m) => m.map((x) => (x.id === id + 1 ? { id: x.id, me: false, text: a.text, a, states: a.proposals.map(() => 'open' as State) } : x.states ? { ...x, states: x.states.map((s) => (s === 'open' ? 'stale' : s)) } : x)));
    const ids = [...new Set([...a.found, ...a.list, ...a.findings.flatMap((f) => f.affected)])].filter((x) => aegis.graph.has(x));
    onFocus?.(ids);
    if (a.open) onOpen?.({ menu: a.open.menu });
  };

  const g = aegis.graph;
  return (
    <div className="aegis-chat">
      <div className="aegis-log" ref={log} aria-live="polite">
        {msgs.map((m) => {
          if (m.me) return <div key={m.id} data-msg={m.id} className="aegis-msg me">{m.text}</div>;
          const a = m.a;
          const list = (a?.list ?? []).filter((x) => g.has(x));
          const more = all.has(m.id);
          const fix = a && !a.proposals.length && a.findings[0];
          return (
            <div key={m.id} data-msg={m.id} className={`aegis-msg bot ${m.pending ? 'pending' : ''}`}>
              {a && a.found.length > 0 && (
                <div className="aegis-found">
                  <span className="aegis-muted">{words.found}</span>
                  {a.found.filter((x) => g.has(x)).map((x) => <button key={x} type="button" onClick={() => onSelect?.(x)}>{g.get(x)!.title}<span className="aegis-muted"> · {aegis.label(g.get(x)!.type)}</span></button>)}
                </div>
              )}
              <p>{m.text}</p>
              {list.length > 0 && !(list.length === a!.found.length && list.every((x) => a!.found.includes(x))) && (
                <ul className="aegis-list">
                  {(more ? list : list.slice(0, LIST)).map((x) => (
                    <li key={x}><button type="button" onClick={() => onSelect?.(x)}>{g.get(x)!.title}<span className="aegis-muted"> {aegis.label(g.get(x)!.type)}</span></button></li>
                  ))}
                  {list.length > LIST && !more && <li><button type="button" className="aegis-link" onClick={() => setAll((s) => new Set([...s, m.id]))}>{words.more(list.length - LIST)}</button></li>}
                </ul>
              )}
              {a && a.findings.length > 0 && (
                <ul className="aegis-list">
                  {a.findings.map((f) => <li key={f.rule}><span className={`aegis-sev ${f.severity}`}>{f.severity}</span> {f.title}</li>)}
                </ul>
              )}
              {a && a.proposals.length > 0 && (
                <div className="aegis-proposals">
                  {a.proposals.map((p, i) => {
                    const it = g.get(p.target);
                    const key = it ? settingOf(it.props, p.action) : undefined;
                    const st = m.states?.[i] ?? 'open';
                    return (
                      <div key={`${p.target}:${p.action.id}`} className={`aegis-card ${st}`}>
                        <div><b>{p.action.label}</b> · {it?.title ?? p.target}{p.action.risky && <span className="aegis-risky"> {words.risky}</span>}</div>
                        {p.input !== undefined && <div className="aegis-change">{key ? `${show(it!.props[key])} → ` : ''}<b>{show(p.input)}</b></div>}
                        {p.reason && <div className="aegis-muted">{p.reason}</div>}
                        <div className="aegis-card-acts">
                          {st === 'open' && <button type="button" className="aegis-primary" onClick={() => void apply(m, i)}>{words.apply}</button>}
                          <button type="button" onClick={() => onOpen?.({ focus: p.target, action: p.action.id, input: p.input })}>{words.openScreen}</button>
                          {st !== 'open' && <span className="aegis-muted">{words.state[st]}</span>}
                        </div>
                      </div>
                    );
                  })}
                  {m.states?.some((s) => s === 'open') && <div className="aegis-muted aegis-hint">{words.sayYes}</div>}
                </div>
              )}
              {fix && <button type="button" className="aegis-cta" onClick={() => void send(words.fixAsk(fix.title))}>{words.fixIt}</button>}
              {a && a.found.length === 1 && !a.proposals.length && (
                <button type="button" className="aegis-link" onClick={() => onOpen?.({ focus: a.found[0] })}>{words.openScreen}</button>
              )}
            </div>
          );
        })}
      </div>
      <form className="aegis-ask" onSubmit={(e) => { e.preventDefault(); void send(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={words.ask} aria-label={words.ask} />
        <button type="submit" className="aegis-primary">{words.send}</button>
      </form>
    </div>
  );
}
