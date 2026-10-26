"""Instala, actualiza o retira claude-toolkit en Windows, macOS o Linux. Solo biblioteca estándar.

  toolkit.py install   [--claude-dir D] [--toolkit-dir T] [--base-python P] [--no-dev-agents|--dev-agents]
                       [--no-tablero|--tablero]
  toolkit.py uninstall [--claude-dir D] [--delete-data]
install se copia a una carpeta fija (--toolkit-dir, por defecto ~/claude-toolkit) e instala desde esa copia:
memory-engine (hooks, CLI, evidencia-haiku, seguridad-revisor), guías de seguridad, agentes dev/appsec, sección
de CLAUDE.md y el panel /tablero. Para actualizar, volver a ejecutarlo: conserva datos, configuración y las
opciones de la instalación anterior. Lanzadores: install.ps1 / uninstall.ps1 (Windows), install.sh /
uninstall.sh (macOS, Linux).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ITEMS = ("agents", "memory-engine", "mods", "security", "templates", "toolkit.py", "install.py", "install.ps1",
         "install.sh", "uninstall.ps1", "uninstall.sh", "README.md", "CHANGELOG.md", "VERSION", ".gitignore",
         ".gitattributes")
ENGINE_ITEMS = ("app", "templates", "tests", "bench", "engine.py", "install.ps1", "uninstall.ps1", "doctor.ps1",
                "memory.cmd", "run.cmd", "memory", "run", "requirements.txt", "README.md")
# nunca se copian: datos, estado y artefactos locales de una carpeta ya usada
SKIP = shutil.ignore_patterns(".venv", "data", "logs", "config.json", "install-state.json", "__pycache__", "*.pyc")


def venv_python(engine):
    return engine / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(cmd, what):
    r = subprocess.run([str(c) for c in cmd])
    if r.returncode:
        sys.exit(f"fallo al {what} (exit {r.returncode})")


def replace(src, dst):
    if dst.is_dir():
        shutil.rmtree(dst)
    elif dst.exists():
        dst.unlink()
    if src.is_dir():
        shutil.copytree(src, dst, ignore=SKIP)
    else:
        shutil.copy2(src, dst)


def copy_toolkit(target):
    """El toolkit vive en una carpeta fija: se ejecute desde donde se ejecute (un zip, un clon), se copia ahí."""
    if target.exists() and os.path.samefile(HERE, target):
        return target
    is_toolkit = (target / "install.py").exists() and (target / "VERSION").exists()
    if target.exists() and any(target.iterdir()) and not is_toolkit:
        sys.exit(f"{target} existe y no es una copia del toolkit; elegí otra con --toolkit-dir")
    target.mkdir(parents=True, exist_ok=True)
    for item in ITEMS:
        if (HERE / item).exists():
            replace(HERE / item, target / item)
    print(f"toolkit copiado en {target}")
    return target


def install(a):
    cd = Path(a.claude_dir)
    src = copy_toolkit(Path(a.toolkit_dir).expanduser())
    version = (src / "VERSION").read_text("utf-8").strip()
    state_path = cd / "claude-toolkit-state.json"
    prev = json.loads(state_path.read_text("utf-8-sig")) if state_path.exists() else None

    # opciones no indicadas: las de la instalación anterior
    no_dev = a.no_dev_agents if a.no_dev_agents is not None else bool(prev and prev.get("no_dev_agents"))
    no_tab = a.no_tablero if a.no_tablero is not None else bool(prev and prev.get("no_tablero"))
    old = prev and prev.get("version")
    print(f"actualizando claude-toolkit {old} -> {version}" if old else f"instalando claude-toolkit {version}")

    # 1. memory-engine: copia el código; conserva data, logs, config.json y .venv de una instalación previa
    engine = cd / "memory-engine"
    engine.mkdir(parents=True, exist_ok=True)
    for item in ENGINE_ITEMS:
        frm, to = src / "memory-engine" / item, engine / item
        if not frm.exists():
            continue
        if item == "bench" and (to / "recall_cases.json").exists():
            shutil.copytree(frm, to, dirs_exist_ok=True, ignore=SKIP)  # conserva tus casos de recall locales
            continue
        replace(frm, to)
    base = a.base_python or sys.executable
    run([base, "-I", engine / "engine.py", "install", "--claude-dir", cd, "--base-python", base],
        "instalar el memory-engine")

    # 2. resto del toolkit, con el Python aislado del engine
    backup = cd / "backups" / f"claude-toolkit-{time.strftime('%Y%m%d-%H%M%S')}"
    if prev and prev.get("backup") and (Path(prev["backup"]) / "manifest.json").exists():
        backup = Path(prev["backup"])
    cmd = [venv_python(engine), "-I", src / "install.py", "install", "--claude-dir", cd, "--src", src,
           "--backup", backup]
    cmd += ["--no-dev-agents"] * no_dev + ["--no-tablero"] * no_tab
    run(cmd, f"instalar el toolkit; respaldo en {backup}")

    state_path.write_text(json.dumps({
        "version": version, "backup": str(backup), "claude_dir": str(cd), "source": str(src),
        "no_dev_agents": no_dev, "no_tablero": no_tab, "updated": time.strftime("%Y-%m-%d %H:%M"),
    }, indent=2) + "\n", "utf-8")
    print(f"claude-toolkit {version} listo. Abre una sesión nueva de Claude Code; el panel se abre solo.")


def uninstall(a):
    """Restaura guías/agentes previos, quita la sección de CLAUDE.md y el panel, y desinstala el memory-engine."""
    cd = Path(a.claude_dir)
    state_path = cd / "claude-toolkit-state.json"
    engine = cd / "memory-engine"
    if state_path.exists():
        st = json.loads(state_path.read_text("utf-8-sig"))
        py = venv_python(engine)
        run([py if py.exists() else sys.executable, "-I", HERE / "install.py", "uninstall", "--claude-dir", cd,
             "--backup", st["backup"]], "retirar el toolkit; el memory-engine NO se tocó")
        state_path.unlink()
    else:
        print("sin claude-toolkit-state.json: se omiten guías, agentes dev/appsec y panel")
    if (engine / "engine.py").exists():
        # con el Python base: el venv del engine se borra
        run([sys.executable, "-I", engine / "engine.py", "uninstall", "--claude-dir", cd]
            + ["--delete-data"] * a.delete_data, "desinstalar el memory-engine")


def main():
    # como el engine: UTF-8, y por línea para no mezclarse con la salida de los subprocesos
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=("install", "uninstall"))
    ap.add_argument("--claude-dir", default=str(Path.home() / ".claude"))
    ap.add_argument("--toolkit-dir", default=str(Path.home() / "claude-toolkit"))
    ap.add_argument("--base-python", help="Python 3.10+ con SQLite FTS5 para crear el venv (por defecto, este)")
    # sin indicar: lo de la instalación anterior
    for name, what in (("dev-agents", "los agentes dev/appsec"), ("tablero", "el panel /tablero")):
        g = ap.add_mutually_exclusive_group()
        g.add_argument(f"--no-{name}", dest=f"no_{name.replace('-', '_')}", action="store_true",
                       help=f"no instalar {what}")
        g.add_argument(f"--{name}", dest=f"no_{name.replace('-', '_')}", action="store_false",
                       help=f"volver a instalar {what}")
    ap.set_defaults(no_dev_agents=None, no_tablero=None)
    ap.add_argument("--delete-data", action="store_true", help="uninstall: borrar la base de recuerdos")
    a = ap.parse_args()
    return install(a) if a.action == "install" else uninstall(a)


if __name__ == "__main__":
    sys.exit(main())
