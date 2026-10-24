"""Detección determinística de secretos. Ante duda se rechaza: nunca se persiste."""
import math
import re

DENY = [
    ("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("aws_key", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b")),
    ("slack_token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("openai_like_key", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")),
    ("google_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("stripe_key", re.compile(r"\b[rs]k_(live|test)_[0-9A-Za-z]{16,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}")),
    ("url_credentials", re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:[^\s@/]+@", re.I)),
    ("assignment", re.compile(
        r"(?i)\b(pass(word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|"
        r"auth[_-]?token|private[_-]?key|db_pass(word)?)\b\s*[:=]\s*['\"]?(?!<|\$\{|\*{3}|x{3})[^\s'\"]{4,}")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9_\-.=]{20,}")),
]
_LONG = re.compile(r"[A-Za-z0-9+/=_\-]{32,}")
_HEX = re.compile(r"^[0-9a-fA-F]+$")


def _entropy(s):
    n = len(s)
    counts = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    return -sum(c / n * math.log2(c / n) for c in counts.values())


def find_secret(text):
    """Devuelve el nombre de la regla que coincide (sin el contenido) o None."""
    if not text:
        return None
    for name, rx in DENY:
        if rx.search(text):
            return name
    for tok in _LONG.findall(text):
        if _HEX.match(tok):
            continue  # hashes/commits: permitidos
        classes = sum(bool(re.search(p, tok)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]"))
        if classes >= 3 and _entropy(tok) > 4.2:
            return "high_entropy"
    return None


SENSITIVE_FILE = re.compile(r"(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_[rd]sa.*|\.credentials\.json|"
                            r"secrets?\.(json|ya?ml)|.*\.pfx|.*\.p12|\.npmrc|\.pypirc|\.netrc)$", re.I)


def is_sensitive_file(path):
    return bool(SENSITIVE_FILE.search(path.strip()))
