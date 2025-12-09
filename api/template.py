from fastapi import APIRouter, Depends

from schemas.models import (
    TemplateDeleteRequest,
    GroupDeleteRequest,
    TemplateCreateRequest,
    TemplateUpdateRequest,
)
from core.dependencies import get_zabbix_service
from utils.response import ok

router = APIRouter(prefix="/api/zabbix", tags=["template"])


@router.get("/templates")
async def list_templates(svc=Depends(get_zabbix_service)):
    return ok(svc.list_templates())


@router.get("/groups")
async def list_groups(svc=Depends(get_zabbix_service)):
    return ok(svc.list_groups())


@router.post("/template/delete")
async def delete_template(req: TemplateDeleteRequest, svc=Depends(get_zabbix_service)):
    return ok(svc.delete_template(req))


@router.post("/template/create")
async def create_template(req: TemplateCreateRequest, svc=Depends(get_zabbix_service)):
    return ok(svc.create_template(req))


@router.post("/template/update")
async def update_template(req: TemplateUpdateRequest, svc=Depends(get_zabbix_service)):
    return ok(svc.update_template(req))


@router.post("/group/delete")
async def delete_group(req: GroupDeleteRequest, svc=Depends(get_zabbix_service)):
    return ok(svc.delete_group(req))
