# 轻量级影像标注系统需求文档（NIfTI / Niivue）

> 版本：PRD v0.5（整合版）  
> 技术栈：React + Niivue（前端）；最小后端（FastAPI + nibabel）负责写 NIfTI  
> 目标优先级：**完成标注功能优先（浏览 + 点/框 + 分割 mask + 导出）**  
> 时区：Asia/Shanghai（本地时间）

---

## 1. 项目概述

### 1.1 项目名称
轻量级影像标注系统（NIfTI .nii / .nii.gz）

### 1.2 背景
现有标注工具较重或偏桌面端。需自研一套 Web 端轻量标注工具，用于 NIfTI 医学影像的浏览与标注，并将结果导出供组学特征提取流程使用。

### 1.3 项目目标（MVP）
- 浏览器中加载并浏览 NIfTI 2D/3D 影像（.nii / .nii.gz）
- 支持两类标注：
  1) **检测标注**：点（Point）、框（BBox）
  2) **分割标注**：画笔/橡皮生成 **mask（NIfTI label image）**
- 导出为一个压缩包，包含原图与标注 mask（空间一致，可直接用于组学）

### 1.4 非目标（MVP 不做）
- 数据集/任务管理、多病例列表、多人协作、权限体系
- 跨切片自动传播、3D 连续刷
- 智能分割（阈值/区域增长/AI）
- DICOM 全链路

---

## 2. 用户与使用场景

### 2.1 用户角色
- 标注员：打开影像、标注、导出
- 组学/算法人员：使用导出包（image+mask+json）进行特征提取

### 2.2 核心场景（MVP）
1) 打开系统 → 上传 `.nii/.nii.gz`
2) 单视图浏览定位目标 → 画点/框/刷 mask
3) 点击导出 → 得到一个 zip 包
4) 组学流程读取包内 `img/` 原图与 `mask/` mask，直接做 ROI 特征提取

---

## 3. 功能需求

> 优先级：P0=必须；P1=增强

### 3.1 影像加载（P0）
- 支持本地上传 `.nii`、`.nii.gz`
- 显示加载状态（loading / error）与失败提示
- 展示基础信息：dims、spacing（可获取则展示）

**验收**：常见 NIfTI 文件可加载并进入可交互浏览状态；解析失败有明确错误提示。

---

### 3.2 影像浏览（P0 单视图；P1 三视图）

#### 3.2.1 单视图（P0 必须）
- 方向切换：Axial / Coronal / Sagittal（至少可切换）
- 切片滚动：鼠标滚轮 + slider
- 缩放 / 平移
- 显示：sliceIndex、坐标（ijk/world 至少一种）、像素值（若可取）
- WL/WW：提供基础调节能力

**验收**：切片切换响应合理；方向切换后显示正确。

#### 3.2.2 三视图联动（P1）
- 三视图同屏
- 十字准星联动

---

### 3.3 标签（Label）管理（P0）
- 新增/编辑/删除 label
- label 字段：`id / name / color / index`
- `index` 为整数，从 1..N，用于多值 mask 编码（0 保留为背景）

**验收**：无 label 时不能创建标注（提示创建/选择 label）；修改 label 后标注颜色更新。

---

### 3.4 检测标注（P0）
**类型**：Point、BBox

**能力**：
- 创建：选择工具后在当前切片创建
- 编辑：选中、移动、删除（BBox 缩放可 P1）
- 标注列表：展示/定位/过滤（按 label）

**绑定规则（MVP 固化）**：
- 标注绑定 `view + sliceIndex`
- 坐标统一保存为 `ijk`（体素索引）

**验收**：切片切换只显示当前切片标注；导出/导入后位置一致（允许像素级误差）。

---

### 3.5 分割标注（P0）
**工具**：Brush、Eraser

**能力**：
- 当前切片刷写 mask：
  - Brush：写 `maskVoxel = activeLabel.index`
  - Eraser：写 `maskVoxel = 0`
- 参数：brushRadius、overlayOpacity
- mask overlay 可开关

**多类别与互斥覆盖（定版）**：
- 允许一个 `mask.nii.gz` 中同时包含多个 label（多值）
- **同一体素互斥**：同一体素只能属于一个 label；后刷的 label 覆盖先前值

**验收**：涂抹后 overlay 即时可见；切片切换后能看到对应切片 mask；导出 mask 与原图空间一致。

---

### 3.6 导出（P0）
- 导出为 **一个 zip 包**
- 结构：包含 `img/` 与 `mask/` 两个主文件夹
- 原始 NIfTI 放在 `img/`；标注后的 `mask.nii.gz` 放在 `mask/`

**导出命名（定版，本地时间 Asia/Shanghai）**：
- `<imageId>_<YYYYMMDDHHmmss>.zip`
- `imageId` 仅允许 `[A-Za-z0-9_-]+`，其他字符替换为 `_`

**导出实现约束（定版）**：
- 前端负责：生成 `annotations.json`（元数据、label 映射、点/框标注）
- 后端负责：读取原图空间信息并写出 NIfTI mask；并将导出内容打包 zip

**后端端口（开发期）**：8010

---

## 4. 导出包规范（Export Package Spec v0.1）

### 4.1 目录结构（定版）
```
<imageId>_<YYYYMMDDHHmmss>.zip
  img/
    image.nii.gz
  mask/
    mask.nii.gz
    annotations.json
    (可选) mask_<labelId>.nii.gz
```

说明：
- `img/image.nii.gz`：原始影像文件（建议统一重命名为固定名，便于组学脚本读取）
- `mask/mask.nii.gz`：多值 segmentation mask（dtype 建议 uint16）
- `mask/annotations.json`：label 映射 + 检测标注 + 文件引用（不包含 mask 数据）
- `mask/mask_<labelId>.nii.gz`：可选，每个 label 一个二值 mask（dtype 建议 uint8）

> 若需要更规整，可将 per-label mask 放入 `mask/per_label/` 子目录；但默认采用“平铺”以减少下游遍历复杂度。

### 4.2 空间一致性硬约束
- `mask/mask.nii.gz` 必须与 `img/image.nii.gz`：
  - dims 一致
  - affine/qform/sform（等价空间信息）一致
- 由后端读取 `img/image.nii.gz` 的空间信息并写出 mask

---

## 5. annotations.json Schema（v0.4.1）

> 说明：**不存储 mask 数据**（不转 JSON，不存 RLE）；仅记录引用与约定。

### 5.1 顶层结构
```json
{
  "schemaVersion": "0.4.1",
  "exportedAt": "2026-03-11T06:20:00Z",
  "app": {
    "name": "light-annotator",
    "version": "0.1.0",
    "platform": "web",
    "niivueVersion": "x.y.z"
  },
  "image": {
    "id": "case001",
    "path": "img/image.nii.gz",
    "sourceFilename": "case001.nii.gz",
    "dims": [512, 512, 120],
    "spacing": [0.7, 0.7, 1.5]
  },
  "labels": [
    { "id": "tumor", "name": "Tumor", "color": "#ff3b30", "index": 1 }
  ],
  "annotations": [],
  "segmentation": {
    "enabled": true,
    "encoding": "nifti",
    "multivalueMask": {
      "path": "mask/mask.nii.gz",
      "dtype": "uint16",
      "background": 0,
      "labelIndexSource": "labels.index"
    },
    "perLabelMasks": {
      "enabled": true,
      "naming": "mask/mask_<labelId>.nii.gz",
      "dtype": "uint8",
      "foreground": 1,
      "background": 0
    }
  },
  "meta": {
    "sliceIndexBase": 0
  }
}
```

### 5.2 labels 约束
- `labels[].index` 必须唯一、且从 1..N
- 0 保留为背景，不得出现在 labels 中

### 5.3 annotations（检测标注）
#### Point
```json
{
  "id": "ann-pt-001",
  "type": "point",
  "labelId": "tumor",
  "view": "axial",
  "sliceIndex": 42,
  "coordSystem": "ijk",
  "ijk": { "i": 120, "j": 200, "k": 42 },
  "createdAt": "2026-03-11T06:15:00Z"
}
```

#### BBox
```json
{
  "id": "ann-bb-001",
  "type": "bbox",
  "labelId": "tumor",
  "view": "axial",
  "sliceIndex": 42,
  "coordSystem": "ijk",
  "rectIJK": { "k": 42, "i0": 120, "j0": 200, "i1": 180, "j1": 260 },
  "createdAt": "2026-03-11T06:18:00Z"
}
```

**sliceIndex 约定（定版）**：0-based（从 0 开始）。

---

## 6. 最小后端（开发期）说明

### 6.1 后端职责
- 接收前端传入的 mask 数组（以及 label 信息等）
- 读取原图 `img/image.nii.gz` 的 affine/header
- 写出：
  - `mask/mask.nii.gz`（多值）
  - `mask/mask_<labelId>.nii.gz`（可选，二值）
- 将 `img/`、`mask/` 打包成 zip 返回

### 6.2 开发期端口
- 使用 **8010**

---

## 7. MVP 验收用例（必须全部通过）
1) 上传 `.nii.gz` → 单视图可浏览（滚轮/slider）
2) 新建 label（index=1）→ 点标注、框标注可创建/删除
3) Brush 在某切片涂抹 → overlay 可见；Eraser 可擦除
4) 导出 → 得到 `<imageId>_<YYYYMMDDHHmmss>.zip`，内部仅有 `img/` 与 `mask/`
5) 组学侧读取 `img/image.nii.gz` 与 `mask/mask.nii.gz` 空间一致（dims/affine 正常）
