from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List


class BatchStore:
    """SQLite store for uploaded batch host data."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY,
                    ts INTEGER,
                    name TEXT,
                    data TEXT
                )
                """
            )
            conn.commit()

    def save(self, hosts: List[Dict[str, Any]], name: str | None = None, batch_id: str | None = None) -> Dict[str, Any]:
        batch_id = batch_id or uuid.uuid4().hex
        ts = int(time.time())
        record = {"hosts": hosts}
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "REPLACE INTO batches(id, ts, name, data) VALUES (?, ?, ?, ?)",
                (batch_id, ts, name or "", json.dumps(record)),
            )
            conn.commit()
        return {"batch_id": batch_id, "ts": ts, "count": len(hosts)}

    def list_recent(self, limit: int = 20) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, ts, name, data FROM batches ORDER BY ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        result: List[Dict[str, Any]] = []
        for row in rows:
            try:
                data = json.loads(row[3]) if row[3] else {}
                count = len(data.get("hosts", []))
            except Exception:
                count = 0
            result.append({"batch_id": row[0], "ts": row[1], "name": row[2], "count": count})
        return result

    def get(self, batch_id: str) -> Dict[str, Any] | None:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT id, ts, name, data FROM batches WHERE id=?", (batch_id,)).fetchone()
        if not row:
            return None
        try:
            data = json.loads(row[3]) if row[3] else {}
        except Exception:
            data = {}
        data.setdefault("hosts", [])
        data["batch_id"] = row[0]
        data["ts"] = row[1]
        data["name"] = row[2]
        return data

    def get_by_name(self, name: str) -> Dict[str, Any] | None:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT id, ts, name, data FROM batches WHERE name=?", (name,)).fetchone()
        if not row:
            return None
        try:
            data = json.loads(row[3]) if row[3] else {}
        except Exception:
            data = {}
        data.setdefault("hosts", [])
        data["batch_id"] = row[0]
        data["ts"] = row[1]
        data["name"] = row[2]
        return data
