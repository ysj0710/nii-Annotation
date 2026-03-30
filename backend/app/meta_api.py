from __future__ import annotations

import base64
import binascii
import gzip
import re
import time
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .db import get_db
from .models import ImageBlobRef, ImageMeta
from .object_store import delete_object, get_many_bytes, put_bytes

router = APIRouter(prefix="/meta", tags=["meta"])


def _sanitize_namespace(value: str | None) -> str:
    text = str(value or "").strip()
    if not text:
        return "local-default"
    sanitized = re.sub(r"[^a-zA-Z0-9:_-]+", "_", text)[:160]
    return sanitized or "local-default"


def _coerce_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except Exception:  # noqa: BLE001
        return fallback


def _coerce_bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        return bool(value)
    raw = str(value).strip().lower()
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return fallback


def _coerce_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _coerce_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _b64_to_bytes(value: str | None) -> bytes | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid base64 payload") from None


def _bytes_to_b64(value: bytes | None) -> str:
    if not value:
        return ""
    return base64.b64encode(value).decode("ascii")


def _is_gzip_payload(value: bytes | None) -> bool:
    data = value if isinstance(value, bytes) else b""
    return len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B


def _normalize_blob_content_for_storage(object_field: str, content: bytes | None) -> bytes:
    data = content if isinstance(content, bytes) else b""
    if object_field not in {"mask", "source_mask"}:
        return data
    if not data or _is_gzip_payload(data):
        return data
    compressed = gzip.compress(data, compresslevel=6)
    # Keep raw when compression does not improve size meaningfully.
    if len(compressed) + 64 >= len(data):
        return data
    return compressed


def _sanitize_object_segment(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", str(value or "").strip()) or "na"


def _build_object_key(namespace: str, image_id: str, field_name: str) -> str:
    ns = _sanitize_object_segment(namespace)
    image = _sanitize_object_segment(image_id)
    field = _sanitize_object_segment(field_name)
    return f"{ns}/{image}/{field}.bin"


def _normalize_blob_field_name(value: str) -> str:
    raw = re.sub(r"[^a-zA-Z]+", "", str(value or "").strip()).lower()
    if raw in {"data"}:
        return "data"
    if raw in {"sourcedata"}:
        return "sourceData"
    if raw in {"mask"}:
        return "mask"
    if raw in {"sourcemask"}:
        return "sourceMask"
    raise HTTPException(status_code=400, detail=f"invalid blob field name: {value}")


def _blob_field_config(field_name: str) -> tuple[str, str]:
    normalized = _normalize_blob_field_name(field_name)
    if normalized == "data":
        return "data_object_key", "data"
    if normalized == "sourceData":
        return "source_data_object_key", "source_data"
    if normalized == "mask":
        return "mask_object_key", "mask"
    if normalized == "sourceMask":
        return "source_mask_object_key", "source_mask"
    raise HTTPException(status_code=400, detail=f"unsupported blob field: {field_name}")


def _resolve_blob_action(raw: str | None) -> tuple[str, bytes | None]:
    if raw is None:
        return "keep", None
    text = str(raw).strip()
    if not text:
        return "clear", None
    return "set", _b64_to_bytes(text)


class ImageMetaPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    name: str = ""
    display_name: str | None = Field(default=None, alias="displayName")
    base_name: str | None = Field(default=None, alias="baseName")
    created_at: int = Field(default=0, alias="createdAt")
    updated_at: int = Field(default=0, alias="updatedAt")
    source_format: str | None = Field(default=None, alias="sourceFormat")
    source_name: str | None = Field(default=None, alias="sourceName")
    remote_image_id: str | None = Field(default=None, alias="remoteImageId")
    remote_batch_id: str | None = Field(default=None, alias="remoteBatchId")
    is_mask_only: bool = Field(default=False, alias="isMaskOnly")
    has_mask: bool = Field(default=False, alias="hasMask")
    mask_attached: bool = Field(default=False, alias="maskAttached")
    mask_version: int = Field(default=0, alias="maskVersion")
    mask_name: str | None = Field(default=None, alias="maskName")
    source_mask_name: str | None = Field(default=None, alias="sourceMaskName")
    hash: str | None = None
    thumbnail: str | None = None
    dicom_study_uid: str | None = Field(default=None, alias="dicomStudyUID")
    dicom_study_id: str | None = Field(default=None, alias="dicomStudyID")
    dicom_series_uid: str | None = Field(default=None, alias="dicomSeriesUID")
    dicom_series_description: str | None = Field(
        default=None, alias="dicomSeriesDescription"
    )
    dicom_series_number: int = Field(default=0, alias="dicomSeriesNumber")
    dicom_series_order: int = Field(default=0, alias="dicomSeriesOrder")
    dicom_accession_number: str | None = Field(
        default=None, alias="dicomAccessionNumber"
    )
    import_batch_id: str | None = Field(default=None, alias="importBatchId")
    modified_by_user: bool = Field(default=False, alias="modifiedByUser")
    custom_fields: dict[str, Any] = Field(default_factory=dict, alias="customFields")
    overlay_annotations: list[Any] = Field(
        default_factory=list, alias="overlayAnnotations"
    )
    last_client_env_report: dict[str, Any] = Field(
        default_factory=dict, alias="lastClientEnvReport"
    )


class ImageMetaPatchPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    name: str | None = None
    display_name: str | None = Field(default=None, alias="displayName")
    base_name: str | None = Field(default=None, alias="baseName")
    created_at: int | None = Field(default=None, alias="createdAt")
    updated_at: int | None = Field(default=None, alias="updatedAt")
    source_format: str | None = Field(default=None, alias="sourceFormat")
    source_name: str | None = Field(default=None, alias="sourceName")
    remote_image_id: str | None = Field(default=None, alias="remoteImageId")
    remote_batch_id: str | None = Field(default=None, alias="remoteBatchId")
    is_mask_only: bool | None = Field(default=None, alias="isMaskOnly")
    has_mask: bool | None = Field(default=None, alias="hasMask")
    mask_attached: bool | None = Field(default=None, alias="maskAttached")
    mask_version: int | None = Field(default=None, alias="maskVersion")
    mask_name: str | None = Field(default=None, alias="maskName")
    source_mask_name: str | None = Field(default=None, alias="sourceMaskName")
    hash: str | None = None
    thumbnail: str | None = None
    dicom_study_uid: str | None = Field(default=None, alias="dicomStudyUID")
    dicom_study_id: str | None = Field(default=None, alias="dicomStudyID")
    dicom_series_uid: str | None = Field(default=None, alias="dicomSeriesUID")
    dicom_series_description: str | None = Field(
        default=None, alias="dicomSeriesDescription"
    )
    dicom_series_number: int | None = Field(default=None, alias="dicomSeriesNumber")
    dicom_series_order: int | None = Field(default=None, alias="dicomSeriesOrder")
    dicom_accession_number: str | None = Field(
        default=None, alias="dicomAccessionNumber"
    )
    import_batch_id: str | None = Field(default=None, alias="importBatchId")
    modified_by_user: bool | None = Field(default=None, alias="modifiedByUser")
    custom_fields: dict[str, Any] | None = Field(default=None, alias="customFields")
    overlay_annotations: list[Any] | None = Field(
        default=None, alias="overlayAnnotations"
    )
    last_client_env_report: dict[str, Any] | None = Field(
        default=None, alias="lastClientEnvReport"
    )


class UpsertBatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    namespace: str | None = None
    items: list[ImageMetaPayload] = Field(default_factory=list)


class ByIdsRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ids: list[str] = Field(default_factory=list)
    namespace: str | None = None


class ImageBlobPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    id: str
    data_b64: str | None = Field(default=None, alias="dataB64")
    source_data_b64: str | None = Field(default=None, alias="sourceDataB64")
    mask_b64: str | None = Field(default=None, alias="maskB64")
    source_mask_b64: str | None = Field(default=None, alias="sourceMaskB64")
    updated_at: int = Field(default=0, alias="updatedAt")


class ImageBlobUpsertBatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    namespace: str | None = None
    items: list[ImageBlobPayload] = Field(default_factory=list)


def _to_response_item(row: ImageMeta) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name or "",
        "displayName": row.display_name,
        "baseName": row.base_name,
        "createdAt": _coerce_int(row.created_at, 0),
        "updatedAt": _coerce_int(row.updated_at, 0),
        "sourceFormat": row.source_format,
        "sourceName": row.source_name,
        "remoteImageId": row.remote_image_id,
        "remoteBatchId": row.remote_batch_id,
        "isMaskOnly": bool(row.is_mask_only),
        "hasMask": bool(row.has_mask),
        "maskAttached": bool(row.mask_attached),
        "maskVersion": _coerce_int(row.mask_version, 0),
        "maskName": row.mask_name,
        "sourceMaskName": row.source_mask_name,
        "hash": row.hash,
        "thumbnail": row.thumbnail or "",
        "dicomStudyUID": row.dicom_study_uid,
        "dicomStudyID": row.dicom_study_id,
        "dicomSeriesUID": row.dicom_series_uid,
        "dicomSeriesDescription": row.dicom_series_description,
        "dicomSeriesNumber": _coerce_int(row.dicom_series_number, 0),
        "dicomSeriesOrder": _coerce_int(row.dicom_series_order, 0),
        "dicomAccessionNumber": row.dicom_accession_number,
        "importBatchId": row.import_batch_id,
        "modifiedByUser": bool(row.modified_by_user),
        "customFields": _coerce_dict(row.custom_fields),
        "overlayAnnotations": _coerce_list(row.overlay_annotations),
        "lastClientEnvReport": _coerce_dict(row.last_client_env_report),
    }


def _to_blob_response_item(
    row: ImageBlobRef,
    data_blob: bytes | None,
    source_data_blob: bytes | None,
    mask_blob: bytes | None,
    source_mask_blob: bytes | None,
) -> dict[str, Any]:
    return {
        "id": row.id,
        "dataB64": _bytes_to_b64(data_blob),
        "sourceDataB64": _bytes_to_b64(source_data_blob),
        "maskB64": _bytes_to_b64(mask_blob),
        "sourceMaskB64": _bytes_to_b64(source_mask_blob),
        "updatedAt": _coerce_int(row.updated_at, 0),
    }


def _apply_upsert_payload(row: ImageMeta, payload: ImageMetaPayload) -> None:
    row.name = str(payload.name or "")
    row.display_name = payload.display_name
    row.base_name = payload.base_name
    row.source_format = payload.source_format
    row.source_name = payload.source_name
    row.remote_image_id = (
        str(payload.remote_image_id) if payload.remote_image_id else None
    )
    row.remote_batch_id = (
        str(payload.remote_batch_id) if payload.remote_batch_id else None
    )
    row.is_mask_only = _coerce_bool(payload.is_mask_only, False)
    row.has_mask = _coerce_bool(payload.has_mask, False)
    row.mask_attached = _coerce_bool(payload.mask_attached, False)
    row.mask_version = _coerce_int(payload.mask_version, 0)
    row.mask_name = payload.mask_name
    row.source_mask_name = payload.source_mask_name
    row.hash = payload.hash
    row.thumbnail = payload.thumbnail

    row.dicom_study_uid = payload.dicom_study_uid
    row.dicom_study_id = payload.dicom_study_id
    row.dicom_series_uid = payload.dicom_series_uid
    row.dicom_series_description = payload.dicom_series_description
    row.dicom_series_number = _coerce_int(payload.dicom_series_number, 0)
    row.dicom_series_order = _coerce_int(payload.dicom_series_order, 0)
    row.dicom_accession_number = payload.dicom_accession_number

    row.import_batch_id = payload.import_batch_id
    row.modified_by_user = _coerce_bool(payload.modified_by_user, False)
    row.custom_fields = _coerce_dict(payload.custom_fields)
    row.overlay_annotations = _coerce_list(payload.overlay_annotations)
    row.last_client_env_report = _coerce_dict(payload.last_client_env_report)

    now_ms = int(time.time() * 1000)
    incoming_created_at = _coerce_int(payload.created_at, 0)
    if incoming_created_at > 0:
        row.created_at = incoming_created_at
    elif _coerce_int(row.created_at, 0) <= 0:
        row.created_at = now_ms

    incoming_updated_at = _coerce_int(payload.updated_at, 0)
    row.updated_at = incoming_updated_at if incoming_updated_at > 0 else now_ms
    row.is_deleted = False
    row.deleted_at = None


def _apply_blob_upsert_payload(
    *,
    row: ImageBlobRef,
    payload: ImageBlobPayload,
    namespace: str,
) -> None:
    actions = [
        ("data_b64", "data_object_key", "data"),
        ("source_data_b64", "source_data_object_key", "source_data"),
        ("mask_b64", "mask_object_key", "mask"),
        ("source_mask_b64", "source_mask_object_key", "source_mask"),
    ]

    for payload_field, key_field, object_field in actions:
        action, content = _resolve_blob_action(getattr(payload, payload_field))
        current_key = getattr(row, key_field)
        if action == "keep":
            continue
        if action == "clear":
            if current_key:
                delete_object(current_key)
            setattr(row, key_field, None)
            continue
        if action == "set":
            next_key = _build_object_key(namespace, row.id, object_field)
            put_bytes(
                next_key,
                _normalize_blob_content_for_storage(object_field, content),
            )
            setattr(row, key_field, next_key)

    now_ms = int(time.time() * 1000)
    incoming_updated_at = _coerce_int(payload.updated_at, 0)
    row.updated_at = incoming_updated_at if incoming_updated_at > 0 else now_ms


def _purge_blob_ref(namespace: str, image_id: str, db: Session) -> None:
    row = db.get(ImageBlobRef, (namespace, str(image_id)))
    if not row:
        return
    if row.data_object_key:
        delete_object(row.data_object_key)
    if row.source_data_object_key:
        delete_object(row.source_data_object_key)
    if row.mask_object_key:
        delete_object(row.mask_object_key)
    if row.source_mask_object_key:
        delete_object(row.source_mask_object_key)
    db.delete(row)


def _dedupe_meta_by_remote_image_id(
    *,
    namespace: str,
    keep_id: str,
    remote_image_id: str | None,
    db: Session,
) -> int:
    remote_id = str(remote_image_id or "").strip()
    if not remote_id:
        return 0
    rows = (
        db.execute(
            select(ImageMeta).where(
                ImageMeta.namespace == namespace,
                ImageMeta.remote_image_id == remote_id,
                ImageMeta.id != str(keep_id),
                ImageMeta.is_deleted.is_(False),
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return 0
    removed = 0
    for row in rows:
        _purge_blob_ref(namespace, str(row.id), db)
        db.delete(row)
        removed += 1
    return removed


def _apply_patch_payload(row: ImageMeta, payload: ImageMetaPatchPayload) -> None:
    data = payload.model_dump(by_alias=False, exclude_unset=True)
    if not data:
        return

    if "name" in data:
        row.name = str(data.get("name") or "")
    if "display_name" in data:
        row.display_name = data.get("display_name")
    if "base_name" in data:
        row.base_name = data.get("base_name")
    if "source_format" in data:
        row.source_format = data.get("source_format")
    if "source_name" in data:
        row.source_name = data.get("source_name")
    if "remote_image_id" in data:
        row.remote_image_id = (
            str(data.get("remote_image_id")) if data.get("remote_image_id") else None
        )
    if "remote_batch_id" in data:
        row.remote_batch_id = (
            str(data.get("remote_batch_id")) if data.get("remote_batch_id") else None
        )
    if "is_mask_only" in data:
        row.is_mask_only = _coerce_bool(data.get("is_mask_only"), row.is_mask_only)
    if "has_mask" in data:
        row.has_mask = _coerce_bool(data.get("has_mask"), row.has_mask)
    if "mask_attached" in data:
        row.mask_attached = _coerce_bool(data.get("mask_attached"), row.mask_attached)
    if "mask_version" in data:
        row.mask_version = _coerce_int(data.get("mask_version"), row.mask_version)
    if "mask_name" in data:
        row.mask_name = data.get("mask_name")
    if "source_mask_name" in data:
        row.source_mask_name = data.get("source_mask_name")
    if "hash" in data:
        row.hash = data.get("hash")
    if "thumbnail" in data:
        row.thumbnail = data.get("thumbnail")

    if "dicom_study_uid" in data:
        row.dicom_study_uid = data.get("dicom_study_uid")
    if "dicom_study_id" in data:
        row.dicom_study_id = data.get("dicom_study_id")
    if "dicom_series_uid" in data:
        row.dicom_series_uid = data.get("dicom_series_uid")
    if "dicom_series_description" in data:
        row.dicom_series_description = data.get("dicom_series_description")
    if "dicom_series_number" in data:
        row.dicom_series_number = _coerce_int(
            data.get("dicom_series_number"), row.dicom_series_number
        )
    if "dicom_series_order" in data:
        row.dicom_series_order = _coerce_int(
            data.get("dicom_series_order"), row.dicom_series_order
        )
    if "dicom_accession_number" in data:
        row.dicom_accession_number = data.get("dicom_accession_number")
    if "import_batch_id" in data:
        row.import_batch_id = data.get("import_batch_id")
    if "modified_by_user" in data:
        row.modified_by_user = _coerce_bool(data.get("modified_by_user"), False)

    if "custom_fields" in data:
        row.custom_fields = _coerce_dict(data.get("custom_fields"))
    if "overlay_annotations" in data:
        row.overlay_annotations = _coerce_list(data.get("overlay_annotations"))
    if "last_client_env_report" in data:
        row.last_client_env_report = _coerce_dict(data.get("last_client_env_report"))

    if "created_at" in data and data.get("created_at") is not None:
        row.created_at = _coerce_int(data.get("created_at"), row.created_at)
    row.updated_at = _coerce_int(data.get("updated_at"), int(time.time() * 1000))


@router.get("/images/count")
def get_meta_count(
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    ns = _sanitize_namespace(namespace)
    total = db.execute(
        select(func.count()).select_from(ImageMeta).where(
            ImageMeta.namespace == ns,
            ImageMeta.is_deleted.is_(False),
        )
    ).scalar_one()
    return {"count": int(total)}


@router.get("/images/id-order")
def get_meta_id_order(
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, list[str]]:
    ns = _sanitize_namespace(namespace)
    rows = db.execute(
        select(ImageMeta.id)
        .where(
            ImageMeta.namespace == ns,
            ImageMeta.is_deleted.is_(False),
        )
        .order_by(ImageMeta.created_at.asc(), ImageMeta.id.asc())
    ).all()
    return {"ids": [str(row[0]) for row in rows]}


@router.get("/images")
def list_meta_images(
    namespace: str = Query("local-default"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    offset = (page - 1) * page_size
    total = db.execute(
        select(func.count()).select_from(ImageMeta).where(
            ImageMeta.namespace == ns,
            ImageMeta.is_deleted.is_(False),
        )
    ).scalar_one()
    rows = db.execute(
        select(ImageMeta)
        .where(
            ImageMeta.namespace == ns,
            ImageMeta.is_deleted.is_(False),
        )
        .order_by(ImageMeta.created_at.asc(), ImageMeta.id.asc())
        .offset(offset)
        .limit(page_size)
    ).scalars()
    return {
        "items": [_to_response_item(row) for row in rows],
        "total": int(total),
        "page": page,
        "pageSize": page_size,
    }


@router.post("/images/by-ids")
def get_meta_images_by_ids(
    request: ByIdsRequest,
    db: Session = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    ids = [str(item or "") for item in request.ids if str(item or "").strip()]
    if not ids:
        return {"items": []}
    ns = _sanitize_namespace(request.namespace)
    rows = db.execute(
        select(ImageMeta).where(
            ImageMeta.namespace == ns,
            ImageMeta.id.in_(ids),  # noqa: S608
            ImageMeta.is_deleted.is_(False),
        )
    ).scalars()
    row_map = {str(row.id): row for row in rows}
    ordered = [row_map[item] for item in ids if item in row_map]
    return {"items": [_to_response_item(row) for row in ordered]}


@router.get("/images/by-remote/{remote_image_id}")
def get_meta_images_by_remote_id(
    remote_image_id: str,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    ns = _sanitize_namespace(namespace)
    rows = db.execute(
        select(ImageMeta)
        .where(
            ImageMeta.namespace == ns,
            ImageMeta.remote_image_id == str(remote_image_id),
            ImageMeta.is_deleted.is_(False),
        )
        .order_by(ImageMeta.updated_at.desc(), ImageMeta.created_at.desc())
    ).scalars()
    return {"items": [_to_response_item(row) for row in rows]}


@router.get("/images/by-hash/{hash_value}")
def get_meta_images_by_hash(
    hash_value: str,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    value = str(hash_value or "").strip()
    if not value:
        return {"items": []}
    ns = _sanitize_namespace(namespace)
    rows = db.execute(
        select(ImageMeta)
        .where(
            ImageMeta.namespace == ns,
            ImageMeta.hash == value,
            ImageMeta.is_deleted.is_(False),
        )
        .order_by(ImageMeta.updated_at.desc(), ImageMeta.created_at.desc())
    ).scalars()
    return {"items": [_to_response_item(row) for row in rows]}


@router.get("/images/{image_id}")
def get_meta_image(
    image_id: str,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    row = db.get(ImageMeta, (ns, str(image_id)))
    if not row or row.is_deleted:
        raise HTTPException(status_code=404, detail="meta image not found")
    return {"item": _to_response_item(row)}


@router.get("/images/{image_id}/blob")
def get_image_blob(
    image_id: str,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    row = db.get(ImageBlobRef, (ns, str(image_id)))
    if not row:
        return {"item": None}
    blob_map = get_many_bytes(
        {
            "data": row.data_object_key,
            "sourceData": row.source_data_object_key,
            "mask": row.mask_object_key,
            "sourceMask": row.source_mask_object_key,
        }
    )
    return {
        "item": _to_blob_response_item(
            row,
            data_blob=blob_map.get("data"),
            source_data_blob=blob_map.get("sourceData"),
            mask_blob=blob_map.get("mask"),
            source_mask_blob=blob_map.get("sourceMask"),
        )
    }


@router.post("/images/blob-upsert-batch")
def upsert_image_blob_batch(
    request: ImageBlobUpsertBatchRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(request.namespace)
    if not request.items:
        return {"namespace": ns, "upserted": 0}
    now_ms = int(time.time() * 1000)
    upserted = 0
    for item in request.items:
        image_id = str(item.id or "").strip()
        if not image_id:
            continue
        try:
            row = db.get(ImageBlobRef, (ns, image_id))
            if not row:
                row = ImageBlobRef(
                    namespace=ns,
                    id=image_id,
                    updated_at=now_ms,
                )
                db.add(row)
            _apply_blob_upsert_payload(
                row=row,
                payload=item,
                namespace=ns,
            )
            upserted += 1
        except HTTPException:
            db.rollback()
            raise
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            raise HTTPException(
                status_code=500,
                detail=(
                    "blob upsert failed: "
                    f"namespace={ns}, image_id={image_id}, error={type(exc).__name__}: {exc}"
                ),
            ) from exc
    db.commit()
    return {"namespace": ns, "upserted": upserted}


@router.post("/images/{image_id}/blob/raw-upsert")
async def upsert_image_blob_raw(
    image_id: str,
    namespace: str = Query("local-default"),
    updated_at: int | None = Query(None, alias="updatedAt"),
    clear_fields: str | None = Form(default=None, alias="clearFields"),
    data: UploadFile | None = File(default=None),
    source_data: UploadFile | None = File(default=None, alias="sourceData"),
    mask: UploadFile | None = File(default=None),
    source_mask: UploadFile | None = File(default=None, alias="sourceMask"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    normalized_id = str(image_id or "").strip()
    if not normalized_id:
        raise HTTPException(status_code=400, detail="image_id is required")

    clear_set: set[str] = set()
    if clear_fields:
        for raw in str(clear_fields).split(","):
            text = str(raw or "").strip()
            if not text:
                continue
            clear_set.add(_normalize_blob_field_name(text))

    uploads: dict[str, UploadFile | None] = {
        "data": data,
        "sourceData": source_data,
        "mask": mask,
        "sourceMask": source_mask,
    }

    row = db.get(ImageBlobRef, (ns, normalized_id))
    if not row:
        row = ImageBlobRef(namespace=ns, id=normalized_id, updated_at=int(time.time() * 1000))
        db.add(row)

    changed = 0
    try:
        for field_name in ["data", "sourceData", "mask", "sourceMask"]:
            key_attr, object_field = _blob_field_config(field_name)
            current_key = getattr(row, key_attr)
            if field_name in clear_set:
                if current_key:
                    delete_object(current_key)
                setattr(row, key_attr, None)
                changed += 1

            upload = uploads.get(field_name)
            if upload is not None:
                content = await upload.read()
                next_key = _build_object_key(ns, normalized_id, object_field)
                put_bytes(
                    next_key,
                    _normalize_blob_content_for_storage(object_field, content),
                )
                setattr(row, key_attr, next_key)
                changed += 1

        if changed <= 0:
            return {"namespace": ns, "id": normalized_id, "updated": False}

        now_ms = int(time.time() * 1000)
        row.updated_at = _coerce_int(updated_at, now_ms) if updated_at is not None else now_ms
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail=(
                "blob raw upsert failed: "
                f"namespace={ns}, image_id={normalized_id}, error={type(exc).__name__}: {exc}"
            ),
        ) from exc

    return {"namespace": ns, "id": normalized_id, "updated": True}


@router.delete("/images/{image_id}/blob")
def delete_image_blob(
    image_id: str,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    row = db.get(ImageBlobRef, (ns, str(image_id)))
    if not row:
        return {"deleted": False}
    _purge_blob_ref(ns, str(image_id), db)
    db.commit()
    return {"deleted": True}


@router.delete("/images/blob")
def clear_image_blobs(
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    ns = _sanitize_namespace(namespace)
    rows = db.execute(select(ImageBlobRef).where(ImageBlobRef.namespace == ns)).scalars()
    for row in rows:
        if row.data_object_key:
            delete_object(row.data_object_key)
        if row.source_data_object_key:
            delete_object(row.source_data_object_key)
        if row.mask_object_key:
            delete_object(row.mask_object_key)
        if row.source_mask_object_key:
            delete_object(row.source_mask_object_key)

    result = db.execute(delete(ImageBlobRef).where(ImageBlobRef.namespace == ns))
    db.commit()
    return {"deleted": int(result.rowcount or 0)}


@router.post("/images/dedupe")
def dedupe_meta_images(
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    rows = (
        db.execute(
            select(ImageMeta)
            .where(
                ImageMeta.namespace == ns,
                ImageMeta.is_deleted.is_(False),
                ImageMeta.remote_image_id.is_not(None),
                ImageMeta.remote_image_id != "",
            )
            .order_by(
                ImageMeta.remote_image_id.asc(),
                ImageMeta.updated_at.desc(),
                ImageMeta.created_at.desc(),
                ImageMeta.id.desc(),
            )
        )
        .scalars()
        .all()
    )
    seen_remote_ids: set[str] = set()
    removed_meta = 0
    removed_blob_ref = 0
    for row in rows:
        remote_id = str(row.remote_image_id or "").strip()
        if not remote_id:
            continue
        if remote_id in seen_remote_ids:
            if db.get(ImageBlobRef, (ns, str(row.id))):
                _purge_blob_ref(ns, str(row.id), db)
                removed_blob_ref += 1
            db.delete(row)
            removed_meta += 1
            continue
        seen_remote_ids.add(remote_id)

    blob_rows = (
        db.execute(select(ImageBlobRef).where(ImageBlobRef.namespace == ns))
        .scalars()
        .all()
    )
    removed_orphan_blob_ref = 0
    for blob_row in blob_rows:
        linked_meta = db.get(ImageMeta, (ns, str(blob_row.id)))
        if linked_meta and not linked_meta.is_deleted:
            continue
        _purge_blob_ref(ns, str(blob_row.id), db)
        removed_orphan_blob_ref += 1

    db.commit()
    return {
        "namespace": ns,
        "removedMeta": removed_meta,
        "removedBlobRefByMeta": removed_blob_ref,
        "removedOrphanBlobRef": removed_orphan_blob_ref,
    }


@router.post("/images/upsert-batch")
def upsert_meta_images_batch(
    request: UpsertBatchRequest,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(request.namespace)
    if not request.items:
        return {"namespace": ns, "upserted": 0}
    now_ms = int(time.time() * 1000)
    upserted = 0
    deduped = 0
    for item in request.items:
        image_id = str(item.id or "").strip()
        if not image_id:
            continue
        row = db.get(ImageMeta, (ns, image_id))
        if not row:
            row = ImageMeta(
                namespace=ns,
                id=image_id,
                created_at=now_ms,
                updated_at=now_ms,
            )
            db.add(row)
        elif row.is_deleted:
            row.is_deleted = False
            row.deleted_at = None
        _apply_upsert_payload(row, item)
        deduped += _dedupe_meta_by_remote_image_id(
            namespace=ns,
            keep_id=image_id,
            remote_image_id=row.remote_image_id,
            db=db,
        )
        upserted += 1
    db.commit()
    return {"namespace": ns, "upserted": upserted, "deduped": deduped}


@router.patch("/images/{image_id}")
def patch_meta_image(
    image_id: str,
    payload: ImageMetaPatchPayload,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    row = db.get(ImageMeta, (ns, str(image_id)))
    if not row or row.is_deleted:
        raise HTTPException(status_code=404, detail="meta image not found")
    _apply_patch_payload(row, payload)
    _dedupe_meta_by_remote_image_id(
        namespace=ns,
        keep_id=str(row.id),
        remote_image_id=row.remote_image_id,
        db=db,
    )
    db.commit()
    db.refresh(row)
    return {"item": _to_response_item(row)}


@router.delete("/images/{image_id}")
def delete_meta_image(
    image_id: str,
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ns = _sanitize_namespace(namespace)
    row = db.get(ImageMeta, (ns, str(image_id)))
    if not row or row.is_deleted:
        return {"deleted": False}
    row.is_deleted = True
    row.deleted_at = int(time.time() * 1000)
    row.updated_at = row.deleted_at
    db.commit()
    return {"deleted": True}


@router.delete("/images")
def clear_meta_images(
    namespace: str = Query("local-default"),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    ns = _sanitize_namespace(namespace)
    now_ms = int(time.time() * 1000)
    result = db.execute(
        update(ImageMeta)
        .where(
            ImageMeta.namespace == ns,
            ImageMeta.is_deleted.is_(False),
        )
        .values(
            is_deleted=True,
            deleted_at=now_ms,
            updated_at=now_ms,
        )
    )
    db.commit()
    return {"deleted": int(result.rowcount or 0)}
