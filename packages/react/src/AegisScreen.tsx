/**
 * A host screen opened over the graph: the items of the screen's types, the actions its contract allows on each row,
 * and the proposals waiting for approval. Nothing on it is specific to a host.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action, Aegis, Finding, Item, Menu, Proposal } from '@xgen-aegis/core';
import { UI, type UiWords } from './words.ts';

export interface AegisScreenProps {
  aegis: Aegis;
  menu: Menu;
  findings: Finding[];
  proposals: Proposal[];
  /** Row to point at (moved to the top and highlighted). */
  focus?: string | null;
  /** Action to open on the focused row right away (from a chat proposal). */
  action?: string | null;
  /** Value to start that action with (what the chat proposed). */
  input?: unknown;
  onPropose(p: Proposal): void;
  onDecide(p: Proposal, approve: boolean): void;
  onSelect?(id: string): void;
  onClose(): void;
  /** Base URL of the host; with it the header links to the screen in the host. */
  hostBase?: string;
  words?: UiWords;
}

const COLS = 3;
const shown = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? '✓' : '–') : v === undefined || v === null || v === '' ? '–' : String(v));

function ActionEditor({ action, target, aegis, onPropose, onCancel, w, preset }: { action: Action; target?: Item; aegis: Aegis; onPropose(p: Proposal): void; onCancel(): void; w: UiWords; preset?: unknown }) {
  const [value, setValue] = useState<string>(preset !== undefined && preset !== null ? String(preset) : action.input === 'toggle' ? 'true' : '');
  const [reason, setReason] = useState('');
  const input = action.input === 'toggle' ? value === 'true' : action.input === 'none' ? undefined : value;
  return (
    <div className="aegis-editor" role="group" aria-label={action.label}>
      <b>{action.label}</b>
      {action.risky && <span className="aegis-risky">{w.risky}</span>}
      {action.input === 'toggle' && (
        <select value={value} onChange={(e) => setValue(e.target.value)} aria-label={action.label}>
          <option value="true">{w.on}</option>
          <option value="false">{w.off}</option>
        </select>
      )}
      {(action.input === 'text' || action.input === 'choice') && <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={action.label} aria-label={action.label} />}
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={w.reason} aria-label={w.reason} />
      <button type="button" className="aegis-primary" disabled={(action.input === 'text' || action.input === 'choice') && !value.trim()} onClick={() => onPropose(aegis.propose(action, target, input, reason || undefined))}>{w.propose}</button>
      <button type="button" onClick={onCancel}>{w.cancel}</button>
    </div>
  );
}

export function AegisScreen({ aegis, menu, findings, proposals, focus, action, input, onPropose, onDecide, onSelect, onClose, hostBase, words = UI }: AegisScreenProps) {
  const g = aegis.graph;
  const order = useMemo(() => [...(menu.primary ?? []), ...menu.types.filter((t) => !menu.primary?.includes(t))], [menu]);
  const [type, setType] = useState(() => (focus && g.get(focus)?.type) || order[0]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ row?: string; action: string } | null>(action ? { row: focus ?? undefined, action } : null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setType((focus && g.get(focus)?.type) || order[0]);
    setEditing(action ? { row: focus ?? undefined, action } : null);
  }, [menu.menu, focus, action]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') (editing ? setEditing(null) : onClose()); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [editing, onClose]);
  useEffect(() => { body.current?.querySelector('.aegis-row.on')?.scrollIntoView({ block: 'nearest' }); }, [focus, type]);

  const gaps = useMemo(() => {
    const n = new Map<string, number>();
    findings.forEach((f) => f.affected.forEach((x) => n.set(x, (n.get(x) ?? 0) + 1)));
    return n;
  }, [findings]);
  const rows = useMemo(() => g.ofType(type)
    .filter((x) => !q.trim() || x.title.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || (gaps.get(b.id) ?? 0) - (gaps.get(a.id) ?? 0) || a.title.localeCompare(b.title)), [g, type, q, focus, gaps]);
  const cols = useMemo(() => [...new Set(g.ofType(type).flatMap((x) => Object.keys(x.props)))].slice(0, COLS), [g, type]);
  const ids = new Set(menu.types.flatMap((t) => g.ofType(t).map((x) => x.id)));
  const waiting = proposals.filter((p) => p.status === 'proposed' && (!p.target || ids.has(p.target)) && menu.screens.includes(p.action.screen));
  const coll = aegis.collectionActions(menu);
  const [path, page] = menu.menu.includes(' > ') ? menu.menu.split(' > ') : ['', menu.menu];

  return (
    <div className="aegis-overlay" role="dialog" aria-label={menu.menu}>
      <div className="aegis-screen">
        <div className="aegis-screen-head">
          <div className="aegis-screen-title">
            {path && <span className="aegis-muted">{path}</span>}
            <b>{page}</b>
            {menu.route && (hostBase ? <a href={`${hostBase}${menu.route}`} target="_blank" rel="noreferrer">{words.openInHost}</a> : <span className="aegis-muted">{menu.route}</span>)}
          </div>
          <button type="button" className="aegis-icon" aria-label={words.close} onClick={onClose}>×</button>
        </div>
        <div className="aegis-screen-bar">
          {order.length > 1 && (
            <div className="aegis-tabs" role="tablist">
              {order.map((t) => <button key={t} type="button" role="tab" aria-selected={t === type} className={t === type ? 'on' : ''} onClick={() => setType(t)}>{aegis.label(t)} {g.ofType(t).length}</button>)}
            </div>
          )}
          {coll.length > 0 && <span className="aegis-muted">{words.screenActions}</span>}
          {coll.map((a) => <button key={a.id} type="button" className={a.risky ? 'aegis-risky-btn' : ''} onClick={() => setEditing({ action: a.id })}>{a.label}</button>)}
          <input className="aegis-search" placeholder={words.findByName} value={q} onChange={(e) => setQ(e.target.value)} aria-label={words.findByName} />
        </div>
        {editing && !editing.row && coll.find((a) => a.id === editing.action) && (
          <ActionEditor action={coll.find((a) => a.id === editing.action)!} aegis={aegis} w={words} preset={editing.action === action ? input : undefined} onCancel={() => setEditing(null)} onPropose={(p) => { onPropose(p); setEditing(null); }} />
        )}
        {waiting.length > 0 && (
          <div className="aegis-waiting">
            <div className="aegis-waiting-head">{words.waiting} {waiting.length}</div>
            {waiting.map((p) => (
              <div key={p.id} className="aegis-proposal">
                <span>{p.action.label}{p.target ? ` · ${g.get(p.target)?.title ?? p.target}` : ''}{p.input !== undefined ? ` → ${shown(p.input)}` : ''}</span>
                {p.reason && <span className="aegis-muted">{p.reason}</span>}
                <button type="button" className="aegis-primary" onClick={() => onDecide(p, true)}>{words.approve}</button>
                <button type="button" onClick={() => onDecide(p, false)}>{words.reject}</button>
              </div>
            ))}
          </div>
        )}
        <div className="aegis-screen-body" ref={body}>
          <table className="aegis-table">
            <thead><tr><th>{words.name}</th>{cols.map((c) => <th key={c}>{c}</th>)}<th>{words.gaps}</th><th>{words.actions}</th></tr></thead>
            <tbody>
              {rows.map((it) => {
                const acts = aegis.actionsFor(it);
                const ed = editing?.row === it.id ? acts.find((a) => a.id === editing.action) : undefined;
                return [
                  <tr key={it.id} className={`aegis-row ${it.id === focus ? 'on' : ''}`} onClick={() => onSelect?.(it.id)}>
                    <td className="aegis-name">{it.title}</td>
                    {cols.map((c) => <td key={c}>{shown(it.props[c])}</td>)}
                    <td className={gaps.get(it.id) ? 'aegis-bad' : 'aegis-muted'}>{gaps.get(it.id) ?? 0}</td>
                    <td className="aegis-acts" onClick={(e) => e.stopPropagation()}>
                      {acts.map((a) => <button key={a.id} type="button" className={a.risky ? 'aegis-risky-btn' : ''} onClick={() => setEditing({ row: it.id, action: a.id })}>{a.label}</button>)}
                    </td>
                  </tr>,
                  ed ? (
                    <tr key={`${it.id}:edit`}><td colSpan={cols.length + 3}>
                      <ActionEditor action={ed} target={it} aegis={aegis} w={words} preset={ed.id === action ? input : undefined} onCancel={() => setEditing(null)} onPropose={(p) => { onPropose(p); setEditing(null); }} />
                    </td></tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
          {!rows.length && <div className="aegis-muted aegis-pad">{order.length ? words.none : words.noList}</div>}
        </div>
      </div>
    </div>
  );
}
