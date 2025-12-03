from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Iterable


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
            self._ensure_results_table(conn)
            self._ensure_queue_table(conn)
            conn.commit()

    def _ensure_results_table(self, conn: sqlite3.Connection) -> None:
        """Ensure batch_results table exists (for old DBs as well)."""
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS batch_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT,
                item_id TEXT,
                ip TEXT,
                host_id TEXT,
                task_id TEXT,
                status TEXT,
                error TEXT,
                zabbix_url TEXT,
                ts INTEGER
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_batch_results_batch ON batch_results(batch_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_batch_results_item ON batch_results(batch_id, item_id)")

    def _ensure_queue_table(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS batch_queue (
                id TEXT PRIMARY KEY,
                batch_id TEXT,
                host_ids TEXT,
                action TEXT,
                payload TEXT,
                status TEXT,
                error TEXT,
                created INTEGER,
                started INTEGER,
                finished INTEGER
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_batch_queue_status ON batch_queue(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_batch_queue_batch ON batch_queue(batch_id)")

    def has_active_queue(self, batch_id: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            row = conn.execute(
                "SELECT 1 FROM batch_queue WHERE batch_id=? AND status IN ('pending','running') LIMIT 1",
                (batch_id,),
            ).fetchone()
        return bool(row)


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
        # 附带最新结果（如有）
        data["results"] = self.get_results(batch_id=row[0])
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

    def save_results(self, batch_id: str, results: List[Dict[str, Any]]) -> None:
        ts = int(time.time())
        rows = []
        for r in results:
            rows.append(
                (
                    batch_id,
                    str(r.get("item_id")),
                    str(r.get("ip")) if r.get("ip") is not None else None,
                    r.get("host_id"),
                    r.get("task_id"),
                    r.get("status"),
                    r.get("error"),
                    r.get("zabbix_url"),
                    ts,
                )
            )
        if not rows:
            return
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_results_table(conn)
            conn.executemany(
                "INSERT INTO batch_results(batch_id, item_id, ip, host_id, task_id, status, error, zabbix_url, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            # 同步写回 batches.data 中的 hosts（仅补充 host_id，不覆盖其他字段）
            try:
                cur = conn.execute("SELECT data FROM batches WHERE id=?", (batch_id,))
                row = cur.fetchone()
                if row and row[0]:
                    data = json.loads(row[0])
                    hosts = data.get("hosts", [])
                    host_map = {str(r[1]): r[3] for r in rows if r[3]}  # item_id -> host_id
                    if host_map and hosts:
                        for h in hosts:
                            item_id = str(h.get("item_id"))
                            if item_id in host_map and not h.get("host_id"):
                                h["host_id"] = host_map[item_id]
                        conn.execute(
                            "UPDATE batches SET data=? WHERE id=?",
                            (json.dumps({"hosts": hosts}), batch_id),
                        )
            except Exception:
                # ignore sync errors to avoid blocking main flow
                pass
            conn.commit()

    def get_results(self, batch_id: str, host_ids: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        host_filter = set(str(h) for h in host_ids) if host_ids else None
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_results_table(conn)
            rows = conn.execute(
                """
                SELECT br.item_id,
                       br.ip,
                       br.host_id,
                       br.task_id,
                       br.status,
                       br.error,
                       br.zabbix_url,
                       br.ts
                FROM batch_results br
                INNER JOIN (
                    SELECT item_id, MAX(ts) AS max_ts
                    FROM batch_results
                    WHERE batch_id=?
                    GROUP BY item_id
                ) latest
                ON br.item_id = latest.item_id AND br.ts = latest.max_ts
                WHERE br.batch_id=?
                """,
                (batch_id, batch_id),
            ).fetchall()
        return [
            {
                "item_id": r[0],
                "ip": r[1],
                "host_id": r[2],
                "task_id": r[3],
                "status": r[4],
                "error": r[5],
                "zabbix_url": r[6],
                "ts": r[7],
            }
            for r in rows
            if (not host_filter or str(r[0]) in host_filter)
        ]

    # -------------------- Queue helpers -------------------- #
    def enqueue(self, batch_id: str, host_ids: List[str], action: str, payload: Dict[str, Any]) -> str:
        if self.has_active_queue(batch_id):
            raise ValueError("当前批次已有待执行/执行中的任务，请稍候再试")
        qid = uuid.uuid4().hex
        now = int(time.time())
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            conn.execute(
                "INSERT INTO batch_queue(id, batch_id, host_ids, action, payload, status, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (qid, batch_id, json.dumps(host_ids), action, json.dumps(payload), "pending", now),
            )
            conn.commit()
        return qid

    def next_pending(self) -> Optional[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            row = conn.execute(
                "SELECT id, batch_id, host_ids, action, payload, status, created FROM batch_queue WHERE status='pending' ORDER BY created ASC LIMIT 1"
            ).fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "batch_id": row[1],
            "host_ids": json.loads(row[2]) if row[2] else [],
            "action": row[3],
            "payload": json.loads(row[4]) if row[4] else {},
            "status": row[5],
            "created": row[6],
        }

    def start_queue(self, queue_id: str) -> None:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            conn.execute("UPDATE batch_queue SET status='running', started=? WHERE id=?", (int(time.time()), queue_id))
            conn.commit()

    def finish_queue(self, queue_id: str, status: str = "done", error: str | None = None) -> None:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            conn.execute(
                "UPDATE batch_queue SET status=?, error=?, finished=? WHERE id=?",
                (status, error or None, int(time.time()), queue_id),
            )
            conn.commit()

    def get_queue(self, queue_id: str) -> Optional[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            row = conn.execute(
                "SELECT id, batch_id, host_ids, action, payload, status, error, created, started, finished FROM batch_queue WHERE id=?",
                (queue_id,),
            ).fetchone()
        if not row:
            return None
        host_ids = json.loads(row[2]) if row[2] else []
        return {
            "queue_id": row[0],
            "batch_id": row[1],
            "host_ids": host_ids,
            "action": row[3],
            "payload": json.loads(row[4]) if row[4] else {},
            "status": row[5],
            "error": row[6],
            "created": row[7],
            "started": row[8],
            "finished": row[9],
            "results": self.get_results(row[1], host_ids=host_ids) if row[1] else [],
        }

    def cancel_queue(self, queue_id: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            cur = conn.execute(
                "UPDATE batch_queue SET status='cancelled', finished=? WHERE id=? AND status IN ('pending','running')",
                (int(time.time()), queue_id),
            )
            conn.commit()
            return cur.rowcount > 0

    def is_cancelled(self, queue_id: str) -> bool:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            row = conn.execute("SELECT status FROM batch_queue WHERE id=?", (queue_id,)).fetchone()
        return bool(row and row[0] == "cancelled")

    def list_active(self) -> List[Dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_queue_table(conn)
            rows = conn.execute(
                "SELECT id, batch_id, host_ids, action, status, created FROM batch_queue WHERE status IN ('pending','running') ORDER BY created DESC"
            ).fetchall()
        res = []
        for r in rows:
            res.append(
                {
                    "queue_id": r[0],
                    "batch_id": r[1],
                    "host_ids": json.loads(r[2]) if r[2] else [],
                    "action": r[3],
                    "status": r[4],
                    "created": r[5],
                }
            )
        return res

    def delete_batch(self, batch_id: str) -> None:
        with sqlite3.connect(self.db_path) as conn:
            self._ensure_results_table(conn)
            self._ensure_queue_table(conn)
            conn.execute("DELETE FROM batches WHERE id=?", (batch_id,))
            conn.execute("DELETE FROM batch_results WHERE batch_id=?", (batch_id,))
            conn.execute("DELETE FROM batch_queue WHERE batch_id=?", (batch_id,))
            conn.commit()
