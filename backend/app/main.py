from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse

app = FastAPI(title="Nii Annotation Backend", version="0.1.0")


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
    # TODO: implement
    # 1) read image (nibabel)
    # 2) read mask array
    # 3) write mask.nii.gz with image affine
    # 4) zip img/ + mask/
    return JSONResponse({"detail": "not implemented"}, status_code=501)
