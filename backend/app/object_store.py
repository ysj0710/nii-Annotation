from __future__ import annotations

import os
from io import BytesIO

from minio import Minio
from minio.error import S3Error


def _bool_env(name: str, default: bool = False) -> bool:
    raw = str(os.getenv(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y", "on"}


OBJECT_STORE_ENDPOINT = os.getenv("ANNOTATION_MINIO_ENDPOINT", "127.0.0.1:9000").strip()
OBJECT_STORE_ACCESS_KEY = os.getenv("ANNOTATION_MINIO_ACCESS_KEY", "minioadmin").strip()
OBJECT_STORE_SECRET_KEY = os.getenv("ANNOTATION_MINIO_SECRET_KEY", "minioadmin").strip()
OBJECT_STORE_BUCKET = os.getenv("ANNOTATION_MINIO_BUCKET", "nii-annotation").strip() or "nii-annotation"
OBJECT_STORE_SECURE = _bool_env("ANNOTATION_MINIO_SECURE", False)

_client: Minio | None = None


def _get_client() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            OBJECT_STORE_ENDPOINT,
            access_key=OBJECT_STORE_ACCESS_KEY,
            secret_key=OBJECT_STORE_SECRET_KEY,
            secure=OBJECT_STORE_SECURE,
        )
    return _client


def ensure_bucket() -> None:
    client = _get_client()
    if client.bucket_exists(OBJECT_STORE_BUCKET):
        return
    client.make_bucket(OBJECT_STORE_BUCKET)


def put_bytes(object_key: str, content: bytes, content_type: str = "application/octet-stream") -> None:
    payload = content if isinstance(content, bytes) else bytes(content or b"")
    data = BytesIO(payload)
    client = _get_client()
    client.put_object(
        OBJECT_STORE_BUCKET,
        object_key,
        data=data,
        length=len(payload),
        content_type=content_type,
    )


def get_bytes(object_key: str) -> bytes | None:
    client = _get_client()
    try:
        resp = client.get_object(OBJECT_STORE_BUCKET, object_key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
            return None
        raise


def delete_object(object_key: str) -> None:
    client = _get_client()
    try:
        client.remove_object(OBJECT_STORE_BUCKET, object_key)
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
            return
        raise
