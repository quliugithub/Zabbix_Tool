from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Dict, Any

from settings import Settings, get_settings


class ConfigStore:
    """SQLite-based key/value store for Zabbix server配置."""

    def __init__(self, db_path: Path, defaults: Settings | None = None):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.defaults = defaults or get_settings()
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)"
            )
            conn.commit()

    def get(self) -> Dict[str, Any]:
        cfg: Dict[str, Any] = {
            "zabbix_api_base": self.defaults.zabbix_api_base,
            "zabbix_api_token": self.defaults.zabbix_api_token,
            "zabbix_api_user": getattr(self.defaults, "zabbix_api_user", None),
            "zabbix_api_password": getattr(self.defaults, "zabbix_api_password", None),
            "default_template_id": self.defaults.default_template_id,
            "default_group_id": self.defaults.default_group_id,
            "zabbix_version": getattr(self.defaults, "zabbix_version", None),
            "zabbix_server_host": self.defaults.zabbix_server_host,
            "agent_tgz_url": self.defaults.agent_tgz_url,
            "local_agent_path": None,
        }
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT key, value FROM config").fetchall()
        for k, v in rows:
            try:
                cfg[k] = json.loads(v)
            except Exception:
                cfg[k] = v
        return cfg

    def set(self, data: Dict[str, Any]) -> Dict[str, Any]:
        with sqlite3.connect(self.db_path) as conn:
            for k, v in data.items():
                conn.execute(
                    "REPLACE INTO config(key, value) VALUES (?, ?)", (k, json.dumps(v))
                )
            conn.commit()
        return self.get()
