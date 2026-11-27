# xgen-aegis-server

OmniFuse search over an Aegis graph and LLM tool calling that only proposes actions. See the main README.

```bash
pip install -e ".[dev]" && pytest
AEGIS_GRAPH=graph.json OPENAI_API_KEY=... python -m xgen_aegis_server.http
```
