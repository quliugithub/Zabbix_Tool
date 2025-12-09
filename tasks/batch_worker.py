from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

from schemas.models import InstallRequest, UninstallRequest, RegisterRequest
from core.settings import get_settings


class BatchWorker:
    """Background worker to process queued batch install/uninstall tasks."""

    def __init__(self, svc, log_store, batch_store):
        self.svc = svc
        self.log_store = log_store
        self.batch_store = batch_store
        self.settings = get_settings()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2)

    def _loop(self):
        while not self._stop.is_set():
            task = self.batch_store.next_pending()
            if not task:
                time.sleep(2)
                continue
            try:
                if self.batch_store.is_cancelled(task["id"]):
                    self.batch_store.finish_queue(task["id"], status="cancelled", error="用户取消")
                    continue
                self._process_queue(task)
            except Exception as exc:
                # Best-effort logging to console/file
                import logging

                logging.getLogger(__name__).exception("batch queue task failed: %s", exc)

    def _process_queue(self, task: Dict[str, Any]):
        qid = task["id"]
        self.batch_store.start_queue(qid)
        payload = task.get("payload", {})
        action = task.get("action", "install")
        host_ids = task.get("host_ids") or []
        batch = self.batch_store.get(task.get("batch_id"))
        if not batch:
            self.batch_store.finish_queue(qid, status="failed", error="batch not found")
            return
        hosts = batch.get("hosts", [])
        if host_ids:
            host_ids_set = {str(h) for h in host_ids}
            hosts = [h for h in hosts if str(h.get("item_id")) in host_ids_set]

        template_ids = payload.get("template_ids") or []
        group_ids = payload.get("group_ids") or []
        proxy_id = payload.get("proxy_id")
        register_server = payload.get("register_server", True)
        register_only = payload.get("register_only", False)
        precheck = payload.get("precheck", False)
        web_monitor_urls = payload.get("web_monitor_urls") or []
        web_monitor_url = payload.get("web_monitor_url")
        jmx_port = payload.get("jmx_port")

        max_workers = max(1, getattr(self.settings, "batch_concurrency", 5))
        executor = ThreadPoolExecutor(max_workers=max_workers)

        def run_host(h: Dict[str, Any]) -> Dict[str, Any]:
            import uuid

            task_id = uuid.uuid4().hex
            # 先写入 installing 状态，便于前端刷新可见
            try:
                self.batch_store.save_results(task["batch_id"], [{
                    "item_id": h.get("item_id"),
                    "ip": str(h.get("ip")),
                    "host_id": None,
                    "task_id": task_id,
                    "status": "installing",
                    "error": None,
                    "zabbix_url": getattr(self.settings, "zabbix_api_base", None),
                }])
            except Exception:
                pass

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
                    res = self.svc.uninstall_agent(req, task_id=task_id, log_store=self.log_store)
                    res["task_id"] = task_id
                else:
                    def _normalize_urls(val):
                        if not val:
                            return []
                        if isinstance(val, str):
                            parts = val.replace("\n", ";").replace(",", ";").split(";")
                            return [p.strip() for p in parts if p.strip()]
                        urls = []
                        for x in val if isinstance(val, (list, tuple, set)) else [val]:
                            if isinstance(x, str):
                                urls.extend([p.strip() for p in x.replace("\n", ";").replace(",", ";").split(";") if p.strip()])
                            else:
                                urls.append(str(x))
                        return urls

                    host_urls = h.get("web_monitor_urls") or h.get("web_monitor_url")
                    urls = _normalize_urls(host_urls) or _normalize_urls(web_monitor_urls) or _normalize_urls(web_monitor_url)
                    if register_only:
                        req = RegisterRequest(
                            hostname=h.get("hostname"),
                            visible_name=h.get("visible_name"),
                            ip=h["ip"],
                            port=h.get("port") or 10050,
                            template_ids=template_ids or h.get("template_ids") or ([h.get("template_id")] if h.get("template_id") else None),
                            group_ids=group_ids or h.get("group_ids") or ([h.get("group_id")] if h.get("group_id") else None),
                            proxy_id=proxy_id or h.get("proxy_id"),
                            web_monitor_urls=urls,
                            web_monitor_url=urls[0] if urls else None,
                            jmx_port=jmx_port or h.get("jmx_port"),
                        )
                        res = self.svc.register_host(req, task_id=task_id, log_store=self.log_store)
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
                            web_monitor_urls=urls,
                            web_monitor_url=urls[0] if urls else None,
                            jmx_port=jmx_port or h.get("jmx_port"),
                        )
                        res = self.svc.install_agent(req, task_id=task_id, log_store=self.log_store)
                        res["task_id"] = task_id
                host_id = res.get("host_id")
                return {
                    "item_id": h.get("item_id"),
                    "ip": str(h.get("ip")),
                    "status": "ok",
                    **res,
                    **({"host_id": host_id} if host_id else {}),
                }
            except Exception as exc:
                return {"item_id": h.get("item_id"), "ip": str(h.get("ip")), "status": "failed", "error": str(exc), "task_id": task_id}

        futures = [executor.submit(run_host, h) for h in hosts]
        results: List[Dict[str, Any]] = []
        for f in futures:
            if self.batch_store.is_cancelled(qid):
                break
            results.append(f.result())
        executor.shutdown(wait=False)
        try:
            self.batch_store.save_results(task["batch_id"], results)
            if self.batch_store.is_cancelled(qid):
                # 将未完成的主机标记为 failed: cancelled
                pending_hosts = [h for h in hosts if not any(str(r.get("item_id")) == str(h.get("item_id")) for r in results)]
                if pending_hosts:
                    # 尝试复用已有 task_id（之前写入的 installing 记录）
                    existing_latest = {str(r.get("item_id")): r.get("task_id") for r in self.batch_store.get_results(task["batch_id"], host_ids=[h.get("item_id") for h in pending_hosts])}
                    cancel_rows = []
                    for h in pending_hosts:
                        item_id = str(h.get("item_id"))
                        cancel_rows.append({
                            "item_id": item_id,
                            "ip": str(h.get("ip")),
                            "host_id": None,
                            "task_id": existing_latest.get(item_id),
                            "status": "failed",
                            "error": "cancelled",
                            "zabbix_url": getattr(self.settings, "zabbix_api_base", None),
                        })
                    self.batch_store.save_results(task["batch_id"], cancel_rows)
                self.batch_store.finish_queue(qid, status="cancelled", error="用户取消")
            else:
                self.batch_store.finish_queue(qid, status="done")
        except Exception as exc:
            self.batch_store.finish_queue(qid, status="failed", error=str(exc))
