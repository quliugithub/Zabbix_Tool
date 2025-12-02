from typing import Dict, Any

from fastapi import APIRouter, Depends

from dependencies import get_config_store
from utils.response import ok

router = APIRouter(prefix="/api/zabbix", tags=["config"])


@router.get("/config")
async def get_config(config_store=Depends(get_config_store)):
    return ok(config_store.get())


@router.put("/config")
async def save_config(payload: Dict[str, Any], config_store=Depends(get_config_store)):
    allowed = {
        "zabbix_api_base",
        "zabbix_api_token",
        "zabbix_api_user",
        "zabbix_api_password",
        "agent_install_dir",
        "project_name",
        "zabbix_version",
        "zabbix_server_host",
        "local_agent_path",
    }
    data = {k: v for k, v in payload.items() if k in allowed}
    return ok(config_store.set(data))
