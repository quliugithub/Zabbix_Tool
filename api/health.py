from pathlib import Path
import os
from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from utils.response import ok
from dependencies import BASE_DIR
from settings import get_settings

router = APIRouter()
settings = get_settings()


@router.get("/health")
async def health():
    return ok({"status": "ok"})


@router.post("/shutdown")
async def shutdown(x_token: str = Header(default="")):
    if x_token != settings.shutdown_token:
        raise HTTPException(status_code=401, detail="unauthorized")
    # 立即退出进程
    os._exit(0)


@router.get("/")
async def ui():
    index_path = BASE_DIR / "static" / "index.html"
    if not index_path.exists():
        return JSONResponse({"code": 404, "msg": "UI not built", "data": None}, status_code=404)
    return FileResponse(index_path)
