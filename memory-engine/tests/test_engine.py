"""Tests unitarios e integración. Ejecutar:  .venv\\Scripts\\python.exe -I -m unittest discover -s tests -v
(desde memory-engine). Cada test usa un MEMORY_ENGINE_HOME temporal: nunca toca los datos reales."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
TMP_HOME = Path(tempfile.mkdtemp(prefix="me-test-"))
os.environ["MEMORY_ENGINE_HOME"] = str(TMP_HOME)
sys.path.insert(0, str(ENGINE))
shutil.copytree(ENGINE / "app", TMP_HOME / "app")

from app import config, context, store  # noqa: E402
from app import hooks as hooks_mod  # noqa: E402
from app.runlog import digest  # noqa: E402
from app.secrets_filter import find_secret, is_sensitive_file  # noqa: E402

HOOK = TMP_HOME / "app" / "hooks.py"


def run_hook(event, payload, env_extra=None, timeout=10):
    env = dict(os.environ, MEMORY_ENGINE_HOME=str(TMP_HOME), **(env_extra or {}))
    t = time.perf_counter()
    r = subprocess.run([sys.executable, "-I", str(HOOK), event], input=json.dumps(payload).encode(),
                       capture_output=True, env=env, timeout=timeout)
    return r, (time.perf_counter() - t) * 1000


class Base(unittest.TestCase):
    def setUp(self):
        for p in (config.DB, Path(str(config.DB) + "-wal"), Path(str(config.DB) + "-shm"), TMP_HOME / "config.json"):
            if p.exists():
                p.unlink()
        shutil.rmtree(config.SESSIONS, ignore_errors=True)
        self.cfg = config.load()
        self.proj = Path(tempfile.mkdtemp(prefix="proj-"))
        (self.proj / ".git").mkdir()
        (self.proj / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        (self.proj / ".git" / "refs" / "heads").mkdir(parents=True)
        (self.proj / ".git" / "refs" / "heads" / "main").write_text("a" * 40 + "\n")
        (self.proj / "composer.json").write_text("{}")
        (self.proj / "src").mkdir()
        (self.proj / "src" / "InvoiceController.php").write_text("<?php function showInvoice($id){}")
        self.con = store.connect()

    def tearDown(self):
        self.con.close()
        shutil.rmtree(self.proj, ignore_errors=True)

    def add(self, **kw):
        base = {"type": "security_control", "topic": "authorization", "validity": "durable", "importance": 4}
        base.update(kw)
        return store.add(self.con, base, root=self.proj, session_id="s1", cfg=self.cfg)

    def ask(self, prompt, session=None, sid="s1", root=None):
        return store.retrieve(self.con, context.extract(prompt), self.cfg, root=root or self.proj,
                              session=session or {}, session_id=sid)


class SecretsTest(unittest.TestCase):
    def test_detects(self):
        for s in ("password=Sup3rS3cret!", "AKIA" + "ABCDEFGHIJKLMNOP", "ghp_" + "a1B2" * 9,
                  "mysql://root:hunter2@db:3306/x", "-----BEGIN RSA PRIVATE KEY-----",
                  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
                  "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
                  "api_key: 'k3y-Th1s-Is-Real'", "x9F3kLm2Qr8Zt5Vw1Yb7Nc4Hd6Jg0Ps2Ae9Xu"):
            self.assertIsNotNone(find_secret(s), s)

    def test_allows(self):
        for s in ("El middleware valida ownership con checkOwner antes de showInvoice",
                  "commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c corrigió el bug",
                  "password=<redacted>", "la columna password_hash usa bcrypt cost 12", "token=${API_TOKEN}"):
            self.assertIsNone(find_secret(s), s)

    def test_sensitive_files(self):
        self.assertTrue(is_sensitive_file("config/.env.production"))
        self.assertTrue(is_sensitive_file("keys/server.pem"))
        self.assertFalse(is_sensitive_file("src/env.php"))


class StoreTest(Base):
    def test_rejections(self):
        with self.assertRaises(store.Rejected):
            self.add(fact="La API usa password=Hunter2xyz en staging")
        with self.assertRaises(store.Rejected):
            self.add(type="random", fact="algo bastante largo como para pasar")
        with self.assertRaises(store.Rejected):
            self.add(fact="corto")
        with self.assertRaises(store.Rejected):
            self.add(fact="x " * 400)
        self.assertEqual(self.con.execute("SELECT count(*) FROM memories").fetchone()[0], 0)

    def test_exact_duplicate_updates(self):
        a, i1 = self.add(fact="showInvoice valida ownership con checkOwner del tenant actual")
        b, i2 = self.add(fact="showInvoice valida ownership con checkOwner del tenant actual.", importance=5)
        self.assertEqual((a, b), ("inserted", "updated"))
        self.assertEqual(i1, i2)
        self.assertEqual(self.con.execute("SELECT importance FROM memories WHERE id=?", (i1,)).fetchone()[0], 5)

    def test_near_duplicate_supersedes(self):
        _, i1 = self.add(fact="showInvoice valida ownership usando checkOwner con el tenant de la sesión",
                         files="src/InvoiceController.php")
        act, i2 = self.add(fact="showInvoice valida ownership usando checkOwner con el tenant de la sesión activa")
        self.assertEqual(act, "superseded")
        old = self.con.execute("SELECT status, superseded_by FROM memories WHERE id=?", (i1,)).fetchone()
        self.assertEqual((old[0], old[1]), ("superseded", i2))
        self.assertIn("InvoiceController.php", self.con.execute("SELECT files FROM memories WHERE id=?",
                                                                (i2,)).fetchone()[0])

    def test_explicit_supersedes(self):
        _, i1 = self.add(fact="Los reembolsos se aprueban por cualquier operador del sistema")
        _, i2 = self.add(type="user_correction", fact="Los reembolsos solo los aprueba el rol supervisor",
                         supersedes=str(i1))
        self.assertEqual(self.con.execute("SELECT status FROM memories WHERE id=?", (i1,)).fetchone()[0],
                         "superseded")


class RetrievalTest(Base):
    def seed(self):
        self.add(fact="showInvoice valida ownership con checkOwner: el tenant de la factura debe coincidir con la sesión",
                 files="src/InvoiceController.php", symbols="showInvoice, checkOwner", aliases="idor, factura")
        self.add(type="deployment", topic="docker", fact="El contenedor nginx necesita reiniciarse tras renovar certificados TLS")
        self.add(type="business_rule", topic="pagos", fact="Los pagos parciales no pueden superar el saldo pendiente de la cuota")
        self.add(type="project_fact", topic="build", fact="El build de assets usa vite con salida en public/build")

    def test_relevant_only(self):
        self.seed()
        sel, st = self.ask("revisá la autorización de showInvoice en InvoiceController.php, posible IDOR")
        self.assertEqual(len(sel), 1)
        self.assertIn("checkOwner", sel[0]["row"]["fact"])

    def test_irrelevant_returns_zero(self):
        self.seed()
        for prompt in ("hola, ¿cómo estás?", "explicame qué es una mónada en haskell", "arreglá el CSS del botón"):
            sel, _ = self.ask(prompt)
            self.assertEqual(sel, [], prompt)

    def test_never_forces_top_k(self):
        self.seed()
        sel, st = self.ask("¿qué regla aplica a los pagos parciales y el saldo pendiente?")
        self.assertEqual(len(sel), 1)
        self.assertLessEqual(len(sel), self.cfg["memory"]["max_results"])

    def test_project_isolation_and_global(self):
        other = Path(tempfile.mkdtemp(prefix="other-"))
        store.add(self.con, {"type": "business_rule", "fact": "Los pagos parciales en el otro proyecto se redondean",
                             "topic": "pagos"}, root=other, cfg=self.cfg)
        store.add(self.con, {"type": "project_fact", "scope": "global", "topic": "pagos",
                             "fact": "Los pagos parciales se registran siempre con idempotency key"}, root=None, cfg=self.cfg)
        sel, _ = self.ask("pagos parciales")
        facts = [s["row"]["fact"] for s in sel]
        self.assertTrue(any("idempotency" in f for f in facts))
        self.assertFalse(any("otro proyecto" in f for f in facts))
        shutil.rmtree(other, ignore_errors=True)

    def test_stale_file_change(self):
        _, mid = self.add(type="test_evidence", validity="until_file_changes", files="src/InvoiceController.php",
                          symbols="showInvoice", fact="Probado: usuario B recibe 403 en showInvoice con factura de A")
        self.assertEqual(len(self.ask("showInvoice 403 usuario B factura")[0]), 1)
        (self.proj / "src" / "InvoiceController.php").write_text("<?php function showInvoice($id){ /*changed*/ }")
        sel, st = self.ask("showInvoice 403 usuario B factura")
        self.assertEqual(sel, [])
        self.assertEqual(st["stale"], 1)
        self.assertEqual(self.con.execute("SELECT status FROM memories WHERE id=?", (mid,)).fetchone()[0], "stale")
        self.cfg["memory"]["stale_action"] = "flag"
        self.cfg["memory"]["threshold"] = 0.3
        sel, _ = self.ask("showInvoice 403 usuario B factura")
        self.assertTrue(sel and sel[0]["stale"])
        self.assertIn("REVERIFICAR", store.format_block(sel, 1400))

    def test_commit_and_session_only(self):
        self.add(type="incident", topic="cola", validity="until_commit_changes",
                 fact="La cola de correos se traba cuando el worker reinicia sin liberar el lock")
        self.add(type="project_fact", topic="cola", validity="session_only",
                 fact="En esta sesión estamos migrando la cola de correos a redis streams")
        self.assertEqual(len(self.ask("cola de correos lock worker redis")[0]), 2)
        self.assertEqual(len(self.ask("cola de correos lock worker redis", sid="otra")[0]), 1)
        (self.proj / ".git" / "refs" / "heads" / "main").write_text("b" * 40 + "\n")
        self.assertEqual(len(self.ask("cola de correos lock worker redis", sid="otra")[0]), 0)

    def test_budget(self):
        for i in range(3):
            self.add(type="business_rule", topic="pagos",
                     fact=f"Regla de pagos parciales número {i}: " + "saldo pendiente cuota " * 20)
        self.cfg["memory"]["max_chars"] = 400
        sel, _ = self.ask("pagos parciales saldo pendiente cuota")
        block = store.format_block(sel, 400)
        body = block.split("\n", 1)[1].rsplit("\n", 1)[0]
        self.assertLessEqual(len(body), 400 + 3)

    def test_verb_variants_and_global(self):
        store.add(self.con, {"type": "business_rule", "scope": "global", "topic": "conciliacion",
                             "aliases": "cobranzas, transferencia, imputacion",
                             "fact": "Conciliacion de transferencias: un cobro recibido sin imputar se pasa a mano a pagos_recibidos"},
                  root=None, cfg=self.cfg)
        sel, _ = self.ask("¿cómo hago la conciliación de una transferencia que no se imputó?")
        self.assertEqual(len(sel), 1)
        self.assertEqual(self.ask("¿cómo hago un deploy de nginx?")[0], [])

    def test_global_never_goes_stale(self):
        _, mid = store.add(self.con, {"type": "architecture", "scope": "global", "topic": "panel",
                                      "validity": "until_commit_changes",
                                      "fact": "El host del panel de operaciones usa Module Federation con api_gateway"},
                           root=None, cfg=self.cfg)
        row = self.con.execute("SELECT validity_mode FROM memories WHERE id=?", (mid,)).fetchone()
        self.assertEqual(row[0], "durable")
        # fila heredada (antes del fix) con validity no durable: tampoco se invalida desde otro proyecto
        self.con.execute("UPDATE memories SET validity_mode='until_commit_changes', commit_ref=NULL WHERE id=?", (mid,))
        self.con.commit()
        for _ in range(2):
            self.assertEqual(len(self.ask("panel operaciones module federation")[0]), 1)
        self.assertEqual(self.con.execute("SELECT status FROM memories WHERE id=?", (mid,)).fetchone()[0], "active")

    def test_auto_symbols_from_fact(self):
        _, mid = self.add(type="architecture", topic="comandos",
                          fact="Los comandos CobroAutomatico y ExportarArchivo escriben en pagos_recibidos cada noche")
        syms = self.con.execute("SELECT symbols FROM memories WHERE id=?", (mid,)).fetchone()[0].split("\n")
        self.assertTrue({"cobroautomatico", "pagos_recibidos"} <= set(syms))
        scored, _ = store.retrieve(self.con, context.extract("qué hace CobroAutomatico"), self.cfg,
                                   root=self.proj, explain=True)
        self.assertEqual(scored[0][3]["symbol"], 1.0)

    def test_fts_injection_safe(self):
        self.seed()
        for p in ('"; DROP TABLE memories; --', "NEAR(a b) OR * AND (", "fact:checkOwner ^ -x", "' OR 1=1"):
            self.ask(p)
        self.assertEqual(self.con.execute("SELECT count(*) FROM memories").fetchone()[0], 4)

    def test_ambiguous_uses_session(self):
        self.seed()
        session = {"topic": ["ownership", "idor", "factura"], "files": ["src/InvoiceController.php"]}
        self.assertEqual(self.ask("¿y acá?")[0], [])
        sel, st = self.ask("¿y acá?", session=session)
        self.assertTrue(st["ambiguous"])
        self.assertEqual(len(sel), 1)


class ParseTest(unittest.TestCase):
    def test_blocks(self):
        text = ("Listo.\n\nMEMORY:\ntype=security_decision\ntopic=auth\nfact=Se exige MFA para rol admin\n"
                "files=a.php, b.php\n\nMEMORY:\ntype=false_positive\nfact=El eval en build.js es de tooling\n"
                "Texto final que no es parte.\n```memory\ntype=<architecture|...>\nfact=<hecho>\n```")
        b = hooks_mod.parse_memory_blocks(text)
        self.assertEqual([x["type"] for x in b], ["security_decision", "false_positive", "<architecture|...>"])
        self.assertEqual(b[0]["files"], "a.php, b.php")

    def test_turn_summary(self):
        entries = [
            {"type": "user", "message": {"content": "arreglá X"}},
            {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5},
                                              "content": [{"type": "tool_use", "name": "Edit",
                                                           "input": {"file_path": "/p/a.php"}}]}},
            {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5},
                                              "content": [{"type": "tool_use", "name": "Agent",
                                                           "input": {"subagent_type": "evidencia-haiku"}}]}},
            {"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": "fin"}]}}]
        s = hooks_mod.summarize_turn(entries)
        self.assertEqual(s["usage"]["output_tokens"], 5)
        self.assertEqual(s["agents"], ["evidencia-haiku"])
        self.assertEqual(s["edited"], ["/p/a.php"])
        self.assertEqual(s["last_text"], "fin")


class HookIntegrationTest(Base):
    def transcript(self, text):
        t = self.proj / "t.jsonl"
        lines = [{"type": "user", "message": {"role": "user", "content": "corregí showInvoice"}},
                 {"type": "assistant", "message": {"id": "a1", "content": [
                     {"type": "tool_use", "name": "Edit",
                      "input": {"file_path": str(self.proj / "src" / "InvoiceController.php")}}]}},
                 {"type": "assistant", "message": {"id": "a2", "content": [{"type": "text", "text": text}]}}]
        t.write_text("\n".join(json.dumps(x) for x in lines), "utf-8")
        return t

    def test_stop_then_prompt_roundtrip(self):
        self.con.close()
        msg = ("Hecho.\n\nMEMORY:\ntype=security_control\ntopic=authorization\n"
               "fact=showInvoice exige checkOwner(tenant) antes de leer la factura; B recibe 403\n"
               "files=src/InvoiceController.php\nsymbols=showInvoice, checkOwner\nvalidity=until_file_changes\n"
               "importance=5\n\nMEMORY:\ntype=project_fact\nfact=la clave es password=Hunter2xyz para staging\n")
        t = self.transcript(msg)
        r, ms = run_hook("stop", {"session_id": "it1", "cwd": str(self.proj), "transcript_path": str(t),
                                  "last_assistant_message": msg})
        self.assertEqual((r.returncode, r.stdout), (0, b""))
        con = store.connect()
        rows = con.execute("SELECT type, validity_mode, source_hashes FROM memories").fetchall()
        con.close()
        self.assertEqual(len(rows), 1)  # el bloque con secreto fue rechazado
        self.assertTrue(rows[0]["source_hashes"].startswith("src/InvoiceController.php\t"))
        sess = json.loads((config.SESSIONS / "it1.json").read_text("utf-8"))
        self.assertIn("src/InvoiceController.php", sess["files"])
        r, ms = run_hook("prompt", {"session_id": "it1", "cwd": str(self.proj),
                                    "prompt": "agregá paginación a showInvoice sin romper la autorización"})
        self.assertEqual(r.returncode, 0)
        out = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("checkOwner", out)
        self.assertIn("php-mysql", out)  # aviso de stack: superficie sensible + composer.json
        r2, _ = run_hook("prompt", {"session_id": "it1", "cwd": str(self.proj), "prompt": "hola qué tal"})
        self.assertEqual(r2.stdout, b"")  # nada relevante: 0 bytes inyectados
        r3, _ = run_hook("prompt", {"session_id": "it1", "cwd": str(self.proj), "prompt": "¿y acá?"})
        self.assertIn("Contexto de sesión", json.loads(r3.stdout)["hookSpecificOutput"]["additionalContext"])
        metrics = [json.loads(x) for x in config.METRICS.read_text("utf-8").splitlines()]
        self.assertTrue(any(m["ev"] == "stop" and m["saved"] == 1 and m["rejected"] for m in metrics))

    def test_disabled_and_flags(self):
        self.con.close()
        (TMP_HOME / "config.json").write_text(json.dumps({"subagents": {"enabled": False}}))
        r, _ = run_hook("prompt", {"session_id": "f", "cwd": str(self.proj), "prompt": "hola mundo largo de prueba"})
        self.assertIn("subagentes desactivados", r.stdout.decode())
        (TMP_HOME / "config.json").write_text(json.dumps({"enabled": False}))
        r, _ = run_hook("prompt", {"session_id": "f", "cwd": str(self.proj), "prompt": "showInvoice"})
        self.assertEqual((r.returncode, r.stdout), (0, b""))
        r, _ = run_hook("prompt", {"prompt": "showInvoice"}, env_extra={"CLAUDE_MEMORY_DISABLED": "1"})
        self.assertEqual(r.stdout, b"")

    def test_failure_safe(self):
        self.con.close()
        (TMP_HOME / "config.json").write_text("{ esto no es json")
        r, _ = run_hook("prompt", {"prompt": "x"})
        self.assertEqual((r.returncode, r.stdout), (0, b""))
        (TMP_HOME / "config.json").unlink()
        r, _ = run_hook("prompt", "no es un objeto")  # stdin con JSON inesperado
        self.assertEqual(r.returncode, 0)
        for p in (config.DB, Path(str(config.DB) + "-wal"), Path(str(config.DB) + "-shm")):
            if p.exists():
                p.unlink()
        config.DB.write_bytes(b"esto no es sqlite" * 100)
        r, _ = run_hook("prompt", {"prompt": "showInvoice ownership", "cwd": str(self.proj)})
        self.assertEqual((r.returncode, r.stdout), (0, b""))
        self.assertIn("prompt", (config.LOGS / "errors.log").read_text())
        config.DB.unlink()

    def test_locked_db_continues(self):
        self.add(fact="showInvoice valida ownership con checkOwner del tenant actual", symbols="showInvoice")
        self.con.close()
        locker = sqlite3.connect(str(config.DB), isolation_level=None)
        locker.execute("PRAGMA journal_mode=DELETE")
        locker.execute("BEGIN EXCLUSIVE")
        try:
            r, ms = run_hook("prompt", {"prompt": "showInvoice ownership", "cwd": str(self.proj)})
        finally:
            locker.execute("ROLLBACK")
            locker.close()
        self.assertEqual(r.returncode, 0)
        self.assertLess(ms, 3000)


class RunlogTest(unittest.TestCase):
    def test_digest(self):
        lines = [f"ok line {i}" for i in range(500)]
        lines[100] = "ERROR: database connection refused"
        lines[300] = "WARNING: deprecated api"
        lines[301] = "Tests: 0 failed, 12 passed"
        out, tail, ne, nw, nh = digest(lines, max_lines=40)
        self.assertEqual((ne, nw), (1, 1))
        self.assertTrue(any("connection refused" in x for x in out))
        self.assertLess(len(out) + len(tail), 40)


class InstallerTest(unittest.TestCase):
    def test_install_uninstall_preserves_config(self):
        cd = Path(tempfile.mkdtemp(prefix="claude-"))
        (cd / "agents").mkdir()
        settings = {"model": "sonnet", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "otro.exe"}]}]}}
        (cd / "settings.json").write_text(json.dumps(settings), "utf-8")
        (cd / "CLAUDE.md").write_text("# Mis reglas\n", "utf-8")
        (cd / "agents" / "evidencia-haiku.md").write_text("original", "utf-8")
        (cd / "agents" / "dev.md").write_text("dev", "utf-8")
        inst = [sys.executable, "-I", str(ENGINE / "app" / "installer.py")]
        for b in ("b1", "b2"):  # idempotente
            subprocess.run(inst + ["install", "--claude-dir", str(cd), "--home", str(ENGINE), "--python", "py.exe",
                                   "--backup", str(cd / b)], check=True, capture_output=True)
        s = json.loads((cd / "settings.json").read_text("utf-8"))
        self.assertEqual(s["model"], "sonnet")
        self.assertEqual(len(s["hooks"]["Stop"]), 2)
        self.assertEqual(len(s["hooks"]["UserPromptSubmit"]), 1)
        self.assertEqual((cd / "CLAUDE.md").read_text("utf-8").count("memory-engine:begin"), 1)
        subprocess.run(inst + ["uninstall", "--claude-dir", str(cd), "--backup", str(cd / "b1")], check=True,
                       capture_output=True)
        self.assertEqual((cd / "settings.json").read_bytes(), json.dumps(settings).encode())  # byte a byte
        self.assertEqual((cd / "CLAUDE.md").read_bytes(), ("# Mis reglas" + os.linesep).encode())
        # modificado por el usuario después de instalar: retiro quirúrgico que conserva sus cambios
        subprocess.run(inst + ["install", "--claude-dir", str(cd), "--home", str(ENGINE), "--python", "py.exe",
                               "--backup", str(cd / "b3")], check=True, capture_output=True)
        s = json.loads((cd / "settings.json").read_text("utf-8"))
        s["theme"] = "light"
        (cd / "settings.json").write_text(json.dumps(s), "utf-8")
        with open(cd / "CLAUDE.md", "a", encoding="utf-8", newline="") as fh:
            fh.write("nota del usuario\r\n")
        subprocess.run(inst + ["uninstall", "--claude-dir", str(cd), "--backup", str(cd / "b3")], check=True,
                       capture_output=True)
        s = json.loads((cd / "settings.json").read_text("utf-8"))
        self.assertEqual((s.get("theme"), s["hooks"]), ("light", settings["hooks"]))
        cm = (cd / "CLAUDE.md").read_text("utf-8")
        self.assertIn("nota del usuario", cm)
        self.assertNotIn("memory-engine", cm)
        self.assertIn("# Mis reglas", cm)
        self.assertEqual((cd / "agents" / "evidencia-haiku.md").read_text("utf-8"), "original")
        self.assertFalse((cd / "agents" / "seguridad-revisor.md").exists())
        self.assertEqual((cd / "agents" / "dev.md").read_text("utf-8"), "dev")
        shutil.rmtree(cd, ignore_errors=True)


def tearDownModule():
    shutil.rmtree(TMP_HOME, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
