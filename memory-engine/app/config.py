"""Configuración y rutas del memory engine. Solo stdlib."""
import copy
import json
import os
from pathlib import Path

HOME = Path(os.environ.get("MEMORY_ENGINE_HOME") or Path(__file__).resolve().parent.parent)

DEFAULTS = {
    "enabled": True,
    "memory": {
        "enabled": True,
        "retrieve": True,
        "store": True,
        "max_results": 3,
        "max_chars": 1400,          # ~350 tokens de recuerdos
        "threshold": 0.45,
        "min_text": 0.15,           # o coincidencia de archivo/símbolo
        "candidate_limit": 40,
        "bm25_k": 2.0,
        "stale_action": "exclude",  # exclude | flag
        "stale_penalty": 0.30,
        "recency_half_life_days": 90,
        "max_fact_chars": 500,
        "max_blocks_per_turn": 3,
        "dedup_jaccard": 0.75,
        "weights": {
            "text": 0.35, "project": 0.15, "file": 0.25, "symbol": 0.20,
            "topic": 0.10, "session": 0.10, "importance": 0.05,
            "confidence": 0.05, "recency": 0.05,
        },
    },
    "session_context": {"enabled": True, "ttl_hours": 24, "max_files": 10, "max_symbols": 12,
                        "ambiguous_max_words": 3},
    "stack_hints": {"enabled": True},
    "security_review": {"enabled": True},
    "subagents": {"enabled": True},
    "metrics": {"enabled": True},
    "limits": {"hook_budget_ms": 1500, "sqlite_timeout_s": 0.25,
               "transcript_tail_bytes": 400000, "runlog_keep": 50, "runlog_max_lines": 80},
}


def _merge(base, extra):
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


def load():
    cfg = copy.deepcopy(DEFAULTS)
    try:
        _merge(cfg, json.loads((HOME / "config.json").read_text("utf-8")))
    except FileNotFoundError:
        pass
    except Exception:
        # Configuración ilegible: no adivinar; apagar el sistema y dejar a Claude intacto.
        cfg["enabled"] = False
        cfg["_config_error"] = True
    if os.environ.get("CLAUDE_MEMORY_DISABLED") == "1":
        cfg["enabled"] = False
    return cfg


DATA = HOME / "data"
DB = DATA / "memory.db"
SESSIONS = DATA / "session"
LOGS = HOME / "logs"
RUNS = LOGS / "runs"
METRICS = LOGS / "metrics.jsonl"
STACKS_DIR = Path(os.environ.get("CLAUDE_HOME") or Path.home() / ".claude") / "security" / "stacks"
