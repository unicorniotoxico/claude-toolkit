"""Compare a scoped PHP baseline and worktree in an offline, disposable container."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
import uuid


class ReplayUnavailable(Exception):
    pass


def run(argv, **kwargs):
    return subprocess.run(argv, capture_output=True, timeout=10, **kwargs)


def git(root, *args):
    return run(["git", "--no-optional-locks", "-C", str(root), *args])


def scoped_path(name):
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_./ -]{1,240}", name):
        raise ReplayUnavailable("Ruta de simulación inválida.")
    path = PurePosixPath(name)
    if path.is_absolute() or path.as_posix() != name or any(
        part.startswith(".") or part.lower() in {"vendor", "node_modules"}
        for part in path.parts
    ) or not name.lower().endswith(".php"):
        raise ReplayUnavailable("Incluí solo archivos PHP concretos del alcance.")
    return path


def copy_snapshot(root, target, files, revision=None):
    hashes = {}
    for path in files:
        name = path.as_posix()
        if revision:
            tree = git(root, "ls-tree", revision, "--", name)
            if tree.returncode:
                raise ReplayUnavailable("No se pudo leer el árbol base.")
            if not tree.stdout:
                continue
            if not tree.stdout.startswith((b"100644 blob ", b"100755 blob ")):
                raise ReplayUnavailable("Archivo base no regular: " + name)
            result = git(root, "show", f"{revision}:{name}")
            if result.returncode:
                raise ReplayUnavailable("No se pudo leer el archivo base: " + name)
            data = result.stdout
        else:
            source = root / path
            if any((root / parent).is_symlink() for parent in (path, *path.parents)):
                raise ReplayUnavailable("Enlace en los archivos de simulación: " + name)
            if not source.exists():
                continue
            file_stat = source.stat()
            if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_size > 512_000:
                raise ReplayUnavailable("Archivo no regular o demasiado grande: " + name)
            data = source.read_bytes()
        if len(data) > 512_000:
            raise ReplayUnavailable("Archivo demasiado grande: " + name)
        dest = target / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    return hashes


def execute(image, app, fixture, case):
    container = "tablero-replay-" + uuid.uuid4().hex
    argv = [
        "docker", "run", "--rm", "-i", "--name", container, "--pull=never", "--network=none",
        "--read-only", "--init", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--memory=128m", "--pids-limit=32", "--cpus=1", "--log-driver=none",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m", "--workdir=/app", "--entrypoint=php",
        "--mount", f"type=bind,source={app},target=/app,readonly",
        "--mount", f"type=bind,source={fixture},target=/fixture,readonly",
        image, "-d", "display_errors=stderr", "/fixture/driver.php",
    ]
    try:
        result = run(argv, input=case["entrada"].encode())
    except subprocess.TimeoutExpired as error:
        raise ReplayUnavailable("La ejecución PHP superó 10 segundos.") from error
    finally:
        try:
            run(["docker", "rm", "-f", container])
        except (OSError, subprocess.TimeoutExpired):
            pass
    if result.returncode != 0:
        raise ReplayUnavailable(f"PHP/Docker terminó con exit {result.returncode} en {case['id']}.")
    if len(result.stdout) > 8192 or len(result.stderr) > 0:
        raise ReplayUnavailable(f"Salida excesiva o mensajes por stderr en {case['id']}.")
    return result.stdout.decode("utf-8").rstrip("\r\n")


def replay(root, request):
    revision = request.get("base", "")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40,64}", revision):
        raise ReplayUnavailable("Hace falta un commit base completo.")
    paths = request.get("archivos", [])
    driver = request.get("driver", "")
    cases = request.get("casos", [])
    if not isinstance(paths, list) or not 1 <= len(paths) <= 20 or not isinstance(driver, str) \
       or not driver.lstrip().startswith("<?php") or len(driver) > 12000 or not isinstance(cases, list) \
       or not 1 <= len(cases) <= 6:
        raise ReplayUnavailable("Indicá de 1 a 20 PHP, un driver y de 1 a 6 casos.")
    files = [scoped_path(name) for name in paths]
    ids = set()
    for case in cases:
        if not isinstance(case, dict) or not isinstance(case.get("id"), str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,40}", case["id"]
        ) or case["id"] in ids or case.get("relacion") not in ("igual", "distinto", "cualquiera") or any(
            not isinstance(case.get(k), str) or len(case[k]) > 4096 for k in ("entrada", "esperado")
        ):
            raise ReplayUnavailable("Cada caso necesita ID único, entrada, esperado y relación válida.")
        ids.add(case["id"])

    git_root = git(root, "rev-parse", "--show-toplevel")
    if git_root.returncode:
        raise ReplayUnavailable("No se encontró la raíz Git.")
    root = Path(os.fsdecode(git_root.stdout).strip())
    image = os.environ.get("CLAUDE_TOOLKIT_PHP_IMAGE", "php:8.3-cli")
    image_id = run(["docker", "image", "inspect", "--format", "{{.Id}}", image])
    if image_id.returncode or not re.fullmatch(rb"sha256:[0-9a-f]{64}\s*", image_id.stdout):
        raise ReplayUnavailable("Docker no tiene disponible la imagen PHP local configurada.")
    image = image_id.stdout.decode().strip()

    with TemporaryDirectory(prefix="tablero-php-") as temp:
        before, after, fixture = (Path(temp) / p for p in ("base", "actual", "prueba"))
        for p in (before, after, fixture):
            p.mkdir()
        original = copy_snapshot(root, before, files, revision)
        current = copy_snapshot(root, after, files)
        if any(p.as_posix() not in original and p.as_posix() not in current for p in files):
            raise ReplayUnavailable("Al menos un archivo declarado no existe en ninguna versión.")
        (fixture / "driver.php").write_text(driver, encoding="utf-8")
        results = []
        for case in cases:
            previous = execute(image, before, fixture, case)
            actual = execute(image, after, fixture, case)
            expected = case["esperado"]
            relation = case["relacion"]
            matches = actual == expected and (
                relation == "cualquiera" or (previous == actual) == (relation == "igual")
            )
            results.append({"id": case["id"], "ok": matches, "base": previous[:400], "actual": actual[:400],
                            "esperado": expected[:400]})
    return {
        "estado": "verificado" if all(c["ok"] for c in results) else "diferencias",
        "base": revision, "archivoBase": original, "archivoActual": current, "imagen": image,
        "driver": hashlib.sha256(driver.encode()).hexdigest(), "casos": results,
    }


def main():
    try:
        request = json.load(sys.stdin)
        result = replay(Path.cwd(), request)
    except (ReplayUnavailable, OSError, ValueError, subprocess.TimeoutExpired) as error:
        result = {"estado": "pendiente", "detalle": str(error)[:400]}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
