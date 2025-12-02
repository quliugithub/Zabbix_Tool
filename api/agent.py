from __future__ import annotations

import tempfile
from typing import Any

from fastapi import APIRouter, UploadFile, File, BackgroundTasks, Body, Depends, HTTPException
import uuid

from models import InstallRequest, UninstallRequest, BatchInstallRequest, TemplateBindRequest, RegisterRequest
from excel import parse_excel
from dependencies import get_zabbix_service, get_tasks, get_upload_dir, get_log_store, get_batch_store
from utils.response import ok

router = APIRouter(prefix="/api/zabbix", tags=["agent"])


@router.post("/install")
async def install(req: InstallRequest, svc=Depends(get_zabbix_service), log_store=Depends(get_log_store)):
    task_id = uuid.uuid4().hex
    return ok(svc.install_agent(req, task_id=task_id, log_store=log_store) | {"task_id": task_id})


@router.post("/uninstall")
async def uninstall(req: UninstallRequest, svc=Depends(get_zabbix_service), log_store=Depends(get_log_store)):
    task_id = uuid.uuid4().hex
    return ok(svc.uninstall_agent(req, task_id=task_id, log_store=log_store) | {"task_id": task_id})


@router.post("/template")
async def template_action(req: TemplateBindRequest, svc=Depends(get_zabbix_service)):
    if req.action == "bind":
        return ok(svc.bind_template(req))
    return ok(svc.unbind_template(req))


@router.get("/proxies")
async def list_proxies(svc=Depends(get_zabbix_service)):
    return ok(svc.list_proxies())


@router.post("/register")
async def register_host(req: RegisterRequest, svc=Depends(get_zabbix_service), log_store=Depends(get_log_store)):
    task_id = uuid.uuid4().hex
    return ok(svc.register_host(req, task_id=task_id, log_store=log_store) | {"task_id": task_id})


@router.post("/agent/upload")
async def upload_agent(file: UploadFile = File(...), upload_dir=Depends(get_upload_dir)):
    dest = upload_dir / file.filename
    with dest.open("wb") as fh:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            fh.write(chunk)
    download_url = f"/agent-packages/{file.filename}"
    return ok({"filename": file.filename, "url": download_url})


@router.post("/batch")
async def batch_install(
    background_tasks: BackgroundTasks,
    action: str = Body(..., embed=True, pattern="^(install|uninstall)$"),
    servers: BatchInstallRequest | None = None,
    file: UploadFile | None = File(default=None),
    svc=Depends(get_zabbix_service),
    tasks=Depends(get_tasks),
    log_store=Depends(get_log_store),
):
    main_task_id = tasks.create(name=f"zabbix-{action}")

    async def _run():
        try:
            if file:
                with tempfile.NamedTemporaryFile(delete=False, suffix=file.filename) as tmp:
                    tmp.write(await file.read())
                    reqs = parse_excel(tmp.name)
            else:
                if not servers:
                    raise ValueError("servers payload required when no file uploaded")
                reqs = servers.servers
            results: list[Any] = []
            for req in reqs:
                if action == "install":
                    results.append(svc.install_agent(req, task_id=main_task_id, log_store=log_store) | {"task_id": main_task_id})
                else:
                    results.append(
                        svc.uninstall_agent(UninstallRequest(ip=req.ip, hostname=req.hostname), task_id=main_task_id, log_store=log_store)
                        | {"task_id": main_task_id}
                    )
            tasks.update(main_task_id, "done", result=results)
        except Exception as exc:
            tasks.update(main_task_id, "failed", log=str(exc))

    if background_tasks:
        background_tasks.add_task(_run)
    else:
        await _run()
    return ok({"task_id": main_task_id})


@router.post("/batch/upload")
async def batch_upload(file: UploadFile = File(...), batch_store=Depends(get_batch_store)):
    with tempfile.NamedTemporaryFile(delete=False, suffix=file.filename) as tmp:
        tmp.write(await file.read())
        hosts = parse_excel(tmp.name)
    # assign stable ids
    hosts_data = []
    for idx, h in enumerate(hosts):
        item = h.dict()
        item["item_id"] = idx + 1
        hosts_data.append(item)
    saved = batch_store.save(hosts_data, name=file.filename)
    return ok({"batch_id": saved["batch_id"], "ts": saved["ts"], "hosts": hosts_data, "count": len(hosts_data)})


@router.get("/batch/list")
async def batch_list(limit: int = 20, batch_store=Depends(get_batch_store)):
    return ok(batch_store.list_recent(limit=limit))


@router.get("/batch/{batch_id}")
async def batch_get(batch_id: str, batch_store=Depends(get_batch_store)):
    data = batch_store.get(batch_id)
    if not data:
        raise HTTPException(status_code=404, detail="batch not found")
    return ok(data)


@router.post("/batch/run")
async def batch_run(
    payload: Dict[str, Any],
    svc=Depends(get_zabbix_service),
    log_store=Depends(get_log_store),
    batch_store=Depends(get_batch_store),
):
    batch_id = payload.get("batch_id")
    action = payload.get("action", "install")
    host_ids = payload.get("host_ids") or []
    template_ids = payload.get("template_ids") or []
    group_ids = payload.get("group_ids") or []
    proxy_id = payload.get("proxy_id")
    register_server = payload.get("register_server", True)
    precheck = payload.get("precheck", False)
    web_monitor_url = payload.get("web_monitor_url")
    jmx_port = payload.get("jmx_port")

    batch = batch_store.get(batch_id) if batch_id else None
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    hosts = batch.get("hosts", [])
    if host_ids:
        hosts = [h for h in hosts if h.get("item_id") in host_ids or str(h.get("item_id")) in host_ids]
    results = []

    for h in hosts:
        try:
            if action == "uninstall":
                req = UninstallRequest(
                    ip=h["ip"],
                    hostname=h.get("hostname"),
                    ssh_user=h.get("ssh_user"),
                    ssh_password=h.get("ssh_password"),
                    ssh_port=h.get("ssh_port"),
                    proxy_id=proxy_id or h.get("proxy_id"),
                )
                task_id = uuid.uuid4().hex
                res = svc.uninstall_agent(req, task_id=task_id, log_store=log_store)
                res["task_id"] = task_id
            else:
                req = InstallRequest(
                    hostname=h.get("hostname"),
                    ip=h["ip"],
                    os_type=h.get("os_type") or "linux",
                    env=h.get("env"),
                    port=h.get("port") or 10050,
                    ssh_user=h.get("ssh_user"),
                    ssh_password=h.get("ssh_password"),
                    ssh_port=h.get("ssh_port"),
                    visible_name=h.get("visible_name"),
                    template_ids=template_ids or h.get("template_ids") or ([h.get("template_id")] if h.get("template_id") else None),
                    group_ids=group_ids or h.get("group_ids") or ([h.get("group_id")] if h.get("group_id") else None),
                    proxy_id=proxy_id or h.get("proxy_id"),
                    register_server=register_server,
                    precheck=precheck,
                    web_monitor_url=web_monitor_url,
                    jmx_port=jmx_port or h.get("jmx_port"),
                )
                task_id = uuid.uuid4().hex
                res = svc.install_agent(req, task_id=task_id, log_store=log_store)
                res["task_id"] = task_id
            results.append({"item_id": h.get("item_id"), "ip": str(h.get("ip")), "status": "ok", **res})
        except Exception as exc:
            results.append({"item_id": h.get("item_id"), "ip": str(h.get("ip")), "status": "failed", "error": str(exc)})
    return ok({"batch_id": batch_id, "results": results})


@router.get("/batch/template")
async def batch_template():
    csv = "hostname,ip,ssh_password,ssh_user,ssh_port,os_type,env,port,visible_name,jmx_port\nsrv-web-01,192.168.1.100,Password123,root,22,linux,prod,10050,,10052\n"
    return ok({"filename": "zabbix_batch_template.csv", "content": csv})


@router.get("/tasks/{task_id}")
async def task_status(task_id: str, tasks=Depends(get_tasks)):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")
    return ok(task)
