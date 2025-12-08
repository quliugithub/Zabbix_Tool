pyinstaller --clean --noconfirm --onefile --name new_zabbix --icon zabbix.ico --add-data "static;static" --add-data "uploads;uploads" --add-data "api;api" --add-data "utils;utils" main.py
