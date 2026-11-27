/**
 * Answering a question from the graph alone (no LLM). It looks for item names, type names and screen names in the question,
 * says plainly what it found, lists what was asked for, and offers the actions that close the control gaps on what it found.
 * There are no keyword lists: everything it matches comes from the graph, the adapter's type labels and the host's screens.
 * An LLM server can answer instead (see server/); its answer has the same shape.
 */

import type { Action } from './actions.ts';
import type { Aegis } from './aegis.ts';
import type { Item } from './graph.ts';
import type { Finding } from './rules.ts';
import type { Menu } from './screens.ts';

export interface Answer {
  text: string;
  /** Items the question named (shown as "found" so it is clear whether the name matched anything). */
  found: string[];
  /** Items the answer is about (shown as a list and highlighted in the graph). */
  list: string[];
  findings: Finding[];
  /** `input`: the value to give the action (a toggle's true/false, a choice, text), when the answer decided it. */
  proposals: { target: string; action: Action; reason: string; input?: unknown }[];
  /** A screen the question asked to open. */
  open?: Menu;
}

export interface Words {
  found: (names: string) => string;
  notFound: string;
  count: (what: string, n: number) => string;
  linked: (name: string, parts: string) => string;
  gaps: (n: number) => string;
  opened: (menu: string) => string;
  gapNamed: (title: string, n: number) => string;
}

export const EN: Words = {
  found: (names) => `Found ${names}.`,
  notFound: 'No item, type or screen in the question matches the graph.',
  count: (what, n) => `${what}: ${n}.`,
  linked: (name, parts) => `${name} is linked to ${parts}.`,
  gaps: (n) => `${n} control gap${n === 1 ? '' : 's'} on it.`,
  opened: (menu) => `Opened ${menu}.`,
  gapNamed: (title, n) => `"${title}" affects ${n} item${n === 1 ? '' : 's'}.`,
};

export const KO: Words = {
  found: (names) => `찾은 항목: ${names}.`,
  notFound: '질문에서 그래프의 항목 · 종류 · 화면 이름을 찾지 못했습니다.',
  count: (what, n) => `${what} ${n}개입니다.`,
  linked: (name, parts) => `${name}에 이어진 것은 ${parts}입니다.`,
  gaps: (n) => `걸린 통제 공백 ${n}개.`,
  opened: (menu) => `「${menu}」 화면을 열었습니다.`,
  gapNamed: (title, n) => `「${title}」에 걸린 항목은 ${n}개입니다.`,
};

const flat = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** Names in the question: exact (spaces ignored), or the leading 70% of a long name. Longer names win; names inside a found name are dropped. */
export function namesIn(items: Item[], question: string): Item[] {
  const q = flat(question);
  const all = items
    .map((it) => {
      const n = flat(it.title);
      if (n.length >= 2 && q.includes(n)) return { it, len: n.length, part: '' };
      const cut = Math.max(6, Math.floor(n.length * 0.7));
      return n.length >= 8 && q.includes(n.slice(0, cut)) ? { it, len: cut, part: n.slice(0, cut) } : null;
    })
    .filter((x): x is { it: Item; len: number; part: string } => !!x);
  // a leading-part match is dropped when a whole name already covers it
  const whole = all.filter((x) => !x.part).map((x) => flat(x.it.title));
  const hits = all.filter((x) => !x.part || !whole.some((w) => w.includes(x.part) || x.part.includes(w))).sort((a, b) => b.len - a.len);
  const keep: Item[] = [];
  for (const h of hits) if (!keep.some((k) => flat(k.title).includes(flat(h.it.title)))) keep.push(h.it);
  return keep;
}

export function ask(aegis: Aegis, findings: Finding[], question: string, labels: Record<string, string> = {}, words: Words = EN): Answer {
  const g = aegis.graph;
  const q = flat(question);
  const label = (t: string) => labels[t] ?? t;
  const empty: Answer = { text: words.notFound, found: [], list: [], findings: [], proposals: [] };
  const closing = (fs: Finding[]) => fs.flatMap((f) =>
    f.affected
      .filter((id) => g.has(id))
      .flatMap((id) => aegis.actionsFor(id).filter((a) => f.closeWith?.includes(a.label)).map((action) => ({ target: id, action, reason: f.fix, ...(f.closeValue !== undefined ? { input: f.closeValue } : {}) }))),
  ).slice(0, 3);

  // a control gap named in the question (the chat's "fix it" sends its title): the items it affects and the actions that close it
  const gap = findings.find((f) => flat(f.title).length >= 6 && q.includes(flat(f.title)));
  if (gap) {
    return { ...empty, text: [words.gapNamed(gap.title, gap.affected.length), gap.fix].join(' '), list: gap.affected.filter((x) => g.has(x)), findings: [gap], proposals: closing([gap]) };
  }

  // a screen named in the question
  const open = aegis.menus.find((m) => { const page = flat(m.menu.split(' > ').pop() ?? ''); return page.length >= 3 && q.includes(page); });
  const found = namesIn(g.items, question);
  // type names in the question (longest first, a name inside a longer one is not counted again)
  let rest = q;
  for (const it of found) rest = rest.replace(flat(it.title), ' ');
  const types: string[] = [];
  for (const t of g.types().sort((a, b) => flat(label(b)).length - flat(label(a)).length)) {
    for (const n of new Set([flat(label(t)), flat(t)])) {
      if (n.length >= 2 && rest.includes(n)) {
        types.push(t);
        rest = rest.replace(n, ' ');
        break;
      }
    }
  }

  if (!found.length) {
    if (types.length) {
      const list = types.flatMap((t) => g.ofType(t).map((x) => x.id));
      return { ...empty, text: types.map((t) => words.count(label(t), g.ofType(t).length)).join(' '), list, findings: findings.filter((f) => f.affected.some((x) => list.includes(x))), open };
    }
    return open ? { ...empty, text: words.opened(open.menu), open } : empty;
  }

  const main = found[0];
  const near = g.neighbors(main.id);
  const byType = new Map<string, Item[]>();
  near.forEach((x) => byType.set(x.type, [...(byType.get(x.type) ?? []), x]));
  const asked = types.filter((t) => byType.has(t));
  const list = asked.length ? asked.flatMap((t) => byType.get(t)!.map((x) => x.id)) : found.map((x) => x.id);
  const fs = findings.filter((f) => found.some((x) => f.affected.includes(x.id)));
  const parts = (asked.length ? asked : [...byType.keys()]).map((t) => `${label(t)} ${byType.get(t)!.length}`).join(', ');
  const proposals = closing(fs);
  const text = [
    words.found(found.map((x) => `"${x.title}"`).join(', ')),
    parts ? words.linked(`"${main.title}"`, parts) : '',
    fs.length ? words.gaps(fs.length) : '',
  ].filter(Boolean).join(' ');
  return { text, found: found.map((x) => x.id), list, findings: fs, proposals, open };
}
