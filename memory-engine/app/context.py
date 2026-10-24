"""Señales del contexto actual: proyecto, git, términos del prompt y session context."""
import json
import os
import re
import time
import unicodedata
from pathlib import Path

from . import config
from .secrets_filter import find_secret

STOP = set("""
a al algo ante antes aqui aca asi aun bien cada como con contra cual cuando de del desde donde dos el ella
ellos en entre era es esa ese eso esta este esto estos fue ha hacer hay la las le les lo los mas me mi mismo
muy nada ni no nos o otra otro para pero poco por porque puede pues que quiero se ser si sin sobre solo su
sus tambien tan te tiene todo tu un una uno unos y ya yo eso esa hace hacelo haz quiero necesito podes podrias
ver dame mostrame revisa revisar arregla arreglar fijate hago haces hacemos tengo tenes tenemos podria deberia
seria sería quiero queres sabes decime contame explica explicame paso pasa pasos manera forma cosa cosas algun
alguna the and for with this that from into have has was are
is it its of on in to be by or as at an not can you your please make use using code file files fix check
""".split())

_WORD = re.compile(r"[^\W\d_][\w\-]{2,}", re.U)
_FILE = re.compile(r"[\w./\\\-]*?[\w\-]+\.(?:php|phtml|js|mjs|cjs|ts|tsx|jsx|py|sql|json|ya?ml|md|ps1|psm1|go|rb|"
                   r"java|cs|html?|css|scss|vue|svelte|toml|ini|sh|bat|cmd|xml|tf|lock)\b", re.I)
_SYMBOL = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*(?:(?:::|->|\.)[A-Za-z_][A-Za-z0-9_]*)*(?=\s*\()|"
                     r"\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b|"
                     r"\b[a-z][a-z0-9]*_[a-z0-9_]+\b|(?<![\w])/(?:api|v\d)[\w/\-{}:]*")


def fold(s):
    """minúsculas sin diacríticos (igual que unicode61 remove_diacritics)."""
    return "".join(c for c in unicodedata.normalize("NFKD", s.lower()) if not unicodedata.combining(c))


_SUFFIXES = ("aciones", "iciones", "amiento", "imiento", "amente", "acion", "icion", "ciones", "mente", "iendo",
             "ando", "ados", "adas", "idos", "idas", "aron", "ieron", "ing", "ado", "ada", "ido", "ida", "aba",
             "cion", "ar", "er", "ir", "es", "os", "as", "ed", "o", "a", "e", "s")


def stem(w):
    """Recorte conservador de sufijos es/en (imputó/imputar/imputado/imputación -> imput).
    Determinístico, sin diccionarios ni modelos; deja raíz de al menos 4 letras."""
    for suf in _SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    return w


def words(text, limit=24):
    out, seen = [], set()
    for w in _WORD.findall(fold(text)):
        for part in w.split("-"):
            if len(part) >= 3 and part not in STOP and part not in seen:
                seen.add(part)
                out.append(part)
    return out[:limit]


_ANAPHORA = re.compile(r"(?i)\b(ac[aá]|aqu[ií]|ah[ií]|all[aá]|eso|esto|esta|este|ese|esa|lo mismo|tambi[eé]n|"
                       r"igual|sigue|segu[ií]|contin[uú]\w*|otra vez|de nuevo|ahora|y\s+(si|con|en)|"
                       r"this|that|there|here|same|again|also|continue|next)\b")


def is_ambiguous(prompt, content_words, max_words):
    """Breve y dependiente del contexto previo ("¿y acá?", "seguí", "lo mismo en el otro")."""
    return len(content_words) <= max_words and (not content_words or bool(_ANAPHORA.search(prompt)))


def extract(prompt):
    files = []
    for m in _FILE.findall(prompt):
        b = m.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if b not in files:
            files.append(b)
    symbols = []
    for m in _SYMBOL.findall(prompt):
        s = m.lower()
        if len(s) >= 4 and s not in symbols and s not in files and not _FILE.fullmatch(m):
            symbols.append(s)
    return {"words": words(prompt), "files": files[:10], "symbols": symbols[:12], "raw": prompt[:400]}


def find_root(cwd):
    p = Path(cwd).resolve()
    home = Path.home().resolve()
    for cand in [p, *p.parents][:12]:
        if (cand / ".git").exists():
            return cand if cand != home else p
    return p


def project_id(root):
    return str(root).replace("\\", "/").lower()


def _gitdir(root):
    g = root / ".git"
    if g.is_file():
        try:
            line = g.read_text("utf-8").strip()
            if line.startswith("gitdir:"):
                gd = Path(line[7:].strip())
                return gd if gd.is_absolute() else (root / gd).resolve()
        except OSError:
            return None
    return g if g.is_dir() else None


def git_info(root):
    """branch y commit leyendo .git directamente (sin lanzar git)."""
    gd = _gitdir(root)
    if not gd:
        return None, None
    try:
        head = (gd / "HEAD").read_text("utf-8").strip()
    except OSError:
        return None, None
    if not head.startswith("ref:"):
        return head[:12], head
    ref = head[4:].strip()
    branch = ref.rsplit("refs/heads/", 1)[-1]
    common = gd
    cd = gd / "commondir"
    if cd.exists():
        try:
            common = (gd / cd.read_text("utf-8").strip()).resolve()
        except OSError:
            pass
    for base in (gd, common):
        f = base / ref
        if f.exists():
            try:
                return branch, f.read_text("utf-8").strip()
            except OSError:
                pass
    packed = common / "packed-refs"
    if packed.exists():
        try:
            for line in packed.read_text("utf-8").splitlines():
                if line.endswith(" " + ref):
                    return branch, line.split(" ", 1)[0]
        except OSError:
            pass
    return branch, None


DEP_FILES = ("composer.json", "composer.lock", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
             "pyproject.toml", "poetry.lock", "requirements.txt", "uv.lock", "Pipfile.lock", "go.sum", "Cargo.lock")


def dep_hash(root):
    import hashlib  # diferido: OpenSSL cuesta ~13 ms y el camino del prompt casi nunca lo usa
    h = hashlib.sha256()
    found = False
    for name in DEP_FILES:
        f = root / name
        if f.is_file():
            found = True
            h.update(name.encode())
            h.update(file_hash(f).encode())
    return h.hexdigest()[:16] if found else None


def file_hash(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


STACK_MARKERS = {
    "php-mysql": ("composer.json", "artisan", "index.php", "wp-config.php"),
    "javascript-typescript": ("package.json", "tsconfig.json", "deno.json"),
    "python": ("pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "manage.py"),
}


def detect_stacks(root):
    return [s for s, marks in STACK_MARKERS.items() if any((root / m).exists() for m in marks)]


SENSITIVE = re.compile(
    r"(?i)\b(auth\w*|autoriz\w*|autentic\w*|login|logout|sesi[oó]n|session|cookie|csrf|jwt|token|oauth|password|contrase[nñ]a|permis\w*|"
    r"rol(es)?|role|ownership|owner|idor|acl|sql|query|consulta|mysql|inyecci[oó]n|injection|upload|subida|archivo|"
    r"path|ruta|exec|subprocess|shell|comando|deserializ\w*|pickle|yaml|ssrf|webhook|cors|xss|crypto\w*|cifrad\w*|"
    r"hash|secret\w*|credencial\w*|pago|payment|dinero|saldo|transfer\w*|borra\w*|delete|drop|migraci[oó]n|"
    r"docker|nginx|apache|firewall|deploy|infra\w*|dependenc\w*|hardening)\b")


# ---------------------------------------------------------------- session context

_SID = re.compile(r"[^A-Za-z0-9_\-]")


def _session_path(session_id):
    sid = _SID.sub("", session_id or "")[:80] or "default"
    return config.SESSIONS / f"{sid}.json"


def load_session(session_id, ttl_hours):
    p = _session_path(session_id)
    try:
        data = json.loads(p.read_text("utf-8"))
        if time.time() - data.get("updated_at", 0) > ttl_hours * 3600:
            return {}
        return data
    except Exception:
        return {}


def save_session(session_id, data):
    config.SESSIONS.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = time.time()
    p = _session_path(session_id)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
    os.replace(tmp, p)


def cleanup_sessions(ttl_hours):
    if not config.SESSIONS.exists():
        return 0
    limit = time.time() - ttl_hours * 3600
    n = 0
    for f in config.SESSIONS.glob("*.json"):
        try:
            if f.stat().st_mtime < limit:
                f.unlink()
                n += 1
        except OSError:
            pass
    return n


def push_unique(lst, items, cap):
    for it in items:
        if it in lst:
            lst.remove(it)
        lst.insert(0, it)
    del lst[cap:]
    return lst


def safe_snippet(text, n=200):
    t = " ".join(text.split())[:n]
    return None if find_secret(t) else t
