"""Aegis search server: OmniFuse over the governance graph, and LLM tool calling that only proposes actions."""
from .agent import ask
from .index import GraphIndex, explore, index_from

__all__ = ["GraphIndex", "ask", "explore", "index_from"]
__version__ = "0.1.0"
