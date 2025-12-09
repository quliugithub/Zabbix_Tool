from __future__ import annotations

import uuid
import time
from typing import Dict, Any
from threading import Lock


class TaskStore:
    def __init__(self):
        self._lock = Lock()
        self._tasks: Dict[str, Dict[str, Any]] = {}

    def create(self, name: str) -> str:
        task_id = uuid.uuid4().hex
        with self._lock:
            self._tasks[task_id] = {"id": task_id, "name": name, "status": "pending", "created": time.time(), "log": []}
        return task_id

    def update(self, task_id: str, status: str, log: str | None = None, result: Any | None = None) -> None:
        with self._lock:
            if task_id not in self._tasks:
                return
            self._tasks[task_id]["status"] = status
            if log:
                self._tasks[task_id]["log"].append(log)
            if result is not None:
                self._tasks[task_id]["result"] = result
            self._tasks[task_id]["updated"] = time.time()

    def get(self, task_id: str) -> Dict[str, Any] | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return dict(self._tasks)
