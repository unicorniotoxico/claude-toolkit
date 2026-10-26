"""Hooks de Claude Code: `prompt` (UserPromptSubmit) y `stop` (Stop).

Contrato failure-safe: cualquier error termina con exit 0 y sin salida; Claude sigue normalmente.
Invocación: <python del venv> -I <home>/app/hooks.py prompt|stop
"""
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

T0 = time.perf_counter()


def log_error(event, exc):
    try:
        from app import config
        config.LOGS.mkdir(parents=True, exist_ok=True)
        f = config.LOGS / "errors.log"
        if f.exists() and f.stat().st_size > 256_000:
            os.replace(f, f.with_suffix(".log.1"))
        with open(f, "a", encoding="utf-8") as fh:  # solo tipo de error, nunca contenido
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {event} {type(exc).__name__}\n")
    except Exception:
        pass


def write_metric(cfg, rec):
    if not cfg["metrics"]["enabled"]:
        return
    from app import config
    config.LOGS.mkdir(parents=True, exist_ok=True)
    f = config.METRICS
    if f.exists() and f.stat().st_size > 5_000_000:
        os.replace(f, f.with_suffix(".jsonl.1"))
    rec["ts"] = round(time.time(), 1)
    rec["ms"] = round((time.perf_counter() - T0) * 1000, 1)
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, separators=(",", ":")) + "\n")


# ----------------------------------------------------------------------------- prompt

def on_prompt(data, cfg):
    from app import config, context, store
    prompt = data.get("prompt") or ""
    sid = data.get("session_id") or ""
    if not prompt.strip():
        return None
    root = context.find_root(data.get("cwd") or os.getcwd())
    signals = context.extract(prompt)
    scfg = cfg["session_context"]
    session = context.load_session(sid, scfg["ttl_hours"]) if scfg["enabled"] else {}
    ambiguous = context.is_ambiguous(prompt, signals["words"], scfg["ambiguous_max_words"])
    parts, metric = [], {"ev": "prompt", "sid": sid[:12], "inj": 0, "chars": 0}

    if not cfg["subagents"]["enabled"]:
        parts.append("Política local: subagentes desactivados; usa herramientas directamente.")
    if not cfg["security_review"]["enabled"]:
        parts.append("Política local: no abras seguridad-revisor; el principal verifica los controles afectados.")

    mcfg = cfg["memory"]
    if mcfg["enabled"] and mcfg["retrieve"] and config.DB.exists():
        con = store.connect(timeout=cfg["limits"]["sqlite_timeout_s"])
        try:
            sel, st = store.retrieve(con, signals, cfg, root=root, session=session, session_id=sid)
        finally:
            con.close()
        block = store.format_block(sel, mcfg["max_chars"])
        if block:
            parts.append(block)
        metric.update(cand=st["candidates"], inj=st["selected"], low=st["below_threshold"],
                      stale=st["stale"], amb=st["ambiguous"])

    if scfg["enabled"] and ambiguous and session.get("task"):
        bits = [f"proyecto={Path(session.get('project', '')).name}"]
        for key, label in (("branch", "rama"), ("task", "tarea"), ("decision", "última decisión")):
            if session.get(key):
                bits.append(f"{label}={session[key]}")
        if session.get("files"):
            bits.append("archivos=" + ", ".join(session["files"][:5]))
        if session.get("symbols"):
            bits.append("símbolos=" + ", ".join(session["symbols"][:5]))
        parts.append("Contexto de sesión (prompt breve): " + " · ".join(bits)[:480])
        metric["sess"] = 1

    if cfg["stack_hints"]["enabled"] and context.SENSITIVE.search(prompt):
        hinted = session.get("hinted", [])
        new = [s for s in context.detect_stacks(root) if s not in hinted]
        if new:
            paths = ", ".join(str(config.STACKS_DIR / f"{s}.md").replace("\\", "/") for s in new)
            parts.append(f"Superficie posiblemente sensible. Stack detectado: {', '.join(new)}. "
                         f"Si el cambio toca controles, lee solo los IDs pertinentes de: {paths}")
            session["hinted"] = hinted + new
            metric["hint"] = new

    if scfg["enabled"]:
        branch, _ = context.git_info(root)
        session.update(project=str(root), branch=branch or "")
        if not ambiguous:
            snip = context.safe_snippet(prompt, 160)
            if snip:
                session["task"] = snip
            session["topic"] = context.push_unique(session.get("topic", []), signals["words"][:6][::-1], 10)
        context.push_unique(session.setdefault("symbols", []), signals["symbols"][::-1], scfg["max_symbols"])
        context.save_session(sid, session)

    out = "\n".join(parts)
    metric["chars"] = len(out)
    write_metric(cfg, metric)
    return out or None


# ----------------------------------------------------------------------------- stop

_KV = re.compile(r"^\s*([a-z_]+)\s*=\s*(.*?)\s*$")
DECISION_TYPES = {"security_decision", "architecture", "user_correction", "business_rule", "authorization_rule"}


def parse_memory_blocks(text, limit=3):
    blocks, cur = [], None
    for line in (text or "").splitlines():
        s = line.strip()
        if s in ("MEMORY:", "```memory"):
            if cur:
                blocks.append(cur)
            cur = {}
            continue
        if cur is None:
            continue
        m = _KV.match(line)
        if m and m.group(1) in ("type", "topic", "fact", "files", "symbols", "validity", "importance",
                                "confidence", "aliases", "scope", "stack", "supersedes", "project"):
            cur[m.group(1)] = m.group(2)
            continue
        if s == "MEMORY:" or (not s and not cur):
            continue
        blocks.append(cur)
        cur = None
    if cur:
        blocks.append(cur)
    return [b for b in blocks if b.get("fact")][:limit]


def read_turn(transcript_path, tail_bytes):
    """Entradas del último turno (desde el último prompt real del usuario)."""
    p = Path(transcript_path or "")
    if not p.is_file():
        return []
    size = p.stat().st_size
    with open(p, "rb") as fh:
        fh.seek(max(0, size - tail_bytes))
        raw = fh.read().decode("utf-8", "replace").splitlines()
    if size > tail_bytes:
        raw = raw[1:]
    entries = []
    for line in raw:
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    turn = []
    for e in reversed(entries):
        turn.append(e)
        if e.get("type") == "user" and not e.get("isMeta") and not e.get("isSidechain"):
            c = (e.get("message") or {}).get("content")
            if isinstance(c, str) or (isinstance(c, list) and any(
                    isinstance(i, dict) and i.get("type") == "text" for i in c)):
                break
    return list(reversed(turn))


def summarize_turn(entries):
    tools, agents, edited, read, usage, seen, last_text = {}, [], [], [], {}, set(), ""
    for e in entries:
        msg = e.get("message") or {}
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        mid = msg.get("id")
        if mid and mid not in seen and isinstance(msg.get("usage"), dict):
            seen.add(mid)
            for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                usage[k] = usage.get(k, 0) + int(msg["usage"].get(k) or 0)
        for item in msg.get("content") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text":
                last_text = item.get("text") or last_text
            if item.get("type") != "tool_use":
                continue
            name = item.get("name") or "?"
            tools[name] = tools.get(name, 0) + 1
            inp = item.get("input") or {}
            if name in ("Agent", "Task"):
                agents.append(inp.get("subagent_type") or "general-purpose")
            fp = inp.get("file_path") or inp.get("notebook_path")
            if fp:
                (edited if name in ("Edit", "Write", "MultiEdit", "NotebookEdit") else read).append(fp)
    return {"tools": tools, "agents": agents, "edited": edited, "read": read, "usage": usage,
            "last_text": last_text}


def on_stop(data, cfg):
    from app import config, context, store
    sid = data.get("session_id") or ""
    root = context.find_root(data.get("cwd") or os.getcwd())
    entries = read_turn(data.get("transcript_path"), cfg["limits"]["transcript_tail_bytes"])
    turn = summarize_turn(entries)
    text = data.get("last_assistant_message") or turn["last_text"]
    metric = {"ev": "stop", "sid": sid[:12], "tools": turn["tools"], "agents": turn["agents"],
              "usage": turn["usage"], "saved": 0, "rejected": []}

    mcfg, decision = cfg["memory"], None
    blocks = parse_memory_blocks(text, mcfg["max_blocks_per_turn"]) if "MEMORY:" in (text or "") or \
        "```memory" in (text or "") else []
    if blocks and mcfg["enabled"] and mcfg["store"]:
        con = store.connect(timeout=max(1.0, cfg["limits"]["sqlite_timeout_s"]))
        try:
            for b in blocks:
                try:
                    action, mid = store.add(con, b, root=root, session_id=sid, cfg=cfg)
                    metric["saved"] += 1
                    if b.get("type") in DECISION_TYPES:
                        decision = context.safe_snippet(b["fact"], 160)
                except store.Rejected as exc:
                    metric["rejected"].append(str(exc)[:80])
        finally:
            con.close()

    scfg = cfg["session_context"]
    if scfg["enabled"]:
        session = context.load_session(sid, scfg["ttl_hours"])
        rels = []
        for f in turn["edited"] + turn["read"]:
            try:
                rels.append(str(Path(f).resolve().relative_to(root)).replace("\\", "/"))
            except (ValueError, OSError):
                rels.append(Path(f).name)
        context.push_unique(session.setdefault("files", []), list(dict.fromkeys(rels))[::-1], scfg["max_files"])
        if decision:
            session["decision"] = decision
        session.setdefault("project", str(root))
        context.save_session(sid, session)
        context.cleanup_sessions(scfg["ttl_hours"])
    write_metric(cfg, metric)
    return None


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        from app import config
        cfg = config.load()
        if not cfg["enabled"]:
            return 0
        raw = sys.stdin.buffer.read(2_000_000).decode("utf-8", "replace")
        data = json.loads(raw) if raw.strip() else {}
        if event == "prompt":
            out = on_prompt(data, cfg)
            if out:
                sys.stdout.write(json.dumps({"hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit", "additionalContext": out}}))  # ASCII: inmune a cp1252
        elif event == "stop":
            on_stop(data, cfg)
    except Exception as exc:  # failure-safe: nunca bloquear a Claude
        log_error(event, exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
