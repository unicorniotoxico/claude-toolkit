"""Local-only administration and a narrow mTLS message gateway. Python stdlib."""
import argparse
from contextlib import closing, contextmanager
import hashlib
import hmac
import secrets
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import ssl
import subprocess
import sys
import time
import uuid

MAX = 16384
KINDS = {"status", "test_result", "work_request"}
FIELDS = {
    "status": {"state"},
    "test_result": {"passed", "failed"},
    "work_request": {"revision", "operation"},
}
IDENT = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}")
FP = re.compile(r"[0-9a-f]{64}")



PRIVATE_V4 = tuple(ipaddress.IPv4Network(net) for net in
                   ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"))


def private_address(value):
    address = ipaddress.IPv4Address(value)
    if not any(address in network for network in PRIVATE_V4):
        raise ValueError("Usá una dirección IPv4 privada o de loopback.")
    return address


def allowed_networks(values):
    if not isinstance(values, list) or not 1 <= len(values) <= 20:
        raise ValueError("Agregá entre una y veinte direcciones permitidas.")
    networks = tuple(ipaddress.IPv4Network(value, strict=False) for value in values)
    if any(not any(network.subnet_of(private) for private in PRIVATE_V4) for network in networks):
        raise ValueError("Los orígenes permitidos deben estar dentro de una red IPv4 privada o de loopback.")
    return networks


def fingerprint(cert):
    return hashlib.sha256(cert).hexdigest()


def certificate(path):
    return ssl.PEM_cert_to_DER_cert(Path(path).read_text(encoding="ascii"))


def open_db(folder):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(folder / "audit.db", timeout=3)
    db.executescript("""
      CREATE TABLE IF NOT EXISTS audit(
        at INTEGER, rule TEXT, peer TEXT, project TEXT, decision TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
        rule, peer, project, decision, content='audit', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS audit_add AFTER INSERT ON audit BEGIN
        INSERT INTO audit_fts(rowid,rule,peer,project,decision)
        VALUES(new.rowid,new.rule,new.peer,new.project,new.decision);
      END;
      CREATE TRIGGER IF NOT EXISTS audit_drop AFTER DELETE ON audit BEGIN
        INSERT INTO audit_fts(audit_fts,rowid,rule,peer,project,decision)
        VALUES('delete',old.rowid,old.rule,old.peer,old.project,old.decision);
      END;
      CREATE INDEX IF NOT EXISTS audit_time ON audit(at);
      CREATE TABLE IF NOT EXISTS link(active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitation(digest TEXT, until INTEGER);
      CREATE TABLE IF NOT EXISTS pending(peer TEXT PRIMARY KEY, at INTEGER);
      CREATE TABLE IF NOT EXISTS grants(
        peer TEXT, project TEXT, kind TEXT, mode TEXT, until INTEGER,
        PRIMARY KEY(peer,project,kind)
      );
      CREATE TABLE IF NOT EXISTS inbox(
        id TEXT PRIMARY KEY, peer TEXT, project TEXT, kind TEXT, at INTEGER, data TEXT
      );
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, until INTEGER);
      CREATE TABLE IF NOT EXISTS local_seen(id TEXT PRIMARY KEY, at INTEGER);
    """)
    return db


@contextmanager
def transaction(folder):
    with closing(open_db(folder)) as db, db:
        yield db


def event(db, rule, peer="", project="", decision="blocked"):
    db.execute("INSERT INTO audit VALUES(?,?,?,?,?)",
               (int(time.time()), rule, peer, project, decision))


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)


def validate(msg):
    if not isinstance(msg, dict) or set(msg) != {"id", "project", "kind", "until", "recipient", "data"}:
        return False
    p, k, d = msg["project"], msg["kind"], msg["data"]
    if not (isinstance(p, str) and IDENT.fullmatch(p) and isinstance(k, str) and k in KINDS
            and isinstance(d, dict) and set(d) == FIELDS[k]
            and isinstance(msg["id"], str) and re.fullmatch(r"[a-f0-9]{32}", msg["id"])
            and isinstance(msg["recipient"], str) and FP.fullmatch(msg["recipient"])
            and type(msg["until"]) is int):
        return False
    if k == "status":
        return d["state"] in ("queued", "running", "finished", "blocked")
    if k == "test_result":
        return all(type(v) is int and 0 <= v <= 100_000 for v in d.values())
    rev = d["revision"]
    return (isinstance(rev, str) and bool(re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", rev))
            and d["operation"] in ("review", "test", "develop"))


def enabled(db):
    return bool(db.execute("SELECT 1 FROM link WHERE active=1").fetchone())


def receive(db, peer, recipient, msg):
    now = int(time.time())
    if not validate(msg) or msg["recipient"] != recipient or not now < msg["until"] <= now + 300:
        event(db, "schema_rejected", peer)
        return 400
    project, kind = msg["project"], msg["kind"]
    db.execute("BEGIN IMMEDIATE")
    if not enabled(db):
        event(db, "permission_denied", peer, project)
        return 403
    grant = db.execute("SELECT mode,until FROM grants WHERE peer=? AND project=? AND kind=?",
                       (peer, project, kind)).fetchone()
    if not grant or grant[1] <= now or (kind == "work_request" and grant[0] != "work"):
        event(db, "permission_denied", peer, project)
        return 403
    added = db.execute("INSERT OR IGNORE INTO seen VALUES(?,?)", (msg["id"], msg["until"]))
    if added.rowcount:
        added = db.execute("INSERT OR IGNORE INTO inbox VALUES(?,?,?,?,?,?)",
                           (msg["id"], peer, project, kind, now, json.dumps(msg["data"])))
    if not added.rowcount:
        event(db, "replay", peer, project)
        return 409
    event(db, "message_received", peer, project, "queued")
    return 202


class Gateway(HTTPServer):
    def __init__(self, cfg, folder):
        self.folder = folder
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.minimum_version = ssl.TLSVersion.TLSv1_3
        self.ctx.load_cert_chain(cfg["cert"], cfg["key"], password=lambda: "")
        self.ctx.load_verify_locations(cfg["ca"])
        self.ctx.verify_mode = ssl.CERT_REQUIRED
        self.identity = fingerprint(certificate(cfg["cert"]))
        self.allowed = allowed_networks(cfg["allow"])
        self.rates = {}
        self.total = (0, 0)
        bind = private_address(cfg["bind"])
        if not (1024 <= cfg["port"] <= 65535 or (bind.is_loopback and cfg["port"] == 0)):
            raise ValueError("Puerto fuera de rango.")
        super().__init__((str(bind), cfg["port"]), Handler)

    def get_request(self):
        sock, addr = super().get_request()
        sock.settimeout(2)
        ip = ipaddress.ip_address(addr[0])
        minute = int(time.time()) // 60
        if self.total[0] != minute:
            self.total = (minute, 0)
            self.rates.clear()
        self.total = (minute, self.total[1] + 1)
        self.rates[ip] = self.rates.get(ip, 0) + 1 if self.total[1] <= 120 else self.rates.get(ip, 0)
        if self.total[1] > 120 or self.rates[ip] > 20 or (str(ip) != self.server_address[0] and not any(ip in net for net in self.allowed)):
            sock.close()
            if self.total[1] <= 121:
                with transaction(self.folder) as db:
                    event(db, "rate_limit" if self.total[1] > 120 or self.rates[ip] > 20
                          else "network_denied", str(ip))
            raise OSError("network policy")
        try:
            return self.ctx.wrap_socket(sock, server_side=True), addr
        except OSError:
            sock.close()
            with transaction(self.folder) as db:
                event(db, "tls_rejected", str(ip))
            raise


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionError, ssl.SSLError):
            with transaction(self.server.folder) as db:
                event(db, "connection_aborted", str(self.client_address[0]))


    def reply(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def do_POST(self):
        peer = fingerprint(self.connection.getpeercert(binary_form=True))
        with transaction(self.server.folder) as db:
            if self.path not in ("/pair", "/messages") or self.headers.get("Transfer-Encoding"):
                event(db, "route_rejected", peer)
                return self.reply(404)
            try:
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > MAX:
                    raise ValueError()
                self.connection.settimeout(2)
                body = self.rfile.read(int(lengths[0]))
                if self.path == "/pair":
                    if not re.fullmatch(rb"[a-f0-9]{32}", body):
                        raise ValueError()
                    db.execute("BEGIN IMMEDIATE")
                    invitation = db.execute("SELECT digest,until FROM invitation").fetchone()
                    if (not enabled(db) or not invitation or invitation[1] <= int(time.time())
                            or not hmac.compare_digest(invitation[0], hashlib.sha256(body).hexdigest())):
                        event(db, "invitation_rejected", peer)
                        return self.reply(403)
                    db.execute("DELETE FROM invitation")
                    db.execute("INSERT INTO pending VALUES(?,?) ON CONFLICT(peer) DO UPDATE SET at=excluded.at",
                               (peer, int(time.time())))
                    event(db, "peer_pending", peer, decision="pending")
                    code = 202
                else:
                    code = receive(db, peer, self.server.identity, decode(body))
            except (ValueError, RecursionError, socket.timeout):
                event(db, "schema_rejected", peer)
                code = 400
        self.reply(code)

    def do_GET(self):
        peer = fingerprint(self.connection.getpeercert(binary_form=True))
        if self.path == "/local-ready" and peer == self.server.identity and self.client_address[0] == self.server.server_address[0]:
            return self.reply(204)
        with transaction(self.server.folder) as db:
            event(db, "route_rejected", fingerprint(self.connection.getpeercert(binary_form=True)))
        self.reply(405)


def connection_settings(config):
    address = private_address(config["bind"])
    port = config["port"]
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError("Elegí un puerto de 1024 a 65535.")
    allowed_networks(config["allow"])
    return str(address), port


def check_identity(paths):
    cert, key, ca = (Path(path.strip().strip('"')).expanduser() for path in paths)
    if not all(path.is_absolute() and path.is_file() for path in (cert, key, ca)):
        raise ValueError("Seleccioná las rutas absolutas de los tres archivos.")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    # Passing a callback prevents OpenSSL from prompting for a key password in the tool process.
    try:
        ctx.load_cert_chain(cert, key, password=lambda: "")
        ctx.load_verify_locations(ca)
    except (ssl.SSLError, OSError) as error:
        raise ValueError("Revisá que el certificado coincida con la clave local y que la CA sea válida.") from error
    return {"cert": str(cert), "key": str(key), "ca": str(ca)}


def save_configuration(folder, args):
    if not isinstance(args, list) or len(args) != 6 or not all(isinstance(value, str) for value in args):
        raise ValueError("Faltan datos de configuración.")
    bind, port, allow = args[3:]
    config = {**check_identity(args[:3]), "bind": bind.strip(), "port": int(port),
              "allow": [network.strip() for network in allow.split(",") if network.strip()]}
    connection_settings(config)
    with transaction(folder) as db:
        db.execute("BEGIN IMMEDIATE")
        if enabled(db):
            raise ValueError("Desactivá el enlace para cambiar la configuración.")
        target = folder / "gateway.json"
        draft = folder / ("gateway-" + secrets.token_hex(8) + ".tmp")
        fd = os.open(draft, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(config, file)
            os.replace(draft, target)
        finally:
            draft.unlink(missing_ok=True)
    return {"ok": True}


def connection_info(folder):
    try:
        config = json.loads((folder / "gateway.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"estado": "sin_configurar"}
    except (OSError, ValueError):
        return {"estado": "invalida"}
    try:
        address, port = connection_settings(config)
        check_identity([config["cert"], config["key"], config["ca"]])
        return {"estado": "configurada", "huella": fingerprint(certificate(config["cert"])),
                "puerto": port, "direccion": address}
    except (OSError, ValueError, TypeError, KeyError):
        return {"estado": "invalida"}


def gateway_ready(cfg):
    ctx = ssl.create_default_context(cafile=cfg["ca"])
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    ctx.check_hostname = False
    ctx.load_cert_chain(cfg["cert"], cfg["key"], password=lambda: "")
    expected = fingerprint(certificate(cfg["cert"]))
    connection = http.client.HTTPSConnection(cfg["bind"], cfg["port"], context=ctx, timeout=0.7)
    try:
        connection.connect()
        if fingerprint(connection.sock.getpeercert(binary_form=True)) != expected:
            return False
        connection.request("GET", "/local-ready")
        return connection.getresponse().status == 204
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def start_gateway(folder, cfg):
    registry = folder / "gateway.json"
    connection_settings(cfg)
    with transaction(folder) as db:
        if not enabled(db):
            raise ValueError("Habilitá el enlace antes de iniciar el receptor.")
    if gateway_ready(cfg):
        return {"ready": True}
    kwargs = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS}
              if os.name == "nt" else {"start_new_session": True})
    child = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), str(registry.parent), "serve-active"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
    until = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < until:
        if gateway_ready(cfg):
            return {"ready": True}
        time.sleep(0.15)
    if child.poll() is None:
        child.terminate()
    raise ValueError("No se pudo iniciar el receptor. Revisá la IP y que el puerto esté libre.")


def local(folder, action, args):
    now = int(time.time())
    with transaction(folder) as db:
        if action == "invite":
            db.execute("BEGIN IMMEDIATE")
            if not enabled(db):
                raise ValueError("Activá el enlace local primero.")
            code = secrets.token_hex(16)
            db.execute("DELETE FROM invitation")
            db.execute("INSERT INTO invitation VALUES(?,?)", (hashlib.sha256(code.encode()).hexdigest(), now + 300))
            return {"code": code}
        if action == "link":
            if args not in (["on"], ["off"]):
                raise ValueError("Estado de enlace inválido.")
            db.execute("DELETE FROM link")
            if args == ["on"]:
                db.execute("INSERT INTO link VALUES(1)")
            else:
                db.execute("DELETE FROM invitation")
                db.execute("DELETE FROM pending")
                db.execute("DELETE FROM grants")
            event(db, "link", decision=args[0])
        if action == "snapshot":
            db.execute("DELETE FROM seen WHERE until<=?", (now,))
            db.execute("DELETE FROM pending WHERE at<=?", (now - 600,))
            db.execute("DELETE FROM audit WHERE at<=?", (now - 30 * 86400,))
            db.execute("DELETE FROM inbox WHERE at<=?", (now - 30 * 86400,))
            db.execute("DELETE FROM grants WHERE until<=?", (now,))
            return dict(
                enabled=enabled(db),
                conexion=connection_info(folder),
                puedeFirmar=(folder / "identidad" / "ca.key").is_file(),
                pending=db.execute("SELECT peer,at FROM pending ORDER BY at DESC LIMIT 12").fetchall(),
                grants=db.execute("SELECT peer,project,kind,mode,until FROM grants WHERE until>? ORDER BY until LIMIT 30", (now,)).fetchall(),
                inbox=db.execute("SELECT project,kind,data FROM inbox ORDER BY rowid DESC LIMIT 12").fetchall(),
                alerts=db.execute("""SELECT rule,peer,count(*),max(at) FROM audit WHERE at>=? AND
                    rule IN ('tls_rejected','rate_limit','network_denied','route_rejected','schema_rejected','permission_denied',
                    'replay','peer_pending','invitation_rejected','remote_logon','outbound_review')
                    GROUP BY rule,peer ORDER BY max(at) DESC LIMIT 16""", (now - 86400,)).fetchall())
        if action == "grant":
            db.execute("BEGIN IMMEDIATE")
            if not enabled(db):
                raise ValueError("Activá el enlace local primero.")
            peer, project, kind, mode, minutes = args
            if not FP.fullmatch(peer) or not IDENT.fullmatch(project) or kind not in KINDS or mode not in ("read", "work"):
                raise ValueError("Permiso inválido.")
            if kind == "work_request" and mode != "work":
                raise ValueError("La solicitud de trabajo requiere modo Trabajo.")
            if not 1 <= int(minutes) <= 120:
                raise ValueError("Duración fuera de rango.")
            if not db.execute("SELECT 1 FROM pending WHERE peer=? AND at>?", (peer, now - 600)).fetchone():
                raise ValueError("No hay solicitud de vinculación vigente.")
            db.execute("INSERT OR REPLACE INTO grants VALUES(?,?,?,?,?)", (peer, project, kind, mode, now + 60 * int(minutes)))
            event(db, "grant", peer, project, "approved_local")
        elif action in ("reject", "revoke"):
            peer = args[0]
            if not FP.fullmatch(peer):
                raise ValueError("Huella inválida.")
            db.execute("DELETE FROM pending WHERE peer=?", (peer,))
            if action == "revoke":
                db.execute("DELETE FROM grants WHERE peer=?", (peer,))
            event(db, action, peer, decision="local")
        elif action == "audit":
            term = args[0]
            if not IDENT.fullmatch(term):
                raise ValueError("Buscá por un código de evento o una huella.")
            return db.execute("""SELECT at,audit.rule,audit.peer,audit.project,audit.decision FROM audit_fts
                JOIN audit ON audit.rowid=audit_fts.rowid WHERE audit_fts MATCH ?
                ORDER BY at DESC LIMIT 50""", ('"' + term + '"',)).fetchall()
    return {"ok": True}


def send(cfg, args):
    host, port, expected, project, kind, payload = args
    host = str(private_address(host))
    if not FP.fullmatch(expected):
        raise ValueError("Verificá la huella del receptor por otro canal.")
    data = decode(payload)
    if kind == "pair" and (not isinstance(data, dict) or set(data) != {"code"} or
                           not isinstance(data["code"], str) or not re.fullmatch(r"[a-f0-9]{32}", data["code"])):
        raise ValueError("Código de invitación inválido.")
    ctx = ssl.create_default_context(cafile=cfg["ca"])
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    ctx.check_hostname = False
    ctx.load_cert_chain(cfg["cert"], cfg["key"])
    connection = http.client.HTTPSConnection(host, int(port), context=ctx, timeout=6)
    try:
        connection.connect()
        if fingerprint(connection.sock.getpeercert(binary_form=True)) != expected:
            raise ValueError("La huella del receptor cambió.")
        msg = {"id": uuid.uuid4().hex, "project": project, "kind": kind, "until": int(time.time()) + 120,
               "recipient": expected, "data": data}
        if kind != "pair" and not validate(msg):
            raise ValueError("Mensaje fuera del esquema autorizado.")
        connection.request("POST", "/pair" if kind == "pair" else "/messages",
                           data["code"].encode() if kind == "pair" else json.dumps(msg).encode())
        return {"status": connection.getresponse().status}
    finally:
        connection.close()


def local_events(folder):
    if os.name != "nt":
        return {"status": "Solo disponible en Windows."}
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    query = r"""
    $failed = @()
    $start = (Get-Date).AddMinutes(-5)
    $rows = @(foreach ($spec in @(@{ Log='Security'; Id=4624 }, @{ Log='Microsoft-Windows-Sysmon/Operational'; Id=3 })) {
      try {
        $events = Get-WinEvent -FilterHashtable @{LogName=$spec.Log; Id=$spec.Id; StartTime=$start} -MaxEvents 200 -ErrorAction Stop
        foreach ($e in $events) {
          $fields = @{}
          ([xml]$e.ToXml()).Event.EventData.Data | ForEach-Object { $fields[$_.Name] = $_.'#text' }
          if ($e.Id -eq 4624 -and $fields.LogonType -eq '10') {
            @{ id="rdp-$($e.RecordId)"; rule='remote_logon'; ip=$fields.IpAddress }
          }
          if ($e.Id -eq 3 -and $fields.Initiated -eq 'true' -and $fields.Image -match '\\(?:powershell|pwsh|wscript|cscript|mshta)\.exe$') {
            @{ id="net-$($e.RecordId)"; rule='outbound_review'; ip=$fields.DestinationIp }
          }
        }
      } catch {
        if ($_.FullyQualifiedErrorId -notmatch '^NoMatchingEventsFound,') { $failed += $spec.Log }
      }
    })
    @{rows=$rows; unavailable=$failed} | ConvertTo-Json -Depth 4 -Compress
    """
    proc = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", query],
                          capture_output=True, timeout=12, check=True)
    report = json.loads(proc.stdout)
    now = int(time.time())
    with transaction(folder) as db:
        db.execute("DELETE FROM local_seen WHERE at<?", (now - 86400,))
        for row in report["rows"]:
            if row["rule"] not in ("remote_logon", "outbound_review") or not IDENT.fullmatch(row["id"]):
                continue
            try:
                address = str(ipaddress.ip_address(row["ip"]))
            except (TypeError, ValueError):
                address = ""
            added = db.execute("INSERT OR IGNORE INTO local_seen VALUES(?,?)", (row["id"], now))
            if added.rowcount:
                event(db, row["rule"], address, decision="review")
    return {"status": "Fuentes no disponibles: " + ", ".join(report["unavailable"])
            if report["unavailable"] else "Eventos de Windows consultados."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("action", choices=["serve", "send", "snapshot", "grant", "reject", "revoke", "audit", "local-events", "identity", "link", "invite", "check-identity", "configure", "start-gateway", "serve-active"])
    parser.add_argument("args", nargs="*")
    opt = parser.parse_args()
    try:
        if opt.action in ("send", "check-identity", "configure") and not opt.args:
            opt.args = json.load(sys.stdin)
        if opt.action == "check-identity":
            check_identity(opt.args)
            result = {"ok": True}
        elif opt.action == "configure":
            result = save_configuration(opt.folder, opt.args)
        elif opt.action == "local-events":
            result = local_events(opt.folder)
        elif opt.action in ("serve", "serve-active", "start-gateway", "send", "identity"):
            cfg = json.loads((opt.folder / "gateway.json").read_text(encoding="utf-8"))
            if opt.action in ("serve", "serve-active"):
                with Gateway(cfg, opt.folder) as gateway:
                    if opt.action == "serve":
                        gateway.serve_forever()
                    else:
                        gateway.timeout = 1
                        while True:
                            with transaction(opt.folder) as db:
                                if not enabled(db):
                                    break
                            gateway.handle_request()
                return
            if opt.action == "start-gateway":
                result = start_gateway(opt.folder, cfg)
            elif opt.action == "identity":
                result = {"fingerprint": fingerprint(certificate(cfg["cert"]))}
            else:
                with transaction(opt.folder) as db:
                    if not enabled(db):
                        raise ValueError("Activá el enlace local primero.")
                result = send(cfg, opt.args)
        else:
            result = local(opt.folder, opt.action, opt.args)
        print(json.dumps(result, ensure_ascii=True))
    except (OSError, ValueError, TypeError, IndexError, KeyError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)[:240]}, ensure_ascii=True))
        sys.exit(1)


if __name__ == "__main__":
    main()
