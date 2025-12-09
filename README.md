# Zabbix Agent 控制台

简要说明：提供 Zabbix Agent 的安装/卸载/注册、模板/群组/Proxy/JMX/Web 监控绑定，支持单机和批量（Excel）操作，前端内置状态提示与日志查看。

## 目录结构
- `core/`：基础设施（`settings.py`、`dependencies.py`、`db_config.py`、`log_store.py`、`batch_store.py`）。
- `services/`：核心业务逻辑（`service.py`）。
- `schemas/`：Pydantic 数据模型（`models.py`）。
- `tasks/`：任务存储与后台批处理（`task_store.py`、`batch_worker.py`）。
- `utils/`：工具（`excel.py` 等）。
- `api/`：FastAPI 路由。
- `static/`：前端资源（含 `static/icon/zabbix.ico` favicon）。
- `uploads/`：Agent 包上传目录（相对路径时自动创建）。
- 入口：`main.py`（挂载静态资源、启动 uvicorn）。

## 运行（开发）
1. 安装依赖：`pip install -r requirements.txt`
2. 启动：`uvicorn main:app --host 0.0.0.0 --port 8000`
3. 访问：http://127.0.0.1:8000/
4. 关闭服务：`POST /shutdown`，Header `X-Token: <SHUTDOWN_TOKEN>`（默认 `shutdown-secret`）。

日志：控制台 + 运行目录 `run.log`（UTF-8）。

## 配置说明（核心字段）
- `ZABBIX_API_BASE` / `ZABBIX_API_TOKEN` 或 `ZABBIX_API_USER` + `ZABBIX_API_PASSWORD`
- `ZABBIX_DEFAULT_TEMPLATE_ID` / `ZABBIX_DEFAULT_GROUP_ID`
- `ZABBIX_AGENT_UPLOAD_DIR`（默认 uploads，相对路径自动创建）
- `LISTEN_HOST` / `LISTEN_PORT`
- `SHUTDOWN_TOKEN`（默认 `shutdown-secret`）
- 其他：`ZABBIX_AGENT_TGZ_URL`、`ZABBIX_AGENT_INSTALL_DIR`、`SSH_USER/PASSWORD/KEY_PATH/PORT` 等

配置页支持“一键测试 API”验证连通性，状态徽章会显示 Ready/NoReady。

## 主要接口
- 单机：`POST /api/zabbix/install` / `uninstall` / `register`
- 模板/群组/Proxy：`/api/zabbix/template`（bind/unbind），`/templates`，`/groups`，`/proxies`
- 批量：`/api/zabbix/batch`、`/batch/upload`、`/batch/run`、`/batch/template/download`、`/batch/queue/*`
- 日志：`GET /api/zabbix/logs/{task_id}`
- 配置：`GET/PUT /api/zabbix/config`，`POST /api/zabbix/config/test`
- 关停：`POST /shutdown`（Header `X-Token`）

业务说明：`services/service.py` 安装流程按 download/extract/write_config/write_unit/enable_service 分步执行，失败会回滚；卸载同理。日志写入 DB 与 `run.log`，前端可查看。

## 打包（PyInstaller 示例）
服务端 exe（可加 `--noconsole` 去掉黑框）：
```
pyinstaller --clean --noconfirm --onefile --name new_zabbix --icon zabbix.ico ^
  --add-data "static;static" --add-data "uploads;uploads" --add-data "api;api" --add-data "utils;utils" ^
  main.py
```
启动器（可选，launcher.py：启动服务、打开浏览器、退出时调用 `/shutdown`）：
```
pyinstaller --clean --noconfirm --onefile --name zabbix_launcher launcher.py
```

## 注意事项
- 打包时务必包含静态资源：`--add-data "static;static"`；favicon 在 `static/icon/zabbix.ico`。
- 重复启动：程序会探测端口，已有实例时仅打开浏览器，不再新建实例。
- 上传 Agent 包：`POST /api/zabbix/agent/upload`，文件保存在 `ZABBIX_AGENT_UPLOAD_DIR`，可通过 `/agent-packages/<filename>` 下载或配置为安装包 URL。 
