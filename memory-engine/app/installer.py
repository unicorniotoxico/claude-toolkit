"""Parcheo reversible de la configuración de Claude Code. Usado por engine.py (install / uninstall).

  installer.py install   --claude-dir D --home H --python P --backup B
  installer.py uninstall --claude-dir D --backup B
Solo toca: settings.json (claves hooks propias), CLAUDE.md (sección marcada) y los dos agentes del sistema.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

BEGIN, END = "<!-- memory-engine:begin -->", "<!-- memory-engine:end -->"
MARK = "memory-engine"
AGENTS = ("evidencia-haiku.md", "seguridad-revisor.md")


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).exists() else None


def read_json(p):
    raw = Path(p).read_text("utf-8-sig") if Path(p).exists() else "{}"
    return json.loads(raw or "{}")


def write_json(p, data):
    tmp = Path(str(p) + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    json.loads(tmp.read_text("utf-8"))  # validar antes de reemplazar
    tmp.replace(p)


def ours(handler):
    return MARK in json.dumps(handler)


def strip_hooks(settings):
    hooks = settings.get("hooks") or {}
    for ev in list(hooks):
        groups = []
        for g in hooks[ev]:
            hs = [h for h in g.get("hooks", []) if not ours(h)]
            if hs:
                g["hooks"] = hs
                groups.append(g)
        if groups:
            hooks[ev] = groups
        else:
            del hooks[ev]
    if "hooks" in settings and not hooks:
        del settings["hooks"]
    return settings


def strip_section(text):
    if BEGIN in text and END in text:
        a, b = text.index(BEGIN), text.index(END) + len(END)
        nl = "\r\n" if "\r\n" in text else "\n"
        text = text[:a].rstrip() + nl + text[b:].lstrip("\r\n")
    return text


def install(a):
    cd, home, backup = Path(a.claude_dir), Path(a.home), Path(a.backup)
    backup.mkdir(parents=True, exist_ok=True)
    targets = [cd / "settings.json", cd / "CLAUDE.md"] + [cd / "agents" / n for n in AGENTS]
    mpath = backup / "manifest.json"
    if mpath.exists():
        # Reinstalación: el respaldo "antes" de la primera instalación es el estado original; no se pisa.
        manifest = json.loads(mpath.read_text("utf-8"))
    else:
        manifest = {"created": time.strftime("%Y-%m-%d %H:%M:%S"), "claude_dir": str(cd), "files": {}}
        for t in targets:
            rel = str(t.relative_to(cd))
            if t.exists():
                dst = backup / "antes" / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(t, dst)
            manifest["files"][rel] = {"before": sha(t)}

    py = a.python.replace("\\", "/")
    hp = str(home / "app" / "hooks.py").replace("\\", "/")
    settings = strip_hooks(read_json(cd / "settings.json"))
    hooks = settings.setdefault("hooks", {})
    hooks.setdefault("UserPromptSubmit", []).append(
        {"hooks": [{"type": "command", "command": py, "args": ["-I", hp, "prompt"], "timeout": 5}]})
    hooks.setdefault("Stop", []).append(
        {"hooks": [{"type": "command", "command": py, "args": ["-I", hp, "stop"], "timeout": 10}]})
    write_json(cd / "settings.json", settings)

    section = render((home / "templates" / "claude-md-section.md").read_text("utf-8").strip(), cd)
    cm = cd / "CLAUDE.md"
    text = strip_section(read_text(cm))
    nl = "\r\n" if "\r\n" in text else "\n"  # respetar los finales de línea existentes
    block = (BEGIN + "\n" + section + "\n" + END + "\n").replace("\n", nl)
    write_text(cm, text.rstrip() + nl + nl + block)

    (cd / "agents").mkdir(exist_ok=True)
    for n in AGENTS:
        write_text(cd / "agents" / n, render(read_text(home / "templates" / "agents" / n), cd))

    for t in targets:
        manifest["files"][str(t.relative_to(cd))]["after"] = sha(t)
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")
    print(f"configuración parcheada; respaldo en {backup}")


def render(text, claude_dir):
    """Las plantillas usan {{CLAUDE_DIR}} en lugar de la carpeta de un usuario concreto y {{CMD}} para la
    extensión de los lanzadores (memory.cmd en Windows, memory en macOS/Linux)."""
    text = text.replace("{{CMD}}", ".cmd" if os.name == "nt" else "")
    return text.replace("{{CLAUDE_DIR}}", str(claude_dir).replace("\\", "/"))


def read_text(p):
    if not Path(p).exists():
        return ""
    with open(p, encoding="utf-8", newline="") as fh:  # sin traducir CRLF/LF
        return fh.read()


def write_text(p, text):
    with open(p, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def _info(man, rel):
    files = (man or {}).get("files", {})
    return files.get(rel) or files.get(rel.replace("/", "\\"))


def _restore_exact(cd, backup, man, rel):
    """Si el archivo no cambió desde la instalación, restaura la copia previa byte a byte."""
    info, cur, orig = _info(man, rel), cd / rel, backup / "antes" / rel
    if info and orig.exists() and sha(cur) == info.get("after"):
        shutil.copy2(orig, cur)
        print(f"{rel}: restaurado exacto desde el respaldo")
        return True
    return False


def uninstall(a):
    cd, backup = Path(a.claude_dir), Path(a.backup)
    man = json.loads((backup / "manifest.json").read_text("utf-8")) if (backup / "manifest.json").exists() else None
    s = cd / "settings.json"
    if s.exists() and not _restore_exact(cd, backup, man, "settings.json"):
        write_json(s, strip_hooks(read_json(s)))
        print("settings.json cambió después de instalar: solo se retiraron los hooks del sistema")
    cm = cd / "CLAUDE.md"
    if cm.exists() and not _restore_exact(cd, backup, man, "CLAUDE.md"):
        write_text(cm, strip_section(read_text(cm)))
        print("CLAUDE.md cambió después de instalar: solo se retiró la sección memory-engine")
    for n in AGENTS:
        rel, cur = f"agents/{n}", cd / "agents" / n
        info = _info(man, rel)
        orig = backup / "antes" / "agents" / n
        if not info:
            print(f"{rel}: sin manifiesto; se deja como está")
        elif sha(cur) != info.get("after"):
            print(f"{rel}: modificado después de instalar; se conserva (original en {orig})")
        elif orig.exists():
            shutil.copy2(orig, cur)
            print(f"{rel}: restaurado")
        elif info.get("before") is None:
            cur.unlink()
            print(f"{rel}: no existía antes; retirado")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # como cli.py: acentos en cualquier consola
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=("install", "uninstall"))
    ap.add_argument("--claude-dir", required=True)
    ap.add_argument("--home")
    ap.add_argument("--python")
    ap.add_argument("--backup", required=True)
    a = ap.parse_args()
    (install if a.action == "install" else uninstall)(a)


if __name__ == "__main__":
    sys.exit(main())
