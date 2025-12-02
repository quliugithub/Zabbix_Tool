from __future__ import annotations

from typing import Optional, List
from pydantic import BaseModel, Field, IPvAnyAddress


class ServerInfo(BaseModel):
    hostname: Optional[str] = Field(default=None, description="Host display name (optional, auto-detect if empty)")
    ip: IPvAnyAddress = Field(..., description="Host IP address")
    os_type: str = Field(..., description="linux/windows")
    env: Optional[str] = Field(default=None, description="Env tag or group")
    port: int = Field(default=10050, description="Agent port")
    template_id: Optional[str] = Field(default=None, description="Zabbix template id")
    group_id: Optional[str] = Field(default=None, description="Zabbix host group id")
    note: Optional[str] = Field(default=None, description="Freeform note")


class InstallRequest(ServerInfo):
    reinstall: bool = Field(default=False, description="Force reinstall if exists")
    precheck: bool = Field(default=True, description="Run pre-install check for existing agent/service/ports")
    register_server: bool = Field(default=True, description="Create/update host and bind templates in Zabbix server")
    web_monitor_url: Optional[str] = Field(default=None, description="Optional web monitor URL tag")
    jmx_port: Optional[int] = Field(default=10052, description="JMX port if JMX templates are bound")
    template_ids: Optional[List[str]] = Field(default=None, description="Override: multiple template ids")
    group_ids: Optional[List[str]] = Field(default=None, description="Override: multiple group ids")
    visible_name: Optional[str] = Field(default=None, description="Alias/visible name for host")
    proxy_id: Optional[str] = Field(default=None, description="Zabbix proxy id (optional)")
    ssh_user: Optional[str] = Field(default=None, description="Override SSH user")
    ssh_password: Optional[str] = Field(default=None, description="Override SSH password")
    ssh_key_path: Optional[str] = Field(default=None, description="Override SSH key path")
    ssh_port: Optional[int] = Field(default=None, description="Override SSH port")


class RegisterRequest(BaseModel):
    hostname: Optional[str] = None
    visible_name: Optional[str] = None
    ip: IPvAnyAddress
    env: Optional[str] = None
    port: int = Field(default=10050, description="Agent port")
    template_id: Optional[str] = None
    template_ids: Optional[List[str]] = None
    group_id: Optional[str] = None
    group_ids: Optional[List[str]] = None
    proxy_id: Optional[str] = None
    web_monitor_url: Optional[str] = None
    jmx_port: Optional[int] = Field(default=10052, description="JMX port if JMX templates are bound")


class UninstallRequest(BaseModel):
    ip: IPvAnyAddress
    hostname: Optional[str] = None
    proxy_id: Optional[str] = None
    ssh_user: Optional[str] = Field(default=None, description="Override SSH user")
    ssh_password: Optional[str] = Field(default=None, description="Override SSH password")
    ssh_key_path: Optional[str] = Field(default=None, description="Override SSH key path")
    ssh_port: Optional[int] = Field(default=None, description="Override SSH port")


class TemplateBindRequest(BaseModel):
    ip: IPvAnyAddress
    template_id: Optional[str] = None
    template_ids: Optional[List[str]] = None
    action: str = Field(..., pattern="^(bind|unbind)$")


class TemplateDeleteRequest(BaseModel):
    template_id: str


class GroupDeleteRequest(BaseModel):
    group_id: str


class TemplateCreateRequest(BaseModel):
    name: str
    group_ids: Optional[List[str]] = None


class TemplateUpdateRequest(BaseModel):
    template_id: str
    name: Optional[str] = None
    group_ids: Optional[List[str]] = None


class BatchInstallRequest(BaseModel):
    servers: List[InstallRequest]
    action: str = Field(default="install", pattern="^(install|uninstall)$")
