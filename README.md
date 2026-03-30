# Nii Annotation (MVP)

基础架构已搭好：
- **frontend/** React + Niivue（上传 + 影像显示基础骨架）
- **backend/** FastAPI（/export 占位接口）

## 目录结构
```
Nii-Annotation/
  frontend/
    src/
      App.jsx
      components/Viewer.jsx
      styles.css
  backend/
    app/main.py
    app/services/exporter.py
    requirements.txt
```

## 开发启动
### 前端
```
cd frontend
npm i
npm run dev
```

### 后端
```
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# MySQL 元数据库（示例）
# export ANNOTATION_DB_URL='mysql+pymysql://user:password@127.0.0.1:3306/Nii-Annotation?charset=utf8mb4'
# MinIO（内网对象存储，示例）
# export ANNOTATION_MINIO_ENDPOINT='127.0.0.1:9000'
# export ANNOTATION_MINIO_ACCESS_KEY='minioadmin'
# export ANNOTATION_MINIO_SECRET_KEY='minioadmin'
# export ANNOTATION_MINIO_BUCKET='nii-annotation'
# export ANNOTATION_MINIO_SECURE='false'
uvicorn app.main:app --reload --port 8010
```

## 存储架构（生产建议）
- 新增后端 `meta` API，默认使用 `ANNOTATION_DB_URL` 指向 MySQL。
- 元数据存储在 MySQL；影像/掩码 Blob 存储在内网 MinIO（S3 兼容）。
- 前端保留 IndexedDB 作为缓存，同时把数据同步到后端。
- 关键接口前缀：`/meta/images/*`（meta 与 blob upsert/query/delete）。

## 远程部署 MinIO
- 已提供一键安装脚本：`deploy/minio/install_minio.sh`（Linux + systemd）。
- 详细步骤见：`deploy/minio/README.md`。
- 最简执行：
```
chmod +x deploy/minio/install_minio.sh
sudo bash deploy/minio/install_minio.sh
```

## 下一步
- Viewer: 加入切片/方向切换、WL/WW、缩放平移
- Label 管理 & 标注工具
- /export 后端实现（nibabel 写 mask + zip）
