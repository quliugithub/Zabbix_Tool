from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import List, Dict, Any


class LogStore:
    """SQLite-based install/uninstall log storage."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS install_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT,
                    name TEXT,
                    step TEXT,
                    status TEXT,
                    message TEXT,
                    ip TEXT,
                    hostname TEXT,
                    ts INTEGER
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_task ON install_logs(task_id)")
            conn.commit()

    def add(
        self,
        task_id: str,
        step: str,
        status: str,
        message: str,
        name: str | None = None,
        ip: str | None = None,
        hostname: str | None = None,
    ) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO install_logs(task_id, name, step, status, message, ip, hostname, ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (task_id, name, step, status, message, ip, hostname, int(time.time())),
            )
            conn.commit()

    def get(self, task_id: str) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT task_id, step, status, message, ip, hostname, ts FROM install_logs WHERE task_id=? ORDER BY id",
                (task_id,),
            ).fetchall()
        return [
            {
                "task_id": r[0],
                "step": r[1],
                "status": r[2],
                "message": r[3],
                "ip": r[4],
                "hostname": r[5],
                "ts": r[6],
            }
            for r in rows
        ]

    def list_recent(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Return recent task summaries (one row per task_id)."""
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT task_id,
                       MAX(ts) as ts,
                       MAX(ip) as ip,
                       MAX(hostname) as hostname
                FROM install_logs
                GROUP BY task_id
                ORDER BY ts DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {"task_id": r[0], "ts": r[1], "ip": r[2], "hostname": r[3]}
            for r in rows
        ]
