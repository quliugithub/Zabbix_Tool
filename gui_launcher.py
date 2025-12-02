"""
Launcher for Windows packaging.
Run directly with Python or bundle with PyInstaller to produce a GUI-friendly .exe.
Starts the FastAPI app and opens the default browser to the UI page.
"""
from __future__ import annotations

import multiprocessing
import threading
import webbrowser
from time import sleep

import uvicorn


def open_browser(url: str) -> None:
    # Delay a bit to let server start
    sleep(1.5)
    webbrowser.open(url)


def main() -> None:
    multiprocessing.freeze_support()
    url = "http://127.0.0.1:8100/"
    threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    uvicorn.run("new_zabbix.main:app", host="127.0.0.1", port=8100, log_level="info", reload=False)


if __name__ == "__main__":
    main()
