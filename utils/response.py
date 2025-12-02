def ok(data=None, msg: str = "ok"):
    return {"code": 0, "msg": msg, "data": data}


def err(code: int = 1, msg: str = "error", data=None):
    return {"code": code, "msg": msg, "data": data}
