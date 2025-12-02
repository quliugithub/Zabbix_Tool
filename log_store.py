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
                    host_id TEXT,
                    zabbix_url TEXT,
                    ts INTEGER
                )
                """
            )
            # 兼容旧库，补齐 host_id / zabbix_url 列
            cols = [row[1] for row in conn.execute("PRAGMA table_info(install_logs)").fetchall()]
            if "host_id" not in cols:
                conn.execute("ALTER TABLE install_logs ADD COLUMN host_id TEXT")
            if "zabbix_url" not in cols:
                conn.execute("ALTER TABLE install_logs ADD COLUMN zabbix_url TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_task ON install_logs(task_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_host ON install_logs(host_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_logs_url ON install_logs(zabbix_url)")
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
        host_id: str | None = None,
        zabbix_url: str | None = None,
    ) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO install_logs(task_id, name, step, status, message, ip, hostname, host_id, zabbix_url, ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (task_id, name, step, status, message, ip, hostname, host_id, zabbix_url, int(time.time())),
            )
            conn.commit()

    def get(self, task_id: str) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT task_id, step, status, message, ip, hostname, host_id, zabbix_url, ts FROM install_logs WHERE task_id=? ORDER BY id",
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
                "host_id": r[6],
                "zabbix_url": r[7],
                "ts": r[8],
            }
            for r in rows
        ]

    def list_recent(self, limit: int = 50, hostname: str | None = None, ip: str | None = None, host_id: str | None = None, zabbix_url: str | None = None) -> List[Dict[str, Any]]:
        """Return recent task summaries (one row per task_id), optionally filtered by hostname/ip/host_id/zabbix_url."""
        where = []
        params = []
        if hostname:
            where.append("hostname = ?")
            params.append(hostname)
        if ip:
            where.append("ip = ?")
            params.append(ip)
        if host_id:
            where.append("host_id = ?")
            params.append(host_id)
        if zabbix_url:
            where.append("zabbix_url = ?")
            params.append(zabbix_url)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        params.append(limit)
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                f"""
                SELECT task_id,
                       MAX(ts) as ts,
                       MAX(ip) as ip,
                       MAX(hostname) as hostname,
                       MAX(host_id) as host_id,
                       MAX(zabbix_url) as zabbix_url
                FROM install_logs
                {where_sql}
                GROUP BY task_id
                ORDER BY ts DESC
                LIMIT ?
                """,
                tuple(params),
            ).fetchall()
        return [
            {"task_id": r[0], "ts": r[1], "ip": r[2], "hostname": r[3], "host_id": r[4], "zabbix_url": r[5]}
            for r in rows
        ]
