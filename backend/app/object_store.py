from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
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
_read_pool: ThreadPoolExecutor | None = None


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


def _get_read_pool() -> ThreadPoolExecutor:
    global _read_pool
    if _read_pool is None:
        try:
            raw_workers = int(str(os.getenv("ANNOTATION_OBJECT_READ_WORKERS", "8") or "8"))
        except Exception:  # noqa: BLE001
            raw_workers = 8
        workers = max(2, raw_workers)
        _read_pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="obj-read")
    return _read_pool


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


def get_many_bytes(object_keys: dict[str, str | None]) -> dict[str, bytes | None]:
    """
    Parallel object reads to avoid cumulative network RTT on multi-field blob fetch.
    """
    results: dict[str, bytes | None] = {field: None for field in object_keys}
    key_to_fields: dict[str, list[str]] = {}

    for field, raw_key in object_keys.items():
        object_key = str(raw_key or "").strip()
        if not object_key:
            continue
        key_to_fields.setdefault(object_key, []).append(field)

    if not key_to_fields:
        return results

    pool = _get_read_pool()
    future_to_key = {pool.submit(get_bytes, object_key): object_key for object_key in key_to_fields}

    for future in as_completed(future_to_key):
        object_key = future_to_key[future]
        payload = future.result()
        for field in key_to_fields[object_key]:
            results[field] = payload

    return results


def delete_object(object_key: str) -> None:
    client = _get_client()
    try:
        client.remove_object(OBJECT_STORE_BUCKET, object_key)
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject", "NoSuchBucket"}:
            return
        raise
