from pathlib import Path
import sys
from typing import Generator

from settings import get_settings
from db_config import ConfigStore
from service import ZabbixService
from tasks import TaskStore
from log_store import LogStore
from batch_store import BatchStore
from batch_worker import BatchWorker
import sqlite3

SETTINGS = get_settings()
def _resolve_base_dir() -> Path:
    """Resolve runtime base dir; supports PyInstaller (_MEIPASS) packaging."""
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        return Path(bundle_dir)
    return Path(__file__).resolve().parent


BASE_DIR = _resolve_base_dir()

upload_cfg = Path(SETTINGS.agent_upload_dir)
if not upload_cfg.is_absolute():
    upload_cfg = BASE_DIR / upload_cfg
UPLOAD_DIR = upload_cfg
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = BASE_DIR / "data.db"
LEGACY_DBS = {
    "config": BASE_DIR / "config.db",
    "logs": BASE_DIR / "logs.db",
    "batches": BASE_DIR / "batches.db",
}


def _migrate_legacy_dbs():
    # 如果新库已存在或没有旧库，跳过
    if DB_PATH.exists():
        return
    if not any(p.exists() for p in LEGACY_DBS.values()):
        return

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 先创建目标库的表结构
    ConfigStore(DB_PATH, defaults=SETTINGS)
    LogStore(DB_PATH)
    BatchStore(DB_PATH)

    def copy_table(src: Path, table: str):
        if not src.exists():
            return
        try:
            with sqlite3.connect(DB_PATH) as dest:
                dest.execute(f"ATTACH DATABASE '{src}' AS legacy")
                dest.execute(f"INSERT OR REPLACE INTO {table} SELECT * FROM legacy.{table}")
                dest.execute("DETACH DATABASE legacy")
                dest.commit()
        except Exception:
            # 兼容缺表或旧格式，不阻塞启动
            pass

    copy_table(LEGACY_DBS["config"], "config")
    copy_table(LEGACY_DBS["logs"], "install_logs")
    for tbl in ["batches", "batch_results", "batch_queue"]:
        copy_table(LEGACY_DBS["batches"], tbl)


_migrate_legacy_dbs()

CONFIG_STORE = ConfigStore(DB_PATH, defaults=SETTINGS)
ZABBIX_SERVICE = ZabbixService(config_store=CONFIG_STORE)
TASKS = TaskStore()
LOG_STORE = LogStore(DB_PATH)
BATCH_STORE = BatchStore(DB_PATH)
BATCH_WORKER = BatchWorker(ZABBIX_SERVICE, LOG_STORE, BATCH_STORE)


def get_settings_dep():
    return SETTINGS


def get_config_store():
    return CONFIG_STORE


def get_zabbix_service():
    return ZABBIX_SERVICE


def get_tasks():
    return TASKS


def get_upload_dir() -> Path:
    return UPLOAD_DIR


def get_log_store():
    return LOG_STORE


def get_batch_store():
    return BATCH_STORE

def get_batch_worker():
    return BATCH_WORKER
