/**
 * The governance graph: one cluster per item type on a ring, links between items, control gaps in red,
 * the chat's answer highlighted. Click an item to select it, click empty space to clear the highlight.
 */

import { useMemo } from 'react';
import type { Aegis, Finding } from '@xgen-aegis/core';

export interface AegisGraphProps {
  aegis: Aegis;
  findings: Finding[];
  /** Highlighted items (null: nothing highlighted). */
  focus: Set<string> | null;
  selected?: string | null;
  onSelect?(id: string): void;
  onClear?(): void;
}

const W = 1000, H = 700, R = 250;

// a stable spread for items inside their cluster
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

export function AegisGraph({ aegis, findings, focus, selected, onSelect, onClear }: AegisGraphProps) {
  const g = aegis.graph;
  const pos = useMemo(() => {
    const types = g.types().sort();
    const p = new Map<string, { x: number; y: number }>();
    types.forEach((t, i) => {
      const ang = (i / types.length) * Math.PI * 2 - Math.PI / 2;
      const cx = W / 2 + Math.cos(ang) * R, cy = H / 2 + Math.sin(ang) * R;
      const items = g.ofType(t);
      const spread = 18 + Math.sqrt(items.length) * 14;
      items.forEach((it) => {
        const a = hash(it.id) * Math.PI * 2, d = Math.sqrt(hash(`${it.id}#`)) * spread;
        p.set(it.id, { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d });
      });
      p.set(`type:${t}`, { x: cx + Math.cos(ang) * (spread + 28), y: cy + Math.sin(ang) * (spread + 28) });
    });
    return { p, types };
  }, [g]);
  const bad = useMemo(() => new Set(findings.flatMap((f) => f.affected)), [findings]);
  const lit = (id: string) => !focus || focus.has(id) || id === selected;

  return (
    <svg className="aegis-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="governance graph" onClick={(e) => { if (e.target === e.currentTarget) onClear?.(); }}>
      {g.links.map((l, i) => {
        const a = pos.p.get(l.from), b = pos.p.get(l.to);
        if (!a || !b) return null;
        const on = focus ? focus.has(l.from) && focus.has(l.to) : false;
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`aegis-edge ${on ? 'on' : focus ? 'dim' : ''}`} />;
      })}
      {pos.types.map((t) => {
        const c = pos.p.get(`type:${t}`)!;
        return <text key={t} x={c.x} y={c.y} className="aegis-type" textAnchor="middle">{aegis.label(t)}</text>;
      })}
      {g.items.map((it) => {
        const c = pos.p.get(it.id)!;
        const on = lit(it.id);
        return (
          <g key={it.id} className={`aegis-node ${on ? '' : 'dim'} ${it.id === selected ? 'sel' : ''}`} onClick={() => onSelect?.(it.id)} data-id={it.id}>
            <circle cx={c.x} cy={c.y} r={it.id === selected ? 9 : 6} className={bad.has(it.id) ? 'bad' : ''} />
            {(focus?.has(it.id) || it.id === selected) && <text x={c.x + 10} y={c.y + 4}>{it.title}</text>}
            <title>{`${it.title} · ${aegis.label(it.type)}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
