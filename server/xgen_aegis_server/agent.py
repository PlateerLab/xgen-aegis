"""LLM tool calling over the governance graph. The model picks read tools (search, item, filtered list, gaps, linked items) and
may propose actions; it never changes anything. Proposals go back to the chat, a person opens the host screen and approves.

Works with any OpenAI-compatible /chat/completions endpoint (AEGIS_LLM_URL, AEGIS_LLM_MODEL, AEGIS_LLM_KEY or OPENAI_API_KEY).
The answer has the same shape as the graph-only answer in @xgen-aegis/core: text, found, list, findings, proposals.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from collections import deque
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import index as I

MAX_ROUNDS = 5
MAX_OUT = 900

SYSTEM = """You are the governance assistant of an admin console. The console's items (users, agents, models, tools, resources, approval rules,
policies) and their control gaps form a graph you read through tools. Answer in the language of the question.
Rules:
- Facts come only from tool results. Never invent numbers or names. Quote item names exactly as the tools give them.
- "Linked by search" lists the items the question names. The screen shows them as "found", so do not write "I found". If nothing is linked
  and the tools cannot find the name either, say plainly that the name was not found.
- Answer only what was asked. A count, a list or a composition question gets the count and what it is (type name), nothing more. Problems,
  causes and what to do are said only when asked. The screen shows lists, so name at most three items.
- Counts of what an item is linked to are in get_item.link_counts, per type. Say the type name with the number and never add up different types.
- For "what is X made of / how many Y does X have" call related(X, Y) to fetch the list; if the type is unknown, the tool returns the linked types.
- Propose actions only when the question asks to fix, change or stop something: open the item with get_item, pick an action from its actions whose
  label does what the gap's fix says, and call propose_action (up to three). Never claim something was changed; say it was proposed and waits for approval.
- Give propose_action the value the action takes (actions[].input: toggle true/false, choice or text) when the question says it ("turn on" is
  true, "stop" or "turn off" is false) or the gap's fix decides it. Leave it out otherwise; the screen asks. An action whose current value
  (actions[].now) already equals the value changes nothing: do not propose it.
- When the question shows [proposed: ...] and only changes that proposal ("make it off instead"), call propose_action again for the same
  target and action with the new value.
- Only say you proposed what you passed to propose_action.
- If no action fits, say the host has no setting for it.
- Do not end with "however ..." about problems nobody asked about.
- No markdown, no ids."""

TOOLS = [
    {"type": "function", "function": {"name": "search_graph", "description": "Search the whole graph (OmniFuse) for items, gaps and relations about the query.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {"name": "get_item", "description": "One item: attributes, link counts per type, links, its control gaps and the actions it allows. Name or id.",
     "parameters": {"type": "object", "properties": {"ref": {"type": "string"}}, "required": ["ref"]}}},
    {"type": "function", "function": {"name": "find_items", "description": "Items of one type filtered by attributes and sorted, e.g. type 'Agent', where [['shared','=','true']].",
     "parameters": {"type": "object", "properties": {
         "type": {"type": "string"},
         "where": {"type": "array", "items": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 3}, "description": "[attribute, op (= != contains >= <=), value]"},
         "sort_by": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["type"]}}},
    {"type": "function", "function": {"name": "list_gaps", "description": "Control gaps, optionally only those on one item.",
     "parameters": {"type": "object", "properties": {"item": {"type": "string"}, "severity": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "related", "description": "Items of a type linked to an item (nearest layer first, up to 3 hops).",
     "parameters": {"type": "object", "properties": {"ref": {"type": "string"}, "type": {"type": "string"}, "hops": {"type": "integer"}}, "required": ["ref"]}}},
    {"type": "function", "function": {"name": "propose_action", "description": "Propose an action for a person to approve. action is an id or label from get_item.actions; value is what it is given (see actions[].input).",
     "parameters": {"type": "object", "properties": {"target": {"type": "string"}, "action": {"type": "string"}, "reason": {"type": "string"},
                                                     "value": {"type": ["string", "boolean", "number"], "description": "toggle: true or false; choice or text: the value. Omit when not decided."}},
                    "required": ["target", "action", "reason"]}}},
]


def _num(v: Any) -> float:
    try:
        return float(str(v).replace(",", "").split()[0])
    except (ValueError, IndexError):
        return 0.0


# Booleans come in many spellings; compare them as one
_TRUE = {"true", "예", "yes", "y", "1", "on", "참"}
_FALSE = {"false", "아니요", "아니오", "no", "n", "0", "off", "거짓"}


def same_value(have: Any, want: str) -> bool:
    h, w = str(have).strip().lower(), str(want).strip().lower()
    if h in _TRUE | _FALSE and w in _TRUE | _FALSE:
        return (h in _TRUE) == (w in _TRUE)
    return h == w


class Session:
    """Tool runner for one question. Keeps what was touched, the last list fetched and the proposals."""

    def __init__(self, idx: I.GraphIndex):
        self.idx = idx
        self.touched: List[str] = []
        self.proposals: List[Dict[str, str]] = []
        self.last_list: List[str] = []
        self.list_by = ""
        self.used: List[Dict[str, Any]] = []

    def resolve(self, ref: str) -> Optional[str]:
        ref = (ref or "").strip()
        if ref in self.idx.node:
            return ref
        names = self.idx.names_in(ref)
        if names:
            return names[0]
        key = I.flat(ref)
        part = [u for u, lab in self.idx.label_of.items() if key and key in I.flat(lab)]
        part.sort(key=lambda u: (self.idx.type_of[u] == I.GAP, len(self.idx.label_of[u])))
        return part[0] if part else None

    def types(self, word: str) -> List[str]:
        w = (word or "").strip().lower()
        for k, ts in self.idx.class_words:
            if k == w:
                return list(ts)
        return self.idx.types_in(w)

    def label(self, t: str) -> str:
        return self.idx.type_label.get(t, t)

    def brief(self, u: str) -> Dict[str, Any]:
        self.touched.append(u)
        out = {"id": u, "name": self.idx.label_of[u], "type": self.label(self.idx.type_of[u]), "attrs": dict(self.idx.node[u].get("attrs", [])[:5])}
        if self.idx.gap_count.get(u):
            out["gaps"] = self.idx.gap_count[u]
        return out

    def counts(self, u: str) -> Dict[str, int]:
        c: Dict[str, int] = {}
        for x in self.idx.near(u):
            c[self.label(self.idx.type_of[x])] = c.get(self.label(self.idx.type_of[x]), 0) + 1
        return c

    # tools
    def search_graph(self, query: str) -> Dict[str, Any]:
        ex = I.explore(self.idx, query)
        return {"found": [self.idx.label_of[u] for u in ex["found"]], "items": [self.brief(u) for u in ex["items"][:12]], "relations": ex["relations"][:12]}

    def get_item(self, ref: str) -> Dict[str, Any]:
        u = self.resolve(ref)
        if not u:
            return {"error": f"no item named {ref}"}
        self.touched.append(u)
        n = self.idx.node[u]
        gaps = [g for g in (self.idx.node[x].get("gap") for x in self.idx.node if self.idx.type_of[x] == I.GAP) if g and u in g["affected"]]
        return {"id": u, "name": self.idx.label_of[u], "type": self.label(n["type"]), "attrs": dict(n.get("attrs", [])), "link_counts": self.counts(u),
                "links": self.idx.links(u)[:14],
                "gaps": [{"title": g["title"], "severity": g["severity"], "fix": g["fix"], **({"close_with": g["closeWith"]} if g.get("closeWith") else {}),
                          **({"close_value": g["closeValue"]} if "closeValue" in g else {})} for g in gaps][:10],
                "actions": [{k: a[k] for k in ("id", "label", "kind", "input", "now") if k in a} for a in n.get("actions", [])],
                "screen": self.idx.screen_of.get(n["type"])}

    def find_items(self, type: str, where: Optional[List[List[str]]] = None, sort_by: str = "", limit: int = 15) -> Dict[str, Any]:
        ts = self.types(type)
        if not ts:
            return {"error": f"unknown type {type}", "types": sorted({self.label(t) for t in set(self.idx.type_of.values())})}
        ids = [u for u, t in self.idx.type_of.items() if t in ts]

        def ok(u: str) -> bool:
            a = dict(self.idx.node[u].get("attrs", []))
            for cond in where or []:
                if len(cond) != 3:
                    continue
                k, op, v = cond
                have = a.get(k)
                if op in ("=", "==") and not same_value(have, v) or op == "!=" and same_value(have, v) or op == "contains" and v not in str(have or ""):
                    return False
                if op in (">=", "<=") and (have is None or (op == ">=" and _num(have) < _num(v)) or (op == "<=" and _num(have) > _num(v))):
                    return False
            return True

        hit = [u for u in ids if ok(u)]
        if where and not hit and ids:
            names: Dict[str, set] = {}
            for u in ids[:200]:
                for k, v in self.idx.node[u].get("attrs", []):
                    names.setdefault(k, set()).add(str(v))
            return {"count": 0, "error": "Nothing matches. Names or values may be spelled differently: retry with the spellings below, and answer zero only if that also finds nothing.", "attrs": {k: sorted(v)[:6] for k, v in names.items()}}
        if sort_by:
            hit.sort(key=lambda u: -_num(dict(self.idx.node[u].get("attrs", [])).get(sort_by, 0)))
        self.last_list, self.list_by = hit[:30], "find_items"
        return {"count": len(hit), "items": [self.brief(u) for u in hit[: max(1, min(int(limit or 15), 30))]]}

    def list_gaps(self, item: str = "", severity: str = "") -> Dict[str, Any]:
        gs = [self.idx.node[x] for x in self.idx.node if self.idx.type_of[x] == I.GAP]
        u = self.resolve(item) if item else None
        if item:
            gs = [g for g in gs if u and u in g["gap"]["affected"]]
        if severity:
            gs = [g for g in gs if g["gap"]["severity"] == severity]
        self.last_list, self.list_by = [g["id"] for g in gs][:30], "list_gaps"
        return {"count": len(gs), "gaps": [{"title": g["title"], "severity": g["gap"]["severity"], "fix": g["gap"]["fix"], "affected": len(g["gap"]["affected"])} for g in gs[:15]]}

    def related(self, ref: str, type: str = "", hops: int = 2) -> Dict[str, Any]:
        u = self.resolve(ref)
        if not u:
            return {"error": f"no item named {ref}"}
        ts = set(self.types(type)) if type else set()
        if type and not ts:
            # an unknown type word: give the types actually linked so the model can pick
            return {"error": f"unknown type {type}. Call again with one of these type names.", "linked_types": self.counts(u)}
        seen = {u: 0}
        q = deque([(u, 0)])
        hits: List[Tuple[str, int]] = []
        while q:
            x, d = q.popleft()
            if d >= max(1, min(int(hops or 2), 3)):
                continue
            for _, y in self.idx.adj.get(x, []):
                if y in seen or self.idx.type_of.get(y) == I.GAP:
                    continue
                seen[y] = d + 1
                if not ts or self.idx.type_of[y] in ts:
                    hits.append((y, d + 1))
                q.append((y, d + 1))
        # the nearest layer is the answer; farther ones are only counted
        nearest = min((d for _, d in hits), default=0)
        found = [y for y, d in hits if d == nearest]
        prev = self.last_list if self.list_by == "related" else []
        self.last_list, self.list_by = list(dict.fromkeys(prev + found))[:30], "related"
        self.touched.append(u)
        out = {"from": self.idx.label_of[u], "count": len(found), "items": [self.brief(y) for y in found[:20]]}
        if len(hits) > len(found):
            out["farther"] = len(hits) - len(found)
        return out

    def propose_action(self, target: str, action: str, reason: str, value: Any = None) -> Dict[str, Any]:
        u = self.resolve(target)
        if not u:
            return {"error": "no such target"}
        acts = self.idx.node[u].get("actions", [])
        a = next((x for x in acts if x["id"] == action or I.flat(x["label"]) == I.flat(action)), None)
        if not a:
            return {"error": "that item has no such action", "actions": [{"id": x["id"], "label": x["label"]} for x in acts]}
        # the value, in the form the action takes; one that does not fit is dropped (the screen asks for it)
        kind = a.get("input", "text")
        v: Any = None
        if value is not None and str(value).strip() != "" and kind != "none":
            w = str(value).strip().lower()
            if kind == "toggle":
                v = True if w in _TRUE else False if w in _FALSE else None
            else:
                v = str(value).strip()[:200]
        if v is not None and "now" in a and same_value(a["now"], str(v).lower()):
            return {"ok": False, "error": f"already {a['now']}: nothing to change"}
        p: Dict[str, Any] = {"target": u, "action": a["id"], "label": a["label"], "reason": reason[:160]}
        if v is not None:
            p["value"] = v
        # the same action on the same target again replaces the earlier proposal (a follow-up that changes its value)
        self.proposals = [x for x in self.proposals if not (x["target"] == u and x["action"] == a["id"])]
        if len(self.proposals) < 3:
            self.proposals.append(p)
        return {"ok": True, **({"value": v} if v is not None else {})}

    def call(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        self.used.append({"name": name, "args": args})
        fn = getattr(self, name, None) if name in {t["function"]["name"] for t in TOOLS} else None
        if not fn:
            return {"error": f"unknown tool {name}"}
        try:
            return fn(**args)
        except TypeError as e:
            return {"error": f"bad arguments: {e}"}


# A sentence that says something was proposed (English and Korean by default; AEGIS_CLAIM adds other languages)
CLAIM = re.compile(os.getenv("AEGIS_CLAIM", r"(?i)\bpropos(e|ed|ing)\b|\bsuggest(ed)?\b|제안(했|합니다|드립니다|하겠)"))


def honest(answer: str, s: "Session", idx: I.GraphIndex) -> str:
    """Drop sentences that claim a proposal naming an action that was not passed to propose_action. If proposals were made and
    no sentence is left that says so, say it in one line."""
    labels = {a["label"] for n in idx.node.values() for a in n.get("actions", [])}
    made = {p["label"] for p in s.proposals}
    keep = []
    for x in re.split(r"(?<=[.!?。])\s+|\n+", answer):
        if CLAIM.search(x) and any(lab in x for lab in labels - made) and not any(lab in x for lab in made):
            continue
        keep.append(x)
    out = " ".join(k for k in keep if k.strip()).strip()
    if s.proposals and not any(CLAIM.search(k) for k in keep):
        names = ", ".join(dict.fromkeys(p["label"] for p in s.proposals))
        korean = re.search(r"[가-힣]", answer + names)
        out = (out + " " if out else "") + (f"「{names}」을(를) 제안했습니다. 승인하면 적용됩니다." if korean else f"Proposed: {names}. It runs once approved.")
    return out


def llm_config() -> Tuple[str, str, str]:
    return (os.getenv("AEGIS_LLM_URL", "https://api.openai.com/v1"), os.getenv("AEGIS_LLM_MODEL", "gpt-5.4"),
            os.getenv("AEGIS_LLM_KEY") or os.getenv("OPENAI_API_KEY") or "")


def chat(messages: List[Dict[str, Any]], tools: bool) -> Dict[str, Any]:
    url, model, key = llm_config()
    body: Dict[str, Any] = {"model": model, "messages": messages, "max_completion_tokens": MAX_OUT}
    if tools:
        body["tools"] = TOOLS
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions", data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode("utf-8"))


def ask(idx: I.GraphIndex, question: str, *, selected: Optional[str] = None, history: Optional[List[Dict[str, str]]] = None,
        llm: Callable[[List[Dict[str, Any]], bool], Dict[str, Any]] = chat) -> Dict[str, Any]:
    """Tool loop. Raises when the LLM cannot be reached (callers fall back to the graph-only answer)."""
    t0 = time.perf_counter()
    s = Session(idx)
    found = [u for u in I.explore(idx, question)["found"] if idx.type_of[u] != I.GAP][:3]
    ctx = ["Linked by search: " + (", ".join(f"{idx.label_of[u]} (id {u}, type {s.label(idx.type_of[u])})" for u in found) if found else "nothing")]
    s.touched += found
    # types the question names, with their real attributes and example values, so filtered searches start with the right spelling
    for t in [t for t in idx.types_in(question) if t != I.GAP][:3]:
        vals: Dict[str, List[str]] = {}
        members = [u for u, x in idx.type_of.items() if x == t]
        for u in members[:200]:
            for k, v in idx.node[u].get("attrs", []):
                if str(v) not in vals.setdefault(k, []) and len(vals[k]) < 3:
                    vals[k].append(str(v))
        attrs = "; ".join(f"{k}: {' / '.join(v)}" for k, v in list(vals.items())[:6])
        ctx.append(f"Type in the question: {s.label(t)} ({len(members)} items" + (f"; attributes e.g. {attrs})" if attrs else ")"))
    if selected and selected in idx.node:
        ctx.append(f"Selected item: {idx.label_of[selected]} (id {selected}). 'this' and 'it' mean this item.")
    # the proposals of the last answer, so a short follow-up ("make it off instead") can change them
    last = next((h for h in reversed(history or []) if h.get("role") == "assistant"), None)
    for p in (last or {}).get("proposals") or []:
        if isinstance(p, dict) and p.get("target") in idx.node:
            ctx.append(f"[proposed: {p.get('label', p.get('action'))} on {idx.label_of[p['target']]} (id {p['target']})" + (f", value {p['value']}" if "value" in p else "") + "]")
    messages: List[Dict[str, Any]] = [{"role": "system", "content": SYSTEM}]
    for h in (history or [])[-6:]:
        if h.get("role") in ("user", "assistant") and h.get("text"):
            messages.append({"role": h["role"], "content": str(h["text"])[:500]})
    messages.append({"role": "user", "content": "\n".join(ctx) + "\n\nQuestion: " + question})
    answer = ""
    for _ in range(MAX_ROUNDS):
        m = llm(messages, True)["choices"][0]["message"]
        calls = m.get("tool_calls") or []
        if not calls:
            answer = (m.get("content") or "").strip()
            break
        messages.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
        for c in calls:
            try:
                args = json.loads(c["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(s.call(c["function"]["name"], args), ensure_ascii=False)[:6000]})
    if not answer:
        answer = (llm(messages + [{"role": "user", "content": "Answer with what you have."}], False)["choices"][0]["message"].get("content") or "").strip()
    answer = honest(answer, s, idx)
    # no list tool used: among the anchors (found, opened, looked at), list the items linked through the types the answer or the
    # question names; prefer the anchor whose count matches a number in the answer
    if not s.last_list:
        asked = set(idx.types_in(question))
        opened = [x for x in [*found, *(s.resolve(str(c["args"].get("ref", ""))) for c in s.used if c["name"] == "get_item"), *s.touched[:12]] if x and idx.type_of.get(x) != I.GAP]
        numbers = {int(n) for n in re.findall(r"\d+", answer)}
        named = [u for u in dict.fromkeys(s.touched) if u not in found and idx.type_of.get(u) != I.GAP and len(idx.label_of[u]) >= 2 and idx.label_of[u] in answer]
        picks = []
        for u0 in dict.fromkeys(opened):
            near = idx.near(u0)
            rest, said = answer, set()
            for t in sorted({idx.type_of[x] for x in near}, key=lambda t: -len(s.label(t))):
                if s.label(t) in rest or (t in asked and idx.type_of[u0] != t):
                    said.add(t)
                    rest = rest.replace(s.label(t), " ")
            if said:
                got = [x for x in near if idx.type_of[x] in said][:30]
                mine = [x for x in named if idx.type_of[x] in said]
                # the answer named items of that type: only a list holding them can be the answer's list
                if mine and not set(mine) & set(got):
                    continue
                picks.append((len(got) in numbers or (len(mine) >= 2 and set(mine) <= set(got)), got, mine))
        if picks:
            # no list whose size matches the answer: the items of that type the answer names, else the first list
            said_named = list(dict.fromkeys(x for _, _, m in picks for x in m))
            s.last_list = next((g for hit, g, _ in picks if hit), None) or said_named or (named if len(named) >= 2 else picks[0][1])
        elif named:
            s.last_list = named
    lst = [u for u in s.last_list if u in idx.node and idx.type_of[u] != I.GAP]
    if not lst:
        # still nothing: the items the answer names, among those the tools looked at
        lst = [u for u in dict.fromkeys(s.touched) if u not in found and idx.type_of.get(u) != I.GAP and len(idx.label_of[u]) >= 2 and idx.label_of[u] in answer]
    gaps = [idx.node[u]["gap"]["id"] for u in s.last_list if idx.type_of.get(u) == I.GAP]
    return {"text": answer, "found": found, "list": lst, "findings": gaps, "proposals": s.proposals,
            "tools": [u["name"] for u in s.used], "model": llm_config()[1], "took": round((time.perf_counter() - t0) * 1000)}
