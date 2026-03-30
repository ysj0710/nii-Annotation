import os

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .db import init_db
from .meta_api import router as meta_router
from .object_store import ensure_bucket
from .services.exporter import ExportValidationError, build_export_zip

app = FastAPI(title="Nii Annotation Backend", version="0.1.0")


def _normalize_origin(raw: str) -> str:
    value = str(raw or "").strip().strip("'\"").rstrip("/")
    return value


def _resolve_cors_origins() -> list[str]:
    cors_origins_env = os.getenv(
        "ANNOTATION_CORS_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173,http://192.168.110.88:5173",
    )
    items = []
    for origin in str(cors_origins_env or "").split(","):
        normalized = _normalize_origin(origin)
        if normalized:
            items.append(normalized)
    if items:
        return items
    return [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://192.168.110.88:5173",
    ]


allow_origins = _resolve_cors_origins()
allow_origin_regex = _normalize_origin(os.getenv("ANNOTATION_CORS_ORIGIN_REGEX", ""))
if not allow_origin_regex:
    allow_origin_regex = (
        r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$"
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(meta_router)


@app.on_event("startup")
def on_startup():
    init_db()
    ensure_bucket()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/export")
async def export_package(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    annotations: UploadFile = File(...),
    image_id: str = Form(...),
):
    image_bytes = await image.read()
    mask_bytes = await mask.read()
    annotations_bytes = await annotations.read()
    if not image_bytes or not mask_bytes:
        raise HTTPException(status_code=400, detail="image/mask payload is empty")
    try:
        storage_root = os.getenv("ANNOTATION_STORAGE_ROOT", "./storage")
        zip_name, zip_bytes = build_export_zip(
            image_bytes=image_bytes,
            mask_bytes=mask_bytes,
            annotations_bytes=annotations_bytes,
            image_filename=image.filename or "image.nii.gz",
            mask_filename=mask.filename or "mask.nii.gz",
            image_id=image_id,
            storage_root=storage_root,
        )
    except ExportValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"failed to export package: {exc}") from exc

    return StreamingResponse(
        iter([zip_bytes]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{zip_name}"'},
    )
