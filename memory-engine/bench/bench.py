"""Benchmark: lookup en proceso, hook completo (arranque incluido), RAM pico y tamaño de DB.
Uso: .venv\\Scripts\\python.exe -I bench\\bench.py [100 1000 10000 100000]
Usa un MEMORY_ENGINE_HOME temporal; no toca los datos reales."""
import ctypes
import hashlib
import json
import os
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
HOME = Path(tempfile.mkdtemp(prefix="me-bench-"))
os.environ["MEMORY_ENGINE_HOME"] = str(HOME)
sys.path.insert(0, str(ENGINE))
shutil.copytree(ENGINE / "app", HOME / "app")
from app import config, context, store  # noqa: E402

random.seed(7)
SYL = ["ra", "to", "mi", "sel", "dor", "ka", "pen", "lu", "tri", "vo", "gan", "si", "mel", "bor", "qui", "ne"]
VOCAB = list({"".join(random.choices(SYL, k=random.randint(2, 4))) for _ in range(6000)})[:4000]
DOMAIN = ["autorizacion", "ownership", "factura", "tenant", "sesion", "token", "query", "transaccion", "nginx",
          "docker", "deploy", "pago", "saldo", "cuota", "upload", "migracion", "indice", "cache", "cola", "worker"]
TYPES = store.TYPES


class PMC(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t)]


def peak_ws(handle):
    c = PMC()
    c.cb = ctypes.sizeof(PMC)
    ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(int(handle)), ctypes.byref(c), c.cb)
    return c.PeakWorkingSetSize / 2**20


def fact():
    return " ".join(random.choices(VOCAB, k=random.randint(12, 22)) + random.choices(DOMAIN, k=2))


def populate(n, projects):
    con = store.connect()
    now = time.time()
    rows = []
    for i in range(n):
        f = fact()
        proj = random.choice(projects)
        rows.append((random.choice(TYPES), proj, "project", random.choice(DOMAIN), f, "",
                     "\n".join(random.choices(VOCAB, k=2)), f"src/{random.choice(VOCAB)}.php", "", random.randint(1, 5),
                     0.8, "durable", "", None, None, None,
                     hashlib.sha1(f"{proj}{i}{f}".encode()).hexdigest(), now - random.random() * 3e7, now, now))
    t = time.perf_counter()
    with con:
        con.executemany("""INSERT INTO memories(type,project,scope,topic,fact,aliases,symbols,files,stack,importance,
            confidence,validity_mode,source_hashes,commit_ref,dep_hash,session_id,fingerprint,created_at,updated_at,
            last_verified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
    con.execute("INSERT INTO memories_fts(memories_fts) VALUES('optimize')")
    con.close()
    return time.perf_counter() - t


def main(sizes):
    cfg = config.load()
    proj_dir = Path(tempfile.mkdtemp(prefix="bench-proj-"))
    projects = [str(proj_dir).replace("\\", "/").lower()] + [f"c:/proj/p{i}" for i in range(19)]
    py = sys.executable
    results = []
    for n in sizes:
        for p in (config.DB, Path(str(config.DB) + "-wal"), Path(str(config.DB) + "-shm")):
            if p.exists():
                p.unlink()
        ins = populate(n, projects)
        con = store.connect()
        own = [r[0] for r in con.execute("SELECT fact FROM memories WHERE project=? ORDER BY random() LIMIT 30",
                                         (projects[0],))]
        classes = {  # clase -> (consultas, inyección esperada)
            "relevante_propio": ([" ".join(random.sample(s.split(), 5)) for s in own], True),
            "aleatoria": ([" ".join(random.choices(VOCAB, k=6)) for _ in range(20)], False),
            "solo_dominio": (["revisá autorización ownership factura tenant", "problema de cola worker cache",
                              "deploy docker nginx", "pago saldo cuota"], False),
            "ambigua_sin_sesion": (["¿y acá?", "seguí", "lo mismo"], False),
        }
        lat, inj = [], {}
        for name, (qs, _) in classes.items():
            hits = 0
            for q in qs:
                t = time.perf_counter()
                sel, _ = store.retrieve(con, context.extract(q), cfg, root=proj_dir, explain=False)
                lat.append((time.perf_counter() - t) * 1000)
                hits += bool(sel)
            inj[name] = f"{hits}/{len(qs)}"
        con.close()
        hook_ms, ram = [], []
        wrapper = ("import ctypes,sys,runpy\nfrom ctypes import wintypes\nh=sys.argv[1];sys.argv=[h,'prompt']\n"
                   "try:\n runpy.run_path(h,run_name='__main__')\nexcept SystemExit:\n pass\n"
                   "c=(ctypes.c_size_t*10)();c[0]=ctypes.sizeof(c)\nk=ctypes.windll.kernel32;k.GetCurrentProcess.restype=ctypes.c_void_p\n"
                   "ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(k.GetCurrentProcess()),ctypes.byref(c),ctypes.sizeof(c))\n"
                   "sys.stderr.write('PEAK %d' % c[2])")
        for q in classes["relevante_propio"][0][:6] + classes["aleatoria"][0][:6]:
            payload = json.dumps({"prompt": q, "session_id": "bench", "cwd": str(proj_dir)}).encode()
            t = time.perf_counter()
            r = subprocess.run([py, "-I", "-c", wrapper, str(HOME / "app" / "hooks.py")], input=payload,
                               capture_output=True, env=dict(os.environ, MEMORY_ENGINE_HOME=str(HOME)))
            hook_ms.append((time.perf_counter() - t) * 1000)
            ram.append(int(r.stderr.decode().rsplit("PEAK ", 1)[-1]) / 2**20)
        lat.sort()
        size = sum(p.stat().st_size for p in config.DATA.glob("memory.db*")) / 2**20
        results.append({"n": n, "insert_s": round(ins, 2), "db_mib": round(size, 2),
                        "lookup_p50_ms": round(statistics.median(lat), 2),
                        "lookup_p95_ms": round(lat[int(len(lat) * 0.95) - 1], 2),
                        "hook_p50_ms": round(statistics.median(hook_ms), 1), "hook_max_ms": round(max(hook_ms), 1),
                        "hook_peak_ram_mib": round(max(ram), 1), "inyecciones": inj})
        print(json.dumps(results[-1]), flush=True)
    t = time.perf_counter()
    subprocess.run([py, "-I", "-c", "pass"])
    print(json.dumps({"python_startup_ms": round((time.perf_counter() - t) * 1000, 1)}))
    shutil.rmtree(proj_dir, ignore_errors=True)
    shutil.rmtree(HOME, ignore_errors=True)
    return results


if __name__ == "__main__":
    main([int(x) for x in sys.argv[1:]] or [100, 1000, 10000, 100000])
