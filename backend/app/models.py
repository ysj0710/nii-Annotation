from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class ImageMeta(Base):
    __tablename__ = "image_meta"

    namespace: Mapped[str] = mapped_column(String(191), primary_key=True)
    id: Mapped[str] = mapped_column(String(191), primary_key=True)

    name: Mapped[str] = mapped_column(String(512), default="")
    display_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    base_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_format: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    remote_image_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    remote_batch_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    is_mask_only: Mapped[bool] = mapped_column(Boolean, default=False)
    has_mask: Mapped[bool] = mapped_column(Boolean, default=False)
    mask_attached: Mapped[bool] = mapped_column(Boolean, default=False)
    mask_version: Mapped[int] = mapped_column(Integer, default=0)
    mask_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_mask_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    hash: Mapped[str | None] = mapped_column(String(191), nullable=True)
    thumbnail: Mapped[str | None] = mapped_column(Text, nullable=True)

    dicom_study_uid: Mapped[str | None] = mapped_column(String(191), nullable=True)
    dicom_study_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    dicom_series_uid: Mapped[str | None] = mapped_column(String(191), nullable=True)
    dicom_series_description: Mapped[str | None] = mapped_column(String(512), nullable=True)
    dicom_series_number: Mapped[int] = mapped_column(Integer, default=0)
    dicom_series_order: Mapped[int] = mapped_column(Integer, default=0)
    dicom_accession_number: Mapped[str | None] = mapped_column(String(191), nullable=True)

    import_batch_id: Mapped[str | None] = mapped_column(String(191), nullable=True)
    modified_by_user: Mapped[bool] = mapped_column(Boolean, default=False)

    custom_fields: Mapped[dict] = mapped_column(JSON, default=dict)
    overlay_annotations: Mapped[list] = mapped_column(JSON, default=list)
    last_client_env_report: Mapped[dict] = mapped_column(JSON, default=dict)

    created_at: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=0)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    __table_args__ = (
        Index("ix_image_meta_ns_created", "namespace", "created_at"),
        Index("ix_image_meta_ns_updated", "namespace", "updated_at"),
        Index("ix_image_meta_ns_remote", "namespace", "remote_image_id"),
        Index("ix_image_meta_ns_batch", "namespace", "remote_batch_id"),
        Index("ix_image_meta_ns_hash", "namespace", "hash"),
        Index("ix_image_meta_ns_deleted", "namespace", "is_deleted"),
    )


class ImageBlobRef(Base):
    __tablename__ = "image_blob_ref"

    namespace: Mapped[str] = mapped_column(String(191), primary_key=True)
    id: Mapped[str] = mapped_column(String(191), primary_key=True)

    data_object_key: Mapped[str | None] = mapped_column(String(768), nullable=True)
    source_data_object_key: Mapped[str | None] = mapped_column(String(768), nullable=True)
    mask_object_key: Mapped[str | None] = mapped_column(String(768), nullable=True)
    source_mask_object_key: Mapped[str | None] = mapped_column(String(768), nullable=True)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=0)

    __table_args__ = (
        Index("ix_image_blob_ns_updated", "namespace", "updated_at"),
    )
