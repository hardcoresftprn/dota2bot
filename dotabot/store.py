"""One process per database; durable per-chat outbox and canonical event IDs."""
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class Store:
    def __init__(self, path: str, database_url: str = "", lock: bool = True):
        self.postgres = bool(database_url)
        self.lock_file = None
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row
            self.conn = psycopg.connect(database_url, autocommit=True, row_factory=dict_row, client_encoding="utf8")
            if lock and not self.execute("SELECT pg_try_advisory_lock(57020261106) AS locked").fetchone()["locked"]:
                self.conn.close()
                raise RuntimeError("Другой экземпляр бота уже использует эту базу")
        else:
            if path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                if lock:
                    import fcntl
                    self.lock_file = open(path + ".lock", "a")
                    try:
                        fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        self.lock_file.close()
                        raise RuntimeError("Другой экземпляр бота уже использует эту базу") from None
            self.conn = sqlite3.connect(path, isolation_level=None)
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
        for statement in (
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS chats (id BIGINT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1)",
            "CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, published BIGINT NOT NULL, message TEXT)",
            "CREATE TABLE IF NOT EXISTS deliveries (event_key TEXT NOT NULL REFERENCES events(key), chat_id BIGINT NOT NULL REFERENCES chats(id), status TEXT NOT NULL DEFAULT 'pending', next_attempt BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(event_key,chat_id))",
            "CREATE INDEX IF NOT EXISTS delivery_pending ON deliveries(status,next_attempt)",
        ):
            self.execute(statement)
        # Telegram does not offer an idempotency key. A request interrupted after
        # dispatch may have succeeded; don't blindly send it again after a crash.
        self.execute("UPDATE deliveries SET status='uncertain' WHERE status='sending'")

    def execute(self, sql, params=()):
        return self.conn.execute(sql.replace("?", "%s") if self.postgres else sql, params)

    @contextmanager
    def transaction(self):
        if self.postgres:
            with self.conn.transaction():
                yield
        else:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.conn.execute("COMMIT")
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise

    def get(self, key, default=None):
        row = self.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set(self, key, value):
        self.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))

    def seen(self, key):
        return self.execute("SELECT 1 FROM events WHERE key=?", (key,)).fetchone() is not None

    def subscribe(self, chat_id, active=True):
        with self.transaction():
            self.execute("INSERT INTO chats(id,active) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active", (chat_id, int(active)))
            if not active:
                self.execute("UPDATE deliveries SET status='cancelled' WHERE chat_id=? AND status='pending'", (chat_id,))

    def is_active(self, chat_id):
        row = self.execute("SELECT active FROM chats WHERE id=?", (chat_id,)).fetchone()
        return bool(row and row["active"])

    def archive(self, key, published):
        self.execute("INSERT INTO events(key,published) VALUES(?,?) ON CONFLICT(key) DO NOTHING", (key, published))

    def save(self, event, message, broadcast=True):
        with self.transaction():
            added = self.execute("INSERT INTO events(key,published,message) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING", (event.key, event.published, message)).rowcount
            if added and message and broadcast:
                self.execute("INSERT INTO deliveries(event_key,chat_id) SELECT ?,id FROM chats WHERE active=1 ON CONFLICT DO NOTHING", (event.key,))

    def latest(self):
        return self.execute("SELECT key,message,published FROM events WHERE message IS NOT NULL ORDER BY published DESC,key DESC LIMIT 1").fetchone()

    def pending(self):
        return self.execute("SELECT d.event_key,d.chat_id,e.message FROM deliveries d JOIN events e ON e.key=d.event_key JOIN chats c ON c.id=d.chat_id WHERE d.status='pending' AND d.next_attempt<=? AND c.active=1 ORDER BY e.published,d.chat_id LIMIT 100", (int(time.time()),)).fetchall()

    def delivery(self, key, chat_id, status, delay=0):
        self.execute("UPDATE deliveries SET status=?,next_attempt=? WHERE event_key=? AND chat_id=?", (status, int(time.time()) + delay, key, chat_id))

    def close(self):
        self.conn.close()
        if self.lock_file:
            self.lock_file.close()
