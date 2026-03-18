from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime
from typing import Any

import nibabel as nib
import numpy as np


class ExportValidationError(ValueError):
    """Raised when incoming files are valid multipart but invalid NIfTI payloads."""


def _load_nifti(buffer: bytes, field_name: str) -> nib.Nifti1Image:
    try:
        image = nib.Nifti1Image.from_bytes(buffer)
    except Exception as exc:  # noqa: BLE001
        raise ExportValidationError(f"{field_name} is not a valid NIfTI file") from exc
    if not isinstance(image, nib.Nifti1Image):
        raise ExportValidationError(f"{field_name} is not a NIfTI-1 image")
    return image


def _normalize_mask(mask_image: nib.Nifti1Image, image_shape: tuple[int, ...]) -> np.ndarray:
    mask_data = np.asanyarray(mask_image.dataobj)
    while mask_data.ndim > 3 and mask_data.shape[-1] == 1:
        mask_data = np.squeeze(mask_data, axis=-1)

    target_shape = tuple(int(v) for v in image_shape[:3])
    if mask_data.shape != target_shape:
        if int(mask_data.size) != int(np.prod(target_shape)):
            raise ExportValidationError(
                f"mask shape {mask_data.shape} does not match image shape {target_shape}"
            )
        mask_data = np.reshape(mask_data, target_shape)

    mask_u16 = np.clip(np.rint(mask_data), 0, np.iinfo(np.uint16).max).astype(np.uint16, copy=False)
    return mask_u16


def _normalize_annotations_json(raw: bytes) -> dict[str, Any]:
    if not raw:
        return {"labels": [], "annotations": []}
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ExportValidationError("annotations is not valid JSON") from exc

    if not isinstance(payload, dict):
        raise ExportValidationError("annotations JSON must be an object")
    labels = payload.get("labels", [])
    annotations = payload.get("annotations", [])
    return {
        "labels": labels if isinstance(labels, list) else [],
        "annotations": annotations if isinstance(annotations, list) else [],
    }


def build_export_zip(
    *,
    image_bytes: bytes,
    mask_bytes: bytes,
    annotations_bytes: bytes,
    image_filename: str,
    mask_filename: str,
    image_id: str,
) -> tuple[str, bytes]:
    image_nifti = _load_nifti(image_bytes, "image")
    mask_nifti = _load_nifti(mask_bytes, "mask")
    normalized_mask = _normalize_mask(mask_nifti, image_nifti.shape)

    mask_header = image_nifti.header.copy()
    mask_header.set_data_dtype(np.uint16)
    merged_mask = nib.Nifti1Image(normalized_mask, image_nifti.affine, mask_header)

    annotations = _normalize_annotations_json(annotations_bytes)
    annotations["imageId"] = str(image_id or "")
    annotations["imageFile"] = f"img/{image_filename}"
    annotations["maskFile"] = "mask/mask.nii.gz"
    annotations["exportedAt"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"

    mask_payload = merged_mask.to_bytes()

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"img/{image_filename}", image_bytes)
        zf.writestr("mask/mask.nii.gz", mask_payload)
        zf.writestr("mask/annotations.json", json.dumps(annotations, ensure_ascii=False, indent=2).encode("utf-8"))
        zf.writestr("mask/source_mask_filename.txt", mask_filename or "mask.nii.gz")
    zip_buffer.seek(0)

    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    safe_image_id = str(image_id or "image")
    zip_name = f"{safe_image_id}_{timestamp}.zip"
    return zip_name, zip_buffer.read()
