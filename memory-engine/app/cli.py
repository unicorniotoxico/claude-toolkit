"""CLI local: memory search|add|show|list|forget|verify|stats|metrics|doctor|vacuum."""
import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, context, store  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _row_line(r):
    day = time.strftime("%Y-%m-%d", time.localtime(r["last_verified_at"]))
    proj = Path(r["project"]).name if r["project"] else "global"
    return f"#{r['id']:<5} {r['status']:<10} {r['type']:<18} {proj:<18} {day}  {r['fact'][:90]}"


def cmd_search(a, cfg):
    root = context.find_root(a.cwd) if not a.global_only else None
    con = store.connect()
    signals = context.extract(a.text)
    scored, st = store.retrieve(con, signals, cfg, root=root, explain=True)
    print(f"términos={signals} candidatos={st['candidates']} umbral={cfg['memory']['threshold']}")
    for score, gate, r, feats in scored[: a.limit]:
        mark = "✓" if gate and score >= cfg["memory"]["threshold"] else " "
        print(f"{mark} {score:.3f} {_row_line(r)}\n         {feats}")
    if a.inject:
        sel, _ = store.retrieve(con, signals, cfg, root=root)
        print("\n--- bloque que se inyectaría ---\n" + (store.format_block(sel, cfg["memory"]["max_chars"]) or "(nada)"))


def cmd_add(a, cfg):
    root = None if a.scope == "global" else context.find_root(a.cwd)
    con = store.connect()
    mem = {k: getattr(a, k) for k in ("type", "fact", "topic", "files", "symbols", "aliases", "validity",
                                       "importance", "scope", "stack", "supersedes")}
    try:
        action, mid = store.add(con, mem, root=root, cfg=cfg)
    except store.Rejected as exc:
        print(f"rechazado: {exc}")
        return 2
    print(f"{action} #{mid}")


def cmd_show(a, cfg):
    r = store.connect().execute("SELECT * FROM memories WHERE id=?", (a.id,)).fetchone()
    if not r:
        print("no existe")
        return 1
    d = dict(r)
    for k in ("created_at", "updated_at", "last_verified_at", "last_used_at"):
        if d.get(k):
            d[k] = time.strftime("%Y-%m-%d %H:%M", time.localtime(d[k]))
    print(json.dumps(d, ensure_ascii=False, indent=2))


def cmd_list(a, cfg):
    con = store.connect()
    sql, args = "SELECT * FROM memories WHERE 1=1", []
    if not a.all:
        sql += " AND status IN ('active','stale')"
    if a.type:
        sql += " AND type=?"
        args.append(a.type)
    if a.here:
        sql += " AND project=?"
        args.append(context.project_id(context.find_root(a.cwd)))
    for r in con.execute(sql + " ORDER BY updated_at DESC LIMIT ?", (*args, a.limit)):
        print(_row_line(r))


def cmd_forget(a, cfg):
    con = store.connect()
    with con:
        if a.purge:
            n = con.execute("DELETE FROM memories WHERE id=?", (a.id,)).rowcount
        else:
            n = con.execute("UPDATE memories SET status='forgotten', updated_at=? WHERE id=?",
                            (time.time(), a.id)).rowcount
    print(("purgado" if a.purge else "olvidado") if n else "no existe")


def cmd_verify(a, cfg):
    """Reverificación manual: recalcula hashes/commit y reactiva."""
    con = store.connect()
    r = con.execute("SELECT * FROM memories WHERE id=?", (a.id,)).fetchone()
    if not r:
        print("no existe")
        return 1
    root = context.find_root(a.cwd) if r["project"] else None
    files = store._lines(r["files"])
    hashes = store._hash_sources(root, files) if root and files else r["source_hashes"]
    commit = context.git_info(root)[1] if root else r["commit_ref"]
    dh = context.dep_hash(root) if root else r["dep_hash"]
    now = time.time()
    with con:
        con.execute("UPDATE memories SET status='active', source_hashes=?, commit_ref=?, dep_hash=?, "
                    "last_verified_at=?, updated_at=? WHERE id=?", (hashes, commit, dh, now, now, a.id))
    print(f"#{a.id} reverificado")


def cmd_stats(a, cfg):
    con = store.connect()
    print("estado:", dict(con.execute("SELECT status, count(*) FROM memories GROUP BY status").fetchall()))
    print("tipo:", dict(con.execute("SELECT type, count(*) FROM memories WHERE status='active' GROUP BY type")
                        .fetchall()))
    print("proyectos:", con.execute("SELECT count(DISTINCT project) FROM memories").fetchone()[0])
    print(f"db: {config.DB.stat().st_size / 1024:.1f} KiB" if config.DB.exists() else "db: inexistente")
    cmd_metrics(a, cfg)


def cmd_metrics(a, cfg):
    if not config.METRICS.exists():
        print("métricas: sin datos")
        return
    p = {"n": 0, "inj": 0, "zero": 0, "chars": 0, "ms": [], "stale": 0, "low": 0, "sess": 0}
    s = {"n": 0, "tools": 0, "agents": {}, "saved": 0, "rejected": 0, "ms": [], "out": 0, "in": 0, "cache": 0}
    since = time.time() - a.days * 86400 if getattr(a, "days", None) else 0
    for line in config.METRICS.read_text("utf-8").splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("ts", 0) < since:
            continue
        if m.get("ev") == "prompt":
            p["n"] += 1
            p["inj"] += m.get("inj", 0)
            p["zero"] += m.get("inj", 0) == 0
            p["chars"] += m.get("chars", 0)
            p["stale"] += m.get("stale", 0)
            p["low"] += m.get("low", 0)
            p["sess"] += m.get("sess", 0)
            p["ms"].append(m.get("ms", 0))
        elif m.get("ev") == "stop":
            s["n"] += 1
            s["tools"] += sum(m.get("tools", {}).values())
            for ag in m.get("agents", []):
                s["agents"][ag] = s["agents"].get(ag, 0) + 1
            s["saved"] += m.get("saved", 0)
            s["rejected"] += len(m.get("rejected", []))
            s["ms"].append(m.get("ms", 0))
            u = m.get("usage", {})
            s["out"] += u.get("output_tokens", 0)
            s["in"] += u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            s["cache"] += u.get("cache_read_input_tokens", 0)

    def p95(xs):
        return sorted(xs)[int(len(xs) * 0.95) - 1] if xs else 0
    print(f"prompts={p['n']} recuerdos_inyectados={p['inj']} prompts_sin_inyección={p['zero']} "
          f"chars_inyectados={p['chars']} descartados_umbral={p['low']} descartados_stale={p['stale']} "
          f"contexto_sesión={p['sess']} hook_p95_ms={p95(p['ms']):.0f}")
    print(f"turnos={s['n']} tool_calls={s['tools']} agentes={s['agents']} memorias_guardadas={s['saved']} "
          f"rechazadas={s['rejected']} tokens_salida={s['out']} tokens_entrada_nuevos={s['in']} "
          f"tokens_cache_leídos={s['cache']} stop_p95_ms={p95(s['ms']):.0f}")
    print("(tokens leídos del transcript local; no equivalen a % del cupo Pro)")


def cmd_doctor(a, cfg):
    ok = True

    def chk(name, cond, detail=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"[{'OK' if cond else 'FALLA'}] {name}{' — ' + detail if detail else ''}")
    chk("intérprete aislado", "memory-engine" in sys.prefix.replace("\\", "/"), sys.prefix)
    chk("sin paquetes de terceros en venv",
        not [p for p in Path(sys.prefix, "Lib", "site-packages").glob("*") if not p.name.startswith(("_", "pip"))]
        if Path(sys.prefix, "Lib", "site-packages").exists() else True)
    chk("config válida", not cfg.get("_config_error"), str(config.HOME / "config.json"))
    print(f"      flags: enabled={cfg['enabled']} memory={cfg['memory']['enabled']} "
          f"security_review={cfg['security_review']['enabled']} subagents={cfg['subagents']['enabled']}")
    try:
        con = sqlite3.connect(":memory:")
        con.execute("CREATE VIRTUAL TABLE t USING fts5(a)")
        chk("FTS5 disponible", True, sqlite3.sqlite_version)
    except sqlite3.Error as exc:
        chk("FTS5 disponible", False, str(exc))
    try:
        con = store.connect()
        chk("integridad DB", con.execute("PRAGMA quick_check").fetchone()[0] == "ok", str(config.DB))
        con.execute("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')")
        chk("integridad FTS", True)
    except sqlite3.Error as exc:
        chk("integridad DB/FTS", False, str(exc))
    chk("memory-engine fuera del PATH", "memory-engine" not in os.environ.get("PATH", "").lower())
    t = time.perf_counter()
    import subprocess
    r = subprocess.run([sys.executable, "-I", str(config.HOME / "app" / "hooks.py"), "prompt"],
                       input=json.dumps({"prompt": "doctor probe autorización", "session_id": "doctor-probe",
                                         "cwd": str(config.HOME)}).encode(), capture_output=True, timeout=10)
    ms = (time.perf_counter() - t) * 1000
    chk("hook prompt responde", r.returncode == 0, f"{ms:.0f} ms (proceso completo)")
    try:
        (config.SESSIONS / "doctor-probe.json").unlink()
    except OSError:
        pass
    err = config.LOGS / "errors.log"
    if err.exists():
        tail = err.read_text("utf-8").splitlines()[-3:]
        print("      últimos errores de hook:", tail)
    return 0 if ok else 1


def cmd_vacuum(a, cfg):
    con = store.connect()
    limit = time.time() - a.days * 86400
    with con:
        n1 = con.execute("DELETE FROM memories WHERE status IN ('forgotten','superseded') AND updated_at<?",
                         (limit,)).rowcount
        n2 = con.execute("DELETE FROM memories WHERE status='stale' AND updated_at<?",
                         (time.time() - a.stale_days * 86400,)).rowcount
    con.execute("INSERT INTO memories_fts(memories_fts) VALUES('optimize')")
    con.execute("VACUUM")
    n3 = context.cleanup_sessions(cfg["session_context"]["ttl_hours"])
    print(f"eliminados olvidados/reemplazados={n1} stale_antiguos={n2} sesiones_expiradas={n3}")


def main(argv=None):
    cfg = config.load()
    ap = argparse.ArgumentParser(prog="memory")
    ap.add_argument("--cwd", default=os.getcwd())
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("text")
    s.add_argument("--limit", type=int, default=10)
    s.add_argument("--global-only", action="store_true")
    s.add_argument("--inject", action="store_true", help="muestra el bloque exacto que recibiría Claude")
    s = sub.add_parser("add")
    s.add_argument("--type", required=True, choices=store.TYPES)
    s.add_argument("--fact", required=True)
    s.add_argument("--topic", default="")
    s.add_argument("--files", default="")
    s.add_argument("--symbols", default="")
    s.add_argument("--aliases", default="")
    s.add_argument("--stack", default="")
    s.add_argument("--validity", default="durable", choices=store.VALIDITY)
    s.add_argument("--importance", type=int, default=3)
    s.add_argument("--scope", default="project", choices=("project", "global"))
    s.add_argument("--supersedes", default="")
    for name in ("show", "forget", "verify"):
        s = sub.add_parser(name)
        s.add_argument("id", type=int)
        if name == "forget":
            s.add_argument("--purge", action="store_true", help="borrado físico en vez de lógico")
    s = sub.add_parser("list")
    s.add_argument("--limit", type=int, default=30)
    s.add_argument("--type")
    s.add_argument("--all", action="store_true")
    s.add_argument("--here", action="store_true", help="solo el proyecto del cwd")
    sub.add_parser("stats")
    s = sub.add_parser("metrics")
    s.add_argument("--days", type=float)
    sub.add_parser("doctor")
    s = sub.add_parser("vacuum")
    s.add_argument("--days", type=float, default=30)
    s.add_argument("--stale-days", type=float, default=90)
    a = ap.parse_args(argv)
    return globals()["cmd_" + a.cmd](a, cfg) or 0


if __name__ == "__main__":
    sys.exit(main())
