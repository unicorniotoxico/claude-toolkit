"""Recall sobre la DB real con consultas reales (bench/recall_cases.json).
Uso: .venv\\Scripts\\python.exe -I bench\\recall.py
Copia recall_cases.example.json a recall_cases.json con tus consultas y los ids de tu DB (no se versiona).
Caso con expect=[] = la consulta no debe inyectar nada. Un caso pasa si lo inyectado incluye algún id esperado
(o nada, si expect está vacío). Sale con 1 si algún caso falla."""
import json
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ENGINE))
from app import config, context, store  # noqa: E402

cfg = config.load()
con = store.connect()
path = ENGINE / "bench" / "recall_cases.json"
if not path.exists():
    sys.exit("falta bench/recall_cases.json: copia recall_cases.example.json y ajusta consultas e ids")
cases = json.loads(path.read_text(encoding="utf-8"))
fails = 0
for c in cases:
    sel, _ = store.retrieve(con, context.extract(c["q"]), cfg, root=None)
    got = [s["row"]["id"] for s in sel]
    ok = (not got) if not c["expect"] else bool(set(got) & set(c["expect"]))
    fails += not ok
    top = f"{sel[0]['score']:.3f}" if sel else "-"
    print(f"{'OK ' if ok else 'FAIL'} top={top} got={got} expect={c['expect']}  {c['q']}")
print(f"{len(cases) - fails}/{len(cases)}")
sys.exit(1 if fails else 0)
