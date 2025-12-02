from __future__ import annotations

import logging
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from api import health, config, agent, template, logs
from dependencies import UPLOAD_DIR

logging.basicConfig(level=logging.INFO)
LOG = logging.getLogger(__name__)

app = FastAPI(title="Zabbix Agent Service", version="0.1.0")
app.mount("/agent-packages", StaticFiles(directory=str(UPLOAD_DIR)), name="agent-packages")
app.mount("/static", StaticFiles(directory="static"), name="static")

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
