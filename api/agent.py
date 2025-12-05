from __future__ import annotations

import tempfile
from typing import Any, Dict

from fastapi import APIRouter, UploadFile, File, BackgroundTasks, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse
import uuid

from models import InstallRequest, UninstallRequest, BatchInstallRequest, TemplateBindRequest, RegisterRequest
from excel import parse_excel
from dependencies import get_zabbix_service, get_tasks, get_upload_dir, get_log_store, get_batch_store
from settings import get_settings
from utils.response import ok

router = APIRouter(prefix="/api/zabbix", tags=["agent"])
settings = get_settings()


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
        # 将模型转换为纯 dict，并把 IP 等字段转为字符串，避免 JSON 序列化错误
        item = h.dict()
        if "ip" in item:
            item["ip"] = str(item["ip"])
        item["item_id"] = idx + 1
        hosts_data.append(item)
    saved = batch_store.save(hosts_data, name=file.filename)
    return ok({"batch_id": saved["batch_id"], "ts": saved["ts"], "hosts": hosts_data, "count": len(hosts_data)})


@router.post("/batch/save")
async def batch_save(payload: dict = Body(...), batch_store=Depends(get_batch_store)):
    name = (payload.get("name") or "").strip()
    hosts = payload.get("hosts") or []
    batch_id = payload.get("batch_id") or None

    if not name:
        raise HTTPException(status_code=400, detail="batch name required")
    if not hosts:
        raise HTTPException(status_code=400, detail="hosts required")

    existing = batch_store.get_by_name(name)
    if existing and existing.get("batch_id") != batch_id:
        raise HTTPException(status_code=400, detail="batch name exists")

    for idx, h in enumerate(hosts, 1):
        if "item_id" not in h:
            h["item_id"] = idx

    saved = batch_store.save(hosts, name=name, batch_id=batch_id)
    return ok({"batch_id": saved["batch_id"], "ts": saved["ts"], "name": name, "count": len(hosts), "hosts": hosts})


@router.get("/batch/list")
async def batch_list(limit: int = 20, batch_store=Depends(get_batch_store)):
    return ok(batch_store.list_recent(limit=limit))


@router.get("/batch/{batch_id}")
async def batch_get(batch_id: str, batch_store=Depends(get_batch_store)):
    data = batch_store.get(batch_id)
    if not data:
        raise HTTPException(status_code=404, detail="batch not found")
    return ok(data)


@router.delete("/batch/{batch_id}")
async def batch_delete(batch_id: str, batch_store=Depends(get_batch_store)):
    batch_store.delete_batch(batch_id)
    return ok({"deleted": True, "batch_id": batch_id})


@router.post("/batch/run")
async def batch_run(
    payload: Dict[str, Any] = Body(...),
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
    web_monitor_urls = payload.get("web_monitor_urls")
    jmx_port = payload.get("jmx_port")

    batch = batch_store.get(batch_id) if batch_id else None
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    hosts = batch.get("hosts", [])
    if host_ids:
        hosts = [h for h in hosts if h.get("item_id") in host_ids or str(h.get("item_id")) in host_ids]
    q_payload = {
        "template_ids": template_ids,
        "group_ids": group_ids,
        "proxy_id": proxy_id,
        "register_server": register_server,
        "precheck": precheck,
        "web_monitor_url": web_monitor_url,
        "web_monitor_urls": web_monitor_urls,
        "jmx_port": jmx_port,
    }
    try:
        queue_id = batch_store.enqueue(batch_id, [str(i) for i in host_ids], action, q_payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ok({"queue_id": queue_id, "batch_id": batch_id, "status": "pending"})


@router.get("/batch/template/download")
async def batch_template():
    """直接下载 Excel 模板文件，避免乱码。"""
    from openpyxl import Workbook
    import io

    wb = Workbook()
    ws = wb.active
    headers = ["hostname", "ip", "visible_name", "ssh_user", "ssh_password", "ssh_port", "port", "jmx_port"]
    sample = ["srv-web-01", "192.168.1.100", "", "root", "Password123", 22, 10050, 10052]
    ws.append(headers)
    ws.append(sample)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="zabbix_batch_template.xlsx"'},
    )


@router.get("/tasks/{task_id}")
async def task_status(task_id: str, tasks=Depends(get_tasks)):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="task not found")
    return ok(task)


@router.get("/batch/queue/active")
async def batch_queue_active(batch_store=Depends(get_batch_store)):
    return ok(batch_store.list_active())


@router.get("/batch/queue/{queue_id}")
async def batch_queue_status(queue_id: str, batch_store=Depends(get_batch_store)):
    data = batch_store.get_queue(queue_id)
    if not data:
        raise HTTPException(status_code=404, detail="queue task not found")
    return ok(data)


@router.post("/batch/queue/{queue_id}/cancel")
async def batch_queue_cancel(queue_id: str, batch_store=Depends(get_batch_store)):
    ok_cancel = batch_store.cancel_queue(queue_id)
    if not ok_cancel:
        raise HTTPException(status_code=400, detail="queue not found or already completed")
    return ok({"queue_id": queue_id, "status": "cancelled"})
