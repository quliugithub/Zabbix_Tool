# Zabbix Agent Service (standalone)

纯代码实现的 Zabbix agent 安装/卸载与模板绑定模块，脱离原有 YAML 逻辑。支持单机接口调用和 Excel 批量导入，并可被前端页面直接调用。

## UI 页面
- 访问 `/` 打开简易 GUI：支持 Agent 包上传、模板/群组查询与删除、模板绑定/解绑、Agent 安装/卸载表单。
- 上传接口 `POST /api/zabbix/agent/upload`，文件保存到 `ZABBIX_AGENT_UPLOAD_DIR`（默认 ./uploads），可通过 `/agent-packages/<filename>` 下载；可将返回 URL 配置给 `ZABBIX_AGENT_TGZ_URL` 使用。

## 目录
- `main.py`：FastAPI 入口，暴露安装/卸载/模板绑定/批量任务接口。
- `models.py`：请求/数据模型。
- `service.py`：核心业务（SSH 安装占位、Zabbix API 占位）。
- `excel.py`：Excel 解析为请求列表。
- `tasks.py`：简易内存任务状态存储。
- `settings.py`：环境变量配置。

## 运行
```bash
cd new_zabbix
python -m venv .venv
. .venv/Scripts/Activate.ps1   # PowerShell
pip install -r requirements.txt
uvicorn new_zabbix.main:app --reload --port 8100
```

环境变量：
- `ZABBIX_API_BASE` / `ZABBIX_API_TOKEN`：Zabbix API 访问信息。
- `ZABBIX_DEFAULT_TEMPLATE_ID` / `ZABBIX_DEFAULT_GROUP_ID`：默认模板/分组 ID。
- `ZABBIX_SERVER_HOST`：Agent Server/ServerActive 填写的 Zabbix 服务端地址（默认 127.0.0.1）。
- `ZABBIX_AGENT_TGZ_URL`：预置好的 zabbix agent2 tar.gz 下载地址（必填，固定包方式安装）。
- `ZABBIX_AGENT_INSTALL_DIR`：解压安装目录（默认 /opt/zabbix-agent2）。
- `SSH_USER` / `SSH_PASSWORD` / `SSH_KEY_PATH` / `SSH_PORT`：默认 SSH 凭据，可在请求体中覆盖。
- Zabbix 接口凭据支持两种：配置 `ZABBIX_API_TOKEN`，或配置 `ZABBIX_API_USER` + `ZABBIX_API_PASSWORD` 由接口自动登录获取 token。界面“Zabbix 配置”页可编辑并写入本地 `config.db`。

## Windows 打包为 .exe（简易 GUI 启动器）
1. 安装依赖：`pip install -r requirements.txt pyinstaller`  
2. 打包：`pyinstaller -F -w new_zabbix/gui_launcher.py`（-w 关闭控制台，-F 单文件）  
3. 运行生成的 `dist/gui_launcher.exe`，会自动启动内置 FastAPI 并打开浏览器访问 `http://127.0.0.1:8100/`。
> 如需携带 agent 安装包，可先上传一次（或放到 `uploads/`），并将返回的下载 URL 配置到 `ZABBIX_AGENT_TGZ_URL` 环境变量。

## 接口示例
- `POST /api/zabbix/install`：单机安装，体参见 `InstallRequest`。
- `POST /api/zabbix/uninstall`：单机卸载。
- `POST /api/zabbix/template`：模板绑定/解绑（`action`: bind|unbind）。
- `GET /api/zabbix/templates`：查询所有模板。
- `GET /api/zabbix/groups`：查询所有群组。
- `POST /api/zabbix/template/delete`：删除模板（如有绑定主机会拒绝）。
- `POST /api/zabbix/group/delete`：删除群组（如有绑定主机会拒绝）。
- `POST /api/zabbix/batch`：批量安装/卸载，支持上传 Excel（首行列名），或 JSON 传入 `servers`。
- `GET /api/zabbix/tasks/{task_id}`：查询批量任务状态。
- `GET /api/zabbix/config` / `PUT /api/zabbix/config`：读取/保存 Zabbix 服务器配置（保存在本地 `config.db`）。

> 说明：`service.py` 使用预置的 tgz 包方式安装，步骤被拆分为 download/extract/write_config/write_unit/enable_service 单独执行；任一步失败会执行回滚（停止服务、删除安装目录和 unit），接口返回的 `log` 包含每步输出。卸载同样分步执行。

请求字段补充：
- 安装：`template_id`（单个）、`template_ids`（多个，优先级高于单个；未提供则用 `ZABBIX_DEFAULT_TEMPLATE_ID`）、`group_id`/`group_ids`（支持多个，未提供则用 `ZABBIX_DEFAULT_GROUP_ID`，再不提供则落到 `1`）。`env` 会写成 tag。
- 模板接口：支持 `template_id` 或 `template_ids`。
- 安装/卸载可覆盖 SSH 凭据：`ssh_user`/`ssh_password`/`ssh_key_path`/`ssh_port`，未填则使用环境变量默认值。
