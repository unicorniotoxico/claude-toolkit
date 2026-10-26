"""Instala, diagnostica o retira el memory engine en Windows, macOS o Linux. Solo biblioteca estándar.

  engine.py install   [--claude-dir D] [--base-python P]
  engine.py doctor    [--claude-dir D]
  engine.py uninstall [--claude-dir D] [--delete-data]
Se ejecuta desde la carpeta del engine (~/.claude/memory-engine). No toca PATH, Python global, npm ni proyectos.
install es idempotente; uninstall se ejecuta con el Python base (el venv se borra) y archiva los datos salvo
--delete-data.
"""
import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

HOME = Path(__file__).resolve().parent
WIN = os.name == "nt"
PY = HOME / ".venv" / ("Scripts/python.exe" if WIN else "bin/python")
STATE = HOME / "install-state.json"
LAUNCHERS = ("memory", "run")  # equivalentes POSIX de memory.cmd / run.cmd


def run(cmd, what, **kw):
    r = subprocess.run([str(c) for c in cmd], **kw)
    if r.returncode:
        sys.exit(f"fallo al {what} (exit {r.returncode})")
    return r


def read_json(p):
    return json.loads(Path(p).read_text("utf-8-sig") or "{}") if Path(p).exists() else None


def write_json(p, data):
    Path(p).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")


def restrict(d):
    """Datos y logs: solo el usuario actual (y SYSTEM en Windows)."""
    if not WIN:
        os.chmod(d, 0o700)
        return
    # por SID: el nombre del usuario puede coincidir con el del equipo
    sid = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True,
                         check=True).stdout.strip().split(",")[-1].strip('"')
    run(["icacls", d, "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"],
        f"restringir permisos de {d}", stdout=subprocess.DEVNULL)


def install(a):
    cd = Path(a.claude_dir)
    base = a.base_python or sys.executable
    probe = subprocess.run([base, "-c", "import sys,sqlite3;c=sqlite3.connect(':memory:');"
                            "c.execute('create virtual table t using fts5(a)');print(sys.version_info>=(3,10))"],
                           capture_output=True, text=True)
    if probe.stdout.strip() != "True":
        sys.exit(f"Se requiere Python >= 3.10 con SQLite FTS5 ({base})")

    if not PY.exists():
        print(f"creando venv aislado (sin pip, sin paquetes): {PY.parent.parent}")
        run([base, "-m", "venv", "--without-pip", PY.parent.parent], "crear el venv")
    prefix = run([PY, "-I", "-c", "import sys;print(sys.prefix)"], "probar el venv",
                 capture_output=True, text=True).stdout.strip()
    if "memory-engine" not in prefix:
        sys.exit(f"el venv no resolvió a memory-engine: {prefix}")

    for d in ("data", "data/session", "logs", "logs/runs"):
        (HOME / d).mkdir(parents=True, exist_ok=True)
    for d in ("data", "logs"):
        restrict(HOME / d)
    if not WIN:
        for n in LAUNCHERS:  # un zip o una copia pueden perder el bit de ejecución
            p = HOME / n
            if p.exists():
                p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    cfg = HOME / "config.json"
    if not cfg.exists():
        run([PY, "-I", "-c", f"import json,sys;sys.path.insert(0,{str(HOME)!r});from app.config import DEFAULTS;"
             f"open({str(cfg)!r},'w',encoding='utf-8').write(json.dumps(DEFAULTS,indent=2))"], "crear config.json")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = cd / "backups" / f"memory-engine-{stamp}"
    prev = read_json(STATE)
    if prev and prev.get("backup") and (Path(prev["backup"]) / "manifest.json").exists():
        # reinstalación: conservar el respaldo de la primera instalación (estado original)
        backup, stamp = Path(prev["backup"]), prev.get("installed", stamp)
    run([PY, "-I", HOME / "app" / "installer.py", "install", "--claude-dir", cd, "--home", HOME, "--python", PY,
         "--backup", backup], f"parchear la configuración; respaldo en {backup}")
    write_json(STATE, {"backup": str(backup), "claude_dir": str(cd), "installed": stamp})

    subprocess.run([str(PY), "-I", str(HOME / "app" / "cli.py"), "stats"], stdout=subprocess.DEVNULL)
    doctor(a)
    print("Instalado. Abre una sesión nueva de Claude Code para cargar hooks y agentes.")


def _engine_procs():
    """Líneas de comando de procesos Python del engine que siguen vivos (salvo este diagnóstico)."""
    if WIN:
        cmd = ["powershell", "-NoProfile", "-Command",
               "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | ForEach-Object { $_.CommandLine }"]
    else:
        cmd = ["ps", "-A", "-o", "args="]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return [ln for ln in out.splitlines() if "memory-engine" in ln and "python" in ln.lower()
            and "engine.py" not in ln and not ("cli.py" in ln and "doctor" in ln)]


def doctor(a):
    cd = Path(a.claude_dir)
    fail = 0

    def check(name, ok, detail=""):
        nonlocal fail
        fail += not ok
        print(f"[{'OK   ' if ok else 'FALLA'}] {name}{f' - {detail}' if detail else ''}")

    check("venv aislado", PY.exists(), str(PY))
    if PY.exists() and subprocess.run([str(PY), "-I", str(HOME / "app" / "cli.py"), "doctor"]).returncode:
        fail += 1

    settings = read_json(cd / "settings.json") or {}
    for ev in ("UserPromptSubmit", "Stop"):
        hs = [h for g in (settings.get("hooks") or {}).get(ev, []) for h in g.get("hooks", [])
              if "memory-engine" in " ".join(h.get("args") or [])]
        ok = len(hs) == 1 and Path(hs[0]["command"]).exists() and Path(hs[0]["args"][1]).exists()
        check(f"hook {ev} registrado una vez y apuntando al venv", ok)
    for name, model in (("evidencia-haiku", "haiku"), ("seguridad-revisor", "sonnet")):
        f = cd / "agents" / f"{name}.md"
        ok = f.exists() and re.search(rf"(?m)^model:\s*{model}\s*$", f.read_text("utf-8-sig")) is not None
        check(f"agente {name} con model: {model}", ok)
    cm = cd / "CLAUDE.md"
    check("sección memory-engine en CLAUDE.md", cm.exists() and "memory-engine:begin" in cm.read_text("utf-8-sig"))
    if WIN:  # el PATH del proceso ya lo revisa cli.py doctor; acá el persistente
        import winreg
        for label, root, key in (("de usuario", winreg.HKEY_CURRENT_USER, "Environment"),
                                 ("de máquina", winreg.HKEY_LOCAL_MACHINE,
                                  r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")):
            try:
                with winreg.OpenKey(root, key) as k:
                    path = winreg.QueryValueEx(k, "Path")[0]
            except OSError:
                path = ""
            check(f"PATH {label} sin memory-engine", "memory-engine" not in path.lower())
    procs = _engine_procs()
    if procs is None:
        print("[  -  ] procesos residentes: no se pudo consultar")
    else:
        check("sin procesos residentes del engine", not procs, f"{len(procs)} procesos")
    print(f"{fail} comprobaciones fallaron" if fail else "doctor: todo OK")
    return 1 if fail else 0


def _rmtree(p):
    def unlock(fn, path, _):  # archivos de solo lectura en Windows
        os.chmod(path, stat.S_IWRITE)
        fn(path)
    shutil.rmtree(p, onerror=unlock)


def uninstall(a):
    st = read_json(STATE)
    if not st:
        sys.exit("no existe install-state.json; nada que desinstalar desde aquí")
    cd = Path(a.claude_dir or st["claude_dir"])
    backup = Path(st["backup"])
    runner = PY if PY.exists() else sys.executable
    run([runner, "-I", HOME / "app" / "installer.py", "uninstall", "--claude-dir", cd, "--backup", backup],
        "restaurar la configuración; el engine NO se eliminó")

    if not a.delete_data:
        arch = backup / "datos-archivados"
        arch.mkdir(parents=True, exist_ok=True)
        if (HOME / "data").exists():
            shutil.copytree(HOME / "data", arch / "data", dirs_exist_ok=True)
        if (HOME / "config.json").exists():
            shutil.copy2(HOME / "config.json", arch)
        print(f"datos archivados en {arch}")

    if Path.cwd().resolve().is_relative_to(HOME):
        os.chdir(cd)
    _rmtree(HOME)
    print(f"memory engine eliminado. Respaldo de configuración previa: {backup}")


def main():
    # como cli.py: UTF-8, y por línea para no mezclarse con la salida de los subprocesos
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=("install", "doctor", "uninstall"))
    ap.add_argument("--claude-dir")
    ap.add_argument("--base-python")
    ap.add_argument("--delete-data", action="store_true")
    a = ap.parse_args()
    if a.action != "uninstall":
        a.claude_dir = a.claude_dir or str(Path.home() / ".claude")
    return {"install": install, "doctor": doctor, "uninstall": uninstall}[a.action](a)


if __name__ == "__main__":
    sys.exit(main())
