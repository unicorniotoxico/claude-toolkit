"""Run one user-approved diagnostic installation using a fixed package-manager invocation."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def locate(name, extras=()):
    path = os.pathsep.join([os.environ.get("PATH", ""), *filter(None, extras)])
    return shutil.which(name, path=path)


def install(request):
    manager = request["gestor"]
    package = request["paquete"]
    executable = request["ejecutable"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,49}", executable):
        raise ValueError("Nombre de ejecutable inválido.")
    if manager == "go":
        valid = re.fullmatch(r"[A-Za-z0-9.-]+(?:/[A-Za-z0-9._-]+)+@[A-Za-z0-9][A-Za-z0-9._+-]*", package)
    else:
        valid = re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+@-]{0,199}", package)
    if not valid or len(package) > 200 or (manager == "apt" and package.endswith("-")):
        raise ValueError("Identificador de paquete inválido.")
    settings = {
        "winget": ["winget", "install", "--id", package, "--exact", "--source", "winget",
                   "--scope", "user", "--disable-interactivity"],
        "brew": ["brew", "install", "--formula", package],
        "apt": ["apt-get", "install", "--assume-yes", "--no-remove", "--no-install-recommends", package],
        "go": ["go", "install", package],
    }
    if manager not in settings:
        raise ValueError("Gestor no disponible.")
    argv = settings[manager]
    if not locate(argv[0]):
        raise ValueError("No está disponible el gestor " + manager + ".")
    extras = [str(Path.home() / ".local" / "bin")]
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        extras.append(str(Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "WinGet" / "Links"))
    if manager == "go":
        result = subprocess.run(["go", "env", "-json", "GOBIN", "GOPATH"], cwd=Path.home(),
                                capture_output=True, text=True, timeout=10, check=False)
        if result.returncode == 0:
            env = json.loads(result.stdout)
            extras.append(env.get("GOBIN") or str(Path(env["GOPATH"].split(os.pathsep)[0]) / "bin"))
    elif manager == "brew":
        result = subprocess.run(["brew", "--prefix"], cwd=Path.home(), capture_output=True,
                                text=True, timeout=10, check=False)
        if result.returncode == 0:
            extras.append(str(Path(result.stdout.strip()) / "bin"))
    current = locate(executable, extras)
    if current:
        return {"estado": "disponible", "ruta": current, "detalle": "La herramienta ya estaba disponible."}
    result = subprocess.run(argv, cwd=Path.home(), stdin=subprocess.DEVNULL, capture_output=True,
                            timeout=240, check=False)
    if result.returncode:
        lines = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip().splitlines()
        detail = lines[-1][:250] if lines else "El gestor no devolvió un detalle."
        return {"estado": "error", "detalle": f"El gestor devolvió código {result.returncode}. {detail}"}
    path = locate(executable, extras)
    if not path:
        return {"estado": "pendiente", "detalle": "El gestor terminó, pero el ejecutable aún no se encontró. Revisá el PATH en una terminal nueva."}
    return {"estado": "disponible", "ruta": path}


if __name__ == "__main__":
    try:
        report = install(json.load(sys.stdin))
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        report = {"estado": "error", "detalle": str(error)[:300]}
    print(json.dumps(report, ensure_ascii=True))
