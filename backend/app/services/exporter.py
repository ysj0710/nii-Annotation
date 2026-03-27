from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime
from pathlib import Path
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
        return {"labels": [], "annotations": [], "customFields": {}}
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ExportValidationError("annotations is not valid JSON") from exc

    if not isinstance(payload, dict):
        raise ExportValidationError("annotations JSON must be an object")
    labels = payload.get("labels", [])
    annotations = payload.get("annotations", [])
    custom_fields = payload.get("customFields", {})
    return {
        "labels": labels if isinstance(labels, list) else [],
        "annotations": annotations if isinstance(annotations, list) else [],
        "customFields": custom_fields if isinstance(custom_fields, dict) else {},
    }


def _strip_known_image_suffix(name: str) -> str:
    value = (name or "").strip()
    lower = value.lower()
    if lower.endswith(".nii.gz"):
        return value[:-7]
    if lower.endswith(".nii"):
        return value[:-4]
    if "." in value:
        return value.rsplit(".", 1)[0]
    return value


def _extract_label_value(annotations: dict[str, Any]) -> str:
    custom_fields = annotations.get("customFields", {})
    if not isinstance(custom_fields, dict):
        return ""

    direct = custom_fields.get("label")
    if direct is not None and str(direct).strip():
        return str(direct).strip()

    workflow_raw = custom_fields.get("__workflow__")
    workflow = None
    if isinstance(workflow_raw, dict):
        workflow = workflow_raw
    elif isinstance(workflow_raw, str) and workflow_raw.strip():
        try:
            parsed = json.loads(workflow_raw)
            if isinstance(parsed, dict):
                workflow = parsed
        except Exception:
            workflow = None
    if not isinstance(workflow, dict):
        return ""

    steps = workflow.get("steps")
    if not isinstance(steps, dict):
        return ""
    for step_val in steps.values():
        if not isinstance(step_val, dict):
            continue
        cards = step_val.get("cards")
        if not isinstance(cards, list):
            continue
        for card in cards:
            if not isinstance(card, dict):
                continue
            main_category = card.get("mainCategory")
            if main_category is not None and str(main_category).strip():
                return str(main_category).strip()
    return ""


def _build_labels_csv(image_filename: str, label_value: str) -> bytes:
    image_id = _strip_known_image_suffix(Path(image_filename or "image.nii.gz").name)
    # CSV escaping for double quotes
    safe_id = str(image_id).replace('"', '""')
    safe_label = str(label_value or "").replace('"', '""')
    csv_text = f'ID,label\n"{safe_id}","{safe_label}"\n'
    return csv_text.encode("utf-8")


def build_export_zip(
    *,
    image_bytes: bytes,
    mask_bytes: bytes,
    annotations_bytes: bytes,
    image_filename: str,
    mask_filename: str,
    image_id: str,
    storage_root: str | None = None,
) -> tuple[str, bytes]:
    image_filename = Path(image_filename or "image.nii.gz").name
    mask_filename = Path(mask_filename or "mask.nii.gz").name
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
    label_value = _extract_label_value(annotations)

    mask_payload = merged_mask.to_bytes()
    annotations_payload = json.dumps(annotations, ensure_ascii=False, indent=2).encode("utf-8")
    labels_csv_payload = _build_labels_csv(image_filename, label_value)

    if storage_root:
        root = Path(storage_root).expanduser().resolve()
        safe_image_id = str(image_id or "image")
        case_root = root / safe_image_id
        img_dir = case_root / "img"
        mask_dir = case_root / "mask"
        img_dir.mkdir(parents=True, exist_ok=True)
        mask_dir.mkdir(parents=True, exist_ok=True)
        (img_dir / image_filename).write_bytes(image_bytes)
        (mask_dir / "mask.nii.gz").write_bytes(mask_payload)
        (mask_dir / "annotations.json").write_bytes(annotations_payload)
        (mask_dir / "source_mask_filename.txt").write_text(mask_filename or "mask.nii.gz", encoding="utf-8")
        (case_root / "labels.csv").write_bytes(labels_csv_payload)

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"img/{image_filename}", image_bytes)
        zf.writestr("mask/mask.nii.gz", mask_payload)
        zf.writestr("mask/annotations.json", annotations_payload)
        zf.writestr("mask/source_mask_filename.txt", mask_filename or "mask.nii.gz")
        zf.writestr("labels.csv", labels_csv_payload)
    zip_buffer.seek(0)

    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    safe_image_id = str(image_id or "image")
    zip_name = f"{safe_image_id}_{timestamp}.zip"
    return zip_name, zip_buffer.read()
