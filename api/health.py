from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

from utils.response import ok
from dependencies import BASE_DIR

router = APIRouter()


@router.get("/health")
async def health():
    return ok({"status": "ok"})


@router.get("/")
async def ui():
    index_path = BASE_DIR / "static" / "index.html"
    if not index_path.exists():
        return JSONResponse({"code": 404, "msg": "UI not built", "data": None}, status_code=404)
    return FileResponse(index_path)
