"""HTTP server: GET /health, POST /search (OmniFuse only), POST /ask (LLM tool calling).

    AEGIS_GRAPH=graph.json python -m xgen_aegis_server.http

Environment: AEGIS_GRAPH (search graph file, re-indexed when it changes), AEGIS_PORT (7842), AEGIS_ORIGINS (comma-separated CORS
allow list; empty allows none), AEGIS_ASK_PER_MIN (20), AEGIS_ASK_PER_DAY (1500), AEGIS_GAP_LABEL, and the LLM settings in agent.py.
Questions are not logged.
"""
from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Deque, Dict

from . import agent as G
from . import index as I

GRAPH = os.getenv("AEGIS_GRAPH", "graph.json")
ORIGINS = {o.strip() for o in os.getenv("AEGIS_ORIGINS", "").split(",") if o.strip()}
PER_MIN = int(os.getenv("AEGIS_ASK_PER_MIN", "20"))
PER_DAY = int(os.getenv("AEGIS_ASK_PER_DAY", "1500"))
MAX_Q = 300
_hits: Dict[str, Deque[float]] = defaultdict(deque)
_day = {"date": "", "n": 0}
_lock = threading.Lock()


def allowed(ip: str) -> bool:
    now = time.time()
    with _lock:
        today = time.strftime("%Y-%m-%d")
        if _day["date"] != today:
            _day.update(date=today, n=0)
        q = _hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= PER_MIN or _day["n"] >= PER_DAY:
            return False
        q.append(now)
        _day["n"] += 1
        return True


def idx() -> I.GraphIndex:
    return I.index_from(GRAPH, os.getenv("AEGIS_GAP_LABEL", "control gap"))


def search(q: str) -> Dict[str, Any]:
    t0 = time.perf_counter()
    ex = I.explore(idx(), q)
    return {**ex, "took": round((time.perf_counter() - t0) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:  # questions are not logged
        return

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path != "/health":
            return self._json(404, {"error": "not found"})
        try:
            i = idx()
            self._json(200, {"ok": True, "items": len(i.node), "edges": len(i.edges), "readAt": i.read_at, "llm": bool(G.llm_config()[2]), "model": G.llm_config()[1]})
        except Exception as e:  # missing or broken graph file
            self._json(503, {"ok": False, "error": type(e).__name__})

    def do_POST(self) -> None:
        if self.path not in ("/search", "/ask"):
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 65536)) or b"{}")
        except ValueError:
            return self._json(400, {"error": "bad json"})
        q = str(body.get("q", "")).strip()
        if not q or len(q) > MAX_Q:
            return self._json(400, {"error": f"q must be 1..{MAX_Q} characters"})
        if self.path == "/search":
            return self._json(200, search(q))
        if not G.llm_config()[2]:
            return self._json(503, {"error": "no LLM key configured"})
        if not allowed(self.client_address[0]):
            return self._json(429, {"error": "too many questions"})
        try:
            hist = [h for h in (body.get("history") or []) if isinstance(h, dict)][-6:]
            self._json(200, G.ask(idx(), q, selected=body.get("selected"), history=hist))
        except Exception as e:  # LLM unreachable: the client answers from the graph instead
            self._json(502, {"error": type(e).__name__})


def main() -> None:
    port = int(os.getenv("AEGIS_PORT", "7842"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
