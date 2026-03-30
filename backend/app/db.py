import os
from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DEFAULT_DB_URL = (
    "mysql+pymysql://root:KBI888@192.168.112.72:3306/Nii_Annotation?charset=utf8mb4"
)


class Base(DeclarativeBase):
    pass


def _resolve_database_url() -> str:
    raw = os.getenv("ANNOTATION_DB_URL", DEFAULT_DB_URL).strip()
    return raw or DEFAULT_DB_URL


engine = create_engine(
    _resolve_database_url(),
    pool_pre_ping=True,
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_soft_delete_columns()


def _ensure_soft_delete_columns() -> None:
    inspector = inspect(engine)
    if "image_meta" not in inspector.get_table_names():
        return

    existing_columns = {col.get("name") for col in inspector.get_columns("image_meta")}
    existing_indexes = {idx.get("name") for idx in inspector.get_indexes("image_meta")}
    with engine.begin() as conn:
        if "is_deleted" not in existing_columns:
            conn.execute(
                text(
                    "ALTER TABLE image_meta "
                    "ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT 0"
                )
            )
        if "deleted_at" not in existing_columns:
            conn.execute(text("ALTER TABLE image_meta ADD COLUMN deleted_at BIGINT NULL"))
        if "ix_image_meta_ns_deleted" not in existing_indexes:
            conn.execute(
                text(
                    "CREATE INDEX ix_image_meta_ns_deleted "
                    "ON image_meta (namespace, is_deleted)"
                )
            )
