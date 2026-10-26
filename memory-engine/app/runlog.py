"""Ejecuta un comando (o lee un archivo), guarda el output completo y devuelve solo lo relevante.

  run -- npm test                          ejecuta y resume
  run --grep "FAIL|Error" -- pytest        patrón propio
  run --file <log> [--grep P] [--lines A-B]   consulta un output ya guardado
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ERR = re.compile(r"(?i)(\berror\b|\bfail(ed|ure)?\b|exception|traceback|fatal|panic|\bE\d{3,}\b|✗|✘|"
                 r"\bcritical\b|\bhigh\b(?=.*vuln)|undefined reference|cannot find|not found|denied|refused)")
WARN = re.compile(r"(?i)\b(warn(ing)?|deprecated)\b")
NOISE = re.compile(r"(?i)(0 errors?|no errors|errors?: 0|0 failed|failed: 0|without errors)")


def digest(lines, pattern=None, ctx=2, max_lines=80, tail=15):
    rx = re.compile(pattern) if pattern else None
    hits = []
    n_err = n_warn = 0
    for i, line in enumerate(lines):
        if rx:
            if rx.search(line):
                hits.append(i)
            continue
        if ERR.search(line) and not NOISE.search(line):
            n_err += 1
            hits.append(i)
        elif WARN.search(line):
            n_warn += 1
    keep = set()
    for i in hits:
        keep.update(range(max(0, i - ctx), min(len(lines), i + ctx + 1)))
    out, prev = [], -2
    for i in sorted(keep):
        if len(out) >= max_lines:
            out.append(f"... ({len(hits)} coincidencias en total; usa --file con --grep/--lines para ver más)")
            break
        if i != prev + 1:
            out.append("--")
        out.append(f"{i + 1}: {lines[i][:400]}")
        prev = i
    tail_start = max(0, len(lines) - tail)
    tail_lines = [f"{i + 1}: {lines[i][:400]}" for i in range(tail_start, len(lines)) if i not in keep]
    return out, tail_lines, n_err, n_warn, len(hits)


def rotate(keep):
    files = sorted(config.RUNS.glob("*.log"), key=lambda p: p.stat().st_mtime)
    for f in files[:-keep] if len(files) > keep else []:
        try:
            f.unlink()
        except OSError:
            pass


def main(argv=None):
    cfg = config.load()
    ap = argparse.ArgumentParser(prog="run")
    ap.add_argument("--file")
    ap.add_argument("--grep")
    ap.add_argument("--lines", help="rango A-B (1-based)")
    ap.add_argument("--ctx", type=int, default=2)
    ap.add_argument("--timeout", type=float, default=1800)
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args(argv)
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    max_lines = cfg["limits"]["runlog_max_lines"]

    if a.file:
        lines = Path(a.file).read_text("utf-8", "replace").splitlines()
        if a.lines:
            s, _, e = a.lines.partition("-")
            s, e = int(s), int(e or s)
            for i in range(max(1, s), min(len(lines), e) + 1):
                print(f"{i}: {lines[i - 1][:400]}")
            return 0
        out, tail, ne, nw, nh = digest(lines, a.grep, a.ctx, max_lines, 0)
        print(f"{a.file}: {len(lines)} líneas, {nh} coincidencias")
        print("\n".join(out))
        return 0

    if not cmd:
        ap.error("falta el comando tras --")
    exe = shutil.which(cmd[0]) or cmd[0]
    config.RUNS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^A-Za-z0-9]+", "-", Path(cmd[0]).stem)[:20]
    log = config.RUNS / f"{stamp}-{slug}.log"
    t0 = time.perf_counter()
    try:
        r = subprocess.run([exe, *cmd[1:]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=a.timeout)
        code, raw = r.returncode, r.stdout
    except subprocess.TimeoutExpired as exc:
        code, raw = "timeout", exc.stdout or b""
    except OSError as exc:
        print(f"no se pudo ejecutar {cmd[0]}: {exc}")
        return 127
    secs = time.perf_counter() - t0
    text = raw.decode("utf-8", "replace")
    log.write_text(text, "utf-8")
    lines = text.splitlines()
    out, tail, ne, nw, nh = digest(lines, a.grep, a.ctx, max_lines)
    print(f"exit={code} duración={secs:.1f}s líneas={len(lines)} errores≈{ne} warnings≈{nw}")
    print(f"output completo: {str(log).replace(chr(92), '/')}")
    if out:
        print("== coincidencias ==\n" + "\n".join(out))
    if tail:
        print("== final ==\n" + "\n".join(tail))
    rotate(cfg["limits"]["runlog_keep"])
    return code if isinstance(code, int) else 124


if __name__ == "__main__":
    sys.exit(main())
