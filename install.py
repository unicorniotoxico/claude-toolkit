"""Instala/retira las piezas del toolkit que no son del memory-engine. Usado por install.ps1 / uninstall.ps1.

  install.py install   --claude-dir D --src S --backup B [--no-dev-agents] [--no-tablero]
  install.py uninstall --claude-dir D --backup B
Toca solo: security/flujo.md, security/stacks/*.md, agents/dev.md, agents/appsec.md, la sección marcada de
CLAUDE.md, mods/tablero y la ruta del mod en env.CLAUDE_CODE_PLUGIN_DIRS de settings.json. Antes de pisar un
archivo guarda la versión previa; al desinstalar restaura solo lo que no cambió desde la instalación.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

BEGIN, END = "<!-- claude-toolkit:begin -->", "<!-- claude-toolkit:end -->"
# marcas de un perfil de seguridad instalado antes del toolkit: su sección se reemplaza en el mismo lugar
LEGACY = ("<!-- BEGIN SEGURIDAD-EFICIENTE -->", "<!-- END SEGURIDAD-EFICIENTE -->")
ENV = "CLAUDE_CODE_PLUGIN_DIRS"


def sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None


def read_text(p):
    if not Path(p).exists():
        return ""
    with open(p, encoding="utf-8-sig", newline="") as fh:
        return fh.read()


def write_text(p, text):
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def write_json(p, data):
    tmp = Path(str(p) + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    json.loads(tmp.read_text("utf-8"))  # validar antes de reemplazar
    tmp.replace(p)


def render(text, cd):
    return text.replace("{{CLAUDE_DIR}}", str(cd).replace("\\", "/"))


def find_block(text, begin, end):
    if begin in text and end in text[text.index(begin):]:
        a = text.index(begin)
        return a, text.index(end, a) + len(end)
    return None


def strip_section(text):
    if BEGIN in text and END in text:
        a, b = text.index(BEGIN), text.index(END) + len(END)
        nl = "\r\n" if "\r\n" in text else "\n"
        text = text[:a].rstrip() + nl + text[b:].lstrip("\r\n")
    return text


def mod_dir(cd):
    return str(Path(cd) / "mods" / "tablero").replace("\\", "/")


def same_path(a, b):
    # la misma carpeta puede llegar en forma corta (DECRED~1) o larga, o con otras mayúsculas
    norm = lambda p: os.path.normcase(os.path.realpath(p))
    return norm(a) == norm(b)


def file_targets(src, a):
    """(origen, destino relativo) de cada archivo que el toolkit copia renderizado."""
    out = [(src / "security" / "flujo.md", "security/flujo.md")]
    out += [(p, f"security/stacks/{p.name}") for p in sorted((src / "security" / "stacks").glob("*.md"))]
    if not a.no_dev_agents:
        out += [(src / "agents" / n, f"agents/{n}") for n in ("dev.md", "appsec.md")]
    return out


def install(a):
    cd, src, backup = Path(a.claude_dir), Path(a.src), Path(a.backup)
    mpath = backup / "manifest.json"
    man = json.loads(mpath.read_text("utf-8")) if mpath.exists() else {
        "created": time.strftime("%Y-%m-%d %H:%M:%S"), "files": {}}
    targets = file_targets(src, a)

    for _, rel in targets + [(None, "CLAUDE.md"), (None, "settings.json")]:
        if rel in man["files"]:
            continue  # reinstalación: el estado original ya está respaldado
        cur = cd / rel
        if cur.is_file():
            dst = backup / "antes" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cur, dst)
        man["files"][rel] = {"before": sha(cur)}

    for s, rel in targets:
        write_text(cd / rel, render(read_text(s), cd))

    section = render(read_text(src / "templates" / "claude-md-security.md").strip(), cd)
    cm = cd / "CLAUDE.md"
    text = read_text(cm)
    nl = "\r\n" if "\r\n" in text else "\n"
    block = (BEGIN + "\n" + section + "\n" + END).replace("\n", nl)
    span = find_block(text, BEGIN, END) or find_block(text, *LEGACY)
    if span:  # actualizar en el mismo lugar (también adopta la sección de un perfil anterior)
        text = text[:span[0]] + block + text[span[1]:]
    else:
        text = (text.rstrip() + nl + nl if text.strip() else "") + block + nl
    write_text(cm, text)

    sp = cd / "settings.json"
    settings = json.loads(read_text(sp) or "{}")
    if not a.no_tablero:
        dst = cd / "mods" / "tablero"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src / "mods" / "tablero", dst)
        env = settings.setdefault("env", {})
        dirs = [d for d in (env.get(ENV) or "").split(os.pathsep) if d]
        if not any(same_path(d, mod_dir(cd)) for d in dirs):
            env[ENV] = os.pathsep.join(dirs + [mod_dir(cd)])
        man["tablero"] = mod_dir(cd)
    write_json(sp, settings)

    for _, rel in targets + [(None, "CLAUDE.md"), (None, "settings.json")]:
        man["files"][rel]["after"] = sha(cd / rel)
    backup.mkdir(parents=True, exist_ok=True)
    mpath.write_text(json.dumps(man, indent=2), "utf-8")
    print(f"toolkit instalado; respaldo en {backup}")


def uninstall(a):
    cd, backup = Path(a.claude_dir), Path(a.backup)
    mpath = backup / "manifest.json"
    if not mpath.exists():
        sys.exit(f"sin manifiesto en {backup}; nada que desinstalar")
    man = json.loads(mpath.read_text("utf-8"))

    for rel, info in man["files"].items():
        if rel in ("CLAUDE.md", "settings.json"):
            continue
        cur, orig = cd / rel, backup / "antes" / rel
        if sha(cur) != info.get("after"):
            print(f"{rel}: modificado después de instalar; se conserva")
        elif orig.exists():
            shutil.copy2(orig, cur)
            print(f"{rel}: restaurado")
        elif info.get("before") is None and cur.exists():
            cur.unlink()
            print(f"{rel}: no existía antes; retirado")

    cm = cd / "CLAUDE.md"
    if cm.exists():
        write_text(cm, strip_section(read_text(cm)))
        print("CLAUDE.md: sección claude-toolkit retirada")

    sp = cd / "settings.json"
    if sp.exists():
        settings = json.loads(read_text(sp) or "{}")
        env = settings.get("env") or {}
        mine = man.get("tablero") if isinstance(man.get("tablero"), str) else mod_dir(cd)
        dirs = [d for d in (env.get(ENV) or "").split(os.pathsep) if d and not same_path(d, mine)]
        if dirs:
            env[ENV] = os.pathsep.join(dirs)
        else:
            env.pop(ENV, None)
        if "env" in settings and not env:
            del settings["env"]
        write_json(sp, settings)
    if man.get("tablero") and (cd / "mods" / "tablero").exists():
        shutil.rmtree(cd / "mods" / "tablero")
        print("mods/tablero: retirado")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=("install", "uninstall"))
    ap.add_argument("--claude-dir", required=True)
    ap.add_argument("--src")
    ap.add_argument("--backup", required=True)
    ap.add_argument("--no-dev-agents", action="store_true")
    ap.add_argument("--no-tablero", action="store_true")
    a = ap.parse_args()
    (install if a.action == "install" else uninstall)(a)


if __name__ == "__main__":
    sys.exit(main())
