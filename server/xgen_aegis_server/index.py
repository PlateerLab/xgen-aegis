"""OmniFuse index over an Aegis search graph (the JSON that `toSearchGraph` in @xgen-aegis/core writes).

One passage per item (name, type, attributes, links), the graph itself (items, type nodes, links, control gaps linked to the
items they affect), and label linking that ignores spaces and accepts the leading part of long names. Type words come from the
graph's own type labels; nothing here knows a host.
"""
from __future__ import annotations

import json
import math
import os
import threading
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

from omnifuse.backends.memory import InMemoryGraph, InMemoryVector
from omnifuse.models import Chunk, Node, Triple
from omnifuse.oneshot import OmniFuse

GAP = "ControlGap"
SEED_LIMIT = 30
VECTOR_K = 60
PASSAGE_MAX = 420
NAMES_CAP = 8


def flat(s: str) -> str:
    return "".join(str(s).lower().split())


class GraphIndex:
    """One search graph, indexed."""

    def __init__(self, data: Dict[str, Any], gap_label: str = "control gap"):
        self.read_at = data.get("readAt")
        self.type_label: Dict[str, str] = {k: v.get("label", k) for k, v in (data.get("types") or {}).items()}
        self.type_label[GAP] = gap_label
        self.screen_of: Dict[str, Optional[str]] = {k: v.get("screen") for k, v in (data.get("types") or {}).items()}
        self.node: Dict[str, Dict[str, Any]] = {n["id"]: n for n in data["nodes"]}
        for g in data.get("gaps") or []:
            gid = f"gap:{g['id']}"
            self.node[gid] = {"id": gid, "type": GAP, "title": g["title"], "attrs": [["severity", g["severity"]], ["fix", g["fix"]]], "actions": [], "gap": g}
        self.label_of = {u: str(n["title"]) for u, n in self.node.items()}
        self.type_of = {u: n["type"] for u, n in self.node.items()}
        edges: List[Tuple[str, str, str]] = [(s, p, o) for s, p, o in data.get("edges") or [] if s in self.node and o in self.node]
        self.gap_count: Dict[str, int] = defaultdict(int)
        for g in data.get("gaps") or []:
            for a in dict.fromkeys(g["affected"]):
                if a in self.node:
                    edges.append((f"gap:{g['id']}", "affects", a))
                    self.gap_count[a] += 1
        self.edges = edges
        self.adj: Dict[str, List[Tuple[str, str]]] = defaultdict(list)
        self.rel_triples: Dict[str, List[str]] = defaultdict(list)
        self.deg: Dict[str, int] = defaultdict(int)
        for s, p, o in edges:
            self.adj[s].append((p, o))
            self.adj[o].append((p, s))
            t = f"{self.label_of[s]} → {p} → {self.label_of[o]}"
            self.rel_triples[s].append(t)
            self.rel_triples[o].append(t)
            self.deg[s] += 1
            self.deg[o] += 1
        present = set(self.type_of.values())
        nodes = [Node(id=u, label=self.label_of[u], kind="instance") for u in self.node]
        nodes += [Node(id=f"C:{t}", label=self.type_label.get(t, t), kind="class") for t in present]
        triples = [Triple(u, "instanceOf", f"C:{self.type_of[u]}") for u in self.node] + [Triple(s, p, o) for s, p, o in edges]
        self.graph = InMemoryGraph(nodes, triples)
        self.chunks = [Chunk(id=u, text=self.passage(u), entities=[u], title=self.label_of[u], meta={"type": self.type_of[u]}) for u in self.node]
        self.chunk_of = {c.id: c for c in self.chunks}
        self.id_of_text = {c.text: c.id for c in self.chunks}
        self.vector = InMemoryVector(self.chunks)
        words: Dict[str, Set[str]] = defaultdict(set)
        for t in present:
            words[self.type_label.get(t, t).lower()].add(t)
            words[t.lower()].add(t)
        self.class_words = sorted(words.items(), key=lambda kv: -len(kv[0]))

    def near(self, u: str) -> List[str]:
        """Directly linked items (control gaps left out)."""
        return [x for x in dict.fromkeys(o for _, o in self.adj.get(u, [])) if x != u and self.type_of.get(x) != GAP]

    def links(self, u: str) -> List[str]:
        by: Dict[str, List[str]] = defaultdict(list)
        for p, o in self.adj.get(u, []):
            by[f"{p} {self.type_label.get(self.type_of[o], self.type_of[o])}"].append(self.label_of[o])
        out = []
        for k, names in by.items():
            names = list(dict.fromkeys(names))
            more = f" +{len(names) - NAMES_CAP}" if len(names) > NAMES_CAP else ""
            out.append(f"{k} {len(names)}: {', '.join(names[:NAMES_CAP])}{more}")
        return out

    def passage(self, u: str) -> str:
        n = self.node[u]
        out = f"{self.label_of[u]} ({self.type_label.get(self.type_of[u], self.type_of[u])})"
        attrs = [f"{k}={v}" for k, v in n.get("attrs", [])]
        if self.gap_count.get(u):
            attrs.append(f"gaps={self.gap_count[u]}")
        if attrs:
            out += " " + ", ".join(attrs)
        for p in self.links(u):
            if len(out) + 3 + len(p) > PASSAGE_MAX:
                break
            out += " | " + p
        return out

    def names_in(self, question: str) -> List[str]:
        """Items named in the question: exact with spaces ignored, or the leading 70% of a long name. Longer first."""
        q = flat(question)
        kinds = {w for w, _ in self.class_words}
        hit: Dict[str, int] = {}
        prefix: Dict[str, str] = {}
        for u, lab in self.label_of.items():
            n = flat(lab)
            if len(n) >= 2 and n in q and lab.lower() not in kinds:
                hit[u] = len(n)
            elif len(n) >= 8 and self.type_of[u] != GAP:
                cut = max(6, int(len(n) * 0.7))
                if n[:cut] in q:
                    hit[u] = cut
                    prefix[u] = n[:cut]
        # a leading-part match is dropped when a whole name already covers it
        whole = {flat(self.label_of[u]) for u in hit if u not in prefix}
        hit = {u: v for u, v in hit.items() if u not in prefix or not any(prefix[u] in w or w in prefix[u] for w in whole)}
        keep: List[str] = []
        for u in sorted(hit, key=lambda x: -hit[x]):
            if not any(flat(self.label_of[u]) in flat(self.label_of[k]) for k in keep):
                keep.append(u)
        return keep

    def types_in(self, text: str) -> List[str]:
        low = text.lower()
        out: List[str] = []
        for w, ts in self.class_words:
            if len(w) >= 2 and w in low:
                out += [t for t in ts if t not in out]
                low = low.replace(w, " ")
        return out


class LinkedGraph:
    """OmniFuse GraphStore for one question: label linking by exact names and type words, the rest from the in-memory graph."""

    def __init__(self, idx: GraphIndex, question: str):
        self.idx, self.q = idx, question
        self.exact_ids = idx.names_in(question)
        self.class_ids = [f"C:{t}" for t in idx.types_in(question)]
        self.seed_ids: List[str] = []
        self._seeded = False

    def seeds(self, limit: int = SEED_LIMIT) -> List[Tuple[Node, float]]:
        out: List[Tuple[Node, float]] = []
        seen: Set[str] = set()

        def add(u: str, sc: float, kind: str = "instance", label: Optional[str] = None) -> None:
            if u not in seen:
                seen.add(u)
                out.append((Node(id=u, label=label or self.idx.label_of.get(u, u), kind=kind), sc))

        for u in self.exact_ids:
            add(u, 1.0)
        if not self.exact_ids:
            for c in self.class_ids:
                add(c, 0.9, "class", self.idx.type_label.get(c[2:], c))
        bm = [(n, s) for n, s in self.idx.graph.search_labels(self.q, limit=limit * 2) if n.kind != "class"]
        top = bm[0][1] if bm else 1.0
        for n, s in bm:
            add(n.id, 0.3 + 0.4 * (s / top if top else 0.0))
        out = out[:limit]
        self.seed_ids = [n.id for n, _ in out]
        self._seeded = True
        return out

    def search_labels(self, query: str, *, limit: int = 30) -> List[Tuple[Node, float]]:
        return self.seeds(limit)

    def class_instances(self, class_id: str, *, limit: int = 1000) -> List[Node]:
        t = class_id[2:]
        ids = sorted((u for u, c in self.idx.type_of.items() if c == t), key=lambda u: -self.idx.gap_count.get(u, 0))
        return [Node(id=u, label=self.idx.label_of[u], kind="instance") for u in ids[:limit]]

    def neighbors(self, node_id: str, *, hops: int = 1, limit: int = 100) -> List[Tuple[str, str, str]]:
        cap = max(limit, 400) if node_id in self.exact_ids else limit
        out = []
        for t in self.idx.rel_triples.get(node_id, [])[:cap]:
            s, p, o = (x.strip() for x in t.split("→", 2))
            out.append((s, p, o))
        return out

    def all_edges(self, limit: int = 80000) -> List[Tuple[str, str]]:
        return [(s, o) for s, _, o in self.idx.edges[:limit]]

    def node_specificity(self, node_ids: List[str]) -> Dict[str, float]:
        return {u: (0.0 if u.startswith("C:") else 1.0 / (1.0 + math.log1p(self.idx.deg.get(u, 0)))) for u in node_ids}

    def neighbor_ids(self, node_id: str, *, limit: int = 100, direction: str = "both") -> List[str]:
        return self.idx.graph.neighbor_ids(node_id, limit=limit, direction=direction)

    def count_class(self, class_id: str) -> int:
        return self.idx.graph.count_class(class_id)

    def get_node(self, node_id: str) -> Optional[Node]:
        return self.idx.graph.get_node(node_id)


class SeededVector:
    """OmniFuse VectorStore: lexical hits plus the passages of linked names."""

    def __init__(self, idx: GraphIndex, g: LinkedGraph):
        self.idx, self.g = idx, g

    def search(self, query: str, *, limit: int = 20) -> List[Tuple[Chunk, float]]:
        if not self.g._seeded:
            self.g.seeds()
        base = self.idx.vector.search(query, limit=limit)
        top = base[0][1] if base else 1.0
        have = {c.id for c, _ in base}
        out = list(base)
        for i, u in enumerate(x for x in self.g.seed_ids if x in self.idx.chunk_of and x not in have):
            out.append((self.idx.chunk_of[u], top * max(0.6, 0.95 - 0.01 * i)))
        out.sort(key=lambda t: -t[1])
        return out[: max(limit, len(self.g.seed_ids))]

    def fetch(self, ids: List[str]) -> List[Chunk]:
        return [self.idx.chunk_of[i] for i in ids if i in self.idx.chunk_of]


def explore(idx: GraphIndex, question: str, *, evidence_k: int = 24) -> Dict[str, Any]:
    """One-shot OmniFuse retrieval (no LLM): linked names, types, evidence items and relations."""
    g = LinkedGraph(idx, question)
    fuse = OmniFuse(g, SeededVector(idx, g), None, vector_k=VECTOR_K, evidence_k=evidence_k, seed_label_limit=SEED_LIMIT, graph_fusion=True, fusion_direction="both")
    res = fuse.search(question, synthesize=False)
    evidence = [idx.id_of_text[t] for t in (res.evidence or []) if t in idx.id_of_text]
    ranked = [c.id for c in (res.chunks or [])]
    items = list(dict.fromkeys(g.exact_ids + evidence + ranked))
    return {"found": g.exact_ids, "types": [c[2:] for c in g.class_ids], "items": [u for u in items if u in idx.node][:40], "relations": list(res.relations or [])[:40]}


_lock = threading.Lock()
_cache: Dict[str, Any] = {"idx": None, "key": None}


def index_from(path: str, gap_label: str = "control gap") -> GraphIndex:
    """Index a search graph file, rebuilt only when the file changes."""
    key = (path, os.path.getmtime(path), gap_label)
    with _lock:
        if _cache["key"] != key:
            with open(path, encoding="utf-8") as f:
                _cache.update(idx=GraphIndex(json.load(f), gap_label), key=key)
        return _cache["idx"]
