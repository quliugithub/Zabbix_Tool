from pydantic import BaseModel, Field
from typing import Optional
import os


class Settings(BaseModel):
    zabbix_api_base: str = Field(default="http://zabbix5.cenboomh.com/api_jsonrpc.php", alias="ZABBIX_API_BASE")
    zabbix_api_token: Optional[str] = Field(default=None, alias="ZABBIX_API_TOKEN")
    zabbix_api_user: Optional[str] = Field(default=None, alias="ZABBIX_API_USER")
    zabbix_api_password: Optional[str] = Field(default=None, alias="ZABBIX_API_PASSWORD")
    default_template_id: Optional[str] = Field(default=None, alias="ZABBIX_DEFAULT_TEMPLATE_ID")
    default_group_id: Optional[str] = Field(default="1", alias="ZABBIX_DEFAULT_GROUP_ID")
    zabbix_version: str = Field(default="6.4", alias="ZABBIX_VERSION")
    zabbix_server_host: str = Field(default="127.0.0.1", alias="ZABBIX_SERVER_HOST")
    agent_tgz_url: Optional[str] = Field(
        default=None,
        alias="ZABBIX_AGENT_TGZ_URL",
        description="URL to a prebuilt zabbix agent2 tar.gz package",
    )
    agent_install_dir: str = Field(default="/opt/zabbix-agent2", alias="ZABBIX_AGENT_INSTALL_DIR")
    project_name: str = Field(default="", alias="PROJECT_NAME")
    agent_upload_dir: str = Field(default="uploads", alias="ZABBIX_AGENT_UPLOAD_DIR")
    batch_concurrency: int = Field(default=5, alias="BATCH_CONCURRENCY")
    ssh_user: str = Field(default="root", alias="SSH_USER")
    ssh_password: Optional[str] = Field(default=None, alias="SSH_PASSWORD")
    ssh_key_path: Optional[str] = Field(default=None, alias="SSH_KEY_PATH")
    ssh_port: int = Field(default=22, alias="SSH_PORT")
    debug: bool = Field(default=False, alias="DEBUG")
    listen_host: str = Field(default="127.0.0.1", alias="LISTEN_HOST")
    listen_port: int = Field(default=8000, alias="LISTEN_PORT")
    shutdown_token: str = Field(default="shutdown-secret", alias="SHUTDOWN_TOKEN")

    class Config:
        populate_by_name = True


def get_settings() -> Settings:
    return Settings()  # type: ignore[arg-type]
