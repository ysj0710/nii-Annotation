from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .services.exporter import ExportValidationError, build_export_zip

app = FastAPI(title="Nii Annotation Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        zip_name, zip_bytes = build_export_zip(
            image_bytes=image_bytes,
            mask_bytes=mask_bytes,
            annotations_bytes=annotations_bytes,
            image_filename=image.filename or "image.nii.gz",
            mask_filename=mask.filename or "mask.nii.gz",
            image_id=image_id,
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
