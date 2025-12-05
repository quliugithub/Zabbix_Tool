from __future__ import annotations

import logging
import os
from pathlib import Path
from urllib.parse import urlparse
import uuid
from typing import List, Any, Dict, Optional

import httpx
import paramiko
from fastapi import HTTPException

from models import (
    InstallRequest,
    UninstallRequest,
    TemplateBindRequest,
    TemplateDeleteRequest,
    GroupDeleteRequest,
    TemplateCreateRequest,
    TemplateUpdateRequest,
)
from settings import get_settings
from db_config import ConfigStore

LOG = logging.getLogger(__name__)
settings = get_settings()


class ZabbixService:
    """High-level operations for agent install/uninstall and template binding."""

    def __init__(self, config_store: ConfigStore | None = None):
        self.client = httpx.Client(timeout=20.0, verify=False)
        self.config_store = config_store or ConfigStore(Path("config.db"), defaults=settings)

    def _iter_web_urls(self, req) -> List[str]:
        """Normalize incoming web monitor URLs (single string, list, or delimited string)."""
        raw_list = getattr(req, "web_monitor_urls", None)
        single = getattr(req, "web_monitor_url", None)
        urls: List[str] = []

        def _add(val):
            if not val:
                return
            if isinstance(val, str):
                parts = (
                    val.replace("\n", ";")
                    .replace(",", ";")
                    .split(";")
                )
                urls.extend([p.strip() for p in parts if p.strip()])
            elif isinstance(val, (list, tuple, set)):
                for item in val:
                    _add(item)
            else:
                urls.append(str(val))

        _add(raw_list)
        _add(single)
        # 去重但保留顺序
        deduped: List[str] = []
        seen = set()
        for u in urls:
            if u not in seen:
                seen.add(u)
                deduped.append(u)
        return deduped

    # --------------------------- Public APIs --------------------------- #
    def install_agent(self, req: InstallRequest, task_id: str | None = None, log_store=None) -> dict:
        cfg = self.config_store.get()
        zabbix_url = cfg.get("zabbix_api_base") or settings.zabbix_api_base
        if req.os_type.lower() != "linux":
            raise HTTPException(status_code=400, detail="Only linux install supported in this version")
        resolved_host = req.hostname
        if not resolved_host:
            try:
                resolved_host = self._probe_hostname(req)
            except Exception as exc:
                LOG.warning("auto hostname probe failed for %s: %s", req.ip, exc)
                resolved_host = str(req.ip)
        # 如果探测/传入的是 localhost，则回退为 IP
        if resolved_host and resolved_host.lower() in {"localhost", "localhost.localdomain"}:
            resolved_host = str(req.ip)
        visible = req.visible_name or resolved_host
        req = req.copy(update={"hostname": resolved_host, "visible_name": visible})

        # 先注册/获取 host_id，便于后续日志和过滤
        host_id = None
        if getattr(req, "register_server", True):
            try:
                host_id = self._ensure_host(req)
                if log_store and task_id:
                    log_store.add(
                        task_id,
                        "ensure_host",
                        "ok",
                        f"host ensured id={host_id}",
                        ip=str(req.ip),
                        hostname=req.hostname,
                        host_id=host_id,
                        zabbix_url=zabbix_url,
                    )
            except Exception as exc:
                if log_store and task_id:
                    log_store.add(
                        task_id,
                        "ensure_host",
                        "failed",
                        str(exc),
                        ip=str(req.ip),
                        hostname=req.hostname,
                        host_id=None,
                        zabbix_url=zabbix_url,
                    )
                raise

        steps, rollback, preupload, remote_tmp = self._linux_install_steps(req)
        log = self._run_steps(
            req.ip,
            steps,
            rollback_script=rollback,
            ssh_opts=req,
            preupload_local_path=preupload,
            remote_tmp=remote_tmp,
            task_id=task_id,
            log_store=log_store,
            hostname=req.hostname,
            host_id=host_id,
            zabbix_url=zabbix_url,
        )

        if getattr(req, "register_server", True):
            # 模板绑定 / Web 监控等仍在安装后执行
            if req.template_ids or req.template_id or settings.default_template_id:
                bind_req = TemplateBindRequest(
                    ip=req.ip,
                    template_id=req.template_id,
                    template_ids=req.template_ids,
                    action="bind",
                )
                try:
                    bind_res = self.bind_template(bind_req)
                    if log_store and task_id:
                        log_store.add(
                            task_id,
                            "bind_template",
                            "ok",
                            f"templates bound: {bind_res.get('template_ids')}",
                            ip=str(req.ip),
                            hostname=req.hostname,
                            host_id=host_id,
                            zabbix_url=zabbix_url,
                        )
                except Exception as exc:
                    if log_store and task_id:
                        log_store.add(
                            task_id,
                            "bind_template",
                            "failed",
                            str(exc),
                            ip=str(req.ip),
                            hostname=req.hostname,
                            host_id=host_id,
                            zabbix_url=zabbix_url,
                        )
                    raise
            web_urls = self._iter_web_urls(req)
            for url in web_urls:
                try:
                    wid = self._ensure_web_monitor(host_id, url)
                    if log_store and task_id:
                        log_store.add(
                            task_id,
                            "web_monitor",
                            "ok",
                            f"web scenario ensured id={wid} url={url}",
                            ip=str(req.ip),
                            hostname=req.hostname,
                            host_id=host_id,
                            zabbix_url=zabbix_url,
                        )
                except Exception as exc:
                    if log_store and task_id:
                        log_store.add(task_id, "web_monitor", "failed", str(exc), ip=str(req.ip), hostname=req.hostname, host_id=host_id, zabbix_url=zabbix_url)
                    raise
        else:
            if log_store and task_id:
                log_store.add(
                    task_id,
                    "ensure_host",
                    "warn",
                    "skipped server registration (register_server=false)",
                    ip=str(req.ip),
                    hostname=req.hostname,
                    host_id=host_id,
                    zabbix_url=zabbix_url,
                )
        return {"host_id": host_id, "ip": str(req.ip), "status": "installed", "log": log, "hostname": req.hostname, "zabbix_url": zabbix_url}

    def uninstall_agent(self, req: UninstallRequest, task_id: str | None = None, log_store=None) -> dict:
        cfg = self.config_store.get()
        zabbix_url = cfg.get("zabbix_api_base") or settings.zabbix_api_base
        host_key = req.hostname or str(req.ip)
        host = self._get_host(host_key, getattr(req, "proxy_id", None))
        host_id = host["hostid"] if host else None
        resolved_hostname = req.hostname or (host.get("host") if host else None)
        log = self._run_steps(
            req.ip,
            self._linux_uninstall_steps(),
            rollback_script=None,
            ssh_opts=req,
            task_id=task_id,
            log_store=log_store,
            hostname=resolved_hostname,
            host_id=host_id,
            zabbix_url=zabbix_url,
        )
        if host:
            self._zbx("host.delete", [host["hostid"]])
        return {"ip": str(req.ip), "status": "uninstalled", "log": log, "host_id": host_id, "hostname": resolved_hostname, "zabbix_url": zabbix_url}

    def register_host(self, req, task_id: str | None = None, log_store=None) -> dict:
        cfg = self.config_store.get()
        zabbix_url = cfg.get("zabbix_api_base") or settings.zabbix_api_base
        resolved_host = getattr(req, "hostname", None) or str(req.ip)
        req = req.copy(update={"hostname": resolved_host}) if hasattr(req, "copy") else req
        host_id = self._ensure_host(req)
        if log_store and task_id:
            log_store.add(
                task_id,
                "ensure_host",
                "ok",
                f"host ensured id={host_id}",
                ip=str(req.ip),
                hostname=getattr(req, "hostname", None),
                host_id=host_id,
                zabbix_url=zabbix_url,
            )
        if getattr(req, "template_ids", None) or getattr(req, "template_id", None) or settings.default_template_id:
            bind_req = TemplateBindRequest(
                ip=req.ip,
                template_id=getattr(req, "template_id", None),
                template_ids=getattr(req, "template_ids", None),
                action="bind",
            )
            try:
                bind_res = self.bind_template(bind_req)
                if log_store and task_id:
                    log_store.add(
                        task_id,
                        "bind_template",
                        "ok",
                        f"templates bound: {bind_res.get('template_ids')}",
                        ip=str(req.ip),
                        hostname=getattr(req, "hostname", None),
                        host_id=host_id,
                        zabbix_url=zabbix_url,
                    )
            except Exception as exc:
                if log_store and task_id:
                    log_store.add(
                        task_id,
                        "bind_template",
                        "failed",
                        str(exc),
                        ip=str(req.ip),
                        hostname=getattr(req, "hostname", None),
                        host_id=host_id,
                        zabbix_url=zabbix_url,
                    )
                raise
        for url in self._iter_web_urls(req):
            try:
                wid = self._ensure_web_monitor(host_id, url)
                if log_store and task_id:
                    log_store.add(
                        task_id,
                        "web_monitor",
                        "ok",
                        f"web scenario ensured id={wid} url={url}",
                        ip=str(req.ip),
                        hostname=getattr(req, "hostname", None),
                        host_id=host_id,
                        zabbix_url=zabbix_url,
                    )
            except Exception as exc:
                if log_store and task_id:
                    log_store.add(task_id, "web_monitor", "failed", str(exc), ip=str(req.ip), hostname=getattr(req, "hostname", None), host_id=host_id, zabbix_url=zabbix_url)
                raise
        return {"host_id": host_id, "ip": str(req.ip), "status": "registered"}

    def bind_template(self, req: TemplateBindRequest) -> dict:
        host_key = getattr(req, "hostname", None) or str(req.ip)
        host = self._get_host(host_key, getattr(req, "proxy_id", None))
        if not host:
            raise HTTPException(status_code=404, detail="host not found in zabbix")
        templates = host.get("parentTemplates", [])
        current_ids = {t["templateid"] for t in templates}
        incoming = set()
        if req.template_id:
            incoming.add(req.template_id)
        if req.template_ids:
            incoming.update(req.template_ids)
        if req.action == "bind":
            current_ids |= incoming
        else:
            current_ids -= incoming
        new_templates = [{"templateid": tid} for tid in current_ids]
        self._zbx("host.update", {"hostid": host["hostid"], "templates": new_templates})
        return {"ip": str(req.ip), "template_ids": list(current_ids), "action": req.action}

    def unbind_template(self, req: TemplateBindRequest) -> dict:
        req.action = "unbind"
        return self.bind_template(req)

    def list_templates(self) -> List[Dict[str, Any]]:
        return self._zbx("template.get", {"output": ["templateid", "name"]})

    def list_groups(self) -> List[Dict[str, Any]]:
        return self._zbx("hostgroup.get", {"output": ["groupid", "name"]})

    def list_proxies(self) -> List[Dict[str, Any]]:
        return self._zbx("proxy.get", {"output": ["proxyid", "host", "name"]})

    def delete_template(self, req: TemplateDeleteRequest) -> dict:
        hosts = self._zbx("host.get", {"output": ["hostid"], "templateids": req.template_id})
        if hosts:
            raise HTTPException(status_code=400, detail=f"template {req.template_id} has bound hosts; cannot delete")
        self._zbx("template.delete", [req.template_id])
        return {"deleted": True, "template_id": req.template_id}

    def create_template(self, req: TemplateCreateRequest) -> dict:
        groups = [{"groupid": gid} for gid in (req.group_ids or [settings.default_group_id or "1"])]
        res = self._zbx("template.create", {"host": req.name, "name": req.name, "groups": groups})
        return {"created": True, "templateids": res.get("templateids") if isinstance(res, dict) else res}

    def update_template(self, req: TemplateUpdateRequest) -> dict:
        params: Dict[str, Any] = {"templateid": req.template_id}
        if req.name:
            params["name"] = req.name
            params["host"] = req.name
        if req.group_ids:
            params["groups"] = [{"groupid": gid} for gid in req.group_ids]
        res = self._zbx("template.update", params)
        return {"updated": True, "result": res}

    def delete_group(self, req: GroupDeleteRequest) -> dict:
        hosts = self._zbx("host.get", {"output": ["hostid"], "groupids": req.group_id})
        if hosts:
            raise HTTPException(status_code=400, detail=f"group {req.group_id} has bound hosts; cannot delete")
        self._zbx("hostgroup.delete", [req.group_id])
        return {"deleted": True, "group_id": req.group_id}

    # --------------------------- Zabbix API helpers --------------------------- #
    def _zbx(self, method: str, params: Any) -> Any:
        cfg = self.config_store.get()
        token = self._ensure_auth(cfg)
        payload = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1, "auth": token}
        url = cfg.get("zabbix_api_base") or settings.zabbix_api_base
        safe_params = self._safe_log_payload(params)
        LOG.info("Zabbix API call %s params=%s", method, safe_params)
        try:
            resp = self.client.post(url, json=payload, follow_redirects=True)
            resp.raise_for_status()
        except httpx.RequestError as exc:
            LOG.exception("Zabbix API request failed (%s): %s", method, exc)
            raise HTTPException(status_code=502, detail=f"Zabbix API request failed: {exc}") from exc
        try:
            data = resp.json()
        except Exception:
            LOG.exception("Zabbix API returned non-JSON for %s: %s", method, resp.text[:200])
            raise HTTPException(
                status_code=502,
                detail=f"Zabbix API returned non-JSON response: {resp.text[:500]}",
            )
        if "error" in data:
            # reset token on auth error
            if data["error"]["code"] in (-32602, -32500):
                self._auth_cache = None
            LOG.error("Zabbix API error %s: %s", method, data["error"])
            raise RuntimeError(f"Zabbix API error {data['error']}")
        LOG.info("Zabbix API call %s success", method)
        return data.get("result")

    _auth_cache: Optional[str] = None

    def _ensure_auth(self, cfg: Dict[str, Any]) -> str:
        if self._auth_cache:
            return self._auth_cache
        if cfg.get("zabbix_api_token"):
            self._auth_cache = cfg.get("zabbix_api_token")
            return self._auth_cache
        if not cfg.get("zabbix_api_user") or not cfg.get("zabbix_api_password"):
            raise HTTPException(status_code=400, detail="Zabbix auth missing: set token or user/password")
        payload = {
            "jsonrpc": "2.0",
            "method": "user.login",
            "params": {"user": cfg.get("zabbix_api_user"), "password": cfg.get("zabbix_api_password")},
            "id": 1,
        }
        url = cfg.get("zabbix_api_base") or settings.zabbix_api_base
        try:
            resp = self.client.post(url, json=payload, follow_redirects=True)
            resp.raise_for_status()
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"Zabbix login request failed: {exc}") from exc
        try:
            data = resp.json()
        except Exception:
            raise HTTPException(
                status_code=502,
                detail=f"Zabbix login non-JSON response (status {resp.status_code}): {resp.text[:500]}",
            )
        if "error" in data:
            raise HTTPException(status_code=401, detail=f"Zabbix login failed: {data['error']}")
        self._auth_cache = data.get("result")
        return self._auth_cache

    def _safe_log_payload(self, params: Any) -> str:
        """Sanitize sensitive fields before logging to file (no DB write)."""
        def mask(obj):
            if isinstance(obj, dict):
                return {k: ("***" if k.lower() in {"password", "pass", "auth", "user", "zabbix_api_password"} else mask(v)) for k, v in obj.items()}
            if isinstance(obj, list):
                return [mask(x) for x in obj]
            return obj

        try:
            safe = mask(params)
            text = str(safe)
            return text if len(text) < 500 else text[:500] + "..."
        except Exception:
            return "<unloggable-params>"

    def _get_host(self, host: str, proxy_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        res = self._zbx(
            "host.get",
            {
                "output": ["hostid", "host", "name"],
                "selectInterfaces": ["interfaceid", "ip", "port", "type"],
                "selectParentTemplates": ["templateid", "name"],
                "filter": {"host": host},
                **({"proxyids": [proxy_id]} if proxy_id else {}),
            },
        )
        return res[0] if res else None

    def _ensure_host(self, req: InstallRequest) -> str:
        cfg = self.config_store.get()
        # Agent 主机名已在 install_agent 解析，这里仅做兜底
        agent_hostname = req.hostname or str(req.ip)

        existing = self._get_host(agent_hostname, getattr(req, "proxy_id", None))
        host_value = agent_hostname
        templates = []
        tmpl_ids = []
        if req.template_ids:
            tmpl_ids.extend(req.template_ids)
        if req.template_id:
            tmpl_ids.append(req.template_id)
        if not tmpl_ids and cfg.get("default_template_id"):
            tmpl_ids.append(cfg.get("default_template_id"))
        templates = [{"templateid": tid} for tid in tmpl_ids]

        groups = []
        grp_ids = []
        if req.group_ids:
            grp_ids.extend(req.group_ids)
        if req.group_id:
            grp_ids.append(req.group_id)
        if not grp_ids and cfg.get("default_group_id"):
            grp_ids.append(cfg.get("default_group_id"))
        if not grp_ids:
            grp_ids.append("1")
        groups = [{"groupid": gid} for gid in grp_ids]
        base_params = {
            "host": host_value,
            "name": req.visible_name or host_value,
            "groups": groups,
            "templates": templates,
        }
        if getattr(req, "proxy_id", None):
            base_params["proxy_hostid"] = req.proxy_id
        tags = []
        if req.env:
            tags.append({"tag": "env", "value": req.env})
        for url in self._iter_web_urls(req):
            tags.append({"tag": "web_monitor", "value": str(url)})
        if tags:
            base_params["tags"] = tags

        interfaces = [
            {
                "type": 1,  # agent
                "main": 1,
                "useip": 1,
                "ip": str(req.ip),
                "dns": "",
                "port": str(req.port),
            }
        ]
        jmx_port = getattr(req, "jmx_port", None) or 10052
        tmpl_ids_all = [t["templateid"] for t in templates if t.get("templateid")]
        has_jmx = self._has_jmx_template(tmpl_ids_all) if tmpl_ids_all else False
        if has_jmx:
            interfaces.append(
                {
                    "type": 4,  # JMX
                    "main": 1,
                    "useip": 1,
                    "ip": str(req.ip),
                    "dns": "",
                    "port": str(jmx_port),
                }
            )

        if existing:
            update_params = dict(base_params)
            update_params["hostid"] = existing["hostid"]
            # Avoid touching interfaces on existing hosts to prevent "interface linked to item" errors
            self._zbx("host.update", update_params)
            if has_jmx:
                has_jmx_iface = any(int(i.get("type", 0)) == 4 for i in existing.get("interfaces", []))
                if not has_jmx_iface:
                    self._zbx(
                        "hostinterface.create",
                        {
                            "hostid": existing["hostid"],
                            "type": 4,
                            "main": 1,
                            "useip": 1,
                            "ip": str(req.ip),
                            "dns": "",
                            "port": str(jmx_port),
                        },
                    )
            return existing["hostid"]

        create_params = dict(base_params)
        create_params["interfaces"] = interfaces
        result = self._zbx("host.create", create_params)
        return result["hostids"][0]

    # --------------------------- SSH install/uninstall --------------------------- #
    def _run_steps(
        self,
        ip,
        steps: List[Dict[str, str]],
        rollback_script: Optional[str],
        ssh_opts: Optional[Any],
        preupload_local_path: Optional[str] = None,
        remote_tmp: str = "/tmp/zabbix-agent2.tgz",
        task_id: str | None = None,
        log_store=None,
        hostname: str | None = None,
        host_id: str | None = None,
        zabbix_url: str | None = None,
    ) -> str:
        """Execute steps one by one; on failure, run rollback script."""
        logs: List[str] = []
        last_step = None
        tolerant_steps = {"pre_cleanup", "precheck"}
        if preupload_local_path:
            self._upload_file(ip, preupload_local_path, remote_tmp, ssh_opts=ssh_opts)
            if log_store and task_id:
                log_store.add(task_id, "upload", "ok", f"upload {preupload_local_path} -> {remote_tmp}", ip=str(ip), hostname=hostname, host_id=host_id, zabbix_url=zabbix_url)
        try:
            for step in steps:
                name = step["name"]
                script = step["script"]
                last_step = name
                try:
                    out = self._run_ssh(ip, script, ssh_opts=ssh_opts)
                except Exception as exc:
                    if name in tolerant_steps:
                        warn_msg = f"{name} ignored: {exc}"
                        logs.append(f"[{name}] {warn_msg}")
                        if log_store and task_id:
                            log_store.add(task_id, name, "warn", warn_msg, ip=str(ip), hostname=hostname, host_id=host_id, zabbix_url=zabbix_url)
                        continue
                    raise
                logs.append(f"[{name}] {out.strip()}")
                if log_store and task_id:
                    log_store.add(task_id, name, "ok", out.strip(), ip=str(ip), hostname=hostname, host_id=host_id, zabbix_url=zabbix_url)
            return "\n".join(logs)
        except Exception as exc:
            logs.append(f"[{last_step}] failed: {exc}")
            if log_store and task_id:
                log_store.add(task_id, last_step or "unknown", "failed", str(exc), ip=str(ip), hostname=hostname, host_id=host_id, zabbix_url=zabbix_url)
            if rollback_script:
                try:
                    ro = self._run_ssh(ip, rollback_script, ssh_opts=ssh_opts)
                    logs.append(f"[rollback] {ro.strip()}")
                    if log_store and task_id:
                        log_store.add(task_id, "rollback", "ok", ro.strip(), ip=str(ip), hostname=hostname, host_id=host_id, zabbix_url=zabbix_url)
                except Exception as rex:
                    logs.append(f"[rollback failed] {rex}")
                    if log_store and task_id:
                        log_store.add(task_id, "rollback", "failed", str(rex), ip=str(ip), hostname=hostname, host_id=host_id, zabbix_url=zabbix_url)
            raise HTTPException(status_code=500, detail="\n".join(logs))

    def _run_ssh(self, ip, script: str, ssh_opts: Optional[Any] = None) -> str:
        user = getattr(ssh_opts, "ssh_user", None) or settings.ssh_user
        password = getattr(ssh_opts, "ssh_password", None) or settings.ssh_password
        key_path = getattr(ssh_opts, "ssh_key_path", None) or settings.ssh_key_path
        port = getattr(ssh_opts, "ssh_port", None) or settings.ssh_port
        if not password and not key_path:
            raise HTTPException(status_code=400, detail="SSH credentials not configured")
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(
                hostname=str(ip),
                username=user,
                password=password,
                key_filename=key_path,
                port=port,
                look_for_keys=False,
            )
        except paramiko.ssh_exception.AuthenticationException as exc:
            ssh.close()
            raise HTTPException(status_code=401, detail=f"SSH 认证失败: {exc}") from exc
        except Exception as exc:
            ssh.close()
            raise HTTPException(status_code=500, detail=f"SSH 连接失败: {exc}") from exc
        cmd = f"bash -s <<'EOF'\n{script}\nEOF"
        stdin, stdout, stderr = ssh.exec_command(cmd)
        out = stdout.read().decode()
        err = stderr.read().decode()
        exit_code = stdout.channel.recv_exit_status()
        ssh.close()
        if exit_code != 0:
            raise RuntimeError(f"SSH command failed ({exit_code}): {err or out}")
        return out + err

    def _probe_hostname(self, req: InstallRequest) -> str:
        """Try to read hostname from remote server."""
        script = "hostname -s || hostname"
        out = self._run_ssh(req.ip, script, ssh_opts=req).strip()
        if not out:
            raise RuntimeError("hostname command returned empty")
        return out

    def _zbx_version(self) -> tuple[int, int]:
        ver_raw = self.config_store.get().get("zabbix_version") or settings.zabbix_version or "6.0"
        try:
            parts = str(ver_raw).split(".")
            major = int(parts[0])
            minor = int(parts[1]) if len(parts) > 1 else 0
            return (major, minor)
        except Exception:
            return (6, 0)

    def _web_monitor_name(self, url: str) -> str:
        parsed = urlparse(url)
        segments = [s for s in (parsed.path or "").split("/") if s]
        if segments:
            name = segments[-1]
        elif parsed.netloc:
            name = parsed.netloc
        else:
            name = f"web_{uuid.uuid4().hex[:6]}"
        # fallback to random if empty after stripping
        name = name.strip() or f"web_{uuid.uuid4().hex[:6]}"
        return name[:255]

    def _has_jmx_template(self, tmpl_ids: list[str]) -> bool:
        if not tmpl_ids:
            return False
        try:
            res = self._zbx("template.get", {"templateids": tmpl_ids, "output": ["templateid", "name"]})
            return any("jmx" in (t.get("name") or "").lower() for t in res or [])
        except Exception:
            return False

    def _ensure_web_monitor(self, host_id: str, url: str) -> str:
        name = self._web_monitor_name(url)
        major, _ = self._zbx_version()
        step = {"name": "step1", "url": url, "status_codes": "200"}
        if major >= 6:
            step["no"] = 1
        steps = [step]
        existing = self._zbx("httptest.get", {"hostids": [host_id], "filter": {"name": name}})
        if existing:
            self._zbx(
                "httptest.update",
                {
                    "httptestid": existing[0]["httptestid"],
                    "name": name,
                    "steps": steps,
                    "delay": "1m",
                    "retries": 1,
                },
            )
            return existing[0]["httptestid"]
        res = self._zbx(
            "httptest.create",
            {
                "name": name,
                "hostid": host_id,
                "steps": steps,
                "delay": "1m",
                "retries": 1,
                "agent": "Mozilla/5.0",
            },
        )
        # response may include httptestids
        if isinstance(res, dict) and res.get("httptestids"):
            return res["httptestids"][0]
        return str(res)

    def _upload_file(self, ip, local_path: str, remote_path: str, ssh_opts: Optional[Any] = None) -> None:
        if not os.path.exists(local_path):
            raise HTTPException(status_code=400, detail=f"local_agent_path not found: {local_path}")
        user = getattr(ssh_opts, "ssh_user", None) or settings.ssh_user
        password = getattr(ssh_opts, "ssh_password", None) or settings.ssh_password
        key_path = getattr(ssh_opts, "ssh_key_path", None) or settings.ssh_key_path
        port = getattr(ssh_opts, "ssh_port", None) or settings.ssh_port
        if not password and not key_path:
            raise HTTPException(status_code=400, detail="SSH credentials not configured")
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(
                hostname=str(ip),
                username=user,
                password=password,
                key_filename=key_path,
                port=port,
                look_for_keys=False,
            )
        except paramiko.ssh_exception.AuthenticationException as exc:
            ssh.close()
            raise HTTPException(status_code=401, detail=f"SFTP 认证失败: {exc}") from exc
        except Exception as exc:
            ssh.close()
            raise HTTPException(status_code=500, detail=f"SFTP 连接失败: {exc}") from exc
        try:
            sftp = ssh.open_sftp()
            sftp.put(local_path, remote_path)
            sftp.close()
            ssh.close()
            return
        except Exception as sftp_exc:
            LOG.warning("SFTP upload failed (%s), fallback to stdin copy", sftp_exc)
            try:
                chan = ssh.get_transport().open_session()
                chan.exec_command(f"cat > {remote_path}")
                with open(local_path, "rb") as fh:
                    while True:
                        chunk = fh.read(1024 * 1024)
                        if not chunk:
                            break
                        chan.sendall(chunk)
                chan.shutdown_write()
                exit_status = chan.recv_exit_status()
                if exit_status != 0:
                    raise RuntimeError(f"fallback upload failed, exit {exit_status}")
            finally:
                ssh.close()

    def _linux_install_steps(self, req: InstallRequest) -> (List[Dict[str, str]], str, Optional[str], str):
        cfg = self.config_store.get()
        if not cfg.get("agent_tgz_url") and not cfg.get("local_agent_path") and not settings.agent_tgz_url:
            raise HTTPException(status_code=400, detail="ZABBIX_AGENT_TGZ_URL or local_agent_path not configured")
        server = cfg.get("zabbix_server_host") or settings.zabbix_server_host
        host = req.hostname or str(req.ip)
        agent_hostname = host
        install_dir = (cfg.get("agent_install_dir") or settings.agent_install_dir or "/opt/zabbix-agent/").rstrip("/")
        unit_name = "zabbix-agent.service"
        tgz_url = cfg.get("agent_tgz_url") or settings.agent_tgz_url
        local_path = cfg.get("local_agent_path")
        remote_tmp = "/tmp/zabbix-agent2.tgz"
        preupload = local_path if local_path else None

        steps: List[Dict[str, str]] = [
            {
                "name": "precheck",
                "script": f"""
set +e
INSTALL_DIR={install_dir}
PORT={req.port}
UNIT=/etc/systemd/system/{unit_name}

echo "[CHECK] systemd unit"
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-unit-files | grep -q "^{unit_name}" && systemctl status {unit_name} --no-pager -l || echo "unit not present"
else
  echo "systemctl not available"
fi

echo "[CHECK] running processes"
ps -ef | grep -E "zabbix_agent(d|2)" | grep -v grep || echo "no running zabbix_agent"

echo "[CHECK] config files"
for f in "/etc/zabbix/zabbix_agentd.conf" "$INSTALL_DIR/conf/zabbix_agentd.conf" "$INSTALL_DIR/etc/zabbix_agent2.conf"; do
  [ -f "$f" ] && echo "found conf: $f" || true
done

echo "[CHECK] port {req.port}"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep :$PORT || echo "port {req.port} not in use"
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltnp | grep :$PORT || echo "port {req.port} not in use"
else
  echo "ss/netstat not available"
fi

echo "[CHECK] proxy hint"
if [ -n "{getattr(req, 'proxy_id', '')}" ]; then
  echo "proxy_id provided: {getattr(req, 'proxy_id', '')}"
else
  echo "no proxy_id provided"
fi

echo "precheck done"
exit 0
""",
            } if getattr(req, "precheck", True) else None,
            {
                "name": "pre_cleanup",
                "script": f"""
set +e
INSTALL_DIR={install_dir}
UNIT=/etc/systemd/system/{unit_name}
PIDFILE=$INSTALL_DIR/zabbix_agent.pid
UNIT_EXISTS=0
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q "^{unit_name}"; then
    UNIT_EXISTS=1
  fi
fi

if [ "$UNIT_EXISTS" = "1" ]; then
  echo "found existing service {unit_name}, stopping/disabling..."
  sudo systemctl stop {unit_name} || true
  sudo systemctl disable {unit_name} || true
else
  echo "no existing systemd unit {unit_name}"
fi

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" >/dev/null 2>&1; then
    echo "killing pid from pidfile: $PID"
    sudo kill "$PID" || true
    sleep 1
  fi
  sudo rm -f "$PIDFILE"
fi

PIDS=$(pgrep -f "zabbix_agent" || true)
if [ -n "$PIDS" ]; then
  echo "killing existing zabbix_agent processes: $PIDS"
  sudo kill $PIDS || true
  sleep 1
else
  echo "no running zabbix_agent processes"
fi

sudo rm -f "$UNIT"
sudo rm -rf "$INSTALL_DIR"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl daemon-reload || true
fi
echo "pre-clean done (unit removed, dir cleaned)"
exit 0
""",
            },
            {
                "name": "download",
                "script": f"""
set -e
umask 022
TMP_TGZ={remote_tmp}
if [ -f "$TMP_TGZ" ]; then
  echo "use pre-uploaded: $TMP_TGZ"
elif [ -n "{tgz_url or ''}" ]; then
  curl -fsSL "{tgz_url or ''}" -o "$TMP_TGZ"
  echo "download ok: $TMP_TGZ"
else
  echo "no agent package available" >&2
  exit 1
fi
""",
            },
            {
                "name": "extract",
                "script": f"""
set -e
TMP_TGZ={remote_tmp}
INSTALL_DIR={install_dir}
sudo mkdir -p "$INSTALL_DIR"
sudo tar -xzf "$TMP_TGZ" -C "$INSTALL_DIR" --strip-components=1
echo "extract ok -> $INSTALL_DIR"
""",
            },
            {
                "name": "write_config",
                "script": f"""
set -e
INSTALL_DIR={install_dir}
CONF=$INSTALL_DIR/conf/zabbix_agentd.conf
LOG_FILE=$INSTALL_DIR/logs/zabbix_agentd.log
LOG_DIR=$(dirname "$LOG_FILE")
sudo mkdir -p "$(dirname "$CONF")" "$LOG_DIR"
sudo touch "$LOG_FILE"
sudo chmod 755 "$LOG_DIR"
sudo chmod 644 "$LOG_FILE"
sudo cat > "$CONF" <<EOFCONF
Server={server}
ServerActive={server}
Hostname={agent_hostname}
LogFileSize=0
LogFile=$LOG_FILE
PidFile=$INSTALL_DIR/zabbix_agent.pid
AllowRoot=1
User=root
EOFCONF
echo "config ok -> $CONF"
""",
            },
            {
                "name": "write_unit",
                "script": rf"""
set -e
INSTALL_DIR={install_dir}
CONF=$INSTALL_DIR/conf/zabbix_agentd.conf
PIDFILE=$INSTALL_DIR/zabbix_agent.pid
UNIT=/etc/systemd/system/{unit_name}

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found; system service install required" >&2
  exit 1
fi

# stop old process (if any)
PIDS=$(ps -ef | grep zabbix_agent | grep -v grep | awk '{{print $2}}')
if [ -n "$PIDS" ]; then
  echo "killing existing zabbix_agent: $PIDS"
  sudo kill $PIDS || true
  sleep 1
fi
sudo rm -f "$PIDFILE"

BIN=$INSTALL_DIR/sbin/zabbix_agentd
ALT_BIN=$INSTALL_DIR/sbin/zabbix_agent2
if [ ! -x "$BIN" ] && [ -x "$ALT_BIN" ]; then
  BIN=$ALT_BIN
fi
if [ ! -x "$BIN" ]; then
  BIN=$(find "$INSTALL_DIR" -type f \( -name 'zabbix_agentd' -o -name 'zabbix_agent2' \) | head -n 1)
fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  echo "agent binary missing under $INSTALL_DIR" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^{unit_name}"; then
  sudo systemctl stop {unit_name} || true
  sudo systemctl disable {unit_name} || true
fi
sudo rm -f "$UNIT"

sudo cat > "$UNIT" <<EOFUNIT
[Unit]
Description=Zabbix Agent
After=network.target

[Service]
Type=simple
ExecStart=$BIN -c $CONF
Restart=on-failure
User=root
Group=root
PIDFile=$PIDFILE
WorkingDirectory=$INSTALL_DIR

[Install]
WantedBy=multi-user.target
EOFUNIT
echo "unit written -> $UNIT (bin=$BIN)"
""",
            },
            {
                "name": "enable_service",
                "script": f"""
set -e
sudo systemctl daemon-reload
sudo systemctl enable --now {unit_name}
sudo systemctl status {unit_name} --no-pager -l || true
echo "service enabled and started: {unit_name}"
""",
            },
        ]
        steps = [s for s in steps if s]
        rollback = self._linux_uninstall_script()
        return steps, rollback, preupload, remote_tmp

    def _linux_uninstall_script(self) -> str:
        cfg = self.config_store.get()
        install_dir = (cfg.get("agent_install_dir") or settings.agent_install_dir or "/opt/zabbix-agent/").rstrip("/")
        unit_name = "zabbix-agent.service"
        unit_path = f"/etc/systemd/system/{unit_name}"
        pid_file = f"{install_dir}/zabbix_agent.pid"
        bin_pattern = "zabbix_agent"
        script = rf"""
set +e
echo "[STEP] stop agent"
UNIT_EXISTS=0
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q "^{unit_name}"; then
    UNIT_EXISTS=1
  fi
fi
if [ "$UNIT_EXISTS" = "1" ]; then
  echo "stopping systemd unit {unit_name}"
  sudo systemctl stop {unit_name} || true
  sudo systemctl disable {unit_name} || true
else
  echo "no systemd unit {unit_name} registered; skip stop"
fi
if [ -f "{pid_file}" ]; then
  PID=$(cat "{pid_file}")
  if kill -0 "$PID" >/dev/null 2>&1; then
    echo "killing pid from pidfile: $PID"
    sudo kill "$PID" || true
    sleep 1
  fi
  sudo rm -f "{pid_file}"
fi
PIDS=$(pgrep -f "{bin_pattern}" || true)
if [ -n "$PIDS" ]; then
  echo "pkill processes: $PIDS"
  sudo kill $PIDS || true
  sleep 1
else
  echo "no running {bin_pattern} processes"
fi
sudo rm -f "{unit_path}"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl daemon-reload || true
fi
echo "[OK] stop agent"
echo "[STEP] clean files"
sudo rm -rf {install_dir}
echo "[OK] clean files"
exit 0
"""
        return script

    def _linux_uninstall_steps(self) -> List[Dict[str, str]]:
        cfg = self.config_store.get()
        install_dir = (cfg.get("agent_install_dir") or settings.agent_install_dir or "/opt/zabbix-agent/").rstrip("/")
        unit_name = "zabbix-agent.service"
        unit_path = f"/etc/systemd/system/{unit_name}"
        pid_file = f"{install_dir}/zabbix_agent.pid"
        bin_pattern = "zabbix_agent"
        return [
            {
                "name": "stop_agent",
                "script": rf"""
set +e
UNIT_EXISTS=0
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files | grep -q "^{unit_name}"; then
    UNIT_EXISTS=1
  fi
fi
if [ "$UNIT_EXISTS" = "1" ]; then
  echo "stopping systemd unit {unit_name}"
  sudo systemctl stop {unit_name} || true
  sudo systemctl disable {unit_name} || true
else
  echo "no systemd unit {unit_name} registered; skip stop"
fi
if [ -f "{pid_file}" ]; then
  PID=$(cat "{pid_file}")
  if kill -0 "$PID" >/dev/null 2>&1; then
    echo "killing pid from pidfile: $PID"
    sudo kill "$PID" || true
    sleep 1
  fi
  sudo rm -f "{pid_file}"
fi
PIDS=$(pgrep -f "{bin_pattern}" || true)
if [ -n "$PIDS" ]; then
  echo "pkill processes: $PIDS"
  sudo kill $PIDS || true
  sleep 1
else
  echo "no running {bin_pattern} processes"
fi
sudo rm -f "{unit_path}"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl daemon-reload || true
fi
echo "agent stopped"
exit 0
""",
            },
            {
                "name": "clean_files",
                "script": rf"""
set -e
sudo rm -rf {install_dir}
echo "files cleaned"
""",
            },
        ]
