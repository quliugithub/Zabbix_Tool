from typing import Dict, Any

from fastapi import APIRouter, Depends, HTTPException
import httpx

from core.dependencies import get_config_store
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


@router.post("/config/test")
async def test_config(payload: Dict[str, Any]):
    """
    Test Zabbix API connectivity with provided credentials (not persisted).
    """
    url = (payload.get("zabbix_api_base") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="zabbix_api_base required")
    token = payload.get("zabbix_api_token")
    user = payload.get("zabbix_api_user")
    password = payload.get("zabbix_api_password")

    def _call(method: str, params: Any, auth: str | None = None):
        body = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
        if auth:
            body["auth"] = auth
        try:
            with httpx.Client(timeout=10.0, verify=False) as client:
                resp = client.post(url, json=body)
                resp.raise_for_status()
                data = resp.json()
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"request failed: {exc}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"non-JSON response: {exc}") from exc
        if "error" in data:
            raise HTTPException(status_code=401, detail=f"zabbix error: {data['error']}")
        return data.get("result")

    # basic reachability
    version = _call("apiinfo.version", [])

    # auth test
    auth_token = token
    if not auth_token and user and password:
        auth_token = _call("user.login", {"user": user, "password": password})
    if auth_token:
        _call("template.get", {"output": ["templateid"], "limit": 1}, auth=auth_token)

    return ok({"reachable": True, "version": version})
