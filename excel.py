from __future__ import annotations

from typing import List
from openpyxl import load_workbook
from models import InstallRequest


def parse_excel(path: str, column_map: dict | None = None) -> List[InstallRequest]:
    """
    Parse Excel file into InstallRequest list.
    column_map: mapping from logical fields to column names, defaults for: hostname, ip, os_type, env, port, ssh_user, ssh_password, ssh_port, visible_name, jmx_port, template_id, group_id, note
    """
    wb = load_workbook(path)
    ws = wb.active
    headers = {cell.value: idx for idx, cell in enumerate(next(ws.iter_rows(min_row=1, max_row=1)), start=0)}
    cmap = column_map or {
        "hostname": "hostname",
        "ip": "ip",
        "os_type": "os",
        "env": "env",
        "port": "port",
        "ssh_user": "ssh_user",
        "ssh_password": "ssh_password",
        "ssh_port": "ssh_port",
        "visible_name": "visible_name",
        "jmx_port": "jmx_port",
        "template_id": "template_id",
        "group_id": "group_id",
        "note": "note",
    }
    requests: List[InstallRequest] = []
    for row in ws.iter_rows(min_row=2):
        data = {}
        for field, col_name in cmap.items():
            if col_name in headers:
                cell = row[headers[col_name]]
                data[field] = cell.value
        if data.get("hostname") and data.get("ip"):
            requests.append(InstallRequest(**data))
    return requests
