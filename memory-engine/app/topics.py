"""Derived topic associations and bounded FTS5 candidate search."""
import re

from .context import fold, stem, words

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_topic_terms (
    term TEXT NOT NULL,
    memory_id INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    PRIMARY KEY (term, memory_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_memory_topic_terms_id ON memory_topic_terms(memory_id);
CREATE TABLE IF NOT EXISTS memory_topic_queue (memory_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS memory_topic_backfill (cursor INTEGER NOT NULL);
INSERT INTO memory_topic_backfill SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM memory_topic_backfill);
CREATE TRIGGER IF NOT EXISTS memory_topic_insert AFTER INSERT ON memories BEGIN
    INSERT OR IGNORE INTO memory_topic_queue VALUES (new.id);
END;
CREATE TRIGGER IF NOT EXISTS memory_topic_update AFTER UPDATE OF topic, aliases, type ON memories BEGIN
    INSERT OR IGNORE INTO memory_topic_queue VALUES (new.id);
END;
CREATE TRIGGER IF NOT EXISTS memory_topic_delete AFTER DELETE ON memories BEGIN
    DELETE FROM memory_topic_terms WHERE memory_id = old.id;
    DELETE FROM memory_topic_queue WHERE memory_id = old.id;
END;
"""

BATCH_SIZE = 256
MAX_BRANCHES = 6
CANDIDATES_PER_BRANCH = 8
BROAD_MATCH = 32
TOPIC_FOCUS = 0.5


def index_batch(con):
    """Resume existing rows and notice new writes, including writes from older clients."""
    state = con.execute("SELECT cursor FROM memory_topic_backfill").fetchone()
    if state[0] < 0 and not con.execute("SELECT 1 FROM memory_topic_queue LIMIT 1").fetchone():
        return
    con.execute("SAVEPOINT update_memory_topics")
    try:
        cursor = con.execute("SELECT cursor FROM memory_topic_backfill").fetchone()[0]
        pending = con.execute("SELECT memory_id FROM memory_topic_queue ORDER BY memory_id LIMIT ?",
                              (BATCH_SIZE,)).fetchall()
        rows = []
        if cursor >= 0:
            rows = con.execute("SELECT id, type, topic, aliases FROM memories WHERE id > ? ORDER BY id LIMIT ?",
                               (cursor, BATCH_SIZE)).fetchall()
            next_cursor = rows[-1]["id"] if len(rows) == BATCH_SIZE else -1
            con.execute("UPDATE memory_topic_backfill SET cursor = ?", (next_cursor,))
        pending_ids = {row[0] for row in pending}
        missing = pending_ids.difference(row["id"] for row in rows)
        if missing:
            marks = ",".join("?" for _ in missing)
            rows += con.execute(f"SELECT id, type, topic, aliases FROM memories WHERE id IN ({marks})",
                                tuple(missing)).fetchall()
        ids = pending_ids.union(row["id"] for row in rows)
        con.executemany("DELETE FROM memory_topic_terms WHERE memory_id = ?", ((mid,) for mid in ids))
        associations = []
        for row in rows:
            terms = {}
            for depth, level in levels(row):
                terms.update(dict.fromkeys(level, depth))
            associations.extend((term, row["id"], depth) for term, depth in terms.items())
        con.executemany("INSERT INTO memory_topic_terms VALUES (?, ?, ?)", associations)
        con.executemany("DELETE FROM memory_topic_queue WHERE memory_id = ?", ((mid,) for mid in ids))
        con.execute("RELEASE update_memory_topics")
    except BaseException:
        con.execute("ROLLBACK TO update_memory_topics")
        con.execute("RELEASE update_memory_topics")
        raise


def levels(row):
    """(depth, stems) per topic level, root first. The type is a broad category (depth 0);
    an explicit topic may be a path such as A > B > C; aliases belong to the leaf (depth 2)."""
    parts = [part for part in re.split(r"[>→]", row["topic"]) if part.strip()]
    out = [(0, {stem(word) for word in words(row["type"].split("_", 1)[0])})]
    out += [(1, {stem(word) for word in words(part)}) for part in parts[:-1]]
    out.append((2, {stem(word) for word in words(parts[-1] if parts else "")} |
                {stem(word) for word in words(row["aliases"])}))
    return [(depth, level) for depth, level in out if level]


def focused_depth(row, query_stems):
    """Deepest topic level the query is about, or -1. A level counts only when the query
    covers at least TOPIC_FOCUS of its terms: one prose word inside a long topic is noise."""
    hits = [depth for depth, level in levels(row)
            if len(level & query_stems) >= TOPIC_FOCUS * len(level)]
    return max(hits, default=-1)


def branches(con, query_words, limit):
    """Return narrow query terms first. Keep broad ancestor terms from consuming all slots."""
    if not query_words or not limit:
        return []
    query_words = list(dict.fromkeys(query_words))
    mapped = []
    for word in query_words:
        known = con.execute("SELECT 1 FROM memory_topic_terms WHERE term = ? LIMIT 1",
                            (stem(word),)).fetchone() is not None
        limit = BROAD_MATCH if known else CANDIDATES_PER_BRANCH + 1
        count = con.execute("""SELECT count(*) FROM (
            SELECT 1 FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?)""",
                            (_literal(word), limit)).fetchone()[0]
        if known or (len(word) >= 4 and 0 < count < limit):
            mapped.append((word, count, known))
    mapped.sort(key=lambda item: (not item[2], not item[1], item[1]))
    return [(word, known, count) for word, count, known in mapped[:limit]]


def _literal(word):
    return '"' + fold(word).replace('"', '""') + '"'


def candidates(con, word, project, session_id, limit, foreign=False):
    # MATCH on the original text still works while the derived index is being backfilled.
    clause = "m.project <> ? AND m.scope <> 'global'" if foreign else "(m.project = ? OR m.scope = 'global')"
    return con.execute(f"""SELECT m.*, rank AS b, t.depth AS topic_depth
        FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
        LEFT JOIN memory_topic_terms t ON t.term = ? AND t.memory_id = m.id
        WHERE memories_fts MATCH ? AND rank MATCH 'bm25(1.0, 0.7, 1.2, 1.0, 0.8)'
        AND {clause} AND m.status IN ('active','stale')
        AND (m.validity_mode <> 'session_only' OR m.session_id = ?)
        ORDER BY rank LIMIT ?""", (stem(word), _literal(word), project, session_id, limit)).fetchall()


def ancestor_candidates(con, word, project, session_id, limit, foreign=False):
    clause = "m.project <> ? AND m.scope <> 'global'" if foreign else "(m.project = ? OR m.scope = 'global')"
    return con.execute(f"""SELECT m.*, 0.0 AS b, t.depth AS topic_depth
        FROM memory_topic_terms t JOIN memories m ON m.id = t.memory_id
        WHERE t.term = ? AND {clause} AND m.status IN ('active','stale')
        AND (m.validity_mode <> 'session_only' OR m.session_id = ?)
        ORDER BY t.memory_id DESC LIMIT ?""", (stem(word), project, session_id, limit)).fetchall()
