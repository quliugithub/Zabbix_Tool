from __future__ import annotations

import logging
import threading
import time
import webbrowser
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import sys
import http.client

from api import health, config, agent, template, logs
from core.dependencies import UPLOAD_DIR, BASE_DIR
from core.settings import get_settings


# ------------- Logging to file (no console) ------------- #
LOG_PATH = Path(getattr(sys, "frozen", False) and Path(sys.executable).parent or Path(".")).resolve() / "run.log"
logging.basicConfig(
    level=logging.INFO,
    filename=str(LOG_PATH),
    filemode="a",
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    encoding="utf-8",
)
# Add console output too
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
logging.getLogger().addHandler(console_handler)

LOG = logging.getLogger(__name__)
settings = get_settings()

app = FastAPI(title="Zabbix Agent Service", version="0.1.0")
app.mount("/agent-packages", StaticFiles(directory=str(UPLOAD_DIR)), name="agent-packages")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

app.include_router(health.router)
app.include_router(config.router)
app.include_router(agent.router)
app.include_router(template.router)
app.include_router(logs.router)


@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.status_code, "msg": str(exc.detail), "data": None},
    )


@app.exception_handler(Exception)
async def generic_exc_handler(request: Request, exc: Exception):
    LOG.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"code": 500, "msg": str(exc), "data": None})


if __name__ == "__main__":
    # Allow running packaged exe directly; keep process alive by starting uvicorn
    import uvicorn
    import asyncio

    def server_alive(host: str, port: int) -> bool:
        try:
            conn = http.client.HTTPConnection(host, port, timeout=1.5)
            conn.request("GET", "/health")
            resp = conn.getresponse()
            return 200 <= resp.status < 500
        except Exception:
            return False

    def _open_browser():
        try:
            time.sleep(1)
            host = getattr(settings, "listen_host", "127.0.0.1") or "127.0.0.1"
            port = getattr(settings, "listen_port", 8000) or 8000
            webbrowser.open(f"http://{host}:{port}/")
        except Exception:
            LOG.exception("failed to open browser")

    host = getattr(settings, "listen_host", "127.0.0.1") or "127.0.0.1"
    port = getattr(settings, "listen_port", 8000) or 8000

    # If already running (port alive), just open browser and exit
    if server_alive(host, port):
        webbrowser.open(f"http://{host}:{port}/")
        sys.exit(0)

    threading.Thread(target=_open_browser, daemon=True).start()

    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())  # type: ignore[attr-defined]
    except Exception:
        pass

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
        log_config=None,  # avoid default TTY-based formatter when running headless
    )
