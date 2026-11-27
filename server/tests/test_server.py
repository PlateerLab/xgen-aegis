import importlib
import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

from xgen_aegis_server import agent as G
from xgen_aegis_server import index as I

GRAPH = Path(__file__).parent / "fixtures" / "demo-graph.json"


def idx() -> I.GraphIndex:
    return I.GraphIndex(json.loads(GRAPH.read_text(encoding="utf-8")))


def test_index_links_names_and_types_from_the_graph():
    i = idx()
    # spaces ignored, leading part of a long name accepted
    assert i.names_in("which tools does Reportwriter use") == ["agent:a1"]
    assert i.names_in("Policy check results") == ["agent:a2"]
    assert i.types_in("how many approval rule entries") == ["ApprovalRule"]
    assert set(i.near("agent:a1")) == {"user:u2", "model:m2", "tool:web", "tool:files", "error:error|ConnectionError|search_index", "error:error|TimeoutError|call_model"}
    # control gaps are nodes linked to what they affect
    assert i.gap_count["agent:a3"] == 2


def test_explore_runs_omnifuse_without_an_llm():
    ex = I.explore(idx(), "Shell helper shell tool")
    assert ex["found"] == ["agent:a3"]
    assert "agent:a3" in ex["items"] and "tool:shell" in ex["items"]


def test_related_returns_the_nearest_layer_and_linked_types_for_unknown_words():
    s = G.Session(idx())
    r = s.related("Report writer", "gadget")
    assert "linked_types" in r and r["linked_types"]["Tool"] == 2
    r = s.related("Report writer", "Tool")
    assert r["count"] == 2 and s.last_list == ["tool:web", "tool:files"]


def test_propose_only_actions_the_item_allows():
    s = G.Session(idx())
    assert "error" in s.propose_action("rule:agent.share", "Delete", "x")
    assert s.propose_action("rule:agent.share", "approval required", "share needs approval") == {"ok": True}
    assert s.proposals[0]["target"] == "rule:agent.share" and s.proposals[0]["label"] == "Approval required"


def scripted(steps):
    """A stand-in LLM that plays back tool calls, then an answer."""
    it = iter(steps)

    def llm(messages, tools):
        step = next(it)
        if isinstance(step, str):
            return {"choices": [{"message": {"content": step}}]}
        calls = [{"id": f"c{n}", "function": {"name": name, "arguments": json.dumps(args)}} for n, (name, args) in enumerate(step)]
        return {"choices": [{"message": {"content": "", "tool_calls": calls}}]}
    return llm


def test_ask_answers_with_found_list_and_proposals():
    i = idx()
    r = G.ask(i, "How many tools does Report writer use?", llm=scripted([
        [("related", {"ref": "Report writer", "type": "tools"})],
        [("related", {"ref": "Report writer", "type": "Tool"})],
        "Tool: 2.",
    ]))
    assert r["found"] == ["agent:a1"]
    assert r["list"] == ["tool:web", "tool:files"]
    assert r["tools"] == ["related", "related"]
    r = G.ask(i, "Fix sharing for Shell helper", llm=scripted([
        [("get_item", {"ref": "Shell helper"})],
        [("propose_action", {"target": "Shell helper", "action": "Shared", "reason": "shell on a shared agent"})],
        "Proposed: stop sharing it. It waits for approval.",
    ]))
    assert r["proposals"] == [{"target": "agent:a3", "action": "agents:PUT /api/admin/agents/{agentId}", "label": "Shared", "reason": "shell on a shared agent"}]


def test_list_falls_back_to_linked_items_of_the_types_the_answer_names():
    r = G.ask(idx(), "What is Shell helper made of?", llm=scripted([[("get_item", {"ref": "Shell helper"})], "It calls 2 Tool items."]))
    assert r["list"] == ["tool:shell", "tool:web"]


def test_http_endpoints(monkeypatch):
    monkeypatch.setenv("AEGIS_GRAPH", str(GRAPH))
    monkeypatch.setenv("AEGIS_ORIGINS", "http://allowed.example")
    monkeypatch.delenv("AEGIS_LLM_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    from xgen_aegis_server import http as H
    H = importlib.reload(H)
    srv = H.ThreadingHTTPServer(("127.0.0.1", 0), H.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        h = json.loads(urllib.request.urlopen(base + "/health").read())
        assert h["ok"] and h["items"] == 22 and h["llm"] is False

        def post(path, body, origin="http://allowed.example"):
            req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Origin": origin})
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, dict(r.headers), json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, dict(e.headers), json.loads(e.read())

        code, headers, body = post("/search", {"q": "Report writer"})
        assert code == 200 and body["found"] == ["agent:a1"]
        assert headers.get("Access-Control-Allow-Origin") == "http://allowed.example"
        _, headers, _ = post("/search", {"q": "Report writer"}, origin="http://other.example")
        assert "Access-Control-Allow-Origin" not in headers
        assert post("/search", {"q": ""})[0] == 400
        assert post("/ask", {"q": "anything"})[0] == 503
    finally:
        srv.shutdown()


def test_list_falls_back_to_items_the_answer_names():
    r = G.ask(idx(), "Which agents use an external model?", llm=scripted([[("search_graph", {"query": "agents external model"})], "Report writer and Shell helper."]))
    assert set(r["list"]) == {"agent:a1", "agent:a3"}


def test_filters_accept_any_boolean_spelling_and_say_when_nothing_matches():
    s = G.Session(idx())
    down = s.find_items("Service", [["healthy", "=", "no"]])
    assert down["count"] == 1 and down["items"][0]["name"] == "vector-store"
    assert s.find_items("Service", [["healthy", "=", "False"]])["count"] == 1
    miss = s.find_items("Service", [["state", "=", "down"]])
    assert miss["count"] == 0 and "error" in miss and "healthy" in miss["attrs"]


def test_question_types_and_their_attributes_go_to_the_llm():
    seen = {}

    def llm(messages, tools):
        seen["user"] = messages[-1]["content"]
        return {"choices": [{"message": {"content": "vector-store is down."}}]}
    G.ask(idx(), "which Service is down?", llm=llm)
    assert "Type in the question: Service (3 items; attributes e.g. healthy: true / false)" in seen["user"]
