"""Create local keys and exchange only public certificate material for Dispositivos."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import ssl
import subprocess
import sys
from contextlib import closing
from tempfile import TemporaryDirectory

IDENTITY = "identidad"
LIMIT = 24 * 1024
EXTENSIONS = """[device]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth,serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
"""


def openssl_binary():
    candidates = [shutil.which("openssl")]
    if os.name == "nt":
        candidates.extend(str(Path(os.environ[base]) / suffix) for base, suffix in (
            ("ProgramFiles", "Git/usr/bin/openssl.exe"),
            ("LOCALAPPDATA", "Programs/Git/usr/bin/openssl.exe"),
        ) if os.environ.get(base))
    binary = next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)
    return binary


def openssl(cwd, *args):
    binary = openssl_binary()
    if not binary:
        raise ValueError("No encuentro OpenSSL. En Windows se puede usar el que trae Git for Windows.")
    result = subprocess.run([binary, *args], cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, timeout=8)
    if result.returncode:
        raise ValueError("OpenSSL no pudo validar o generar el certificado. Revisá los archivos seleccionados.")


def private_file(path, content):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
        file.write(content)


def new_key(folder, name):
    private_file(folder / name, b"")
    openssl(folder, "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-out", name)


def signed_device(work, identity):
    private_file(work / "device.ext", EXTENSIONS.encode("ascii"))
    openssl(work, "req", "-verify", "-in", "solicitud.csr", "-noout")
    openssl(work, "x509", "-req", "-in", "solicitud.csr", "-CA", str(identity / "ca.pem"),
            "-CAkey", str(identity / "ca.key"), "-set_serial", "0x" + secrets.token_hex(16),
            "-days", "180", "-sha256", "-copy_extensions", "none", "-extfile", "device.ext", "-extensions", "device", "-out", "device.pem")


def cert_fingerprint(pem):
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()


def ready(identity):
    cert, key, ca = (identity / name for name in ("device.pem", "device.key", "ca.pem"))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key, password=lambda: "")
    ctx.load_verify_locations(ca)
    return {"cert": str(cert), "key": str(key), "ca": str(ca)}


def create_identity(folder, as_authority):
    identity = folder / IDENTITY
    if identity.exists():
        if as_authority:
            if (identity / "ca.key").is_file():
                return ready(identity)
            raise ValueError("Esta PC ya tiene clave local. Continuá con su solicitud o elegí certificados existentes.")
        if not (identity / "ca.key").exists() and (identity / "device.pem").exists() and (identity / "ca.pem").exists():
            return ready(identity)
        if (identity / "solicitud.csr").is_file() and not (identity / "ca.key").exists():
            return request_details(identity / "solicitud.csr")
        raise ValueError("Ya existe una identidad local. No se reemplazó ningún archivo.")
    with TemporaryDirectory(prefix="identidad-", dir=folder) as temp:
        work = Path(temp) / IDENTITY
        work.mkdir(mode=0o700)
        new_key(work, "device.key")
        openssl(work, "req", "-new", "-key", "device.key", "-subj", "/CN=Claude Toolkit Device", "-out", "solicitud.csr")
        if as_authority:
            new_key(work, "ca.key")
            openssl(work, "req", "-new", "-x509", "-key", "ca.key", "-subj", "/CN=Claude Toolkit Local CA",
                    "-days", "730", "-sha256", "-addext", "basicConstraints=critical,CA:true,pathlen:0",
                    "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash", "-out", "ca.pem")
            signed_device(work, work)
            (work / "device.ext").unlink()
            (work / "solicitud.csr").unlink()
            ready(work)
        work.rename(identity)
    return ready(identity) if as_authority else request_details(identity / "solicitud.csr")


def read_exchange(path):
    file = Path(path.strip().strip('"')).expanduser()
    if not file.is_absolute() or not file.is_file():
        raise ValueError("Ingresá la ruta absoluta del archivo que recibiste.")
    with file.open("rb") as source:
        contents = source.read(LIMIT + 1)
    if not contents or len(contents) > LIMIT:
        raise ValueError("El archivo de intercambio está vacío o es demasiado grande.")
    return contents


def request_details(path):
    contents = read_exchange(str(path))
    if not re.fullmatch(rb"-----BEGIN CERTIFICATE REQUEST-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE REQUEST-----\s*", contents):
        raise ValueError("Seleccioná un archivo de solicitud de certificado (.csr).")
    return {"archivo": str(path), "huella": hashlib.sha256(contents).hexdigest()}


def issue(folder, path, approved):
    identity = folder / IDENTITY
    if not (identity / "ca.key").is_file():
        raise ValueError("Esta PC no tiene la clave de la autoridad local.")
    if not re.fullmatch(r"[0-9a-f]{64}", approved):
        raise ValueError("Confirmá primero la huella de la solicitud.")
    contents = read_exchange(path)
    if not hmac.compare_digest(hashlib.sha256(contents).hexdigest(), approved):
        raise ValueError("La solicitud cambió. Revisá su huella de nuevo.")
    with TemporaryDirectory(prefix="firmar-", dir=folder) as temp:
        work = Path(temp)
        private_file(work / "solicitud.csr", contents)
        signed_device(work, identity)
        output = folder / ("certificado-" + secrets.token_hex(6) + ".json")
        private_file(output, json.dumps({
            "certificado": (work / "device.pem").read_text("ascii"),
            "autoridad": (identity / "ca.pem").read_text("ascii"),
        }).encode("ascii"))
    return {"archivo": str(output), "huellaAutoridad": cert_fingerprint((identity / "ca.pem").read_text("ascii"))}


def import_certificate(folder, path, approved_ca):
    identity = folder / IDENTITY
    if not (identity / "device.key").is_file() or (identity / "ca.key").exists():
        raise ValueError("Generá primero la clave y la solicitud en esta PC.")
    if (identity / "device.pem").exists() and (identity / "ca.pem").exists():
        raise ValueError("Esta PC ya tiene un certificado. Los archivos existentes quedaron intactos.")
    bundle = json.loads(read_exchange(path))
    if not isinstance(bundle, dict) or set(bundle) != {"certificado", "autoridad"} or not all(
        isinstance(value, str) and re.fullmatch(r"-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*", value) for value in bundle.values()
    ):
        raise ValueError("Seleccioná el archivo de certificado que devolvió la PC que firma.")
    approved_ca = approved_ca.strip().replace(":", "").replace(" ", "").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", approved_ca) or not hmac.compare_digest(
            cert_fingerprint(bundle["autoridad"]), approved_ca):
        raise ValueError("La huella de la CA no coincide con la que confirmaste.")
    with TemporaryDirectory(prefix="importar-", dir=folder) as temp:
        work = Path(temp)
        private_file(work / "device.pem", bundle["certificado"].encode("ascii"))
        private_file(work / "ca.pem", bundle["autoridad"].encode("ascii"))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            ctx.load_cert_chain(work / "device.pem", identity / "device.key", password=lambda: "")
        except ssl.SSLError as error:
            raise ValueError("El certificado pertenece a otra clave. Pedí el archivo firmado de esta PC.") from error
        for purpose in ("sslserver", "sslclient"):
            openssl(work, "verify", "-purpose", purpose, "-CAfile", "ca.pem", "device.pem")
        os.replace(work / "ca.pem", identity / "ca.pem")
        os.replace(work / "device.pem", identity / "device.pem")
    return ready(identity)


def main():
    folder = Path(sys.argv[1]).resolve()
    action = sys.argv[2]
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        args = json.load(sys.stdin)
        lengths = {"crear-autoridad": 0, "crear-solicitud": 0, "leer-solicitud": 1, "firmar": 2, "importar": 2}
        if action not in lengths or not isinstance(args, list) or len(args) != lengths[action] or any(
            not isinstance(value, str) or len(value) > 2048 or "\x00" in value for value in args
        ):
            raise ValueError("Operación de certificados inválida.")
        with closing(sqlite3.connect(folder / "certificados.db", timeout=3)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if action in ("crear-autoridad", "crear-solicitud"):
                result = create_identity(folder, action == "crear-autoridad")
            elif action == "leer-solicitud":
                result = request_details(args[0])
            elif action == "firmar":
                result = issue(folder, *args)
            else:
                result = import_certificate(folder, *args)
        print(json.dumps(result, ensure_ascii=True))
    except (OSError, ValueError, TypeError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({"error": str(error)[:260]}, ensure_ascii=True))
        sys.exit(1)


if __name__ == "__main__":
    main()
