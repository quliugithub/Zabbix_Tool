from fastapi import APIRouter, Depends, HTTPException
from dependencies import get_log_store
from utils.response import ok

router = APIRouter(prefix="/api/zabbix", tags=["logs"])


@router.get("/logs")
async def list_logs(limit: int = 10, log_store=Depends(get_log_store)):
    return ok(log_store.list_recent(limit=limit))


@router.get("/logs/{task_id}")
async def get_logs(task_id: str, log_store=Depends(get_log_store)):
    logs = log_store.get(task_id)
    if not logs:
        raise HTTPException(status_code=404, detail="logs not found")
    return ok(logs)
