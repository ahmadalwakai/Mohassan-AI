"""Opt-in, installation-owned knowledge/history; metrics contain no prompt text.

SQLite is the offline development store. Set WASLA_DATABASE_URL for PostgreSQL
(including Neon) after installing requirements-hybrid.txt. All values are bound
parameters, and every content query is scoped to this installation's owner ID.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid

from .security import atomic_json, read_json, state_lock, protect_directory
from .services import ServiceError, _plain_text


SCHEMA = (
    "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(conversation_id,ordinal))",
    "CREATE TABLE IF NOT EXISTS knowledge_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, search_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS web_sources (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT, retrieved_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS research_runs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, route TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS usage_metrics (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, route TEXT NOT NULL, latency_ms REAL NOT NULL, cache_hit INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS engine_settings (owner_id TEXT PRIMARY KEY, memory_enabled INTEGER NOT NULL DEFAULT 0, knowledge_revision INTEGER NOT NULL DEFAULT 0)",
    "CREATE INDEX IF NOT EXISTS knowledge_owner_updated ON knowledge_documents(owner_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS conversations_owner_updated ON conversations(owner_id, updated_at)",
    "CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at)",
    "CREATE INDEX IF NOT EXISTS metrics_owner_created ON usage_metrics(owner_id, created_at)",
)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def normalized(text):
    text = re.sub(r"[\u064b-\u065f\u0670\u0640]", "", text.lower())
    return text.translate(str.maketrans("أإآى", "اااي"))


def checked_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise ServiceError("invalid_id", "معرّف العنصر غير صالح.", 400) from None


class KnowledgeStore:
    def __init__(self, root: Path, database_url=None, owner_id=None):
        self.root = Path(root)
        protect_directory(self.root)
        self.lock = threading.RLock()
        self.database_url = database_url if database_url is not None else os.getenv("WASLA_DATABASE_URL", "")
        self.storage = "neon" if self.database_url else "sqlite"
        with state_lock(self.root):
            metadata = read_json(self.root / "intelligence-owner.json", {})
            if not metadata.get("owner_id"):
                metadata = {"owner_id": str(uuid.uuid4())}
                atomic_json(self.root / "intelligence-owner.json", metadata)
        self.owner_id = owner_id or metadata["owner_id"]
        with self.transaction() as db:
            for statement in SCHEMA:
                db.execute(statement)
            db.execute("INSERT INTO engine_settings(owner_id) VALUES (?) ON CONFLICT(owner_id) DO NOTHING", (self.owner_id,))

    @contextmanager
    def transaction(self):
        with self.lock:
            if self.database_url:
                if not self.database_url.startswith(("postgres://", "postgresql://")):
                    raise RuntimeError("WASLA_DATABASE_URL must be a PostgreSQL connection string.")
                try:
                    import psycopg
                    from psycopg.rows import dict_row
                    import certifi
                except ImportError:
                    raise RuntimeError("Install requirements-hybrid.txt to enable PostgreSQL storage.") from None
                connection = psycopg.connect(self.database_url, connect_timeout=8, sslmode="verify-full", sslrootcert=certifi.where(), row_factory=dict_row)
            else:
                connection = sqlite3.connect(self.root / "intelligence.sqlite3", timeout=5)
                connection.row_factory = sqlite3.Row
                connection.execute("PRAGMA foreign_keys=ON")
                connection.execute("PRAGMA journal_mode=WAL")

            class Database:
                def execute(_, sql, args=()):
                    return connection.execute(sql.replace("?", "%s") if self.database_url else sql, args)

            try:
                yield Database()
                connection.commit()
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def settings(self):
        with self.transaction() as db:
            row = db.execute("SELECT memory_enabled FROM engine_settings WHERE owner_id=?", (self.owner_id,)).fetchone()
        return {"memory_enabled": bool(row["memory_enabled"]), "storage": self.storage}

    def set_settings(self, memory_enabled):
        if type(memory_enabled) is not bool:
            raise ServiceError("invalid_request", "اختيار حفظ المحادثات يجب أن يكون نعم أو لا.", 400)
        with self.transaction() as db:
            db.execute("UPDATE engine_settings SET memory_enabled=? WHERE owner_id=?", (int(memory_enabled), self.owner_id))
        return self.settings()

    def knowledge_version(self, device_id=None):
        with self.transaction() as db:
            row = db.execute("SELECT knowledge_revision FROM engine_settings WHERE owner_id=?", (self.owner_id,)).fetchone()
        return row["knowledge_revision"]

    def documents(self):
        with self.transaction() as db:
            rows = db.execute("SELECT id,title,content,created_at,updated_at FROM knowledge_documents WHERE owner_id=? ORDER BY updated_at DESC LIMIT 500", (self.owner_id,)).fetchall()
        return [dict(row) for row in rows]

    def add_document(self, title, content):
        title = _plain_text(title, "title", 160)
        content = _plain_text(content, "content", 20000)
        document = {"id": str(uuid.uuid4()), "title": title, "content": content, "created_at": utcnow()}
        document["updated_at"] = document["created_at"]
        with self.transaction() as db:
            count = db.execute("SELECT COUNT(*) AS n FROM knowledge_documents WHERE owner_id=?", (self.owner_id,)).fetchone()["n"]
            if count >= 500:
                raise ServiceError("knowledge_full", "وصلت المعرفة المحفوظة إلى حد ٥٠٠ مستند. احذف ما لا تحتاجه أولًا.", 409)
            db.execute("INSERT INTO knowledge_documents(id,owner_id,title,content,search_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", (document["id"], self.owner_id, title, content, normalized(title + " " + content), document["created_at"], document["updated_at"]))
            db.execute("UPDATE engine_settings SET knowledge_revision=knowledge_revision+1 WHERE owner_id=?", (self.owner_id,))
        return document

    def delete_document(self, document_id):
        with self.transaction() as db:
            cursor = db.execute("DELETE FROM knowledge_documents WHERE id=? AND owner_id=?", (checked_id(document_id), self.owner_id))
            db.execute("UPDATE engine_settings SET knowledge_revision=knowledge_revision+1 WHERE owner_id=?", (self.owner_id,))
        return {"deleted": cursor.rowcount > 0}

    def knowledge_lookup(self, device_id, query, limit=4):
        words = set(re.findall(r"[^\W_]{2,}", normalized(query), re.UNICODE))
        words -= {"ما", "هو", "هي", "في", "من", "عن", "the", "what", "is", "are", "of", "in", "my"}
        if not words:
            return []
        with self.transaction() as db:
            rows = db.execute("SELECT id,title,content,search_text,updated_at FROM knowledge_documents WHERE owner_id=? ORDER BY updated_at DESC LIMIT 500", (self.owner_id,)).fetchall()
        ranked = []
        for row in rows:
            matches = words.intersection(re.findall(r"[^\W_]{2,}", row["search_text"], re.UNICODE))
            if matches:
                ranked.append((len(matches) / len(words), dict(row)))
        ranked.sort(key=lambda pair: pair[0], reverse=True)
        return [{key: value for key, value in row.items() if key != "search_text"} for _, row in ranked[:max(1, min(8, limit))]]

    def save_exchange(self, messages, answer, *, remember=False, conversation_id=None):
        if remember is not True:
            return None
        last = messages[-1]["content"]
        conversation_id = checked_id(conversation_id) if conversation_id else str(uuid.uuid4())
        now = utcnow()
        with self.transaction() as db:
            row = db.execute("SELECT id FROM conversations WHERE id=? AND owner_id=?", (conversation_id, self.owner_id)).fetchone()
            if not row:
                # A client-supplied identifier belonging to another owner must not
                # be used to append messages via the globally unique primary key.
                collision = db.execute("SELECT id FROM conversations WHERE id=?", (conversation_id,)).fetchone()
                if collision:
                    raise ServiceError("not_found", "المحادثة غير متاحة.", 404)
                db.execute("INSERT INTO conversations(id,owner_id,title,created_at,updated_at) VALUES (?,?,?,?,?)", (conversation_id, self.owner_id, last[:100], now, now))
            ordinal = db.execute("SELECT COALESCE(MAX(ordinal),0) AS n FROM messages WHERE conversation_id=?", (conversation_id,)).fetchone()["n"]
            for role, content in (("user", last), ("assistant", answer["content"])):
                ordinal += 1
                db.execute("INSERT INTO messages(id,conversation_id,ordinal,role,content,created_at) VALUES (?,?,?,?,?,?)", (str(uuid.uuid4()), conversation_id, ordinal, role, content, now))
            db.execute("UPDATE conversations SET updated_at=? WHERE id=? AND owner_id=?", (now, conversation_id, self.owner_id))
            if answer.get("route") == "research" or answer.get("evidence", {}).get("web_used") is True:
                db.execute("INSERT INTO research_runs(id,owner_id,conversation_id,route,evidence_json,created_at) VALUES (?,?,?,?,?,?)", (str(uuid.uuid4()), self.owner_id, conversation_id, "research", json.dumps(answer.get("evidence", {}), ensure_ascii=False), now))
                for source in answer.get("sources", []):
                    if source.get("url"):
                        db.execute("INSERT INTO web_sources(id,owner_id,conversation_id,url,title,published_at,retrieved_at) VALUES (?,?,?,?,?,?,?)", (str(uuid.uuid4()), self.owner_id, conversation_id, source["url"], source["title"], source.get("published_at"), source.get("retrieved_at") or now))
        return conversation_id

    def conversations(self):
        with self.transaction() as db:
            rows = db.execute("SELECT id,title,created_at,updated_at FROM conversations WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100", (self.owner_id,)).fetchall()
        return [dict(row) for row in rows]

    def conversation(self, conversation_id):
        conversation_id = checked_id(conversation_id)
        with self.transaction() as db:
            row = db.execute("SELECT id,title FROM conversations WHERE id=? AND owner_id=?", (checked_id(conversation_id), self.owner_id)).fetchone()
            if not row:
                raise ServiceError("not_found", "المحادثة غير موجودة.", 404)
            messages = db.execute("SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY ordinal DESC LIMIT 300", (conversation_id,)).fetchall()
        return {**dict(row), "messages": [dict(item) for item in reversed(messages)]}

    def delete_conversation(self, conversation_id):
        with self.transaction() as db:
            cursor = db.execute("DELETE FROM conversations WHERE id=? AND owner_id=?", (checked_id(conversation_id), self.owner_id))
        return {"deleted": cursor.rowcount > 0}

    def record_usage(self, answer):
        usage = answer.get("usage") or {}
        with self.transaction() as db:
            db.execute("INSERT INTO usage_metrics(id,owner_id,route,latency_ms,cache_hit,input_tokens,output_tokens,estimated_cost_usd,created_at) VALUES (?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), self.owner_id, answer.get("route", "local"), max(0, answer.get("timing_ms", 0)), int(bool(answer.get("cache_hit"))), usage.get("input_tokens"), usage.get("output_tokens"), usage.get("estimated_cost_usd"), utcnow()))
            # Keep bounded telemetry without retaining question or answer text.
            db.execute("DELETE FROM usage_metrics WHERE owner_id=? AND id NOT IN (SELECT id FROM usage_metrics WHERE owner_id=? ORDER BY created_at DESC LIMIT 10000)", (self.owner_id, self.owner_id))

    def metrics(self):
        with self.transaction() as db:
            row = dict(db.execute("SELECT COUNT(*) AS requests,COALESCE(AVG(latency_ms),0) AS latency_ms,COALESCE(SUM(CASE WHEN route='research' THEN 1 ELSE 0 END),0) AS web_requests,COALESCE(SUM(CASE WHEN route NOT IN ('research','cloud') THEN 1 ELSE 0 END),0) AS local_requests,COALESCE(SUM(cache_hit),0) AS cache_hits FROM usage_metrics WHERE owner_id=?", (self.owner_id,)).fetchone())
            row["memory_items"] = db.execute("SELECT COUNT(*) AS n FROM knowledge_documents WHERE owner_id=?", (self.owner_id,)).fetchone()["n"]
        return row
