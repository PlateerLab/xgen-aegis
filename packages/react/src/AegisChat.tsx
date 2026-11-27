/**
 * One chat box to steer everything: ask, see what was found, highlight it in the graph, and open the host screen
 * (with the proposed action ready) instead of hunting through tabs.
 */

import { useEffect, useRef, useState } from 'react';
import type { Aegis, Answer } from '@xgen-aegis/core';
import { UI, type UiWords } from './words.ts';

export interface AegisChatProps {
  aegis: Aegis;
  ask(question: string): Promise<Answer>;
  onFocus?(ids: string[]): void;
  onSelect?(id: string): void;
  /** Open the host screen of an item (or a menu), optionally with an action ready on it. */
  onOpen?(target: { menu?: string; focus?: string; action?: string }): void;
  /** Messages pushed from outside (e.g. the result of an approval). */
  notes?: { id: number; text: string }[];
  words?: UiWords;
}

interface Msg { id: number; me: boolean; text: string; a?: Answer; pending?: boolean }

const LIST = 8;

export function AegisChat({ aegis, ask, onFocus, onSelect, onOpen, notes = [], words = UI }: AegisChatProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [all, setAll] = useState<Set<number>>(new Set());
  const log = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<number>());
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);
  useEffect(() => {
    const fresh = notes.filter((n) => !seen.current.has(n.id));
    fresh.forEach((n) => seen.current.add(n.id));
    if (fresh.length) setMsgs((m) => [...m, ...fresh.map((n) => ({ id: n.id, me: false, text: n.text }))]);
  }, [notes]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    setQ('');
    const id = Date.now();
    setMsgs((m) => [...m, { id, me: true, text: t }, { id: id + 1, me: false, text: words.thinking, pending: true }]);
    let a: Answer;
    try {
      a = await ask(t);
    } catch (e) {
      a = { text: String(e instanceof Error ? e.message : e), found: [], list: [], findings: [], proposals: [] };
    }
    setMsgs((m) => m.map((x) => (x.id === id + 1 ? { id: x.id, me: false, text: a.text, a } : x)));
    const ids = [...new Set([...a.found, ...a.list, ...a.findings.flatMap((f) => f.affected)])].filter((x) => aegis.graph.has(x));
    onFocus?.(ids);
    if (a.open) onOpen?.({ menu: a.open.menu });
  };

  const g = aegis.graph;
  return (
    <div className="aegis-chat">
      <div className="aegis-log" ref={log} aria-live="polite">
        {msgs.map((m) => {
          if (m.me) return <div key={m.id} className="aegis-msg me">{m.text}</div>;
          const a = m.a;
          const list = (a?.list ?? []).filter((x) => g.has(x));
          const open = all.has(m.id);
          return (
            <div key={m.id} className={`aegis-msg bot ${m.pending ? 'pending' : ''}`}>
              {a && a.found.length > 0 && (
                <div className="aegis-found">
                  <span className="aegis-muted">{words.found}</span>
                  {a.found.filter((x) => g.has(x)).map((x) => <button key={x} type="button" onClick={() => onSelect?.(x)}>{g.get(x)!.title}<span className="aegis-muted"> · {aegis.label(g.get(x)!.type)}</span></button>)}
                </div>
              )}
              <p>{m.text}</p>
              {list.length > 0 && !(list.length === a!.found.length && list.every((x) => a!.found.includes(x))) && (
                <ul className="aegis-list">
                  {(open ? list : list.slice(0, LIST)).map((x) => (
                    <li key={x}><button type="button" onClick={() => onSelect?.(x)}>{g.get(x)!.title}<span className="aegis-muted"> {aegis.label(g.get(x)!.type)}</span></button></li>
                  ))}
                  {list.length > LIST && <li><button type="button" className="aegis-link" onClick={() => setAll((s) => new Set([...s, m.id]))}>{open ? '' : words.more(list.length - LIST)}</button></li>}
                </ul>
              )}
              {a && a.findings.length > 0 && (
                <ul className="aegis-list">
                  {a.findings.map((f) => <li key={f.rule}><span className={`aegis-sev ${f.severity}`}>{f.severity}</span> {f.title}</li>)}
                </ul>
              )}
              {a && a.proposals.length > 0 && (
                <div className="aegis-proposals">
                  {a.proposals.map((p) => (
                    <div key={`${p.target}:${p.action.id}`}>
                      <button type="button" className="aegis-primary" onClick={() => onOpen?.({ focus: p.target, action: p.action.id })}>{g.get(p.target)?.title} · {p.action.label}</button>
                      <span className="aegis-muted"> {p.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {a && a.found.length === 1 && (
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
