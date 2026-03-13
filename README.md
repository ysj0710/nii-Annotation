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
uvicorn app.main:app --reload --port 8010
```

## 下一步
- Viewer: 加入切片/方向切换、WL/WW、缩放平移
- Label 管理 & 标注工具
- /export 后端实现（nibabel 写 mask + zip）
