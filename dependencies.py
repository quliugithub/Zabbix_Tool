from pathlib import Path
from typing import Generator

from settings import get_settings
from db_config import ConfigStore
from service import ZabbixService
from tasks import TaskStore
from log_store import LogStore
from batch_store import BatchStore
from batch_worker import BatchWorker

SETTINGS = get_settings()
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = Path(SETTINGS.agent_upload_dir)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

CONFIG_STORE = ConfigStore(BASE_DIR / "config.db", defaults=SETTINGS)
ZABBIX_SERVICE = ZabbixService(config_store=CONFIG_STORE)
TASKS = TaskStore()
LOG_STORE = LogStore(BASE_DIR / "logs.db")
BATCH_STORE = BatchStore(BASE_DIR / "batches.db")
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
