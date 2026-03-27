import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Layout,
  Button,
  Space,
  Input,
  Select,
  Radio,
  Checkbox,
  InputNumber,
  Popover,
  Message,
  Modal,
} from "@arco-design/web-react";
import JSZip from "jszip";
import * as nifti from "nifti-reader-js";
import dicomParser from "dicom-parser";
import {
  getAllImages,
  getImageById,
  getImagesByRemoteImageId,
  saveImages,
  updateImage,
  clearAllImages,
  getImageIdOrder,
  getImageMetasByIds,
  setImageStoreNamespace,
} from "./utils/imageStore.js";
import { resolveAutoWindowRange } from "./utils/windowPresets.js";

const Viewer = lazy(() => import("./components/Viewer.jsx"));

let niivueCtorPromise = null;
const loadNiivueCtor = async () => {
  if (!niivueCtorPromise) {
    niivueCtorPromise = import("@niivue/niivue").then((mod) => mod.Niivue);
  }
  return niivueCtorPromise;
};

let niivueDicomLoaderPromise = null;
const loadNiivueDicomLoader = async () => {
  if (!niivueDicomLoaderPromise) {
    niivueDicomLoaderPromise = import("@niivue/dicom-loader").then(
      (mod) => mod.dicomLoader,
    );
  }
  return niivueDicomLoaderPromise;
};

const { Header, Sider, Content } = Layout;
const Option = Select.Option;

const FIXED_LABELS = [
  { id: 1, name: "label1", color: "#FF6B6B", value: 1 },
  { id: 2, name: "label2", color: "#4D96FF", value: 2 },
  { id: 3, name: "label3", color: "#6BCB77", value: 3 },
  { id: 4, name: "label4", color: "#FFD93D", value: 4 },
  { id: 5, name: "label5", color: "#845EC2", value: 5 },
  { id: 6, name: "label6", color: "#FF9671", value: 6 },
];
const THUMBNAIL_SIZE = 240;
const THUMBNAIL_RENDER_VERSION = 2;
const RASTER_CONVERSION_VERSION = 8;
const PLATFORM_SYNC_CHANNEL = "nii-annotation-sync";
const PLATFORM_SYNC_STORAGE_KEY = "nii-annotation:sync";
const QUEUE_PREFETCH_RADIUS = 2;
const LOCAL_IMAGE_PAGE_SIZE = 20;
const BATCH_PREFETCH_CONCURRENCY = 3;
const ENABLE_NEARBY_PREFETCH = false;

const detectBrowserRuntimeEnv = () => {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const hasWindow = typeof window !== "undefined";
  const hasDocument = typeof document !== "undefined";
  const userAgent = String(nav?.userAgent || "");
  const platform = String(nav?.platform || "");
  const hardwareConcurrency = Number(nav?.hardwareConcurrency || 0);
  const deviceMemoryGB = Number(nav?.deviceMemory || 0);
  const currentDpr = hasWindow ? Number(window.devicePixelRatio || 1) : 1;
  const isWindows = /win/i.test(platform) || /windows/i.test(userAgent);
  const isMac = /mac/i.test(platform) || /mac os/i.test(userAgent);
  const isLinux =
    !isWindows &&
    !isMac &&
    (/linux/i.test(platform) || /linux/i.test(userAgent));
  const base = {
    detectedAt: Date.now(),
    browser: {
      userAgent,
      platform,
      os: isWindows
        ? "windows"
        : isMac
          ? "macos"
          : isLinux
            ? "linux"
            : "unknown",
      isWindows,
      isMac,
      isLinux,
      language: String(nav?.language || ""),
      languages: Array.isArray(nav?.languages) ? nav.languages : [],
      hardwareConcurrency,
      deviceMemoryGB,
      timezone: (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        } catch {
          return "";
        }
      })(),
    },
    webgl: {
      supported: false,
      version: "none",
      tier: "fallback",
      renderer: "",
      vendor: "",
      maxTextureSize: 0,
      max3DTextureSize: 0,
      majorPerformanceCaveat: false,
    },
    refreshBudgetMs: 100,
    refreshPolicy: {
      maxTier: 1,
      locationRefreshMinIntervalMs: 80,
      escalationCooldownMs: 120,
    },
    viewerProfile: {
      lowPowerMode: false,
      mediumPowerMode: true,
      forceDevicePixelRatio: 1,
      strokeRefreshTarget: "source-only",
      liveCrosshairDuringAnnotation: false,
      labelStatsDelayMs: 420,
    },
  };
  if (!hasWindow || !hasDocument) return base;

  const makeCtx = (canvas, type, opts = {}) => {
    try {
      return canvas.getContext(type, opts);
    } catch {
      return null;
    }
  };

  const canvas = document.createElement("canvas");
  const webgl2 = makeCtx(canvas, "webgl2", {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  const gl =
    webgl2 ||
    makeCtx(canvas, "webgl", { antialias: false, alpha: false }) ||
    makeCtx(canvas, "experimental-webgl", { antialias: false, alpha: false });
  if (!gl) return base;

  const isWebgl2 = !!webgl2;
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0);
  const max3DTextureSize = isWebgl2
    ? Number(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 0)
    : 0;
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "")
    : String(gl.getParameter(gl.RENDERER) || "");
  const vendor = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "")
    : String(gl.getParameter(gl.VENDOR) || "");
  const caveatCanvas = document.createElement("canvas");
  const caveatCtx = makeCtx(caveatCanvas, isWebgl2 ? "webgl2" : "webgl", {
    failIfMajorPerformanceCaveat: true,
  });
  const majorPerformanceCaveat = !caveatCtx;
  const softwareLike =
    /(swiftshader|software|llvmpipe|angle \(.*microsoft basic render driver)/i.test(
      renderer,
    );
  let tier = "medium";
  if (majorPerformanceCaveat || softwareLike || maxTextureSize < 4096)
    tier = "low";
  else if (isWebgl2 && maxTextureSize >= 8192 && max3DTextureSize >= 2048)
    tier = "high";
  const refreshBudgetMs = tier === "high" ? 80 : tier === "medium" ? 90 : 100;
  let maxTier = tier === "high" ? 3 : tier === "medium" ? 2 : 1;
  if (isWindows) {
    // Windows/ANGLE 在 2D 频繁刷新上更容易卡顿，默认限制到二级刷新。
    maxTier = Math.min(maxTier, 2);
  }
  const lowPowerMode =
    tier === "low" ||
    (hardwareConcurrency > 0 && hardwareConcurrency <= 4) ||
    (deviceMemoryGB > 0 && deviceMemoryGB <= 4);
  const mediumPowerMode =
    !lowPowerMode &&
    (tier === "medium" ||
      isWindows ||
      (hardwareConcurrency > 0 && hardwareConcurrency <= 8) ||
      (deviceMemoryGB > 0 && deviceMemoryGB <= 8));
  const forceDevicePixelRatio = lowPowerMode
    ? 1
    : mediumPowerMode
      ? isWindows
        ? 1
        : Math.min(1.2, currentDpr || 1)
      : isWindows
        ? Math.min(1.1, currentDpr || 1)
        : Math.min(1.5, currentDpr || 1);
  const refreshPolicy = {
    maxTier,
    locationRefreshMinIntervalMs: maxTier >= 3 ? 34 : maxTier >= 2 ? 48 : 72,
    escalationCooldownMs: maxTier >= 3 ? 40 : maxTier >= 2 ? 75 : 120,
  };
  const viewerProfile = {
    lowPowerMode,
    mediumPowerMode,
    forceDevicePixelRatio,
    strokeRefreshTarget:
      lowPowerMode || mediumPowerMode ? "source-only" : "all-2d",
    liveCrosshairDuringAnnotation: false,
    labelStatsDelayMs: lowPowerMode ? 720 : mediumPowerMode ? 460 : 240,
  };

  const lose = gl.getExtension("WEBGL_lose_context");
  lose?.loseContext?.();
  const loseCaveat = caveatCtx?.getExtension?.("WEBGL_lose_context");
  loseCaveat?.loseContext?.();

  return {
    ...base,
    webgl: {
      supported: true,
      version: isWebgl2 ? "webgl2" : "webgl1",
      tier,
      renderer,
      vendor,
      maxTextureSize,
      max3DTextureSize,
      majorPerformanceCaveat,
    },
    refreshBudgetMs,
    refreshPolicy,
    viewerProfile,
  };
};

const normalizeBaseName = (name) => {
  if (!name) return "";
  const clean = name.split("/").pop();
  return clean
    .toLowerCase()
    .replace(
      /\.(nii\.gz|nii|nrrd|dicom|dcm|png|jpe?g|bmp|webp|tif|tiff)$/i,
      "",
    );
};

const fileStem = (name) =>
  (name || "")
    .split("/")
    .pop()
    .replace(
      /\.(nii\.gz|nii|nrrd|dicom|dcm|png|jpe?g|bmp|webp|tif|tiff)$/i,
      "",
    );

const inferMaskFileName = (name) => {
  const source = String(name || "");
  const stem = fileStem(source) || "mask";
  if (/\.nii$/i.test(source) && !/\.nii\.gz$/i.test(source)) {
    return `${stem}.nii`;
  }
  return `${stem}.nii.gz`;
};

const stripMaskTokens = (base) =>
  base
    .replace(/(mask|seg|label)/gi, "")
    .replace(/[-_.]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");

const isNiftiFile = (name) => /\.nii(\.gz)?$/i.test(name);
const isNrrdFile = (name) => /\.nrrd$/i.test(name);
const isDicomFile = (name) => /\.(dcm|dicom)$/i.test(name);
const isImageFile = (name) => /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(name);
const isZipFile = (name) => /\.zip$/i.test(name);
const isMaskName = (name) => /(mask|seg|label)/i.test(name);
const isSupportedImageFile = (name) => isNiftiFile(name);

const isZipBuffer = (buffer) => {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer);
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
};

const isHtmlLikeBuffer = (buffer) => {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return false;
  const prefix = new TextDecoder("utf-8")
    .decode(new Uint8Array(buffer).slice(0, 64))
    .toLowerCase()
    .trim();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
};

const normalizeIncomingFileName = (name, buffer, fallbackBase = "image") => {
  const leaf = getLeafName(name) || fallbackBase;
  if (
    isZipFile(leaf) ||
    isSupportedImageFile(leaf) ||
    isDicomFile(leaf) ||
    isImageFile(leaf)
  ) {
    return leaf;
  }
  if (isNiftiBuffer(buffer)) return `${leaf}.nii.gz`;
  if (isZipBuffer(buffer)) return `${leaf}.zip`;
  if (isDicomContentBuffer(buffer)) return `${leaf}.dcm`;
  return leaf;
};

const getMimeFromName = (name) => {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  return "application/octet-stream";
};

const toInternalNiftiName = (name) => `${fileStem(name)}.nii`;
const getLeafName = (name) =>
  String(name || "")
    .split("/")
    .pop() || "";
const isMaskPath = (name) => {
  const segments = String(name || "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "mask" ||
      segment === "masks" ||
      segment === "label" ||
      segment === "labels" ||
      segment === "seg" ||
      segment === "segs" ||
      segment.startsWith("mask_"),
  );
};

const isImagePath = (name) => {
  const segments = String(name || "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  return segments.some(
    (segment) =>
      segment === "img" || segment === "image" || segment === "images",
  );
};

const getPngSpacingMM = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 33) return null;
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < pngSig.length; i += 1) {
    if (bytes[i] !== pngSig[i]) return null;
  }
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataOffset = offset + 8;
    if (type === "pHYs" && length >= 9 && dataOffset + 9 <= bytes.length) {
      const xPpm = view.getUint32(dataOffset, false);
      const yPpm = view.getUint32(dataOffset + 4, false);
      const unit = bytes[dataOffset + 8];
      if (unit === 1 && xPpm > 0 && yPpm > 0) {
        return [1000 / xPpm, 1000 / yPpm];
      }
      return null;
    }
    offset += 12 + length;
  }
  return null;
};

const getJpegSpacingMM = (buffer) => {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe0 && length >= 16) {
      const idStart = offset + 4;
      const isJfif =
        bytes[idStart] === 0x4a &&
        bytes[idStart + 1] === 0x46 &&
        bytes[idStart + 2] === 0x49 &&
        bytes[idStart + 3] === 0x46 &&
        bytes[idStart + 4] === 0x00;
      if (isJfif) {
        const units = bytes[idStart + 7];
        const xDen = (bytes[idStart + 8] << 8) | bytes[idStart + 9];
        const yDen = (bytes[idStart + 10] << 8) | bytes[idStart + 11];
        if (xDen > 0 && yDen > 0) {
          if (units === 1) return [25.4 / xDen, 25.4 / yDen];
          if (units === 2) return [10 / xDen, 10 / yDen];
        }
      }
    }
    offset += 2 + length;
  }
  return null;
};

const readRasterSpacingMM = (buffer, name) => {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".png")) {
    return getPngSpacingMM(buffer) || [1, 1];
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return getJpegSpacingMM(buffer) || [1, 1];
  }
  return [1, 1];
};

const isNiftiBuffer = (buffer) => {
  if (!(buffer instanceof ArrayBuffer)) return false;
  if (nifti.isNIFTI(buffer)) return true;
  if (nifti.isCompressed(buffer)) {
    try {
      const decompressed = nifti.decompress(buffer);
      return nifti.isNIFTI(decompressed);
    } catch {
      return false;
    }
  }
  return false;
};

const clampByte = (value) =>
  Math.max(0, Math.min(255, Math.round(Number(value) || 0)));

const getOrientationDirection = (orientation, spacing) => {
  const sx = Number(spacing?.[0] || 1);
  const sy = Number(spacing?.[1] || 1);
  const sz = Number(spacing?.[2] || 1);
  if (orientation === "LPS") return [sx, 0, 0, 0, sy, 0, 0, 0, sz];
  return [-sx, 0, 0, 0, -sy, 0, 0, 0, sz];
};

const encodeNiftiUInt8 = ({
  width,
  height,
  depth = 1,
  components = 1,
  voxels,
  spacing = [1, 1, 1],
  origin = [0, 0, 0],
  orientation = "RAI",
  headerTemplate = null,
}) => {
  const headerSize = 348;
  const extSize = 4;
  const imageSize = width * height * depth * components;
  const out = new ArrayBuffer(headerSize + extSize + imageSize);
  const dv = new DataView(out);
  const bytes = new Uint8Array(out);

  dv.setInt32(0, 348, true);
  dv.setInt16(40, components > 1 ? 5 : 3, true);
  dv.setInt16(42, width, true);
  dv.setInt16(44, height, true);
  dv.setInt16(46, depth, true);
  dv.setInt16(48, 1, true);
  dv.setInt16(50, components, true);
  dv.setInt16(70, 2, true);
  dv.setInt16(72, 8, true);
  dv.setInt16(68, components > 1 ? 1007 : 0, true);

  const pix0 = Number(headerTemplate?.pixDims?.[0] || 1) || 1;
  dv.setFloat32(76, pix0, true);
  dv.setFloat32(80, Number(spacing[0] || 1), true);
  dv.setFloat32(84, Number(spacing[1] || 1), true);
  dv.setFloat32(88, Number(spacing[2] || 1), true);

  dv.setFloat32(108, headerSize + extSize, true);
  // 显式设置缩放与显示范围，避免部分查看器把 uint8 影像按 0 缩放后呈现全黑。
  dv.setFloat32(112, 1, true); // scl_slope
  dv.setFloat32(116, 0, true); // scl_inter
  dv.setFloat32(124, 255, true); // cal_max
  dv.setFloat32(128, 0, true); // cal_min
  dv.setInt16(254, Number(headerTemplate?.sform_code ?? 0), true);
  dv.setInt16(252, Number(headerTemplate?.qform_code ?? 1), true);
  dv.setInt8(123, Number(headerTemplate?.xyzt_units ?? 10));
  // 与 ITK-SNAP 常见 2D 影像约定对齐：X/Y 负方向，避免 JPG 与配对 NII 方向不一致。
  dv.setFloat32(256, Number(headerTemplate?.quatern_b ?? 0), true);
  dv.setFloat32(260, Number(headerTemplate?.quatern_c ?? 0), true);
  dv.setFloat32(264, Number(headerTemplate?.quatern_d ?? 0), true);
  dv.setFloat32(268, Number(headerTemplate?.qoffset_x ?? 0), true);
  dv.setFloat32(272, Number(headerTemplate?.qoffset_y ?? 0), true);
  dv.setFloat32(276, Number(headerTemplate?.qoffset_z ?? 0), true);

  if (
    Array.isArray(headerTemplate?.affine) &&
    headerTemplate.affine.length >= 3
  ) {
    dv.setFloat32(280, Number(headerTemplate.affine[0]?.[0] || 0), true);
    dv.setFloat32(284, Number(headerTemplate.affine[0]?.[1] || 0), true);
    dv.setFloat32(288, Number(headerTemplate.affine[0]?.[2] || 0), true);
    dv.setFloat32(292, Number(headerTemplate.affine[0]?.[3] || 0), true);
    dv.setFloat32(296, Number(headerTemplate.affine[1]?.[0] || 0), true);
    dv.setFloat32(300, Number(headerTemplate.affine[1]?.[1] || 0), true);
    dv.setFloat32(304, Number(headerTemplate.affine[1]?.[2] || 0), true);
    dv.setFloat32(308, Number(headerTemplate.affine[1]?.[3] || 0), true);
    dv.setFloat32(312, Number(headerTemplate.affine[2]?.[0] || 0), true);
    dv.setFloat32(316, Number(headerTemplate.affine[2]?.[1] || 0), true);
    dv.setFloat32(320, Number(headerTemplate.affine[2]?.[2] || 1), true);
    dv.setFloat32(324, Number(headerTemplate.affine[2]?.[3] || 0), true);
  } else {
    const dir = getOrientationDirection(orientation, spacing);
    dv.setFloat32(280, Number(dir[0] || 0), true);
    dv.setFloat32(284, 0, true);
    dv.setFloat32(288, 0, true);
    dv.setFloat32(292, Number(origin[0] || 0), true);
    dv.setFloat32(296, 0, true);
    dv.setFloat32(300, Number(dir[4] || 0), true);
    dv.setFloat32(304, 0, true);
    dv.setFloat32(308, Number(origin[1] || 0), true);
    dv.setFloat32(312, 0, true);
    dv.setFloat32(316, 0, true);
    dv.setFloat32(320, Number(dir[8] || 1), true);
    dv.setFloat32(324, Number(origin[2] || 0), true);
  }

  bytes[344] = 0x6e;
  bytes[345] = 0x2b;
  bytes[346] = 0x31;
  bytes[347] = 0x00;

  bytes.set(voxels, headerSize + extSize);
  return out;
};

const rasterToNifti = async (
  buffer,
  name,
  {
    spacing = null,
    origin = [0, 0, 0],
    orientation = "RAI",
    fileFormat = "Generic ITK Image",
  } = {},
) => {
  const blob = new Blob([buffer], { type: getMimeFromName(name) });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close?.();
    throw new Error("无法初始化栅格转换画布");
  }
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close?.();

  const out = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const alpha = Number(data[i + 3] || 255) / 255;
    const r = Number(data[i] || 0) * alpha;
    const g = Number(data[i + 1] || 0) * alpha;
    const b = Number(data[i + 2] || 0) * alpha;
    out[p] = clampByte(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const [defaultSX, defaultSY] = readRasterSpacingMM(buffer, name);
  const sx = Math.max(1e-6, Number(spacing?.[0] || defaultSX || 1));
  const sy = Math.max(1e-6, Number(spacing?.[1] || defaultSY || 1));
  const sz = Math.max(1e-6, Number(spacing?.[2] || 1));
  const ox = Number(origin?.[0] || 0);
  const oy = Number(origin?.[1] || 0);
  const oz = Number(origin?.[2] || 0);
  const normalized = encodeNiftiUInt8({
    width: bitmap.width,
    height: bitmap.height,
    depth: 1,
    components: 1,
    voxels: out,
    spacing: [sx, sy, sz],
    origin: [ox, oy, oz],
    orientation,
  });
  const direction = getOrientationDirection(orientation, [sx, sy, sz]);
  const rgbBytes = bitmap.width * bitmap.height * 3;
  const sourceSummary = {
    fileName: name || "image",
    dimensions: [bitmap.width, bitmap.height, 1],
    timePoints: 1,
    componentsPerVoxel: 3,
    voxelSpacing: [sx, sy, sz],
    origin: [ox, oy, oz],
    orientation,
    byteOrder: "Little Endian",
    dataType: "unsigned_char",
    fileSize: `${Math.round(rgbBytes / 1024)} KB`,
    metadata: {
      spacingMM: [sx, sy, sz],
      fileFormat,
      generatedBy: "Nii Annotation Generic ITK Converter",
    },
  };

  return {
    buffer: normalized,
    internalName: toInternalNiftiName(name || "image"),
    spatialMeta: {
      origin: [ox, oy, oz],
      spacing: [sx, sy, sz],
      direction,
      sourceSummary,
      width: bitmap.width,
      height: bitmap.height,
    },
  };
};

const normalizeRasterNiftiToScalar = (
  buffer,
  sourceName = "",
  { spacingOverride = null } = {},
) => {
  const { header, voxels, width, height, depth, components, datatypeCode } =
    decodeNifti(buffer);
  const sx = Math.max(
    1e-6,
    Number(spacingOverride?.[0] || header?.pixDims?.[1] || 1),
  );
  const sy = Math.max(
    1e-6,
    Number(spacingOverride?.[1] || header?.pixDims?.[2] || 1),
  );
  const sz = Math.max(
    1e-6,
    Number(spacingOverride?.[2] || header?.pixDims?.[3] || 1),
  );

  const voxelCount = width * height * depth;
  const out = new Uint8Array(voxelCount);
  const isRgb24 = datatypeCode === nifti.NIFTI1.TYPE_RGB24;
  for (let i = 0; i < voxelCount; i += 1) {
    if (isRgb24) {
      const base = i * 3;
      const r = Number(voxels[base] || 0);
      const g = Number(voxels[base + 1] || 0);
      const b = Number(voxels[base + 2] || 0);
      out[i] = clampByte(0.299 * r + 0.587 * g + 0.114 * b);
      continue;
    }
    if (components >= 3) {
      // dim[5] 向量数据按 NIfTI 规范通常为平面布局：C0..Cn 逐平面存储。
      const r = Number(voxels[i] || 0);
      const g = Number(voxels[i + voxelCount] || 0);
      const b = Number(voxels[i + 2 * voxelCount] || 0);
      out[i] = clampByte(0.299 * r + 0.587 * g + 0.114 * b);
      continue;
    }
    out[i] = clampByte(voxels[i]);
  }

  const normalized = encodeNiftiUInt8({
    width,
    height,
    depth,
    components: 1,
    voxels: out,
    spacing: [sx, sy, sz],
  });

  return {
    buffer: normalized,
    internalName: toInternalNiftiName(sourceName || "image"),
    spatialMeta: {
      origin: [0, 0, 0],
      spacing: [sx, sy, sz],
      direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
      sourceSummary: {
        dimensions: [width, height, depth],
        timePoints: 1,
        componentsPerVoxel: components,
        voxelSpacing: [sx, sy, sz],
        origin: [0, 0, 0],
        orientation: "RAI",
        dataType: "unsigned_char",
      },
      width,
      height,
    },
  };
};

const isLikelyDicomBuffer = (buffer) => {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 132) return false;
  const bytes = new Uint8Array(buffer, 128, 4);
  return (
    bytes[0] === 68 && bytes[1] === 73 && bytes[2] === 67 && bytes[3] === 77
  );
};

const hasDicomLikeName = (name) => {
  const leaf = getLeafName(name);
  if (!leaf) return false;
  if (isDicomFile(leaf)) return true;
  // 常见无扩展名 DICOM 文件名样式：IM-0001-0001、纯数字、.IMA
  if (/\.ima$/i.test(leaf)) return true;
  if (/^im[-_]/i.test(leaf)) return true;
  if (/^\d+$/.test(leaf)) return true;
  return false;
};

const toNumeric = (value, fallback = 0) => {
  const parsed = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readDicomIdentity = (buffer, name = "") => {
  const source = arrayBufferFrom(buffer);
  if (!source) return null;
  try {
    const dataSet = dicomParser.parseDicom(new Uint8Array(source), {
      untilTag: "x00200013",
    });
    const studyUID = String(dataSet.string("x0020000d") || "").trim();
    const seriesUID = String(dataSet.string("x0020000e") || "").trim();
    const seriesDescription = String(dataSet.string("x0008103e") || "").trim();
    const studyID = String(dataSet.string("x00200010") || "").trim();
    const accessionNumber = String(dataSet.string("x00080050") || "").trim();
    const seriesNumber = toNumeric(
      dataSet.intString("x00200011") ?? dataSet.string("x00200011"),
      0,
    );
    const instanceNumber = toNumeric(
      dataSet.intString("x00200013") ?? dataSet.string("x00200013"),
      0,
    );
    return {
      sourceName: name,
      studyUID,
      seriesUID,
      seriesDescription,
      studyID,
      accessionNumber,
      seriesNumber,
      instanceNumber,
    };
  } catch {
    return null;
  }
};

const isDicomContentBuffer = (buffer) => {
  const source = arrayBufferFrom(buffer);
  if (!source) return false;
  if (isLikelyDicomBuffer(source)) return true;
  const meta = readDicomIdentity(source);
  if (!meta) return false;
  if (meta.studyUID || meta.seriesUID) return true;
  if (meta.seriesNumber > 0 || meta.instanceNumber > 0) return true;
  return false;
};

const groupDicomInputsBySeries = (items) => {
  const groups = new Map();
  const UNKNOWN_STUDY = "unknown-study";
  let unknownSeriesIndex = 1;

  for (const item of items) {
    const meta = readDicomIdentity(item?.data, item?.name);
    const studyUID = meta?.studyUID || UNKNOWN_STUDY;
    const seriesUID =
      meta?.seriesUID || `unknown-series-${unknownSeriesIndex++}`;
    const key = `${studyUID}::${seriesUID}`;
    if (!groups.has(key)) {
      groups.set(key, {
        studyUID,
        seriesUID,
        studyID: meta?.studyID || "",
        accessionNumber: meta?.accessionNumber || "",
        seriesDescription: meta?.seriesDescription || "",
        seriesNumber: Number(meta?.seriesNumber || 0),
        items: [],
      });
    }
    groups.get(key).items.push({
      name: item?.name || `dicom_${Date.now()}`,
      data: item?.data,
      instanceNumber: Number(meta?.instanceNumber || 0),
    });
  }

  const output = Array.from(groups.values());
  for (const group of output) {
    group.items.sort((a, b) => {
      if (a.instanceNumber !== b.instanceNumber)
        return a.instanceNumber - b.instanceNumber;
      return String(a.name).localeCompare(String(b.name), "en");
    });
  }
  output.sort((a, b) => {
    if (a.seriesNumber !== b.seriesNumber)
      return a.seriesNumber - b.seriesNumber;
    if (a.seriesDescription !== b.seriesDescription) {
      return String(a.seriesDescription).localeCompare(
        String(b.seriesDescription),
        "en",
      );
    }
    return String(a.seriesUID).localeCompare(String(b.seriesUID), "en");
  });
  return output;
};

const arrayBufferFrom = (data) => {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
  }
  return null;
};

const hashBuffer = async (buffer) => {
  const subtle = globalThis?.crypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    const digest = await subtle.digest("SHA-256", buffer);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for non-secure contexts where crypto.subtle is unavailable.
  const bytes = new Uint8Array(buffer);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= bytes[bytes.length - 1 - i];
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const sizeHex = (bytes.length >>> 0).toString(16).padStart(8, "0");
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}${sizeHex}`;
};

const bufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const hasNonZeroMaskNifti = (maskData) => {
  const buffer = arrayBufferFrom(maskData);
  if (!buffer) return false;
  try {
    let source = buffer;
    if (nifti.isCompressed(source)) {
      source = nifti.decompress(source);
    }
    if (!nifti.isNIFTI(source)) return false;
    const header = nifti.readHeader(source);
    const imageBuffer = nifti.readImage(header, source);
    const datatype = header.datatypeCode;

    let voxels;
    switch (datatype) {
      case nifti.NIFTI1.TYPE_UINT8:
        voxels = new Uint8Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_INT8:
        voxels = new Int8Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_UINT16:
        voxels = new Uint16Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_INT16:
        voxels = new Int16Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_UINT32:
        voxels = new Uint32Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_INT32:
        voxels = new Int32Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_FLOAT32:
        voxels = new Float32Array(imageBuffer);
        break;
      case nifti.NIFTI1.TYPE_FLOAT64:
        voxels = new Float64Array(imageBuffer);
        break;
      default:
        voxels = new Uint8Array(imageBuffer);
        break;
    }
    for (let i = 0; i < voxels.length; i += 1) {
      if (Number(voxels[i]) !== 0) return true;
    }
    return false;
  } catch (error) {
    console.warn("检查 mask 非零体素失败", error);
    return false;
  }
};

const createRasterThumbnail = async (buffer, _name) => {
  const blob = new Blob([buffer]);
  const bitmap = await createImageBitmap(blob);
  const outCanvas = document.createElement("canvas");
  outCanvas.width = THUMBNAIL_SIZE;
  outCanvas.height = THUMBNAIL_SIZE;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) return "";

  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);

  const scale = Math.min(
    THUMBNAIL_SIZE / bitmap.width,
    THUMBNAIL_SIZE / bitmap.height,
  );
  const drawW = Math.max(1, Math.round(bitmap.width * scale));
  const drawH = Math.max(1, Math.round(bitmap.height * scale));
  const dx = Math.floor((THUMBNAIL_SIZE - drawW) / 2);
  const dy = Math.floor((THUMBNAIL_SIZE - drawH) / 2);
  outCtx.drawImage(bitmap, dx, dy, drawW, drawH);
  bitmap.close?.();
  return outCanvas.toDataURL("image/png");
};

const decodeNifti = (buffer) => {
  let source = buffer;
  if (nifti.isCompressed(source)) {
    source = nifti.decompress(source);
  }
  if (!nifti.isNIFTI(source)) {
    throw new Error("Not a NIfTI file");
  }

  const header = nifti.readHeader(source);
  const imageBuffer = nifti.readImage(header, source);
  const datatype = header.datatypeCode;

  let voxels;
  switch (datatype) {
    case nifti.NIFTI1.TYPE_UINT8:
      voxels = new Uint8Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_INT8:
      voxels = new Int8Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_UINT16:
      voxels = new Uint16Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_INT16:
      voxels = new Int16Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_UINT32:
      voxels = new Uint32Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_INT32:
      voxels = new Int32Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_FLOAT32:
      voxels = new Float32Array(imageBuffer);
      break;
    case nifti.NIFTI1.TYPE_FLOAT64:
      voxels = new Float64Array(imageBuffer);
      break;
    default:
      voxels = new Uint8Array(imageBuffer);
      break;
  }

  const width = Math.max(1, Number(header.dims?.[1] || 1));
  const height = Math.max(1, Number(header.dims?.[2] || 1));
  const depth = Math.max(1, Number(header.dims?.[3] || 1));
  const dimComponents = Math.max(1, Number(header.dims?.[5] || 1));
  const components =
    header.datatypeCode === nifti.NIFTI1.TYPE_RGB24 ? 3 : dimComponents;
  return {
    header,
    voxels,
    width,
    height,
    depth,
    components,
    datatypeCode: Number(header.datatypeCode || 0),
  };
};

const isRasterOriginRecord = (record) => {
  const sourceName = record?.sourceName || record?.displayName || "";
  if (isImageFile(sourceName)) return true;
  const sourceData = arrayBufferFrom(record?.sourceData);
  if (sourceData && !isNiftiBuffer(sourceData)) return true;
  return false;
};

const isLikelyMaskNiftiBuffer = (buffer) => {
  const source = arrayBufferFrom(buffer);
  if (!source || !isNiftiBuffer(source)) return false;
  try {
    const { voxels } = decodeNifti(source);
    const unique = new Set();
    let nonZero = 0;
    const maxCheck = Math.min(voxels.length, 200000);
    for (let i = 0; i < maxCheck; i += 1) {
      const v = clampByte(voxels[i]);
      unique.add(v);
      if (v > 0) nonZero += 1;
      if (unique.size > 12) return false;
    }
    return nonZero > 0 && nonZero / maxCheck < 0.4;
  } catch {
    return false;
  }
};

const createNiftiThumbnail = async (buffer, _name, { isMask = false } = {}) => {
  const { voxels, width, height, depth, components } = decodeNifti(buffer);
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (!srcCtx) return "";

  const z = Math.floor((depth - 1) / 2);
  const wh = width * height;
  const sliceBase = z * wh;
  const imageData = srcCtx.createImageData(width, height);

  if (isMask) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const vIdx = sliceBase + y * width + x;
        const pixel = (y * width + x) * 4;
        const value = Number(voxels[vIdx] || 0);
        const on = value > 0;
        imageData.data[pixel] = on ? 255 : 0;
        imageData.data[pixel + 1] = on ? 255 : 0;
        imageData.data[pixel + 2] = on ? 255 : 0;
        imageData.data[pixel + 3] = 255;
      }
    }
  } else if (components >= 3) {
    const frameSize = wh * depth;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = sliceBase + y * width + x;
        const pixel = (y * width + x) * 4;
        imageData.data[pixel] = Number(voxels[base] || 0);
        imageData.data[pixel + 1] = Number(voxels[base + frameSize] || 0);
        imageData.data[pixel + 2] = Number(voxels[base + 2 * frameSize] || 0);
        imageData.data[pixel + 3] = 255;
      }
    }
  } else {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const vIdx = sliceBase + y * width + x;
        const value = Number(voxels[vIdx] || 0);
        if (Number.isFinite(value)) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      min = 0;
      max = 1;
    }
    const span = Math.max(1e-6, max - min);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const vIdx = sliceBase + y * width + x;
        const pixel = (y * width + x) * 4;
        const value = Number(voxels[vIdx] || 0);
        const gray = Math.max(
          0,
          Math.min(255, Math.round(((value - min) / span) * 255)),
        );
        imageData.data[pixel] = gray;
        imageData.data[pixel + 1] = gray;
        imageData.data[pixel + 2] = gray;
        imageData.data[pixel + 3] = 255;
      }
    }
  }

  srcCtx.putImageData(imageData, 0, 0);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = THUMBNAIL_SIZE;
  outCanvas.height = THUMBNAIL_SIZE;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) return "";

  outCtx.fillStyle = "#000";
  outCtx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);

  const scale = Math.min(THUMBNAIL_SIZE / width, THUMBNAIL_SIZE / height);
  const drawW = Math.max(1, Math.round(width * scale));
  const drawH = Math.max(1, Math.round(height * scale));
  const dx = Math.floor((THUMBNAIL_SIZE - drawW) / 2);
  const dy = Math.floor((THUMBNAIL_SIZE - drawH) / 2);
  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(srcCanvas, dx, dy, drawW, drawH);

  return outCanvas.toDataURL("image/png");
};

const createNiivueThumbnail = async (buffer, name, { isMask = false } = {}) => {
  const NiivueCtor = await loadNiivueCtor();
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  canvas.style.position = "absolute";
  canvas.style.opacity = "0";
  canvas.style.pointerEvents = "none";
  document.body.appendChild(canvas);
  const nv = new NiivueCtor({ show3Dcrosshair: false });
  try {
    nv.attachToCanvas(canvas);
    await nv.loadFromArrayBuffer(buffer, name);
    if (typeof nv.setInterpolation === "function") {
      nv.setInterpolation(true);
    }
    const baseVolume = nv.volumes?.[0];
    const windowRange = !isMask
      ? resolveAutoWindowRange({
          volume: baseVolume,
          imageMeta: { name },
        })
      : null;
    if (baseVolume && windowRange) {
      baseVolume.cal_min = Number(windowRange.min);
      baseVolume.cal_max = Number(windowRange.max);
      if (typeof nv.updateGLVolume === "function") {
        nv.updateGLVolume();
      }
    }
    const dims = nv.back?.dims;
    const is2D = dims && (dims[0] <= 2 || dims[3] <= 1);
    nv.setSliceType(nv.sliceTypeAxial);
    // 仅对 2D 图像应用 radiological 约定，避免影响 3D 体数据方位。
    if (is2D) {
      nv.setRadiologicalConvention(true);
    }
    if (isMask && typeof nv.setColormap === "function") {
      nv.setColormap("itksnap");
    }
    nv.drawScene();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return canvas.toDataURL("image/png");
  } catch (error) {
    console.warn("Niivue 缩略图生成失败", error);
    return "";
  } finally {
    nv.removeAllListeners?.();
    document.body.removeChild(canvas);
  }
};

const createThumbnail = async (buffer, name, { isMask = false } = {}) => {
  if (isNiftiFile(name)) {
    if (!isNiftiBuffer(buffer)) return "";
    try {
      const fastThumb = await createNiftiThumbnail(buffer, name, { isMask });
      if (fastThumb) return fastThumb;
    } catch {
      // ignore and fallback to niivue renderer
    }
    const niivueThumb = await createNiivueThumbnail(buffer, name, { isMask });
    if (niivueThumb) return niivueThumb;
    return "";
  }
  return createNiivueThumbnail(buffer, name, { isMask });
};

const toListItem = (record) => ({
  id: record.id,
  name: record.name,
  displayName: record.displayName || record.name,
  baseName: record.baseName || normalizeBaseName(record.name),
  createdAt: record.createdAt,
  sourceFormat: record.sourceFormat || "nifti",
  dicomStudyUID: record.dicomStudyUID || "",
  dicomStudyID: record.dicomStudyID || "",
  dicomSeriesUID: record.dicomSeriesUID || "",
  dicomSeriesDescription: record.dicomSeriesDescription || "",
  dicomSeriesNumber: Number(record.dicomSeriesNumber || 0),
  dicomSeriesOrder: Number(record.dicomSeriesOrder || 0),
  dicomAccessionNumber: record.dicomAccessionNumber || "",
  remoteImageId: record.remoteImageId ? String(record.remoteImageId) : "",
  remoteBatchId: record.remoteBatchId ? String(record.remoteBatchId) : "",
  isMaskOnly: !!record.isMaskOnly,
  hasMask:
    typeof record.hasMask === "boolean"
      ? record.hasMask
      : !!(record.sourceMask || record.mask),
  maskAttached: record.maskAttached !== false,
  maskVersion: Number(record.maskVersion || 0),
  thumbnail: record.thumbnail || "",
});

const hasAttachedMask = (record) =>
  record?.maskAttached !== false && !!(record?.mask || record?.sourceMask);

const resolveMaskVersion = (record) => {
  const explicit = Number(record?.maskVersion);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  return hasAttachedMask(record) ? 1 : 0;
};

const getNextMaskVersion = (record, { bump = false } = {}) => {
  const current = resolveMaskVersion(record);
  return bump ? current + 1 : current;
};

const makeImportBatchId = () =>
  `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const parseFileNameFromDisposition = (contentDisposition) => {
  if (!contentDisposition) return "";
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).replace(/^"(.*)"$/, "$1");
    } catch {
      return utf8Match[1].replace(/^"(.*)"$/, "$1");
    }
  }
  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || "";
};

const buildAuthHeaders = (token) => {
  const raw = String(token || "").trim();
  if (!raw) return {};
  const authValue = /^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`;
  return { Authorization: authValue };
};

const resolveRemoteUrl = (url, platformOrigin) => {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) return "";
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  const origin = String(platformOrigin || "")
    .trim()
    .replace(/\/+$/, "");
  if (!origin) return rawUrl;
  const normalizedPath = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
  return `${origin}${normalizedPath}`;
};

const parseApiPayload = (json) => {
  if (!json || typeof json !== "object") return null;
  if (json.data && typeof json.data === "object") return json.data;
  return json;
};

const getRawQueryParam = (name) => {
  if (typeof window === "undefined") return "";
  const key = String(name || "").trim();
  if (!key) return "";
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`[?&]${escaped}=([^&#]*)`);
  const match = window.location.search.match(re);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const assertPlatformResponseSuccess = (
  json,
  fallbackMessage = "平台返回失败",
) => {
  if (!json || typeof json !== "object") return;
  const success = json.success;
  const code = Number(json.code);
  const message = String(json.msg || fallbackMessage);
  if (success === false) {
    throw new Error(message);
  }
  if (Number.isFinite(code) && code !== 200) {
    throw new Error(message);
  }
};

const queueItemHasMaskMeta = (item) => {
  const maskName = String(item?.maskName || "").trim();
  const status = item?.annotationStatus;
  if (maskName) return true;
  if (typeof status === "string") {
    const s = status.trim().toUpperCase();
    if (s === "ANNOTATED" || s === "1" || s === "TRUE") return true;
  }
  if (typeof status === "number" && status > 0) return true;
  return false;
};

const queueItemIsAnnotated = (item) => {
  const status = item?.annotationStatus ?? item?.annotation_status;
  if (typeof status === "number") return status === 1;
  const s = String(status || "")
    .trim()
    .toUpperCase();
  return s === "1" || s === "ANNOTATED" || s === "TRUE";
};

const parseJsonSafe = (raw, fallback = null) => {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
};

const normalizeWorkflowFieldType = (rawType) => {
  const typeRaw = String(rawType || "text")
    .trim()
    .toLowerCase();
  if (typeRaw === "single" || typeRaw === "radio" || typeRaw === "单选")
    return "radio";
  if (typeRaw === "multiple" || typeRaw === "checkbox" || typeRaw === "多选")
    return "checkbox";
  if (typeRaw === "input" || typeRaw === "inputtext" || typeRaw === "textinput")
    return "text";
  if (typeRaw === "select") return "radio";
  if (
    ["text", "textarea", "number", "radio", "checkbox", "switch"].includes(
      typeRaw,
    )
  )
    return typeRaw;
  return "text";
};

const normalizeWorkflowOption = (opt, i = 0) => {
  if (opt == null) return null;
  if (typeof opt === "object") {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(opt, key);
    const rawValue = hasOwn("value")
      ? opt.value
      : hasOwn("optionValue")
        ? opt.optionValue
        : hasOwn("id")
          ? opt.id
          : hasOwn("key")
            ? opt.key
            : hasOwn("code")
              ? opt.code
              : opt.label ?? opt.name ?? opt.title ?? opt.text ?? i;
    const value = rawValue;
    const rawLabel =
      opt.label ?? opt.name ?? opt.title ?? opt.text ?? opt.optionName ?? value;
    const label = String(rawLabel);
    return { label, value };
  }
  return { label: String(opt), value: opt };
};

const normalizeWorkflowField = (item, index = 0) => {
  const id = String(item?.id || item?.key || `field_${index + 1}`).trim();
  if (!id) return null;
  const rawOptions = Array.isArray(item?.options)
    ? item.options
    : Array.isArray(item?.choices)
      ? item.choices
      : Array.isArray(item?.enum)
        ? item.enum
        : Array.isArray(item?.optionList)
          ? item.optionList
          : Array.isArray(item?.questionOptions)
            ? item.questionOptions
            : typeof item?.options === "string"
              ? item.options
              : typeof item?.choices === "string"
                ? item.choices
                : typeof item?.enum === "string"
                  ? item.enum
                  : typeof item?.optionList === "string"
                    ? item.optionList
                    : typeof item?.questionOptions === "string"
                      ? item.questionOptions
                      : [];
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .map((opt, i) => normalizeWorkflowOption(opt, i))
        .filter(Boolean)
    : typeof rawOptions === "string"
      ? String(rawOptions)
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => ({ label: v, value: v }))
      : [];
  return {
    id,
    label: String(item?.label || item?.name || item?.questionTitle || id),
    type: normalizeWorkflowFieldType(item?.type || item?.questionType),
    required:
      !!item?.required ||
      String(item?.isRequired || "").toLowerCase() === "true",
    placeholder: String(item?.placeholder || ""),
    options,
    rows: Number.isFinite(Number(item?.rows))
      ? Math.max(2, Number(item.rows))
      : 3,
  };
};

const parseMaybeArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const splitMixedFieldsByPrefix = (fields = []) => {
  const lesion = [];
  const patient = [];
  const rest = [];
  for (const field of fields) {
    const rawId = String(field?.id || field?.key || "").toLowerCase();
    if (rawId.startsWith("lesion_") || rawId.startsWith("lesion-")) {
      lesion.push(field);
      continue;
    }
    if (rawId.startsWith("patient_") || rawId.startsWith("patient-")) {
      patient.push(field);
      continue;
    }
    rest.push(field);
  }
  return { lesion, patient, rest };
};

const resolveAnnotationAnchorForCard = (annotation = {}) => {
  const points = Array.isArray(annotation?.points) ? annotation.points : [];
  const voxPoints = points
    .map((pt) =>
      Array.isArray(pt?.vox) && pt.vox.length >= 3
        ? [Number(pt.vox[0]), Number(pt.vox[1]), Number(pt.vox[2])]
        : null,
    )
    .filter((pt) => Array.isArray(pt) && pt.every((v) => Number.isFinite(v)));
  if (voxPoints.length > 0) {
    const center = voxPoints.reduce(
      (acc, pt) => [acc[0] + pt[0], acc[1] + pt[1], acc[2] + pt[2]],
      [0, 0, 0],
    );
    return [
      Math.round(center[0] / voxPoints.length),
      Math.round(center[1] / voxPoints.length),
      Math.round(center[2] / voxPoints.length),
    ];
  }
  return null;
};

const isLesionCheckboxField = (field) => {
  const label = String(field?.label || "").trim();
  const type = String(field?.type || "").toLowerCase();
  return type === "checkbox" && label === "病灶";
};

const createEmptyWorkflowSchema = () => ({
  mainCategoryOptions: [],
  mainCategoryTitle: "主分类项",
  steps: [
    {
      id: "lesion",
      title: "病灶标注项",
      scope: "lesion",
      fields: [],
    },
  ],
});

const parseCustomWorkflowSchema = (raw) => {
  const parsed = parseJsonSafe(raw, raw);
  if (!parsed) return createEmptyWorkflowSchema();
  const makeMainCategoryOptions = (mainCategory) =>
    Array.isArray(mainCategory)
      ? mainCategory
          .map((v, i) => normalizeWorkflowOption(v, i))
          .filter(
            (opt) =>
              !!opt &&
              opt.value != null &&
              String(opt.value).trim() !== "" &&
              String(opt.label || "").trim() !== "",
          )
      : [];

  if (Array.isArray(parsed)) {
    const normalizedFields = parsed
      .map((f, i) => normalizeWorkflowField(f, i))
      .filter(Boolean);
    const { lesion, patient, rest } =
      splitMixedFieldsByPrefix(normalizedFields);
    if (lesion.length > 0 || patient.length > 0) {
      return {
        mainCategoryOptions: [],
        mainCategoryTitle: String(parsed?.mainCategoryTitle || parsed?.mainClassificationTitle || "主分类项"),
        steps: [
          lesion.length > 0
            ? {
                id: "lesion",
                title: "病灶标注项",
                scope: "lesion",
                fields: lesion,
              }
            : null,
          patient.length > 0
            ? {
                id: "patient",
                title: "患者信息",
                scope: "patient",
                fields: patient,
              }
            : null,
          rest.length > 0
            ? { id: "step_1", title: "标注项", scope: "lesion", fields: rest }
            : null,
        ].filter(Boolean),
      };
    }
    return {
      mainCategoryOptions: [],
      mainCategoryTitle: String(parsed?.mainCategoryTitle || parsed?.mainClassificationTitle || "主分类项"),
      steps:
        normalizedFields.length > 0
          ? [
              {
                id: "step_1",
                title: "标注项",
                scope: "lesion",
                fields: normalizedFields,
              },
            ]
          : [],
    };
  }

  if (Array.isArray(parsed?.steps)) {
    let steps = parsed.steps
      .map((step, stepIndex) => {
        const fields = (Array.isArray(step?.fields) ? step.fields : [])
          .map((f, i) => normalizeWorkflowField(f, i))
          .filter(Boolean);
        if (!fields.length) return null;
        return {
          id: String(step?.id || `step_${stepIndex + 1}`),
          title: String(step?.title || `标注项${stepIndex + 1}`),
          scope:
            String(step?.scope || "").toLowerCase() === "global"
              ? "global"
              : "lesion",
          fields,
        };
      })
      .filter(Boolean);
    if (steps.length === 1) {
      const only = steps[0];
      const { lesion, patient, rest } = splitMixedFieldsByPrefix(
        Array.isArray(only?.fields) ? only.fields : [],
      );
      if (lesion.length > 0 || patient.length > 0) {
        steps = [
          lesion.length > 0
            ? {
                id: "lesion",
                title: "病灶标注项",
                scope: "lesion",
                fields: lesion,
              }
            : null,
          patient.length > 0
            ? {
                id: "patient",
                title: "患者信息",
                scope: "patient",
                fields: patient,
              }
            : null,
          rest.length > 0 ? { ...only, fields: rest } : null,
        ].filter(Boolean);
      }
    }
    return {
      mainCategoryOptions: makeMainCategoryOptions(
        Array.isArray(parsed?.mainCategory)
          ? parsed.mainCategory
          : parseMaybeArray(parsed?.mainCategory),
      ),
      mainCategoryTitle: String(parsed?.mainCategoryTitle || parsed?.mainClassificationTitle || "主分类项"),
      steps,
    };
  }

  const lesionSignsRaw = Array.isArray(parsed?.lesionSigns)
    ? parsed.lesionSigns
    : Array.isArray(parsed?.lesionAnnotations)
      ? parsed.lesionAnnotations
      : parseMaybeArray(parsed?.lesionSigns || parsed?.lesionAnnotations);
  const patientInfoRaw = Array.isArray(parsed?.patientInfo)
    ? parsed.patientInfo
    : parseMaybeArray(parsed?.patientInfo);
  const lesionSigns = lesionSignsRaw
    .map((f, i) => normalizeWorkflowField(f, i))
    .filter(Boolean);
  const patientInfo = patientInfoRaw
    .map((f, i) => normalizeWorkflowField(f, i))
    .filter(Boolean);
  const rawMainCategory = Array.isArray(parsed?.mainCategory)
    ? parsed.mainCategory
    : Array.isArray(parsed?.mainClassification)
      ? parsed.mainClassification
      : parseMaybeArray(parsed?.mainCategory || parsed?.mainClassification);
  const steps = [];
  if (lesionSigns.length > 0) {
    steps.push({
      id: "lesion",
      title: "病灶标注项",
      scope: "lesion",
      fields: lesionSigns,
    });
  }
  if (patientInfo.length > 0) {
    steps.push({
      id: "patient",
      title: "患者信息",
      scope: "lesion",
      fields: patientInfo,
    });
  }
  return {
    mainCategoryOptions: makeMainCategoryOptions(rawMainCategory),
    mainCategoryTitle: String(parsed?.mainCategoryTitle || parsed?.mainClassificationTitle || "主分类项"),
    steps,
  };
};

const makeEmptyCard = (stepId, index = 0) => ({
  id: `${stepId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  title: `病灶 ${index + 1}`,
  suspicious: false,
  completed: false,
  mainCategory: "",
  values: {},
});

const formatLesionNameBySeq = (seq = 0) => {
  const n = Math.max(0, Number(seq || 0));
  return `病灶${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`;
};

export default function App() {
  const [labels] = useState(FIXED_LABELS);
  const [activeLabelId, setActiveLabelId] = useState(1);
  const [tool, setTool] = useState("pan");
  const [brushSize, setBrushSize] = useState(15);
  const [brushShape, setBrushShape] = useState("circle"); // 'circle' | 'square'
  const [radiological2D, setRadiological2D] = useState(true);
  const [labelStats, setLabelStats] = useState({});
  const [viewerMode, setViewerMode] = useState("default");
  const [runtimeEnv, setRuntimeEnv] = useState(null);

  const [images, setImages] = useState([]);
  const [localImageIds, setLocalImageIds] = useState([]);
  const [activeImage, setActiveImage] = useState(null);
  const [exportDirHandle, setExportDirHandle] = useState(null);
  const [batchQueue, setBatchQueue] = useState(null);
  const [workflowSchema, setWorkflowSchema] = useState(
    createEmptyWorkflowSchema(),
  );
  const [workflowState, setWorkflowState] = useState({
    stepIndex: 0,
    steps: {},
  });
  const [workflowErrors, setWorkflowErrors] = useState({});
  const [selectedLesionId, setSelectedLesionId] = useState("");

  const viewerRef = useRef(null);
  const viewerHostRef = useRef(null);
  const processedFilesRef = useRef(new Set());
  const imageRecordCacheRef = useRef(new Map());
  const imageRecordPrefetchingRef = useRef(new Set());
  const saveTimerRef = useRef(null);
  const saveIdleRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve(false));
  const thumbnailRefreshInFlightRef = useRef(false);
  const runtimeEnvRef = useRef(null);
  const statsTimerRef = useRef(null);
  const statsIdleRef = useRef(null);
  const dicomWheelSwitchAtRef = useRef(0);
  const autoImportedRef = useRef(false);
  const initializedRef = useRef(false);
  const queueNavIndexRef = useRef(-1);
  const hasUnsavedChangesRef = useRef(false);
  const localPersistDirtyRef = useRef(false);
  const activeImageIdRef = useRef("");
  const queueSwitchingRef = useRef(false);
  const queuedSwitchDirectionRef = useRef(0);
  const remoteImportInFlightRef = useRef(new Map());
  const batchPrefetchStartedRef = useRef(false);
  const platformBroadcastRef = useRef(null);

  const externalCtx = useMemo(() => {
    const globalCtx = window.__NII_ANNOTATION_CONTEXT__ || {};
    const p = new URLSearchParams(window.location.search);
    return {
      imageId: p.get("imageId") || globalCtx.imageId || "",
      imageUrl: p.get("imageUrl") || globalCtx.imageUrl || "",
      token:
        getRawQueryParam("token") ||
        p.get("token") ||
        globalCtx.token ||
        localStorage.getItem("token") ||
        sessionStorage.getItem("token") ||
        "",

      platformOrigin: p.get("platformOrigin") || globalCtx.platformOrigin || "",
      annotationBackendOrigin:
        p.get("annotationBackendOrigin") ||
        p.get("backendOrigin") ||
        globalCtx.annotationBackendOrigin ||
        globalCtx.backendOrigin ||
        "",
      originalName:
        p.get("originalName") ||
        p.get("imageName") ||
        globalCtx.originalName ||
        globalCtx.imageName ||
        "",
      batchId: p.get("batchId") || globalCtx.batchId || "",
      topicId: p.get("topicId") || globalCtx.topicId || "",
      customSchema:
        p.get("customSchema") ||
        p.get("customFields") ||
        globalCtx.customSchema ||
        globalCtx.customFields ||
        "",
      customSchemaUrl:
        p.get("customSchemaUrl") || globalCtx.customSchemaUrl || "",
    };
  }, []);
  const localBackendOrigin = useMemo(() => {
    const envOrigin = String(
      import.meta.env?.VITE_ANNOTATION_BACKEND_ORIGIN || "",
    )
      .trim()
      .replace(/\/+$/, "");
    const ctxOrigin = String(externalCtx.annotationBackendOrigin || "")
      .trim()
      .replace(/\/+$/, "");
    return ctxOrigin || envOrigin || "http://192.168.110.88:8010";
  }, [externalCtx.annotationBackendOrigin]);

  const imageStoreScope = useMemo(() => {
    const platformOrigin = String(externalCtx.platformOrigin || "")
      .trim()
      .replace(/\/+$/, "");
    const topicId = String(externalCtx.topicId || "").trim();
    const batchId = String(externalCtx.batchId || "").trim();
    const imageId = String(externalCtx.imageId || "").trim();
    const imageUrl = String(externalCtx.imageUrl || "").trim();
    const hasRemoteContext = !!(platformOrigin || topicId || batchId || imageId || imageUrl);
    if (!hasRemoteContext) return "local-default";
    return [
      "remote",
      platformOrigin || "no-origin",
      topicId || "no-topic",
      batchId || "no-batch",
      imageId || imageUrl || "no-image",
    ].join("::");
  }, [
    externalCtx.platformOrigin,
    externalCtx.topicId,
    externalCtx.batchId,
    externalCtx.imageId,
    externalCtx.imageUrl,
  ]);

  useEffect(() => {
    setImageStoreNamespace(imageStoreScope);
  }, [imageStoreScope]);

  const resolveRuntimePlatformToken = (fallbackToken = "") => {
    const rawFallback = String(fallbackToken || "").trim();
    if (rawFallback) return rawFallback;
    const fromLocal = String(localStorage.getItem("token") || "").trim();
    if (fromLocal) return fromLocal;
    const fromSession = String(sessionStorage.getItem("token") || "").trim();
    if (fromSession) return fromSession;
    const fromGlobal = String(window.__NII_ANNOTATION_CONTEXT__?.token || "").trim();
    if (fromGlobal) return fromGlobal;
    return String(externalCtx.token || "").trim();
  };

  const fetchWithAuthFallback = async (url, init = {}, token = "") => {
    const normalizedInit = { ...(init || {}) };
    const runtimeToken = resolveRuntimePlatformToken(token);
    const firstHeaders = {
      ...(normalizedInit.headers || {}),
      ...buildAuthHeaders(runtimeToken),
    };
    const firstResp = await fetch(url, {
      ...normalizedInit,
      headers: firstHeaders,
    });
    if (firstResp.status !== 401) return firstResp;

    const nextToken = resolveRuntimePlatformToken("");
    if (!nextToken || nextToken === runtimeToken) return firstResp;

    const retryHeaders = {
      ...(normalizedInit.headers || {}),
      ...buildAuthHeaders(nextToken),
    };
    return fetch(url, {
      ...normalizedInit,
      headers: retryHeaders,
    });
  };

  const activeLabel = useMemo
(
    () => labels.find((label) => label.id === activeLabelId) || labels[0],
    [labels, activeLabelId],
  );

  const activeDicomSeries = useMemo(() => {
    if (activeImage?.sourceFormat !== "dicom") return [];
    const studyUID = String(activeImage?.dicomStudyUID || "");
    const studyID = String(activeImage?.dicomStudyID || "");
    const accessionNumber = String(activeImage?.dicomAccessionNumber || "");
    const scoped = images.filter((img) => {
      if (img.sourceFormat !== "dicom") return false;
      if (studyUID) return String(img.dicomStudyUID || "") === studyUID;
      if (studyID) return String(img.dicomStudyID || "") === studyID;
      if (accessionNumber)
        return String(img.dicomAccessionNumber || "") === accessionNumber;
      return false;
    });
    return [...scoped].sort((a, b) => {
      if ((a.dicomSeriesOrder || 0) !== (b.dicomSeriesOrder || 0)) {
        return (a.dicomSeriesOrder || 0) - (b.dicomSeriesOrder || 0);
      }
      if ((a.dicomSeriesNumber || 0) !== (b.dicomSeriesNumber || 0)) {
        return (a.dicomSeriesNumber || 0) - (b.dicomSeriesNumber || 0);
      }
      return String(a.dicomSeriesDescription || "").localeCompare(
        String(b.dicomSeriesDescription || ""),
        "zh",
      );
    });
  }, [
    images,
    activeImage?.sourceFormat,
    activeImage?.dicomStudyUID,
    activeImage?.dicomStudyID,
    activeImage?.dicomAccessionNumber,
  ]);

  const activeDicomSeriesIndex = useMemo(() => {
    if (!activeImage?.id || activeDicomSeries.length === 0) return -1;
    return activeDicomSeries.findIndex((item) => item.id === activeImage.id);
  }, [activeDicomSeries, activeImage?.id]);

  const activeLocalGlobalIndex = useMemo(
    () =>
      localImageIds.findIndex(
        (id) => String(id) === String(activeImage?.id || ""),
      ),
    [localImageIds, activeImage?.id],
  );

  const queueImages = useMemo(
    () => (Array.isArray(batchQueue?.images) ? batchQueue.images : []),
    [batchQueue?.images],
  );
  const activeQueueIndex = useMemo(() => {
    if (!activeImage?.remoteImageId || queueImages.length === 0) return -1;
    return queueImages.findIndex(
      (item) => String(item.imageId) === String(activeImage.remoteImageId),
    );
  }, [queueImages, activeImage?.remoteImageId]);
  const activeQueueItem = useMemo(() => {
    if (!activeImage?.remoteImageId || queueImages.length === 0) return null;
    return (
      queueImages.find(
        (item) =>
          String(item?.imageId || "") === String(activeImage.remoteImageId),
      ) || null
    );
  }, [queueImages, activeImage?.remoteImageId]);
  const currentBatchId = String(
    batchQueue?.batchId || externalCtx.batchId || "",
  );
  const isBatchMode = !!currentBatchId;
  const isQueueMode = isBatchMode || queueImages.length > 0;
  const progressTotal = isQueueMode ? queueImages.length : localImageIds.length;
  const progressIndex = isQueueMode ? activeQueueIndex : activeLocalGlobalIndex;
  const displayImages = useMemo(() => {
    if (!isBatchMode) return images.filter((img) => !img.isMaskOnly);
    if (queueImages.length > 0) {
      return queueImages.map((item) => {
        const remoteId = String(item?.imageId || "");
        const local = images.find(
          (img) => String(img.remoteImageId || "") === remoteId,
        );
        const queueHasMask = queueItemHasMaskMeta(item);
        const queueAnnotated = queueItemIsAnnotated(item);
        if (local) {
          return {
            ...local,
            hasMask: !!(local.hasMask || queueHasMask),
            maskAttached: !!(local.maskAttached && local.hasMask),
            isAnnotated: !!(queueAnnotated || local.hasMask),
          };
        }
        const displayName = String(
          item?.sourceImageName || item?.fileName || `image-${remoteId}`,
        );
        return {
          id: `remote-${remoteId}`,
          remoteImageId: remoteId,
          remoteBatchId: currentBatchId,
          name: displayName,
          displayName,
          sourceFormat: "nifti",
          thumbnail: "",
          hasMask: queueHasMask,
          maskAttached: false,
          isAnnotated: queueAnnotated,
          _placeholder: true,
        };
      });
    }
    return images
      .filter(
        (img) =>
          !img.isMaskOnly && String(img.remoteBatchId || "") === currentBatchId,
      )
      .map((img) => ({ ...img, isAnnotated: !!img.hasMask }));
  }, [isBatchMode, queueImages, images, currentBatchId]);
  const activeStepDef = useMemo(() => {
    const steps = Array.isArray(workflowSchema?.steps)
      ? workflowSchema.steps
      : [];
    const idx = Math.max(
      0,
      Math.min(steps.length - 1, Number(workflowState?.stepIndex || 0)),
    );
    return steps[idx] || null;
  }, [workflowSchema, workflowState?.stepIndex]);
  const activeStepState = useMemo(() => {
    const stepId = String(activeStepDef?.id || "");
    if (!stepId) return null;
    return workflowState?.steps?.[stepId] || null;
  }, [workflowState, activeStepDef?.id]);
  const activeCard = useMemo(() => {
    const cards = Array.isArray(activeStepState?.cards)
      ? activeStepState.cards
      : [];
    if (!cards.length) return null;
    const index = Math.max(
      0,
      Math.min(cards.length - 1, Number(activeStepState?.activeCardIndex || 0)),
    );
    return cards[index] || null;
  }, [activeStepState]);
  const lesionItems = useMemo(() => {
    const lesions = Array.isArray(viewerRef.current?.exportLesionItems?.())
      ? viewerRef.current.exportLesionItems()
      : Array.isArray(viewerRef.current?.exportAnnotations?.())
        ? viewerRef.current.exportAnnotations()
        : [];
    return lesions.map((annotation, idx) => {
      const coord = resolveAnnotationAnchorForCard(annotation);
      const lesionId = String(annotation?.lesionId || "");
      return {
        key: lesionId || `lesion-${Math.random().toString(16).slice(2)}`,
        lesionId,
        name: formatLesionNameBySeq(idx),
        labelValue: Number(annotation?.labelValue || 0),
        labelName: String(annotation?.labelName || ""),
        voxelCount: Number(annotation?.voxelCount || 0),
        coord,
      };
    });
  }, [activeImage?.id, activeImage?.maskVersion, workflowState, labelStats]);
  useEffect(() => {
    if (!selectedLesionId) return;
    if (!lesionItems.some((item) => item.lesionId === selectedLesionId)) {
      setSelectedLesionId("");
    }
  }, [lesionItems, selectedLesionId]);
  useEffect(() => {
    const detected = detectBrowserRuntimeEnv();
    runtimeEnvRef.current = detected;
    setRuntimeEnv(detected);
  }, []);

  useEffect(() => {
    const localSchema = parseCustomWorkflowSchema(externalCtx.customSchema);
    if ((localSchema?.steps || []).length > 0) {
      setWorkflowSchema(localSchema);
      return;
    }
    const url = String(externalCtx.customSchemaUrl || "").trim();
    if (!url) {
      setWorkflowSchema(createEmptyWorkflowSchema());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetchWithAuthFallback(
          resolveRemoteUrl(url, externalCtx.platformOrigin),
          {},
        );
        if (!resp.ok) {
          if (!cancelled) setWorkflowSchema(createEmptyWorkflowSchema());
          return;
        }
        const json = await resp.json().catch(() => null);
        const remoteSchema = parseCustomWorkflowSchema(json);
        if (!cancelled) {
          if ((remoteSchema?.steps || []).length > 0) {
            setWorkflowSchema(remoteSchema);
          } else {
            setWorkflowSchema(createEmptyWorkflowSchema());
          }
        }
      } catch {
        if (!cancelled) setWorkflowSchema(createEmptyWorkflowSchema());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    externalCtx.customSchema,
    externalCtx.customSchemaUrl,
    externalCtx.platformOrigin,
  ]);

  useEffect(() => {
    const steps = Array.isArray(workflowSchema?.steps)
      ? workflowSchema.steps
      : [];
    if (!steps.length) {
      setWorkflowState({ stepIndex: 0, steps: {} });
      return;
    }
    const saved = parseJsonSafe(activeImage?.customFields?.__workflow__, null);
    const nextSteps = {};
    for (const step of steps) {
      const savedStep = saved?.steps?.[step.id] || {};
      const savedCards = Array.isArray(savedStep?.cards) ? savedStep.cards : [];
      const cards =
        savedCards.length > 0
          ? savedCards.map((card, idx) => ({
              ...makeEmptyCard(step.id, idx),
              ...card,
              title: String(
                card?.title || `${step.title || "标注"} ${idx + 1}`,
              ),
              annotationIndex: Number.isFinite(Number(card?.annotationIndex))
                ? Number(card.annotationIndex)
                : -1,
            }))
          : [
              {
                ...makeEmptyCard(step.id, 0),
                annotationIndex: -1,
                title: "未绑定标注",
                completed: false,
              },
            ];
      nextSteps[step.id] = {
        activeCardIndex: Math.max(
          0,
          Math.min(cards.length - 1, Number(savedStep?.activeCardIndex || 0)),
        ),
        cards,
        annotationCount: Number.isFinite(Number(savedStep?.annotationCount))
          ? Number(savedStep.annotationCount)
          : 0,
        completed: savedCards.some(
          (card) => Number(card?.annotationIndex) >= 0,
        ),
      };
    }
    const savedStepIndex = Number(saved?.stepIndex || 0);
    const stepIndex = Math.max(
      0,
      Math.min(
        steps.length - 1,
        Number.isFinite(savedStepIndex) ? savedStepIndex : 0,
      ),
    );
    setWorkflowState({ stepIndex, steps: nextSteps });
    setWorkflowErrors({});
  }, [activeImage?.id, activeImage?.customFields, workflowSchema]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.BroadcastChannel !== "function"
    )
      return;
    const channel = new window.BroadcastChannel(PLATFORM_SYNC_CHANNEL);
    platformBroadcastRef.current = channel;
    return () => {
      channel.close();
      platformBroadcastRef.current = null;
    };
  }, []);

  const notifyPlatformSaveSuccess = (payload = {}) => {
    const messagePayload = {
      type: "NII_ANNOTATION_SAVED",
      source: "nii-annotation",
      at: Date.now(),
      ...payload,
    };
    try {
      window.opener?.postMessage?.(messagePayload, "*");
    } catch {
      // ignore
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(messagePayload, "*");
      }
    } catch {
      // ignore
    }
    try {
      platformBroadcastRef.current?.postMessage?.(messagePayload);
    } catch {
      // ignore
    }
    try {
      window.localStorage?.setItem(
        PLATFORM_SYNC_STORAGE_KEY,
        JSON.stringify(messagePayload),
      );
      window.localStorage?.removeItem(PLATFORM_SYNC_STORAGE_KEY);
    } catch {
      // ignore
    }
    try {
      const opener = window.opener;
      if (opener && typeof opener.__NII_ANNOTATION_ON_SAVE__ === "function") {
        opener.__NII_ANNOTATION_ON_SAVE__(messagePayload);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (activeImage?.sourceFormat !== "dicom" && viewerMode !== "default") {
      setViewerMode("default");
    }
  }, [activeImage?.sourceFormat, viewerMode]);

  // 不再因为存在 mask 文件而自动重置工具或关闭菜单

  useEffect(() => {
    if (activeQueueIndex >= 0) {
      queueNavIndexRef.current = activeQueueIndex;
    }
  }, [activeQueueIndex]);

  useEffect(() => {
    hasUnsavedChangesRef.current = false;
    localPersistDirtyRef.current = false;
    setSelectedLesionId("");
  }, [activeImage?.id]);

  useEffect(() => {
    activeImageIdRef.current = String(activeImage?.id || "");
    if (activeImage?.id) cacheImageRecord(activeImage);
  }, [activeImage]);

  const clearLabelStatsSchedule = () => {
    if (statsTimerRef.current !== null) {
      clearTimeout(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (statsIdleRef.current !== null) {
      if (
        typeof window !== "undefined" &&
        typeof window.cancelIdleCallback === "function"
      ) {
        window.cancelIdleCallback(statsIdleRef.current);
      } else {
        clearTimeout(statsIdleRef.current);
      }
      statsIdleRef.current = null;
    }
  };

  const getMaxImageRecordCacheSize = () => {
    const profile = runtimeEnvRef.current?.viewerProfile || {};
    if (profile.lowPowerMode) return 4;
    if (profile.mediumPowerMode) return 6;
    return 10;
  };

  const cacheImageRecord = (record) => {
    if (!record?.id) return record;
    const cache = imageRecordCacheRef.current;
    const key = String(record.id);
    cache.delete(key);
    cache.set(key, record);
    const maxEntries = getMaxImageRecordCacheSize();
    while (cache.size > maxEntries) {
      const firstKey = cache.keys().next().value;
      if (typeof firstKey === "undefined") break;
      cache.delete(firstKey);
    }
    return record;
  };

  const getCachedImageRecord = (id) => {
    const key = String(id || "");
    if (!key) return null;
    const cache = imageRecordCacheRef.current;
    const record = cache.get(key) || null;
    if (!record) return null;
    cache.delete(key);
    cache.set(key, record);
    return record;
  };

  const getImageRecordFast = async (id) => {
    const cached = getCachedImageRecord(id);
    if (cached) return cached;
    const record = await getImageById(id);
    return record ? cacheImageRecord(record) : null;
  };

  const prefetchImageRecord = (id) => {
    const key = String(id || "");
    if (
      !key ||
      getCachedImageRecord(key) ||
      imageRecordPrefetchingRef.current.has(key)
    )
      return;
    imageRecordPrefetchingRef.current.add(key);
    void getImageById(key)
      .then((record) => {
        if (record) cacheImageRecord(record);
      })
      .catch(() => {})
      .finally(() => {
        imageRecordPrefetchingRef.current.delete(key);
      });
  };

  const scheduleLabelStatsRefresh = () => {
    clearLabelStatsSchedule();
    const statsDelayMs = Math.max(
      180,
      Number(runtimeEnvRef.current?.viewerProfile?.labelStatsDelayMs || 320),
    );
    statsTimerRef.current = setTimeout(() => {
      const run = () => {
        statsIdleRef.current = null;
        const stats = viewerRef.current?.getLabelStats?.() || {};
        setLabelStats(stats);
      };
      if (
        typeof window !== "undefined" &&
        typeof window.requestIdleCallback === "function"
      ) {
        statsIdleRef.current = window.requestIdleCallback(run, {
          timeout: 260,
        });
      } else {
        run();
      }
    }, statsDelayMs);
  };

  const buildClientEnvReport = (phase = "save", extra = {}) => {
    const refreshState = viewerRef.current?.getRefreshDiagnostics?.() || null;
    return {
      phase,
      recordedAt: new Date().toISOString(),
      imageId: String(activeImageIdRef.current || activeImage?.id || ""),
      runtime: runtimeEnvRef.current,
      refresh: refreshState?.last || null,
      ...extra,
    };
  };

  const getEffectiveCustomFieldValues = (
    record = null,
    workflowOverride = null,
  ) => {
    const existing = parseJsonSafe(record?.customFields, {}) || {};
    const workflow =
      workflowOverride ||
      parseJsonSafe(existing?.__workflow__, existing?.__workflow__) ||
      null;
    if (!workflow || !workflow.steps || typeof workflow.steps !== "object")
      return { ...existing };
    const sanitized = { ...existing };
    for (const step of Array.isArray(workflowSchema?.steps)
      ? workflowSchema.steps
      : []) {
      const prefix = `${step.id}__`;
      for (const key of Object.keys(sanitized)) {
        if (key.startsWith(prefix)) delete sanitized[key];
      }
    }
    delete sanitized.label;
    const flattened = {};
    let preferredLabelSet = false;
    const stepOrder = Array.isArray(workflowSchema?.steps)
      ? workflowSchema.steps
      : [];
    const sortedSteps = [...stepOrder].sort((a, b) => {
      const aCount = Number(workflow?.steps?.[a.id]?.annotationCount || 0);
      const bCount = Number(workflow?.steps?.[b.id]?.annotationCount || 0);
      if (aCount !== bCount) return bCount - aCount;
      return (
        stepOrder.findIndex((s) => s.id === a.id) -
        stepOrder.findIndex((s) => s.id === b.id)
      );
    });
    for (const step of sortedSteps) {
      const stepState = workflow.steps?.[step.id] || {};
      if (!stepState || typeof stepState !== "object") continue;
      const cards = Array.isArray(stepState.cards) ? stepState.cards : [];
      for (let idx = 0; idx < cards.length; idx += 1) {
        const card = cards[idx] || {};
        const cardNo = idx + 1;
        if (card.mainCategory != null && String(card.mainCategory).trim()) {
          flattened[`${step.id}__${cardNo}__mainCategory`] = String(
            card.mainCategory,
          );
          if (idx === 0)
            flattened[`${step.id}__mainCategory`] = String(card.mainCategory);
          if (!preferredLabelSet) {
            const num = Number(card.mainCategory);
            flattened.label = Number.isFinite(num)
              ? num
              : String(card.mainCategory);
            preferredLabelSet = true;
          }
        }
        const values = card.values || {};
        for (const field of step.fields || []) {
          if (!field?.id) continue;
          const value = values[field.id];
          if (value == null) continue;
          flattened[`${step.id}__${cardNo}__${field.id}`] = value;
          if (idx === 0) flattened[`${step.id}__${field.id}`] = value;
        }
      }
      if (stepState.annotationCount != null) {
        flattened[`${step.id}__annotationCount`] =
          Number(stepState.annotationCount) || 0;
      }
    }
    return {
      ...sanitized,
      ...flattened,
    };
  };

  const persistWorkflowStateToImage = (nextState) => {
    const id = String(activeImage?.id || "");
    if (!id) return;
    const base = getEffectiveCustomFieldValues(activeImage);
    const nextCustomFields = {
      ...base,
      __workflow__: nextState,
    };
    const optimistic = {
      ...(activeImage || {}),
      customFields: nextCustomFields,
    };
    cacheImageRecord(optimistic);
    setActiveImage((prev) => {
      if (!prev || String(prev.id || "") !== id) return prev;
      return { ...prev, customFields: nextCustomFields };
    });
    void updateImage(id, {
      customFields: nextCustomFields,
      updatedAt: Date.now(),
    }).then((updated) => {
      if (updated) cacheImageRecord(updated);
    });
  };

  const updateWorkflowState = (updater, { persist = true } = {}) => {
    setWorkflowState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (persist) persistWorkflowStateToImage(next);
      return next;
    });
  };

  const updateActiveCardFieldValue = (fieldId, value) => {
    if (!activeStepDef || !activeCard) return;
    const stepId = String(activeStepDef.id);
    updateWorkflowState((prev) => {
      const step = prev?.steps?.[stepId];
      if (!step) return prev;
      const cards = Array.isArray(step.cards) ? [...step.cards] : [];
      const cardIndex = Math.max(
        0,
        Math.min(cards.length - 1, Number(step.activeCardIndex || 0)),
      );
      const current = cards[cardIndex];
      if (!current) return prev;
      if ((current.values || {})[fieldId] === value) return prev;
      const nextStep = {
        ...step,
        cards: cards.map((card, idx) =>
          idx === cardIndex
            ? {
                ...card,
                values: {
                  ...(card.values || {}),
                  [fieldId]: value,
                },
              }
            : card,
        ),
      };
      return {
        ...prev,
        steps: {
          ...prev.steps,
          [stepId]: nextStep,
        },
      };
    });
  };

  const loadLocalImagePage = async (idOrder, startIndex = 0) => {
    const total = idOrder.length;
    if (total <= 0) {
      setImages([]);
      return { items: [], start: 0 };
    }
    const clampedStart = Math.max(
      0,
      Math.min(
        Math.floor(startIndex / LOCAL_IMAGE_PAGE_SIZE) * LOCAL_IMAGE_PAGE_SIZE,
        Math.max(0, total - LOCAL_IMAGE_PAGE_SIZE),
      ),
    );
    const pageIds = idOrder.slice(
      clampedStart,
      clampedStart + LOCAL_IMAGE_PAGE_SIZE,
    );
    const metas = await getImageMetasByIds(pageIds);
    setImages(metas.map(toListItem));
    return { items: metas, start: clampedStart };
  };

  const refreshImageList = async () => {
    const idOrder = await getImageIdOrder();
    setLocalImageIds(idOrder.map((id) => String(id)));
    const activeId = String(activeImageIdRef.current || "");
    const activeOrderIndex = activeId
      ? idOrder.findIndex((id) => String(id) === activeId)
      : -1;
    const desiredIndex = activeOrderIndex >= 0 ? activeOrderIndex : 0;
    const { items } = await loadLocalImagePage(idOrder, desiredIndex);
    for (const record of items) cacheImageRecord(record);

    if (activeId) {
      const stillExists = activeOrderIndex >= 0;
      if (!stillExists) return;
      const fresh = await getImageById(activeId);
      if (fresh) {
        cacheImageRecord(fresh);
        setActiveImage((prev) => {
          if (String(prev?.id || "") !== activeId) return prev;
          return {
            ...fresh,
            maskVersion: Math.max(
              Number(prev?.maskVersion || 0),
              resolveMaskVersion(fresh),
            ),
          };
        });
      }
      return;
    }

    if (idOrder.length > 0) {
      const first = await getImageById(idOrder[0]);
      if (!first) return;
      cacheImageRecord(first);
      setActiveImage({
        ...first,
        maskVersion: resolveMaskVersion(first),
      });
    }
  };

  const activateImportedRecordIfAllowed = (record, { dicom = false } = {}) => {
    if (!record) return false;
    if (externalCtx.batchId) return false;
    if (activeImageIdRef.current) return false;
    activeImageIdRef.current = String(record.id);
    setActiveImage({ ...record, maskVersion: resolveMaskVersion(record) });
    if (dicom) setViewerMode("dicom");
    return true;
  };

  const findLocalByRemoteImageId = async (remoteImageId) => {
    if (!remoteImageId) return null;
    const records = await getImagesByRemoteImageId(String(remoteImageId));
    const candidates = records.filter((record) => record && !record.isMaskOnly);
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const aUpdated = Number(a?.updatedAt || 0);
      const bUpdated = Number(b?.updatedAt || 0);
      if (aUpdated !== bUpdated) return bUpdated - aUpdated;
      const aCreated = Number(a?.createdAt || 0);
      const bCreated = Number(b?.createdAt || 0);
      return bCreated - aCreated;
    });
    return candidates[0] || null;
  };

  const fetchAndImportByImageId = async ({
    imageId = externalCtx.imageId,
    imageUrl = externalCtx.imageUrl,
    originalName = externalCtx.originalName,
    remoteBatchId = externalCtx.batchId,
    topicId = externalCtx.topicId,
    useAutoGuard = true,
    silent = false,
    skipUiRefresh = false,
  } = {}) => {
    const remoteKey = String(imageId || imageUrl || "").trim();
    if (remoteKey && remoteImportInFlightRef.current.has(remoteKey)) {
      return remoteImportInFlightRef.current.get(remoteKey);
    }
    const runPromise = (async () => {
      if (useAutoGuard && autoImportedRef.current) return null;
      const hasDirectImageUrl = !!imageUrl;
      const hasImageIdDownload = !!imageId && !!externalCtx.platformOrigin;
      if (!hasDirectImageUrl && !hasImageIdDownload) return null;

      if (useAutoGuard) autoImportedRef.current = true;
      try {
        const normalizedOrigin = String(
          externalCtx.platformOrigin || "",
        ).replace(/\/+$/, "");
        const url = hasDirectImageUrl
          ? resolveRemoteUrl(imageUrl, normalizedOrigin)
          : (() => {
              const params = new URLSearchParams();
              params.set("imageId", String(imageId));
              if (remoteBatchId) params.set("batchId", String(remoteBatchId));
              if (topicId) params.set("topicId", String(topicId));
              return `${normalizedOrigin}/analysisPlatformService/api/v1/analysis/sample/image/downloadByImageId?${params.toString()}`;
            })();
        const resp = await fetchWithAuthFallback(url, {});
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);

        const blob = await resp.blob();
        const rawBuffer = await blob.arrayBuffer();
        const downloadedHash = await hashBuffer(rawBuffer);
        const contentType = String(
          resp.headers.get("content-type") || "",
        ).toLowerCase();
        if (contentType.includes("text/html") || isHtmlLikeBuffer(rawBuffer)) {
          const htmlHead = new TextDecoder("utf-8")
            .decode(new Uint8Array(rawBuffer).slice(0, 220))
            .replace(/\s+/g, " ")
            .trim();
          throw new Error(
            `downloadByImageId 返回 HTML（疑似登录页/网关页），imageId=${imageId}, status=${resp.status}, content-type=${contentType || "unknown"}, url=${url}, head=${htmlHead}`,
          );
        }
        const headerName = parseFileNameFromDisposition(
          resp.headers.get("content-disposition"),
        );
        const fallbackName =
          originalName || headerName || `image-${imageId || Date.now()}`;
        let normalizedName = normalizeIncomingFileName(
          fallbackName,
          rawBuffer,
          `image-${imageId || "remote"}`,
        );
        const niftiByContent = isNiftiBuffer(rawBuffer);
        const zipByContent = isZipBuffer(rawBuffer);
        const dicomByContent = isDicomContentBuffer(rawBuffer);

        if (isNiftiFile(normalizedName) && !niftiByContent) {
          if (zipByContent)
            normalizedName = `${fileStem(normalizedName) || `image-${imageId || "remote"}`}.zip`;
          else if (dicomByContent)
            normalizedName = `${fileStem(normalizedName) || `image-${imageId || "remote"}`}.dcm`;
          else {
            const head = Array.from(new Uint8Array(rawBuffer).slice(0, 16))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ");
            throw new Error(
              `payload is not valid NIfTI for imageId=${imageId}; first16=${head}`,
            );
          }
        }

        if (
          !isZipFile(normalizedName) &&
          !isSupportedImageFile(normalizedName) &&
          !isDicomFile(normalizedName) &&
          !isDicomContentBuffer(rawBuffer)
        ) {
          if (
            contentType.includes("application/json") ||
            contentType.includes("text/plain")
          ) {
            const text = new TextDecoder("utf-8").decode(
              new Uint8Array(rawBuffer).slice(0, 300),
            );
            throw new Error(
              `remote payload is not image binary (content-type=${contentType}): ${text}`,
            );
          }
          throw new Error(
            `unsupported remote payload: name=${normalizedName}, content-type=${contentType || "unknown"}`,
          );
        }

        const file = new File([rawBuffer], normalizedName, {
          type: blob.type || "application/octet-stream",
        });

        const existing = await getAllImages();
        const hashSet = new Set(
          existing.map((item) => item.hash).filter(Boolean),
        );
        const importBatchId = makeImportBatchId();
        const beforeCount = existing.length;

        if (isZipFile(file.name)) {
          await importZipFile(file, hashSet, importBatchId);
        } else {
          await importImageFile(file, hashSet, importBatchId);
        }

        const afterRecords = await getAllImages();
        const afterCount = afterRecords.length;
        const imported = afterRecords.filter(
          (record) =>
            record.importBatchId === importBatchId && !record.isMaskOnly,
        );
        if (imported.length > 0 && imageId) {
          for (const record of imported) {
            await updateImage(record.id, {
              remoteImageId: String(imageId),
              remoteBatchId: String(remoteBatchId || ""),
              updatedAt: Date.now(),
            });
          }
        }
        let mappedRecord =
          (await findLocalByRemoteImageId(imageId)) ||
          imported[0] ||
          afterRecords.find(
            (record) =>
              !record.isMaskOnly && record.importBatchId === importBatchId,
          ) ||
          null;

        if (!mappedRecord && imageId) {
          const expectedBase = normalizeBaseName(normalizedName);
          const byName = afterRecords.find(
            (record) =>
              !record.isMaskOnly &&
              normalizeBaseName(
                record.sourceName || record.displayName || record.name,
              ) === expectedBase,
          );
          const byHash = afterRecords.find(
            (record) =>
              !record.isMaskOnly &&
              String(record.hash || "") === String(downloadedHash || ""),
          );
          const candidate = byName || byHash || null;

          if (candidate) {
            if (
              candidate.remoteImageId &&
              String(candidate.remoteImageId) !== String(imageId)
            ) {
              // 后端返回了重复影像内容时，为当前 imageId 建立别名记录，避免批次切换失败。
              const alias = createImageRecord(
                candidate.name || normalizedName,
                candidate.data,
                candidate.hash || downloadedHash,
                candidate.thumbnail || "",
                {
                  displayName: candidate.displayName || normalizedName,
                  maskBuffer: candidate.mask || null,
                  maskName: candidate.maskName || null,
                  sourceMask: candidate.sourceMask || null,
                  sourceMaskName: candidate.sourceMaskName || null,
                  maskAttached: candidate.maskAttached !== false,
                  isMaskOnly: !!candidate.isMaskOnly,
                  rasterHFlipNormalized: !!candidate.rasterHFlipNormalized,
                  spatialMeta: candidate.spatialMeta || null,
                  rasterConversionVersion: Number(
                    candidate.rasterConversionVersion || 0,
                  ),
                  importBatchId,
                  sourceName: candidate.sourceName || normalizedName,
                  sourceData: candidate.sourceData || candidate.data,
                  modifiedByUser: false,
                  sourceFormat: candidate.sourceFormat || "nifti",
                  dicomSourceCount: Number(candidate.dicomSourceCount || 0),
                  dicomStudyUID: candidate.dicomStudyUID || "",
                  dicomStudyID: candidate.dicomStudyID || "",
                  dicomSeriesUID: candidate.dicomSeriesUID || "",
                  dicomSeriesDescription:
                    candidate.dicomSeriesDescription || "",
                  dicomSeriesNumber: Number(candidate.dicomSeriesNumber || 0),
                  dicomSeriesOrder: Number(candidate.dicomSeriesOrder || 0),
                  dicomAccessionNumber: candidate.dicomAccessionNumber || "",
                  customFields: parseJsonSafe(candidate.customFields, {}) || {},
                  remoteImageId: String(imageId),
                  remoteBatchId: String(remoteBatchId || ""),
                },
              );
              await saveImages([alias]);
              mappedRecord = alias;
            } else {
              const patched = await updateImage(candidate.id, {
                remoteImageId: String(imageId),
                remoteBatchId: String(remoteBatchId || ""),
                updatedAt: Date.now(),
              });
              mappedRecord = patched || candidate;
            }
          }
        }
        if (!skipUiRefresh) {
          void refreshImageList();
        }
        if (afterCount <= beforeCount) {
          if (!silent) Message.info("影像已存在，已直接加载本地记录");
          return mappedRecord;
        }
        if (!silent) Message.success("已自动接收科研平台影像");
        return mappedRecord;
      } catch (error) {
        console.error(error);
        if (silent) return null;
        const msg = String(error?.message || "");
        if (msg.includes("返回 HTML")) {
          Message.error(
            "下载接口返回了 HTML 页面（非 NIfTI 文件），请检查登录态/鉴权与 downloadByImageId 接口实现",
          );
        } else {
          Message.error("自动加载影像失败，请检查科研平台传参与下载接口");
        }
        return null;
      }
    })();
    if (remoteKey) remoteImportInFlightRef.current.set(remoteKey, runPromise);
    try {
      return await runPromise;
    } finally {
      if (remoteKey) remoteImportInFlightRef.current.delete(remoteKey);
    }
  };

  const ensureQueueImageLoaded = async (queueItem) => {
    const remoteImageId = String(queueItem?.imageId || "");
    if (!remoteImageId) return false;
    const existing = await findLocalByRemoteImageId(remoteImageId);
    if (existing) {
      await selectImage(existing.id);
      return true;
    }
    const imported = await fetchAndImportByImageId({
      imageId: remoteImageId,
      imageUrl: queueItem?.imageUrl || queueItem?.downloadUrl || "",
      originalName:
        queueItem?.sourceImageName ||
        queueItem?.fileName ||
        `image-${remoteImageId}.nii.gz`,
      remoteBatchId: batchQueue?.batchId || externalCtx.batchId,
      topicId: externalCtx.topicId,
      useAutoGuard: false,
    });
    if (!imported?.id) return false;
    await selectImage(imported.id);
    return true;
  };

  const prefetchQueueItemData = async (queueItem) => {
    const remoteImageId = String(queueItem?.imageId || "");
    if (!remoteImageId) return false;
    const existing = await findLocalByRemoteImageId(remoteImageId);
    if (existing) return false;
    const imported = await fetchAndImportByImageId({
      imageId: remoteImageId,
      imageUrl: queueItem?.imageUrl || queueItem?.downloadUrl || "",
      originalName:
        queueItem?.sourceImageName ||
        queueItem?.fileName ||
        `image-${remoteImageId}.nii.gz`,
      remoteBatchId: batchQueue?.batchId || externalCtx.batchId,
      topicId: externalCtx.topicId,
      useAutoGuard: false,
      silent: true,
      skipUiRefresh: true,
    });
    return !!imported?.id;
  };

  const pickQueuePrefetchCandidates = (
    items = [],
    {
      aroundIndex = -1,
      radius = QUEUE_PREFETCH_RADIUS,
      skipImageId = "",
      scope = "window",
    } = {},
  ) => {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (scope === "all") {
      return items.filter(
        (item) => String(item?.imageId || "") !== String(skipImageId || ""),
      );
    }
    const idx =
      Number.isInteger(aroundIndex) && aroundIndex >= 0 ? aroundIndex : 0;
    const resolvedRadius = Math.max(0, Number(radius || 0));
    const picked = [];
    for (let offset = -resolvedRadius; offset <= resolvedRadius; offset += 1) {
      if (offset === 0) continue;
      const targetIndex = idx + offset;
      if (targetIndex < 0 || targetIndex >= items.length) continue;
      const item = items[targetIndex];
      if (!item) continue;
      if (String(item?.imageId || "") === String(skipImageId || "")) continue;
      picked.push(item);
    }
    return picked;
  };

  const prefetchQueueImages = async (
    items = [],
    {
      skipImageId = "",
      aroundIndex = -1,
      radius = QUEUE_PREFETCH_RADIUS,
      scope = "window",
      concurrency = 1,
    } = {},
  ) => {
    const targets = pickQueuePrefetchCandidates(items, {
      aroundIndex,
      radius,
      skipImageId,
      scope,
    });
    if (!targets.length) return;
    let changed = false;
    const maxWorkers = Math.max(1, Math.min(6, Number(concurrency || 1)));
    const queue = [...targets];
    const runWorker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;
        const remoteImageId = String(item?.imageId || "");
        if (
          !remoteImageId ||
          (skipImageId && String(skipImageId) === remoteImageId)
        )
          continue;
        const imported = await prefetchQueueItemData(item);
        if (imported) changed = true;
      }
    };
    await Promise.all(Array.from({ length: maxWorkers }, () => runWorker()));
    if (changed) {
      await refreshImageList();
    }
  };

  const loadBatchQueue = async () => {
    if (!externalCtx.platformOrigin || !externalCtx.batchId) return null;
    const normalizedOrigin = String(externalCtx.platformOrigin || "").replace(
      /\/+$/,
      "",
    );
    const params = new URLSearchParams();
    if (externalCtx.topicId) params.set("topicId", String(externalCtx.topicId));
    params.set("batchId", String(externalCtx.batchId));
    const endpoint = `${normalizedOrigin}/analysisPlatformService/api/v1/analysis/sample/image/getBatchImageQueue?${params.toString()}`;
    const resp = await fetchWithAuthFallback(endpoint, {});
    if (!resp.ok) throw new Error(`get batch queue failed: ${resp.status}`);
    const json = await resp.json().catch(() => null);
    const payload = parseApiPayload(json);
    if (!payload || !Array.isArray(payload.images))
      throw new Error("invalid batch queue payload");
    setBatchQueue(payload);
    return payload;
  };

  useEffect(() => {
    (async () => {
      if (initializedRef.current) return;
      initializedRef.current = true;
      const hasRemoteBootstrap =
        !externalCtx.batchId && !!(externalCtx.imageId || externalCtx.imageUrl);
      if (externalCtx.batchId) {
        await clearAllImages();
        setImages([]);
        setLocalImageIds([]);
        setActiveImage(null);
      }
      if (!hasRemoteBootstrap) {
        await refreshImageList();
      }
      if (externalCtx.batchId) {
        try {
          const queue = await loadBatchQueue();
          const targetImageId = String(
            externalCtx.imageId || queue?.images?.[0]?.imageId || "",
          );
          const targetItem =
            queue?.images?.find(
              (item) => String(item.imageId) === targetImageId,
            ) ||
            queue?.images?.[0] ||
            null;
          if (targetItem && Array.isArray(queue?.images)) {
            const idx = queue.images.findIndex(
              (item) => String(item.imageId) === String(targetItem.imageId),
            );
            queueNavIndexRef.current = idx >= 0 ? idx : 0;
          }
          if (targetItem) {
            await ensureQueueImageLoaded(targetItem);
            if (Array.isArray(queue?.images) && queue.images.length > 1) {
              const currentIndex = Math.max(0, queueNavIndexRef.current);
              const nextIndex = (currentIndex + 1) % queue.images.length;
              const prevIndex =
                (currentIndex - 1 + queue.images.length) % queue.images.length;
              void prefetchQueueItemData(queue.images[nextIndex]);
              void prefetchQueueItemData(queue.images[prevIndex]);
            }
            if (ENABLE_NEARBY_PREFETCH) {
              void prefetchQueueImages(queue?.images || [], {
                skipImageId: targetItem?.imageId,
                aroundIndex: queueNavIndexRef.current,
                scope: "window",
              });
            }
            if (!batchPrefetchStartedRef.current) {
              batchPrefetchStartedRef.current = true;
              void prefetchQueueImages(queue?.images || [], {
                skipImageId: targetItem?.imageId,
                scope: "all",
                concurrency: BATCH_PREFETCH_CONCURRENCY,
              });
            }
          }
        } catch (error) {
          console.error(error);
          Message.error("批次队列加载失败，已回退单图模式");
          await fetchAndImportByImageId();
        }
      } else {
        const imported = await fetchAndImportByImageId();
        if (!imported) {
          await refreshImageList();
        }
      }
    })();
  }, []);

  useEffect(() => {
    scheduleLabelStatsRefresh();
  }, [activeImage?.id, activeImage?.maskVersion, labels.length]);

  const captureViewerPersistPayload = async (
    imageRecord,
    phase = "persist",
  ) => {
    if (!imageRecord?.id) return null;
    const templateBuffer = imageRecord?.sourceData || imageRecord?.data || null;
    const persistedState = viewerRef.current?.exportPersistState?.() || null;
    const overlayAnnotations =
      persistedState?.overlayAnnotations ||
      viewerRef.current?.exportAnnotations?.() ||
      [];
    const hasOverlayAnnotations = overlayAnnotations.length > 0;
    const hadExistingMask = !!(
      imageRecord?.maskAttached ||
      imageRecord?.mask ||
      imageRecord?.sourceMask
    );
    const hadExistingContent =
      hadExistingMask ||
      (Array.isArray(imageRecord?.overlayAnnotations) &&
        imageRecord.overlayAnnotations.length > 0);
    const clientEnvReport = buildClientEnvReport(phase, {
      imageId: String(imageRecord.id || ""),
    });
    const exported = await viewerRef.current?.exportDrawing?.();
    const raw = arrayBufferFrom(exported);
    const buffer = raw ? sanitizeMaskBuffer(raw, { templateBuffer }) : null;
    const hasMask = buffer ? hasNonZeroMaskNifti(buffer) : false;

    // Prefer Niivue's native drawing export so the persisted mask uses the
    // same spatial encoding path as the viewer. Keep the bitmap snapshot only
    // as a fallback if native export is unavailable.
    if (buffer) {
      return {
        imageId: imageRecord.id,
        imageName: imageRecord.name,
        sourceMask: imageRecord.sourceMask || null,
        overlayAnnotations,
        buffer,
        bitmap: null,
        dims: null,
        headerTemplate: null,
        hasMask,
        hasOverlayAnnotations,
        hadExistingMask,
        hadExistingContent,
        currentMaskVersion: resolveMaskVersion(imageRecord),
        templateBuffer,
        clientEnvReport,
      };
    }

    if (persistedState?.bitmap && Array.isArray(persistedState?.dims)) {
      return {
        imageId: imageRecord.id,
        imageName: imageRecord.name,
        sourceMask: imageRecord.sourceMask || null,
        overlayAnnotations,
        bitmap: persistedState.bitmap,
        dims: persistedState.dims,
        headerTemplate: persistedState.headerTemplate || null,
        buffer: null,
        hasMask: !!persistedState.hasMask,
        hasOverlayAnnotations,
        hadExistingMask,
        hadExistingContent,
        currentMaskVersion: resolveMaskVersion(imageRecord),
        templateBuffer,
        clientEnvReport,
      };
    }

    return {
      imageId: imageRecord.id,
      imageName: imageRecord.name,
      sourceMask: imageRecord.sourceMask || null,
      overlayAnnotations,
      buffer,
      bitmap: null,
      dims: null,
      headerTemplate: null,
      hasMask,
      hasOverlayAnnotations,
      hadExistingMask,
      hadExistingContent,
      currentMaskVersion: resolveMaskVersion(imageRecord),
      templateBuffer,
      clientEnvReport,
    };
  };

  const materializePersistBuffer = (payload) => {
    if (!payload) return null;
    if (payload.buffer) return payload.buffer;
    if (!payload.hasMask || !payload.bitmap || !Array.isArray(payload.dims))
      return null;
    const encoded = encodeMaskBitmapToNifti(payload.bitmap, payload.dims, {
      templateBuffer: payload.templateBuffer,
      headerTemplate: payload.headerTemplate,
    });
    if (encoded) payload.buffer = encoded;
    return encoded;
  };

  const resolvePersistMaskVersion = (payload, hasMask) => {
    const currentVersion = Math.max(
      0,
      Number(payload?.currentMaskVersion || 0),
    );
    if (hasMask) return currentVersion + 1;
    if (payload?.hadExistingMask) return currentVersion + 1;
    return currentVersion;
  };

  const buildOptimisticPersistRecord = (record, payload) => {
    if (
      !record?.id ||
      !payload ||
      String(record.id) !== String(payload.imageId || "")
    )
      return null;
    const buffer = materializePersistBuffer(payload);
    const hasMask = !!(payload.hasMask && buffer);
    const nextMaskVersion = resolvePersistMaskVersion(payload, hasMask);
    return {
      ...record,
      mask: hasMask ? buffer : null,
      maskName: hasMask ? `${fileStem(payload.imageName)}.nii.gz` : null,
      maskAttached: hasMask,
      overlayAnnotations: payload.overlayAnnotations,
      lastClientEnvReport: payload.clientEnvReport,
      modifiedByUser: true,
      updatedAt: Date.now(),
      maskVersion: nextMaskVersion,
    };
  };

  const persistDrawingPayload = async (payload) => {
    if (!payload?.imageId) return false;
    const imageId = payload.imageId;
    const clearCurrentDirtyFlag = () => {
      if (String(activeImageIdRef.current || "") === String(imageId)) {
        localPersistDirtyRef.current = false;
      }
    };
    let buffer = materializePersistBuffer(payload);
    const hasMask = !!(payload.hasMask && buffer);
    const hasOverlayAnnotations =
      Array.isArray(payload.overlayAnnotations) &&
      payload.overlayAnnotations.length > 0;
    const nextMaskVersion = resolvePersistMaskVersion(payload, hasMask);
    if (!buffer && !hasOverlayAnnotations && !payload.hadExistingContent) {
      clearCurrentDirtyFlag();
      return false;
    }
    if (!hasMask) {
      const updated = await updateImage(imageId, {
        mask: null,
        maskName: null,
        maskAttached: false,
        maskVersion: nextMaskVersion,
        overlayAnnotations: payload.overlayAnnotations,
        lastClientEnvReport: payload.clientEnvReport,
        modifiedByUser: true,
        updatedAt: Date.now(),
      });
      if (updated) cacheImageRecord(updated);
      const hasSourceMask = !!payload.sourceMask;
      setImages((prev) =>
        prev.map((img) =>
          img.id === imageId
            ? {
                ...img,
                hasMask: hasSourceMask,
                maskAttached: false,
                maskVersion: nextMaskVersion,
              }
            : img,
        ),
      );
      setActiveImage((prev) =>
        prev && prev.id === imageId
          ? {
              ...prev,
              mask: null,
              maskName: null,
              maskAttached: false,
              // 当前影像内自动保存只更新数据，不触发 maskVersion 重载，避免 2D 视口瞬时错位。
              maskVersion: Number(prev?.maskVersion || 0),
              overlayAnnotations: payload.overlayAnnotations,
              lastClientEnvReport: payload.clientEnvReport,
              modifiedByUser: true,
            }
          : prev,
      );
      clearCurrentDirtyFlag();
      return true;
    }

    const updated = await updateImage(imageId, {
      mask: buffer,
      maskName: `${fileStem(payload.imageName)}.nii.gz`,
      maskAttached: true,
      maskVersion: nextMaskVersion,
      overlayAnnotations: payload.overlayAnnotations,
      lastClientEnvReport: payload.clientEnvReport,
      modifiedByUser: true,
      updatedAt: Date.now(),
    });
    if (updated) cacheImageRecord(updated);

    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? {
              ...img,
              hasMask: true,
              maskAttached: true,
              maskVersion: nextMaskVersion,
            }
          : img,
      ),
    );
    setActiveImage((prev) =>
      prev && prev.id === imageId
        ? {
            ...prev,
            mask: buffer,
            maskAttached: true,
            // 当前影像内自动保存只更新数据，不触发 maskVersion 重载，避免 2D 视口瞬时错位。
            maskVersion: Number(prev?.maskVersion || 0),
            overlayAnnotations: payload.overlayAnnotations,
            lastClientEnvReport: payload.clientEnvReport,
            modifiedByUser: true,
          }
        : prev,
    );
    clearCurrentDirtyFlag();
    return true;
  };

  const persistActiveDrawing = async () => {
    if (!activeImage?.id) return false;
    const payload = await captureViewerPersistPayload(activeImage, "persist");
    return persistDrawingPayload(payload);
  };

  const clearAutoSaveSchedule = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (saveIdleRef.current !== null) {
      if (
        typeof window !== "undefined" &&
        typeof window.cancelIdleCallback === "function"
      ) {
        window.cancelIdleCallback(saveIdleRef.current);
      } else {
        clearTimeout(saveIdleRef.current);
      }
      saveIdleRef.current = null;
    }
  };

  const enqueuePersistPayload = (payload) => {
    saveQueueRef.current = saveQueueRef.current
      .then(() => persistDrawingPayload(payload))
      .catch((error) => {
        console.error("自动保存失败", error);
        return false;
      });
    return saveQueueRef.current;
  };

  const enqueuePersistActiveDrawing = async () => {
    if (!activeImage?.id) return false;
    const payload = await captureViewerPersistPayload(activeImage, "persist");
    if (!payload) return false;
    return enqueuePersistPayload(payload);
  };

  const scheduleAutoPersist = (delay = 1200) => {
    clearAutoSaveSchedule();
    saveTimerRef.current = setTimeout(() => {
      const run = () => {
        saveIdleRef.current = null;
        void enqueuePersistActiveDrawing();
      };
      if (
        typeof window !== "undefined" &&
        typeof window.requestIdleCallback === "function"
      ) {
        saveIdleRef.current = window.requestIdleCallback(run, {
          timeout: 1500,
        });
      } else {
        saveIdleRef.current = setTimeout(run, 0);
      }
    }, delay);
  };

  const syncActiveAnnotationToLocalBackend = async () => {
    if (!activeImage?.id) return false;
    const record = await getImageById(activeImage.id);
    if (!record) return false;
    const imageBuffer = record?.sourceData || record?.data;
    const maskBuffer = record?.mask || record?.sourceMask;
    if (!imageBuffer || !maskBuffer) return false;

    const endpoint = `${localBackendOrigin}/export`;
    const payload = new FormData();
    const imageName = String(
      record?.sourceName || record?.name || "image.nii.gz",
    );
    const maskName = `${fileStem(imageName) || "mask"}.nii.gz`;
    const overlayAnnotations = Array.isArray(record?.overlayAnnotations)
      ? record.overlayAnnotations
      : [];
    const customFields = getEffectiveCustomFieldValues(record);
    const clientEnvReport = buildClientEnvReport("local-backend", {
      imageId: String(
        record?.remoteImageId || record?.id || activeImage.id || "",
      ),
    });
    const annotationsJson = JSON.stringify({
      labels,
      annotations: overlayAnnotations,
      customFields,
      imageId: String(
        record?.remoteImageId || record?.id || activeImage.id || "",
      ),
      clientEnv: clientEnvReport,
    });

    payload.append(
      "image",
      new File([imageBuffer], imageName, { type: "application/octet-stream" }),
    );
    payload.append(
      "mask",
      new File([maskBuffer], maskName, { type: "application/octet-stream" }),
    );
    payload.append(
      "annotations",
      new File([annotationsJson], "annotations.json", {
        type: "application/json",
      }),
    );
    payload.append(
      "image_id",
      String(record?.remoteImageId || record?.id || activeImage.id || ""),
    );

    let resp;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        body: payload,
      });
    } catch (error) {
      throw new Error(`本地导出服务不可达: ${endpoint}`);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(errText || `local export failed: ${resp.status}`);
    }
    return true;
  };

  const syncActiveAnnotationToPlatform = async (
    workflowSnapshot = null,
    labelCsv = "",
    labelXlsxBase64 = "",
  ) => {
    const remoteImageId = String(
      activeImage?.remoteImageId || externalCtx?.imageId || "",
    );
    if (!remoteImageId || !externalCtx?.platformOrigin || !activeImage?.id)
      return false;
    const record = await getImageById(activeImage.id);
    const maskBuffer = record?.mask || record?.sourceMask;
    if (!maskBuffer) return false;

    const sourceName = String(record?.sourceName || record?.name || "");
    const sourceNameStem =
      fileStem(sourceName) || sourceName || `image-${remoteImageId}`;
    const customFields = getEffectiveCustomFieldValues(
      record,
      workflowSnapshot,
    );
    const clientEnvReport = buildClientEnvReport("platform-single", {
      imageId: remoteImageId,
    });
    const normalizedOrigin = String(externalCtx.platformOrigin || "").replace(
      /\/+$/,
      "",
    );
    const endpoint = `${normalizedOrigin}/analysisPlatformService/api/v1/analysis/sample/image/saveAnnotationByImageId`;
    const payload = new FormData();
    payload.append("imageId", remoteImageId);
    payload.append(
      "maskFile",
      new File([maskBuffer], inferMaskFileName(sourceName || "mask.nii.gz"), {
        type: "application/octet-stream",
      }),
    );
    payload.append("sourceImageName", sourceNameStem);
    payload.append("annotationStatus", "1");
    payload.append("annotation_status", "1");
    payload.append(
      "annotations",
      JSON.stringify({
        labels,
        annotations: Array.isArray(record?.overlayAnnotations)
          ? record.overlayAnnotations
          : [],
        customFields,
        clientEnv: clientEnvReport,
      }),
    );
    if (labelCsv) payload.append("labelCsv", labelCsv);
    if (labelXlsxBase64) payload.append("labelXlsxBase64", labelXlsxBase64);

    const resp = await fetchWithAuthFallback(endpoint, {
      method: "POST",
      body: payload,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(errText || `sync failed: ${resp.status}`);
    }
    const json = await resp.json().catch(() => null);
    assertPlatformResponseSuccess(json, "科研平台保存失败");
    return true;
  };

  const syncBatchAnnotationsToPlatform = async ({
    activeImageId = "",
    activeWorkflowSnapshot = null,
    labelCsv = "",
    labelXlsxBase64 = "",
  } = {}) => {
    if (!externalCtx?.batchId || !externalCtx?.platformOrigin) return false;
    const normalizedOrigin = String(externalCtx.platformOrigin || "").replace(
      /\/+$/,
      "",
    );
    const endpoint = `${normalizedOrigin}/analysisPlatformService/api/v1/analysis/sample/image/saveAnnotationBatch`;
    const records = await getAllImages();
    const queueItems = Array.isArray(batchQueue?.images)
      ? batchQueue.images
      : [];
    const clientEnvReport = buildClientEnvReport("platform-batch", {
      batchId: String(externalCtx.batchId || ""),
    });
    if (!queueItems.length) return false;

    const items = [];
    for (const item of queueItems) {
      const remoteImageId = String(item?.imageId || "");
      if (!remoteImageId) continue;
      const record =
        records.find(
          (r) =>
            String(r.remoteImageId || "") === remoteImageId && !r.isMaskOnly,
        ) || null;
      const maskBuffer = record?.mask || record?.sourceMask;
      if (!maskBuffer) continue;
      const sourceName = String(
        record?.sourceName ||
          item?.sourceImageName ||
          item?.fileName ||
          `image-${remoteImageId}`,
      );
      const sourceNameStem =
        fileStem(sourceName) || sourceName || `image-${remoteImageId}`;
      const customFields =
        activeWorkflowSnapshot &&
        String(record?.id || "") === String(activeImageId || "")
          ? getEffectiveCustomFieldValues(record, activeWorkflowSnapshot)
          : getEffectiveCustomFieldValues(record);
      items.push({
        imageId: Number.isFinite(Number(remoteImageId))
          ? Number(remoteImageId)
          : remoteImageId,
        sourceImageName: sourceNameStem,
        annotations: JSON.stringify({
          labels,
          annotations: Array.isArray(record?.overlayAnnotations)
            ? record.overlayAnnotations
            : [],
          customFields,
          clientEnv: clientEnvReport,
        }),
        maskBase64: bufferToBase64(maskBuffer),
        maskFileName: inferMaskFileName(
          sourceName || `mask-${remoteImageId}.nii.gz`,
        ),
        annotationStatus: 1,
        annotation_status: 1,
      });
    }
    if (!items.length) return false;

    const resp = await fetchWithAuthFallback(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        batchId: String(externalCtx.batchId),
        topicId: externalCtx.topicId ? String(externalCtx.topicId) : null,
        clientEnv: clientEnvReport,
        labelCsv: labelCsv || "",
        labelXlsxBase64: labelXlsxBase64 || "",
        items,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(errText || `batch sync failed: ${resp.status}`);
    }
    const json = await resp.json().catch(() => null);
    assertPlatformResponseSuccess(json, "科研平台批量保存失败");
    const payload = parseApiPayload(json) || {};
    if (payload?.queue && Array.isArray(payload.queue.images)) {
      setBatchQueue(payload.queue);
    }
    return true;
  };

  const saveCurrentAnnotation = async () => {
    if (!activeImage?.id) {
      Message.warning("当前没有可保存的影像");
      return false;
    }
    let workflowSnapshot = null;
    if (activeStepDef) {
      const ok = validateCurrentCard();
      if (!ok) {
        Message.warning("请先完成当前分类项必填信息");
        return false;
      }
      workflowSnapshot = syncWorkflowCardsByAnnotations({
        persist: true,
        returnNextState: true,
      });
    }
    clearAutoSaveSchedule();
    await saveQueueRef.current;
    if (!hasUnsavedChangesRef.current) {
      const annotationCount = Number(
        viewerRef.current?.getAnnotationCount?.() || 0,
      );
      if (annotationCount <= 0) {
        Message.info("当前无新增修改，未执行保存");
        return true;
      }
      hasUnsavedChangesRef.current = true;
    }
    const saved = await enqueuePersistActiveDrawing();
    if (!saved) {
      Message.warning("保存失败，请重试");
      return false;
    }
    const freshLocal = await getImageById(activeImage.id);
    if (freshLocal) {
      cacheImageRecord(freshLocal);
      setActiveImage((prev) =>
        prev && prev.id === freshLocal.id
          ? { ...freshLocal, maskVersion: resolveMaskVersion(freshLocal) }
          : prev,
      );
    }

    let saveTableRecords = [];
    let saveLabelCsv = "";
    let saveLabelXlsxBuffer = null;
    let saveLabelXlsxBase64 = "";
    try {
      const allRecords = await getAllImages();
      saveTableRecords = externalCtx.batchId
        ? resolveBulkExportScope(allRecords)
        : allRecords.filter(
            (record) => String(record?.id || "") === String(activeImage?.id || ""),
          );
      saveLabelCsv = buildLabelCsv(saveTableRecords);
      saveLabelXlsxBuffer = await buildLabelXlsxBuffer(saveTableRecords);
      saveLabelXlsxBase64 = saveLabelXlsxBuffer
        ? bufferToBase64(saveLabelXlsxBuffer)
        : "";
      if (exportDirHandle && saveLabelCsv) {
        const labelHandle = await exportDirHandle.getFileHandle("labels.csv", {
          create: true,
        });
        const labelWritable = await labelHandle.createWritable();
        await labelWritable.write(saveLabelCsv);
        await labelWritable.close();
      }
      if (exportDirHandle && saveLabelXlsxBuffer) {
        const xlsxHandle = await exportDirHandle.getFileHandle("labels.xlsx", {
          create: true,
        });
        const xlsxWritable = await xlsxHandle.createWritable();
        await xlsxWritable.write(saveLabelXlsxBuffer);
        await xlsxWritable.close();
      }
    } catch (error) {
      console.warn("保存时写入 labels.csv/xlsx 失败", error);
    }

    try {
      const synced = externalCtx.batchId
        ? await syncBatchAnnotationsToPlatform({
            activeImageId: String(activeImage?.id || ""),
            activeWorkflowSnapshot: workflowSnapshot,
            labelCsv: saveLabelCsv,
            labelXlsxBase64: saveLabelXlsxBase64,
          })
        : await syncActiveAnnotationToPlatform(
            workflowSnapshot,
            saveLabelCsv,
            saveLabelXlsxBase64,
          );
      if (synced) {
        if (externalCtx.batchId && activeImage?.remoteImageId) {
          setBatchQueue((prev) => {
            if (!prev || !Array.isArray(prev.images)) return prev;
            return {
              ...prev,
              images: prev.images.map((item) =>
                String(item?.imageId || "") ===
                String(activeImage.remoteImageId)
                  ? { ...item, annotationStatus: 1, annotation_status: 1 }
                  : item,
              ),
            };
          });
        }
        hasUnsavedChangesRef.current = false;
        localPersistDirtyRef.current = false;
        notifyPlatformSaveSuccess({
          imageId: String(
            activeImage?.remoteImageId ||
              externalCtx.imageId ||
              activeImage?.id ||
              "",
          ),
          batchId: String(externalCtx.batchId || ""),
          topicId: String(externalCtx.topicId || ""),
          annotationStatus: 1,
        });
        Message.success(
          externalCtx.batchId
            ? "批次标注已保存并同步科研平台"
            : "当前标注已保存并同步科研平台",
        );
        viewerRef.current?.clearAnalysisCache?.();
      } else {
        hasUnsavedChangesRef.current = false;
        localPersistDirtyRef.current = false;
        Message.success("当前标注已保存");
        viewerRef.current?.clearAnalysisCache?.();
      }
      return true;
    } catch (error) {
      console.error(error);
      Message.error("标注已本地保存，但科研平台同步失败");
      hasUnsavedChangesRef.current = false;
      localPersistDirtyRef.current = false;
      viewerRef.current?.clearAnalysisCache?.();
      return true;
    }
  };

  const onViewerEvent = (reason = "draw") => {
    if (reason === "curve-complete") {
      Message.success("标注成功");
    }
    if (
      reason === "draw" ||
      reason === "brush-stroke-complete" ||
      reason === "undo" ||
      reason === "redo" ||
      reason === "annotate" ||
      reason === "curve-complete"
    ) {
      hasUnsavedChangesRef.current = true;
      localPersistDirtyRef.current = true;
    }
    if (
      reason === "draw" ||
      reason === "brush-stroke-complete" ||
      reason === "undo" ||
      reason === "redo" ||
      reason === "clear" ||
      reason === "load" ||
      reason === "curve-complete"
    ) {
      scheduleLabelStatsRefresh();
    }
    if (
      reason === "draw" ||
      reason === "brush-stroke-complete" ||
      reason === "annotate" ||
      reason === "undo" ||
      reason === "redo" ||
      reason === "clear" ||
      reason === "curve-complete" ||
      reason === "load"
    ) {
      syncWorkflowCardsByAnnotations({
        persist: reason === "curve-complete" || reason === "load",
      });
    }
  };

  useEffect(
    () => () => {
      clearAutoSaveSchedule();
      clearLabelStatsSchedule();
    },
    [],
  );

  const selectImage = async (id) => {
    if (activeImage?.id === id) return;
    if (hasUnsavedChangesRef.current || localPersistDirtyRef.current) {
      const allowSwitch = await new Promise((resolve) => {
        Modal.confirm({
          title: "存在未保存标注",
          content: "当前影像有未保存修改。请先点击“保存”，再切换到下一张。",
          okText: "确认保存",
          cancelText: "取消切换",
          onOk: async () => {
            const saved = await saveCurrentAnnotation();
            resolve(!!saved);
          },
          onCancel: () => resolve(false),
          unmountOnExit: true,
        });
      });
      if (!allowSwitch) return;
    }

    clearAutoSaveSchedule();
    let idOrder = localImageIds;
    if (!isBatchMode && queueImages.length === 0) {
      if (!idOrder.length || !idOrder.includes(String(id))) {
        const refreshedIds = await getImageIdOrder();
        idOrder = refreshedIds.map((item) => String(item));
        setLocalImageIds(idOrder);
      }
      const targetIndex = idOrder.findIndex(
        (item) => String(item) === String(id),
      );
      if (targetIndex >= 0) {
        const pageStart =
          Math.floor(targetIndex / LOCAL_IMAGE_PAGE_SIZE) *
          LOCAL_IMAGE_PAGE_SIZE;
        const pageIds = idOrder.slice(
          pageStart,
          pageStart + LOCAL_IMAGE_PAGE_SIZE,
        );
        const metas = await getImageMetasByIds(pageIds);
        setImages(metas.map(toListItem));
      }
    }

    const record = (await getImageById(id)) || (await getImageRecordFast(id));
    if (!record) return;
    cacheImageRecord(record);
    activeImageIdRef.current = String(record.id);
    setActiveImage({
      ...record,
      maskVersion: resolveMaskVersion(record),
    });
  };

  const switchQueueImage = async (direction = 1) => {
    if (!queueImages.length) return;
    if (queueSwitchingRef.current) {
      queuedSwitchDirectionRef.current += Number(direction || 0);
      return;
    }
    queueSwitchingRef.current = true;
    const baseIndex =
      activeQueueIndex >= 0
        ? activeQueueIndex
        : queueNavIndexRef.current >= 0
          ? queueNavIndexRef.current
          : Math.max(
              0,
              queueImages.findIndex(
                (item) =>
                  String(item.imageId) ===
                  String(batchQueue?.nextImageId || ""),
              ),
            );
    const targetIndex =
      (baseIndex + direction + queueImages.length) % queueImages.length;
    const target = queueImages[targetIndex];
    if (!target) {
      queueSwitchingRef.current = false;
      return;
    }
    queueNavIndexRef.current = targetIndex;
    try {
      const ok = await ensureQueueImageLoaded(target);
      if (!ok) Message.error("切换影像失败，请检查批次数据与下载接口");
      if (ok && ENABLE_NEARBY_PREFETCH) {
        void prefetchQueueImages(queueImages, {
          skipImageId: target?.imageId,
          aroundIndex: targetIndex,
          scope: "window",
        });
      }
    } finally {
      queueSwitchingRef.current = false;
      const pending = Number(queuedSwitchDirectionRef.current || 0);
      queuedSwitchDirectionRef.current = 0;
      if (pending !== 0) {
        void switchQueueImage(pending);
      }
    }
  };

  const switchDisplayImage = async (direction = 1) => {
    if (isBatchMode || queueImages.length > 0) {
      await switchQueueImage(direction);
      return;
    }
    if (!localImageIds.length) return;
    const baseIndex = activeLocalGlobalIndex >= 0 ? activeLocalGlobalIndex : 0;
    const targetIndex =
      (baseIndex + direction + localImageIds.length) % localImageIds.length;
    const targetId = localImageIds[targetIndex];
    if (!targetId) return;
    await selectImage(targetId);
  };

  useEffect(() => {
    if (isBatchMode || queueImages.length > 0) return;
    if (!activeImage?.id || localImageIds.length <= 1) return;
    const currentIndex = localImageIds.findIndex(
      (id) => String(id) === String(activeImage.id),
    );
    if (currentIndex < 0) return;
    const prev =
      localImageIds[
        (currentIndex - 1 + localImageIds.length) % localImageIds.length
      ];
    const next = localImageIds[(currentIndex + 1) % localImageIds.length];
    for (const id of [prev, next]) {
      if (!id) continue;
      prefetchImageRecord(id);
    }
  }, [activeImage?.id, localImageIds, isBatchMode, queueImages.length]);

  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;

    const onWheelSwitchSeries = (event) => {
      if (viewerMode !== "dicom") return;
      if (activeImage?.sourceFormat !== "dicom") return;
      if (activeDicomSeries.length <= 1) return;
      const now = Date.now();
      if (now - dicomWheelSwitchAtRef.current < 180) {
        event.preventDefault();
        return;
      }
      const currentIndex = activeDicomSeries.findIndex(
        (item) => item.id === activeImage.id,
      );
      if (currentIndex < 0) return;

      event.preventDefault();
      const direction = event.deltaY > 0 ? 1 : -1;
      const nextIndex =
        (currentIndex + direction + activeDicomSeries.length) %
        activeDicomSeries.length;
      const next = activeDicomSeries[nextIndex];
      if (!next || next.id === activeImage.id) return;
      dicomWheelSwitchAtRef.current = now;
      selectImage(next.id);
    };

    host.addEventListener("wheel", onWheelSwitchSeries, { passive: false });
    return () => {
      host.removeEventListener("wheel", onWheelSwitchSeries);
    };
  }, [
    viewerMode,
    activeImage?.id,
    activeImage?.sourceFormat,
    activeDicomSeries,
  ]);

  const findImageByBase = (base) => {
    if (!base) return null;
    const normalized = base.toLowerCase();
    return (
      images.find((img) => img.baseName === normalized) ||
      images.find((img) => stripMaskTokens(img.baseName || "") === normalized)
    );
  };

  const applyMaskToImage = async (imageId, maskBuffer, maskName) => {
    const normalizedMask = sanitizeMaskBuffer(maskBuffer);
    if (!normalizedMask) return;
    const currentRecord = await getImageById(imageId);
    const nextMaskVersion = getNextMaskVersion(currentRecord, { bump: true });
    const updated = await updateImage(imageId, {
      sourceMask: normalizedMask,
      sourceMaskName: maskName,
      mask: normalizedMask,
      maskName,
      maskAttached: true,
      maskVersion: nextMaskVersion,
      updatedAt: Date.now(),
    });
    if (updated) cacheImageRecord(updated);
    setImages((prev) =>
      prev.map((img) =>
        img.id === imageId
          ? {
              ...img,
              hasMask: true,
              maskAttached: true,
              maskVersion: nextMaskVersion,
            }
          : img,
      ),
    );
    if (activeImage?.id === imageId) {
      setActiveImage((prev) => ({
        ...prev,
        sourceMask: normalizedMask,
        sourceMaskName: maskName,
        mask: normalizedMask,
        maskName,
        maskAttached: true,
        maskVersion: nextMaskVersion,
      }));
    }
  };

  const createImageRecord = (
    name,
    buffer,
    hash,
    thumbnail,
    {
      displayName = null,
      maskBuffer = null,
      maskName = null,
      sourceMask = null,
      sourceMaskName = null,
      maskAttached = false,
      isMaskOnly = false,
      rasterHFlipNormalized = false,
      spatialMeta = null,
      rasterConversionVersion = 0,
      importBatchId = null,
      sourceName = null,
      sourceData = null,
      thumbnailRenderVersion = THUMBNAIL_RENDER_VERSION,
      modifiedByUser = false,
      sourceFormat = "nifti",
      dicomSourceCount = 0,
      dicomStudyUID = "",
      dicomStudyID = "",
      dicomSeriesUID = "",
      dicomSeriesDescription = "",
      dicomSeriesNumber = 0,
      dicomSeriesOrder = 0,
      dicomAccessionNumber = "",
      remoteImageId = "",
      remoteBatchId = "",
      customFields = {},
    } = {},
  ) => {
    const baseName = normalizeBaseName(name);
    const finalSourceMask = sourceMask || maskBuffer || null;
    const finalSourceMaskName = sourceMaskName || maskName || null;
    const finalMaskAttached = finalSourceMask ? true : maskAttached;

    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name,
      displayName,
      baseName,
      data: buffer,
      isMaskOnly,
      rasterHFlipNormalized,
      spatialMeta,
      rasterConversionVersion,
      importBatchId,
      sourceName,
      sourceData,
      modifiedByUser,
      sourceFormat,
      dicomSourceCount,
      dicomStudyUID,
      dicomStudyID,
      dicomSeriesUID,
      dicomSeriesDescription,
      dicomSeriesNumber,
      dicomSeriesOrder,
      dicomAccessionNumber,
      remoteImageId: remoteImageId ? String(remoteImageId) : "",
      remoteBatchId: remoteBatchId ? String(remoteBatchId) : "",
      customFields: parseJsonSafe(customFields, {}) || {},
      sourceMask: finalSourceMask,
      sourceMaskName: finalSourceMaskName,
      mask: maskBuffer,
      maskName,
      maskAttached: finalMaskAttached,
      maskVersion: finalSourceMask ? 1 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hash,
      thumbnail,
      thumbnailRenderVersion,
    };
  };

  const normalizeMaskNiftiToScalar = (
    buffer,
    { templateBuffer = null } = {},
  ) => {
    const { header, voxels, width, height, depth, components, datatypeCode } =
      decodeNifti(buffer);
    const voxelCount = width * height * depth;
    const out = new Uint8Array(voxelCount);
    const isRgb24 = datatypeCode === nifti.NIFTI1.TYPE_RGB24;

    for (let i = 0; i < voxelCount; i += 1) {
      let value = 0;
      if (isRgb24) {
        const base = i * 3;
        value = Math.max(
          Number(voxels[base] || 0),
          Number(voxels[base + 1] || 0),
          Number(voxels[base + 2] || 0),
        );
      } else if (components > 1) {
        for (let c = 0; c < components; c += 1) {
          value = Math.max(value, Number(voxels[c * voxelCount + i] || 0));
        }
      } else {
        value = Number(voxels[i] || 0);
      }
      out[i] = clampByte(value);
    }

    let templateHeader = null;
    const template = arrayBufferFrom(templateBuffer);
    if (template && isNiftiBuffer(template)) {
      try {
        templateHeader = decodeNifti(template).header;
      } catch {
        templateHeader = null;
      }
    }
    const referenceHeader = templateHeader || header;
    const spacing = [
      Math.max(1e-6, Number(referenceHeader?.pixDims?.[1] || 1)),
      Math.max(1e-6, Number(referenceHeader?.pixDims?.[2] || 1)),
      Math.max(1e-6, Number(referenceHeader?.pixDims?.[3] || 1)),
    ];

    return encodeNiftiUInt8({
      width,
      height,
      depth,
      components: 1,
      voxels: out,
      spacing,
      headerTemplate: referenceHeader,
    });
  };

  const encodeMaskBitmapToNifti = (
    bitmap,
    dims,
    { templateBuffer = null, headerTemplate = null } = {},
  ) => {
    const width = Math.max(1, Number(dims?.[0] || 0));
    const height = Math.max(1, Number(dims?.[1] || 0));
    const depth = Math.max(1, Number(dims?.[2] || 1));
    const voxelCount = width * height * depth;
    if (!bitmap || voxelCount < 1 || bitmap.length !== voxelCount) return null;

    let referenceHeader = headerTemplate || null;
    if (!referenceHeader) {
      const template = arrayBufferFrom(templateBuffer);
      if (template && isNiftiBuffer(template)) {
        try {
          referenceHeader = decodeNifti(template).header;
        } catch {
          referenceHeader = null;
        }
      }
    }

    return encodeNiftiUInt8({
      width,
      height,
      depth,
      components: 1,
      voxels: bitmap instanceof Uint8Array ? bitmap : new Uint8Array(bitmap),
      spacing: [
        Math.max(1e-6, Number(referenceHeader?.pixDims?.[1] || 1)),
        Math.max(1e-6, Number(referenceHeader?.pixDims?.[2] || 1)),
        Math.max(1e-6, Number(referenceHeader?.pixDims?.[3] || 1)),
      ],
      headerTemplate: referenceHeader,
    });
  };

  const sanitizeMaskBuffer = (maskBuffer, { templateBuffer = null } = {}) => {
    const source = arrayBufferFrom(maskBuffer);
    if (!source || !isNiftiBuffer(source)) return source;
    try {
      return normalizeMaskNiftiToScalar(source, { templateBuffer });
    } catch (error) {
      console.warn("mask 规范化失败，保留原始输出", error);
      return source;
    }
  };

  const isDuplicateHash = (hash, hashSet) => hashSet.has(hash);

  const importDicomItems = async (items, hashSet, importBatchId = null) => {
    if (!Array.isArray(items) || items.length === 0) return;
    try {
      const niivueDicomLoader = await loadNiivueDicomLoader();
      const groupedSeries = groupDicomInputsBySeries(items);
      if (!groupedSeries.length) {
        Message.warning("未识别到有效 DICOM 序列");
        return;
      }

      const newRecords = [];
      for (
        let groupIndex = 0;
        groupIndex < groupedSeries.length;
        groupIndex += 1
      ) {
        const group = groupedSeries[groupIndex];
        const loadedFiles = await niivueDicomLoader(
          group.items.map((item) => ({ name: item.name, data: item.data })),
        );
        if (!loadedFiles.length) continue;

        for (const converted of loadedFiles) {
          const content = converted?.data;
          const name = converted?.name || `dicom_${Date.now()}.nii`;
          if (!content || !isNiftiBuffer(content)) continue;
          const hash = await hashBuffer(content);
          if (isDuplicateHash(hash, hashSet)) continue;

          const thumbnail = await createThumbnail(content, name);
          const seriesNameParts = [];
          if (group.seriesNumber > 0)
            seriesNameParts.push(`S${group.seriesNumber}`);
          if (group.seriesDescription)
            seriesNameParts.push(group.seriesDescription);
          const seriesLabel = seriesNameParts.join(" ");
          const record = createImageRecord(name, content, hash, thumbnail, {
            displayName: seriesLabel || `${name} (DICOM)`,
            sourceName: name,
            sourceData: content,
            sourceFormat: "dicom",
            dicomSourceCount: group.items.length,
            dicomStudyUID: group.studyUID,
            dicomStudyID: group.studyID,
            dicomSeriesUID: group.seriesUID,
            dicomSeriesDescription: group.seriesDescription,
            dicomSeriesNumber: group.seriesNumber,
            dicomSeriesOrder: groupIndex + 1,
            dicomAccessionNumber: group.accessionNumber,
            importBatchId,
            modifiedByUser: false,
          });
          newRecords.push(record);
          hashSet.add(hash);
        }
      }

      if (!newRecords.length) {
        Message.warning("未从 DICOM 中解析出可用影像");
        return;
      }

      if (newRecords.length > 0) {
        await saveImages(newRecords);
        await refreshImageList();
        const first = newRecords[0];
        activateImportedRecordIfAllowed(first, { dicom: true });
      }
    } catch (error) {
      console.error("DICOM 导入失败", error);
      Message.error("DICOM 导入失败，请确认文件完整并重试");
    }
  };

  const importImageFile = async (file, hashSet, importBatchId = null) => {
    const originalBuffer = await file.arrayBuffer();
    if (isDicomFile(file.name) || isDicomContentBuffer(originalBuffer)) {
      await importDicomItems(
        [{ name: file.name || "dicom_slice", data: originalBuffer }],
        hashSet,
        importBatchId,
      );
      return;
    }
    if (isImageFile(file.name)) {
      Message.warning(
        "已移除 JPG/PNG 等原始图片导入，请先转换为 NIfTI(.nii/.nii.gz)",
      );
      return;
    }
    if (!isSupportedImageFile(file.name)) return;
    const effectiveName = file.name;
    if (isNiftiFile(effectiveName) && !isNiftiBuffer(originalBuffer)) {
      Message.error(`下载内容不是有效 NIfTI：${effectiveName}`);
      return;
    }

    let buffer = originalBuffer;
    let internalName = effectiveName;
    let spatialMeta = null;
    let isMaskOnly = false;
    const maskFile = isMaskName(file.name);
    if (
      maskFile ||
      (isNiftiFile(effectiveName) && isLikelyMaskNiftiBuffer(originalBuffer))
    ) {
      isMaskOnly = true;
      buffer = sanitizeMaskBuffer(originalBuffer);
    }

    const hash = await hashBuffer(buffer);

    if (isDuplicateHash(hash, hashSet)) return;

    const thumbnail = await createThumbnail(buffer, internalName, {
      isMask: isMaskOnly,
    });
    const record = createImageRecord(internalName, buffer, hash, thumbnail, {
      displayName: effectiveName,
      isMaskOnly,
      rasterHFlipNormalized: false,
      spatialMeta,
      rasterConversionVersion: 0,
      importBatchId,
      sourceName: effectiveName,
      sourceData: buffer,
      modifiedByUser: false,
    });
    await saveImages([record]);
    hashSet.add(hash);

    await refreshImageList();
    activateImportedRecordIfAllowed(record);
  };

  const importZipFile = async (file, hashSet, importBatchId = null) => {
    const buffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);

    const imageEntries = [];
    const maskEntries = [];
    const dicomEntries = [];
    const unknownEntries = [];
    const unresolved = [];

    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const name = entry.name;
      if (isDicomFile(name)) {
        dicomEntries.push(entry);
        continue;
      }
      if (!isSupportedImageFile(name)) {
        unknownEntries.push(entry);
        continue;
      }
      const leaf = getLeafName(name);
      if (isMaskPath(name) || isMaskName(leaf)) {
        maskEntries.push(entry);
        continue;
      }
      if (isImagePath(name)) {
        imageEntries.push(entry);
        continue;
      }
      unresolved.push(entry);
    }

    const dicomInputs = [];
    for (const entry of dicomEntries) {
      const content = await entry.async("arraybuffer");
      dicomInputs.push({ name: entry.name, data: content });
    }
    for (const entry of unknownEntries) {
      const content = await entry.async("arraybuffer");
      if (!isDicomContentBuffer(content)) continue;
      dicomInputs.push({ name: entry.name, data: content });
    }
    if (dicomInputs.length > 0) {
      await importDicomItems(dicomInputs, hashSet, importBatchId);
    } else if (imageEntries.length === 0 && maskEntries.length === 0) {
      Message.warning("zip 内未识别到可导入的 NIfTI 或 DICOM 文件");
    }

    const unresolvedByBase = new Map();
    for (const entry of unresolved) {
      const base = normalizeBaseName(getLeafName(entry.name));
      const list = unresolvedByBase.get(base) || [];
      list.push(entry);
      unresolvedByBase.set(base, list);
    }
    for (const list of unresolvedByBase.values()) {
      if (!list.length) continue;
      imageEntries.push(list[0]);
      for (let i = 1; i < list.length; i += 1) {
        maskEntries.push(list[i]);
      }
    }

    const maskByBase = new Map();
    const masks = [];
    for (const entry of maskEntries) {
      const content = await entry.async("arraybuffer");
      const normalizedMask = sanitizeMaskBuffer(content);
      const displayName = entry.name.split("/").pop();
      const rawBaseName = normalizeBaseName(displayName);
      const matchBaseName = stripMaskTokens(rawBaseName);
      const maskItem = {
        name: displayName,
        baseName: rawBaseName,
        matchBaseName,
        buffer: normalizedMask,
        used: false,
      };
      masks.push(maskItem);
      if (matchBaseName) maskByBase.set(matchBaseName, maskItem);
      if (rawBaseName) maskByBase.set(rawBaseName, maskItem);
    }

    const newRecords = [];
    const importedImageBaseSet = new Set();

    for (const entry of imageEntries) {
      const rawContent = await entry.async("arraybuffer");
      const name = entry.name.split("/").pop();
      const baseName = normalizeBaseName(name);
      if (importedImageBaseSet.has(baseName)) continue;
      let content = rawContent;
      let internalName = name;
      let spatialMeta = null;
      if (isImageFile(name)) {
        content = rawContent;
        internalName = name;
        spatialMeta = null;
      }
      const hash = await hashBuffer(content);
      if (isDuplicateHash(hash, hashSet)) continue;

      const maskMatch =
        maskByBase.get(baseName) || maskByBase.get(stripMaskTokens(baseName));
      if (maskMatch) maskMatch.used = true;
      const thumbnail = await createThumbnail(content, internalName);
      const record = createImageRecord(internalName, content, hash, thumbnail, {
        displayName: name,
        sourceMask: maskMatch?.buffer || null,
        sourceMaskName: maskMatch?.name || null,
        maskBuffer: maskMatch?.buffer || null,
        maskName: maskMatch?.name || null,
        maskAttached: !!maskMatch,
        rasterHFlipNormalized: false,
        spatialMeta,
        rasterConversionVersion: isImageFile(name)
          ? RASTER_CONVERSION_VERSION
          : 0,
        importBatchId,
        sourceName: name,
        sourceData: isImageFile(name) ? rawContent : content,
        modifiedByUser: false,
      });
      newRecords.push(record);
      hashSet.add(hash);
      importedImageBaseSet.add(baseName);
    }

    for (const maskItem of masks) {
      if (maskItem.used) continue;
      const displayName = maskItem.name;
      const internalName = toInternalNiftiName(displayName);
      const hash = await hashBuffer(maskItem.buffer);
      if (isDuplicateHash(hash, hashSet)) continue;
      const thumbnail = await createThumbnail(maskItem.buffer, internalName, {
        isMask: true,
      });
      const record = createImageRecord(
        internalName,
        maskItem.buffer,
        hash,
        thumbnail,
        {
          displayName,
          isMaskOnly: true,
          rasterHFlipNormalized: false,
          spatialMeta: null,
          rasterConversionVersion: 0,
          importBatchId,
          sourceName: displayName,
          sourceData: maskItem.buffer,
          modifiedByUser: false,
        },
      );
      newRecords.push(record);
      hashSet.add(hash);
    }

    if (newRecords.length > 0) {
      await saveImages(newRecords);
      await refreshImageList();
      const first = newRecords[0];
      activateImportedRecordIfAllowed(first);
    }
  };

  const handleUploadChange = async (fileList) => {
    if (!fileList?.length) return;
    const importBatchId = makeImportBatchId();
    const existing = await getAllImages();
    const hashSet = new Set(existing.map((item) => item.hash).filter(Boolean));

    const regularFiles = [];
    const dicomInputs = [];
    for (const item of fileList) {
      const originFile = item?.originFile;
      if (!originFile) continue;
      const key = `${originFile.name}-${originFile.size}-${originFile.lastModified}`;
      if (processedFilesRef.current.has(key)) continue;
      processedFilesRef.current.add(key);

      if (isZipFile(originFile.name)) {
        await importZipFile(originFile, hashSet, importBatchId);
      } else {
        regularFiles.push(originFile);
      }
    }

    for (const file of regularFiles) {
      if (isDicomFile(file.name) || hasDicomLikeName(file.name)) {
        const buffer = await file.arrayBuffer();
        if (isDicomContentBuffer(buffer)) {
          dicomInputs.push({ name: file.name, data: buffer });
          continue;
        }
      }
      await importImageFile(file, hashSet, importBatchId);
    }

    if (dicomInputs.length > 0) {
      await importDicomItems(dicomInputs, hashSet, importBatchId);
    }
  };

  const importFolder = async () => {
    if (!window.showDirectoryPicker) return;
    const dirHandle = await window.showDirectoryPicker();
    setExportDirHandle(dirHandle);

    const imgHandle = await dirHandle
      .getDirectoryHandle("img", { create: false })
      .catch(() => null);
    const maskHandle =
      (await dirHandle
        .getDirectoryHandle("mask", { create: false })
        .catch(() => null)) ||
      (await dirHandle
        .getDirectoryHandle("masks", { create: false })
        .catch(() => null));
    const imageRootHandle = imgHandle || dirHandle;
    const importBatchId = makeImportBatchId();

    const existing = await getAllImages();
    const hashSet = new Set(existing.map((item) => item.hash).filter(Boolean));
    const imageEntries = [];
    const dicomInputs = [];
    for await (const [name, handle] of imageRootHandle.entries()) {
      if (handle.kind !== "file") continue;
      if (isMaskName(name)) continue;
      const file = await handle.getFile();
      if (isDicomFile(name) || hasDicomLikeName(name)) {
        const headerBuf = await file.slice(0, 512).arrayBuffer();
        if (isDicomContentBuffer(headerBuf)) {
          const content = await file.arrayBuffer();
          dicomInputs.push({ name, data: content });
          continue;
        }
      }
      if (!isSupportedImageFile(name)) continue;
      if (isSupportedImageFile(name)) imageEntries.push(handle);
    }

    if (dicomInputs.length > 0) {
      await importDicomItems(dicomInputs, hashSet, importBatchId);
    }

    const masks = [];
    if (maskHandle) {
      for await (const [name, handle] of maskHandle.entries()) {
        if (handle.kind !== "file") continue;
        if (!isSupportedImageFile(name)) continue;
        const file = await handle.getFile();
        const content = await file.arrayBuffer();
        const normalizedMask = sanitizeMaskBuffer(content);
        const rawBaseName = normalizeBaseName(name);
        masks.push({
          name,
          baseName: rawBaseName,
          matchBaseName: stripMaskTokens(rawBaseName),
          buffer: normalizedMask,
        });
      }
    }

    const maskByBase = new Map();
    for (const mask of masks) {
      const item = { ...mask, used: false };
      if (item.matchBaseName) maskByBase.set(item.matchBaseName, item);
      if (item.baseName) maskByBase.set(item.baseName, item);
      mask.__item = item;
    }

    const newRecords = [];
    const importedImageBaseSet = new Set();
    for (const handle of imageEntries) {
      const file = await handle.getFile();
      const rawContent = await file.arrayBuffer();
      const baseName = normalizeBaseName(file.name);
      if (importedImageBaseSet.has(baseName)) continue;
      let content = rawContent;
      let internalName = file.name;
      let spatialMeta = null;
      if (isImageFile(file.name)) {
        content = rawContent;
        internalName = file.name;
        spatialMeta = null;
      }
      const hash = await hashBuffer(content);
      if (isDuplicateHash(hash, hashSet)) continue;
      const maskMatch =
        maskByBase.get(baseName) || maskByBase.get(stripMaskTokens(baseName));
      if (maskMatch) maskMatch.used = true;
      const thumbnail = await createThumbnail(content, internalName);
      const record = createImageRecord(internalName, content, hash, thumbnail, {
        displayName: file.name,
        sourceMask: maskMatch?.buffer || null,
        sourceMaskName: maskMatch?.name || null,
        maskBuffer: maskMatch?.buffer || null,
        maskName: maskMatch?.name || null,
        maskAttached: !!maskMatch,
        rasterHFlipNormalized: false,
        spatialMeta,
        rasterConversionVersion: isImageFile(file.name)
          ? RASTER_CONVERSION_VERSION
          : 0,
        importBatchId,
        sourceName: file.name,
        sourceData: isImageFile(file.name) ? rawContent : content,
        modifiedByUser: false,
      });
      newRecords.push(record);
      hashSet.add(hash);
      importedImageBaseSet.add(baseName);
    }

    for (const mask of masks.map((m) => m.__item).filter(Boolean)) {
      if (mask.used) continue;
      const internalName = toInternalNiftiName(mask.name);
      const hash = await hashBuffer(mask.buffer);
      if (isDuplicateHash(hash, hashSet)) continue;
      const thumbnail = await createThumbnail(mask.buffer, internalName, {
        isMask: true,
      });
      const record = createImageRecord(
        internalName,
        mask.buffer,
        hash,
        thumbnail,
        {
          displayName: mask.name,
          isMaskOnly: true,
          rasterHFlipNormalized: false,
          spatialMeta: null,
          rasterConversionVersion: 0,
          importBatchId,
          sourceName: mask.name,
          sourceData: mask.buffer,
          modifiedByUser: false,
        },
      );
      newRecords.push(record);
      hashSet.add(hash);
    }

    if (newRecords.length > 0) {
      await saveImages(newRecords);
      await refreshImageList();
      const first = newRecords[0];
      activateImportedRecordIfAllowed(first);
    }
  };

  const detachMaskFromImage = async (id, knownRecord = null) => {
    const record = knownRecord || (await getImageById(id));
    if (!record) return;
    const nextMaskVersion = getNextMaskVersion(record, { bump: true });

    const updated = await updateImage(id, {
      maskAttached: false,
      mask: null,
      maskVersion: nextMaskVersion,
      updatedAt: Date.now(),
    });
    if (updated) cacheImageRecord(updated);

    const hasMask = !!(record.sourceMask || record.mask);
    setImages((prev) =>
      prev.map((img) =>
        img.id === id
          ? {
              ...img,
              hasMask,
              maskAttached: false,
              maskVersion: nextMaskVersion,
            }
          : img,
      ),
    );

    if (activeImage?.id === id) {
      setActiveImage((prev) =>
        prev
          ? {
              ...prev,
              maskAttached: false,
              mask: null,
              maskVersion: nextMaskVersion,
            }
          : prev,
      );
    }
  };

  const handleClear = async () => {
    clearAutoSaveSchedule();
    const id = activeImage?.id;
    if (!id) return;

    viewerRef.current?.clear();

    const record = await getImageById(id);
    if (!record) return;

    if (record.sourceMask) {
      await updateImage(id, {
        overlayAnnotations: [],
        modifiedByUser: true,
        updatedAt: Date.now(),
      });
      setActiveImage((prev) =>
        prev
          ? {
              ...prev,
              overlayAnnotations: [],
              modifiedByUser: true,
            }
          : prev,
      );
      await detachMaskFromImage(id, record);
      return;
    }

    const nextMaskVersion = getNextMaskVersion(record, { bump: true });
    const updated = await updateImage(id, {
      mask: null,
      maskName: null,
      maskAttached: false,
      maskVersion: nextMaskVersion,
      overlayAnnotations: [],
      modifiedByUser: true,
      updatedAt: Date.now(),
    });
    if (updated) cacheImageRecord(updated);

    setImages((prev) =>
      prev.map((img) =>
        img.id === id
          ? {
              ...img,
              hasMask: false,
              maskAttached: false,
              maskVersion: nextMaskVersion,
            }
          : img,
      ),
    );

    setActiveImage((prev) =>
      prev
        ? {
            ...prev,
            mask: null,
            maskName: null,
            maskAttached: false,
            overlayAnnotations: [],
            modifiedByUser: true,
            maskVersion: nextMaskVersion,
          }
        : prev,
    );
  };

  const promptExportZipName = async (defaultZipName) =>
    new Promise((resolve) => {
      let nextName = defaultZipName;
      Modal.confirm({
        title: "导出文件名",
        content: (
          <Input
            defaultValue={defaultZipName}
            placeholder="请输入导出压缩包文件名"
            onChange={(value) => {
              nextName = String(value || "");
            }}
          />
        ),
        okText: "确认导出",
        cancelText: "取消",
        onOk: () => resolve(nextName),
        onCancel: () => resolve(null),
      });
    });

  const buildExportEntries = (records = []) => {
    const entries = [];
    for (const record of records) {
      if (!record || record.isMaskOnly) continue;
      const imgName = getLeafName(
        record.sourceName || record.displayName || record.name,
      );
      const imgData = arrayBufferFrom(record.sourceData || record.data);
      const rawMask = record.mask || record.sourceMask;
      if (!imgName || !imgData || !rawMask) continue;
      const maskData = sanitizeMaskBuffer(rawMask, {
        templateBuffer: record.sourceData || record.data,
      });
      if (!maskData || !hasNonZeroMaskNifti(maskData)) continue;
      entries.push({
        record,
        imageName: imgName,
        imageData: imgData,
        maskName: inferMaskFileName(imgName),
        maskData,
      });
    }
    return entries;
  };

  const getRecordMainCategoryValue = (record) => {
    const custom = parseJsonSafe(record?.customFields, {}) || {};
    const explicitLabel = custom?.label;
    if (explicitLabel != null && String(explicitLabel).trim() !== "") {
      return String(explicitLabel).trim();
    }
    const workflow = parseJsonSafe(custom?.__workflow__, custom?.__workflow__) || {};
    const steps = workflow?.steps || {};
    for (const stepId of Object.keys(steps)) {
      const cards = Array.isArray(steps?.[stepId]?.cards) ? steps[stepId].cards : [];
      const first = cards[0] || null;
      const mainCategory = first?.mainCategory;
      if (mainCategory != null && String(mainCategory).trim() !== "") {
        return String(mainCategory).trim();
      }
    }
    return "";
  };

  const buildLabelCsv = (records = []) => {
    const lines = ["ID,label"];
    for (const record of records) {
      if (!record || record.isMaskOnly) continue;
      const sourceName = String(record.sourceName || record.displayName || record.name || "");
      const idValue = fileStem(sourceName) || sourceName || String(record.id || "");
      const labelValue = getRecordMainCategoryValue(record);
      const safeId = `"${String(idValue).replaceAll('"', '""')}"`;
      const safeLabel = `"${String(labelValue).replaceAll('"', '""')}"`;
      lines.push(`${safeId},${safeLabel}`);
    }
    return lines.join("\n");
  };

  const buildLabelRows = (records = []) => {
    const rows = [{ id: "ID", label: "label" }];
    for (const record of records) {
      if (!record || record.isMaskOnly) continue;
      const sourceName = String(
        record.sourceName || record.displayName || record.name || "",
      );
      const idValue = fileStem(sourceName) || sourceName || String(record.id || "");
      const labelValue = getRecordMainCategoryValue(record);
      rows.push({
        id: String(idValue || ""),
        label: String(labelValue || ""),
      });
    }
    return rows;
  };

  const escapeXml = (value = "") =>
    String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");

  const excelCol = (index) => {
    let n = Number(index || 0);
    let out = "";
    while (n >= 0) {
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26) - 1;
    }
    return out || "A";
  };

  const buildLabelXlsxBuffer = async (records = []) => {
    const rows = buildLabelRows(records);
    const sheetRowsXml = rows
      .map((row, rowIndex) => {
        const r = rowIndex + 1;
        const cells = [row.id, row.label]
          .map((cell, colIndex) => {
            const ref = `${excelCol(colIndex)}${r}`;
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
          })
          .join("");
        return `<row r="${r}">${cells}</row>`;
      })
      .join("");

    const sheetXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData>${sheetRowsXml}</sheetData>` +
      `</worksheet>`;
    const workbookXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="labels" sheetId="1" r:id="rId1"/></sheets>` +
      `</workbook>`;
    const contentTypesXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`;
    const rootRelsXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`;
    const workbookRelsXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`;

    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypesXml);
    zip.folder("_rels")?.file(".rels", rootRelsXml);
    zip.folder("xl")?.file("workbook.xml", workbookXml);
    zip.folder("xl")?.folder("_rels")?.file("workbook.xml.rels", workbookRelsXml);
    zip.folder("xl")?.folder("worksheets")?.file("sheet1.xml", sheetXml);
    return zip.generateAsync({ type: "arraybuffer" });
  };

  const writeExportEntriesToFolder = async (
    entries = [],
    labelCsv = "",
    labelXlsxBuffer = null,
  ) => {
    if (!exportDirHandle) return;
    try {
      const imgDir = await exportDirHandle.getDirectoryHandle("img", {
        create: true,
      });
      const maskDir = await exportDirHandle.getDirectoryHandle("mask", {
        create: true,
      });
      for (const entry of entries) {
        const imgHandle = await imgDir.getFileHandle(entry.imageName, {
          create: true,
        });
        const imgWritable = await imgHandle.createWritable();
        await imgWritable.write(entry.imageData);
        await imgWritable.close();

        const maskHandle = await maskDir.getFileHandle(entry.maskName, {
          create: true,
        });
        const maskWritable = await maskHandle.createWritable();
        await maskWritable.write(entry.maskData);
        await maskWritable.close();
      }
      if (labelCsv) {
        const labelHandle = await exportDirHandle.getFileHandle("labels.csv", {
          create: true,
        });
        const labelWritable = await labelHandle.createWritable();
        await labelWritable.write(labelCsv);
        await labelWritable.close();
      }
      if (labelXlsxBuffer) {
        const xlsxHandle = await exportDirHandle.getFileHandle("labels.xlsx", {
          create: true,
        });
        const xlsxWritable = await xlsxHandle.createWritable();
        await xlsxWritable.write(labelXlsxBuffer);
        await xlsxWritable.close();
      }
    } catch (error) {
      console.warn("导出到文件夹失败", error);
    }
  };

  const exportEntriesAsZip = async (
    entries = [],
    defaultZipName = "nii_annotations.zip",
  ) => {
    if (!entries.length) {
      Message.warning("当前没有可导出的标注结果");
      return;
    }

    const zip = new JSZip();
    const imgFolder = zip.folder("img");
    const maskFolder = zip.folder("mask");
    const sourceRecords = entries.map((entry) => entry.record).filter(Boolean);
    const labelCsv = buildLabelCsv(sourceRecords);
    const labelXlsxBuffer = await buildLabelXlsxBuffer(sourceRecords);
    for (const entry of entries) {
      imgFolder?.file(entry.imageName, entry.imageData);
      maskFolder?.file(entry.maskName, entry.maskData);
    }
    if (labelCsv) zip.file("labels.csv", labelCsv);
    if (labelXlsxBuffer) zip.file("labels.xlsx", labelXlsxBuffer);

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const userInput = await promptExportZipName(defaultZipName);
    if (userInput === null) {
      URL.revokeObjectURL(url);
      return;
    }

    const normalizedName = String(userInput || "")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\.zip$/i, "");
    const finalZipName = `${normalizedName || defaultZipName.replace(/\.zip$/i, "")}.zip`;
    const link = document.createElement("a");
    link.href = url;
    link.download = finalZipName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 200);

    await writeExportEntriesToFolder(entries, labelCsv, labelXlsxBuffer);
  };

  const resolveBulkExportScope = (records = []) => {
    const imageRecords = records.filter((record) => !record?.isMaskOnly);
    const queueIdSet = new Set(
      queueImages.map((item) => String(item?.imageId || "")).filter(Boolean),
    );

    if (queueIdSet.size > 0 || currentBatchId) {
      return imageRecords.filter((record) => {
        const remoteImageId = String(record?.remoteImageId || "");
        const remoteBatchId = String(record?.remoteBatchId || "");
        if (queueIdSet.size > 0 && queueIdSet.has(remoteImageId)) return true;
        if (currentBatchId && remoteBatchId === currentBatchId) return true;
        return false;
      });
    }

    const activeRecord = activeImage?.id
      ? imageRecords.find((record) => record.id === activeImage.id)
      : null;
    if (activeRecord?.importBatchId) {
      return imageRecords.filter(
        (record) => record.importBatchId === activeRecord.importBatchId,
      );
    }
    return imageRecords;
  };

  const exportCurrent = async () => {
    if (!activeImage?.id) {
      Message.warning("当前没有可导出的影像");
      return;
    }
    await persistActiveDrawing();
    const record = await getImageById(activeImage.id);
    const entries = buildExportEntries(record ? [record] : []);
    const sourceName =
      record?.sourceName || record?.displayName || record?.name || "annotation";
    const defaultZipName = `${fileStem(sourceName) || "annotation"}.zip`;
    await exportEntriesAsZip(entries, defaultZipName);
  };

  const exportBatch = async () => {
    await persistActiveDrawing();
    if (queueImages.length > 0) {
      await prefetchQueueImages(queueImages, { scope: "all" });
    }
    const records = await getAllImages();
    const exportScope = resolveBulkExportScope(records);
    const entries = buildExportEntries(exportScope);
    const sanitizedBatchId = String(currentBatchId || "").replace(
      /[\\/:*?"<>|]/g,
      "_",
    );
    const defaultZipName =
      entries.length === 1
        ? `${fileStem(entries[0].imageName) || "annotation"}.zip`
        : sanitizedBatchId
          ? `batch_${sanitizedBatchId}_annotations.zip`
          : "nii_annotations.zip";
    await exportEntriesAsZip(entries, defaultZipName);
  };

  const toggleAnnotationTool = (nextTool) => {
    setTool((prev) => (prev === nextTool ? "pan" : nextTool));
    requestAnimationFrame(() => {
      viewerRef.current?.refreshOverlay?.();
    });
  };

  const annotationMenuItems = [
    {
      key: "zoom",
      name: "缩放",
      active: tool === "zoom",
      onClick: () => toggleAnnotationTool("zoom"),
    },
    {
      key: "brush",
      name: "笔刷",
      active: tool === "brush",
      onClick: () => toggleAnnotationTool("brush"),
    },
    {
      key: "clearLabel",
      name: "橡皮擦",
      active: tool === "clearLabel",
      onClick: () => toggleAnnotationTool("clearLabel"),
    },
    {
      key: "freehand",
      name: "自由曲线",
      active: tool === "freehand",
      onClick: () => toggleAnnotationTool("freehand"),
    },
    {
      key: "undo",
      name: "撤销",
      onClick: () => {
        const handled = viewerRef.current?.undoToolAction?.();
        if (!handled) viewerRef.current?.undo?.();
      },
    },
    {
      key: "clear",
      name: "清除标注",
      onClick: async () => {
        viewerRef.current?.clearAnnotations?.();
        await handleClear();
      },
    },
  ];

  const renderAnnotationIcon = (key) => {
    const iconProps = {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      className: "annotation-menu-svg",
      "aria-hidden": true,
    };
    switch (key) {
      case "zoom":
        return (
          <svg {...iconProps}>
            <circle cx="11" cy="11" r="5.2" />
            <path d="M15 15l4 4" />
            <path d="M11 8.8v4.4" />
            <path d="M8.8 11h4.4" />
          </svg>
        );
      case "brush":
        return (
          <svg {...iconProps}>
            <circle
              cx="12"
              cy="12"
              r="3"
              fill="currentColor"
              fillOpacity="0.3"
            />
            <circle cx="12" cy="12" r="6" />
          </svg>
        );
      case "freehand":
        return (
          <svg {...iconProps}>
            <path d="M5 16c2-6 5-2 7-6 1.8-3.6 5 0 7-4" />
            <circle cx="5" cy="16" r="1.5" fill="currentColor" />
            <circle cx="12" cy="10" r="1.5" fill="currentColor" />
            <circle cx="19" cy="6" r="1.5" fill="currentColor" />
          </svg>
        );
      case "clearLabel":
        return (
          <svg {...iconProps}>
            <path d="M6 15l5-6h6l3 3-6 6H9z" />
            <path d="M13 9l4 4" />
            <path d="M5 19h8" />
          </svg>
        );
      case "undo":
        return (
          <svg {...iconProps}>
            <path d="M9 8H5v4" />
            <path d="M5 12a7 7 0 1 0 2-5" />
          </svg>
        );
      case "clear":
        return (
          <svg {...iconProps}>
            <path d="M5 14l5-6h9l-5 8H7z" />
            <path d="M13 11l3 3" />
          </svg>
        );
      default:
        return (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="3" />
          </svg>
        );
    }
  };

  const annotationToolsMenuContent = (
    <div className="annotation-menu">
      {annotationMenuItems.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`annotation-menu-item${item.active ? " active" : ""}${item.disabled ? " disabled" : ""}`}
          onClick={item.onClick}
          disabled={item.disabled}
        >
          <span className="annotation-menu-icon">
            {renderAnnotationIcon(item.key)}
          </span>
          <span className="annotation-menu-name">{item.name}</span>
        </button>
      ))}
    </div>
  );

  const exportMenuContent = (
    <div className="export-menu">
      <Button type="text" className="export-menu-item" onClick={exportCurrent}>
        导出当前标注
      </Button>
      <Button type="text" className="export-menu-item" onClick={exportBatch}>
        批量导出本批
      </Button>
    </div>
  );

  const buildAnnotationSignature = (annotation = {}, index = 0) => {
    const ax = Number(annotation?.axCorSag);
    const slice = Number(annotation?.sliceIndex);
    const first = Array.isArray(annotation?.points)
      ? annotation.points[0]
      : null;
    const vox = Array.isArray(first?.vox) ? first.vox : [];
    return `${index}|${Number.isFinite(ax) ? ax : "x"}|${Number.isFinite(slice) ? slice : "x"}|${Number(vox[0] || 0)}|${Number(vox[1] || 0)}|${Number(vox[2] || 0)}`;
  };

  const resolveAnnotationAnchor = (annotation = {}) => {
    const points = Array.isArray(annotation?.points) ? annotation.points : [];
    const voxPoints = points
      .map((pt) =>
        Array.isArray(pt?.vox) && pt.vox.length >= 3
          ? [Number(pt.vox[0]), Number(pt.vox[1]), Number(pt.vox[2])]
          : null,
      )
      .filter((pt) => Array.isArray(pt) && pt.every((v) => Number.isFinite(v)));
    if (voxPoints.length > 0) {
      const center = voxPoints.reduce(
        (acc, pt) => [acc[0] + pt[0], acc[1] + pt[1], acc[2] + pt[2]],
        [0, 0, 0],
      );
      return [
        Math.round(center[0] / voxPoints.length),
        Math.round(center[1] / voxPoints.length),
        Math.round(center[2] / voxPoints.length),
      ];
    }
    return null;
  };

  const syncWorkflowCardsByAnnotations = ({
    persist = false,
    returnNextState = false,
  } = {}) => {
    const annotations = Array.isArray(viewerRef.current?.exportAnnotations?.())
      ? viewerRef.current.exportAnnotations()
      : [];
    const labelStats = viewerRef.current?.getLabelStats?.() || {};
    const hasMaskStroke = Object.entries(labelStats).some(
      ([label, count]) => Number(label) > 0 && Number(count || 0) > 0,
    );
    const annotationCount = Math.max(
      0,
      annotations.length,
      hasMaskStroke ? 1 : 0,
    );
    let computedNextState = null;
    updateWorkflowState(
      (prev) => {
        const steps = Array.isArray(workflowSchema?.steps)
          ? workflowSchema.steps
          : [];
        if (!steps.length) return prev;
        const nextSteps = { ...(prev?.steps || {}) };
        let changed = false;
        for (const def of steps) {
          const stepId = String(def.id);
          const prevStep = prev?.steps?.[stepId] || {};
          const prevCards = Array.isArray(prevStep.cards) ? prevStep.cards : [];
          const base = prevCards[0] || makeEmptyCard(stepId, 0);
          const nextCards = [
            {
              ...base,
              title: String(def?.title || workflowSchema?.mainCategoryTitle || "主分类项"),
              completed: annotationCount > 0,
              annotationIndex: annotationCount > 0 ? 0 : -1,
              annotationSignature:
                annotationCount > 0
                  ? annotations[0]
                    ? buildAnnotationSignature(annotations[0], 0)
                    : "mask-0"
                  : "",
              annotationAnchor:
                annotationCount > 0 && annotations[0]
                  ? resolveAnnotationAnchor(annotations[0])
                  : null,
            },
          ];
          const nextActiveCardIndex = 0;
          const nextStep = {
            ...prevStep,
            activeCardIndex: nextActiveCardIndex,
            cards: nextCards,
            annotationCount,
            completed: annotationCount > 0,
          };
          const prevDigest = JSON.stringify({
            activeCardIndex: prevStep?.activeCardIndex,
            annotationCount: prevStep?.annotationCount,
            cards: prevCards,
          });
          const nextDigest = JSON.stringify({
            activeCardIndex: nextStep.activeCardIndex,
            annotationCount: nextStep.annotationCount,
            cards: nextStep.cards,
          });
          if (prevDigest !== nextDigest) {
            nextSteps[stepId] = nextStep;
            changed = true;
          }
        }
        if (!changed) {
          computedNextState = prev;
          return prev;
        }
        const next = { ...prev, steps: nextSteps };
        computedNextState = next;
        return next;
      },
      { persist },
    );
    if (returnNextState) return computedNextState;
  };

  const validateCurrentCard = () => {
    if (!activeStepDef || !activeCard) return true;
    const nextErrors = {};
    const requireMainCategory = String(activeStepDef?.id || "") === "lesion";
    if (
      requireMainCategory &&
      (workflowSchema.mainCategoryOptions || []).length > 0 &&
      !String(activeCard.mainCategory || "").trim()
    ) {
      nextErrors.mainCategory = "主分类项为必填项";
    }
    for (const field of activeStepDef.fields || []) {
      if (isLesionCheckboxField(field)) continue;
      if (!field?.required) continue;
      const value = activeCard?.values?.[field.id];
      const empty = Array.isArray(value)
        ? value.length === 0
        : value == null || String(value).trim() === "";
      if (empty) nextErrors[field.id] = `${field.label}为必填项`;
    }
    setWorkflowErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const markCurrentCardCompleted = () => {
    if (!activeStepDef || !activeCard) return;
    const stepId = String(activeStepDef.id);
    updateWorkflowState((prev) => {
      const step = prev?.steps?.[stepId];
      if (!step) return prev;
      const cards = Array.isArray(step.cards) ? [...step.cards] : [];
      const cardIndex = Math.max(
        0,
        Math.min(cards.length - 1, Number(step.activeCardIndex || 0)),
      );
      if (!cards[cardIndex]) return prev;
      return {
        ...prev,
        steps: {
          ...prev.steps,
          [stepId]: {
            ...step,
            cards: cards.map((card, idx) =>
              idx === cardIndex ? { ...card, completed: true } : card,
            ),
            completed: cards.some((card, idx) =>
              idx === cardIndex ? true : !!card?.completed,
            ),
          },
        },
      };
    });
  };

  const updateActiveCardMainCategory = (value) => {
    if (!activeStepDef || !activeCard) return;
    const stepId = String(activeStepDef.id);
    updateWorkflowState((prev) => {
      const step = prev?.steps?.[stepId];
      if (!step) return prev;
      const cards = Array.isArray(step.cards) ? [...step.cards] : [];
      const cardIndex = Math.max(
        0,
        Math.min(cards.length - 1, Number(step.activeCardIndex || 0)),
      );
      const card = cards[cardIndex];
      if (!card) return prev;
      const normalized = String(value ?? "");
      if (String(card.mainCategory || "") === normalized) return prev;
      return {
        ...prev,
        steps: {
          ...prev.steps,
          [stepId]: {
            ...step,
            cards: cards.map((item, idx) =>
              idx === cardIndex ? { ...item, mainCategory: normalized } : item,
            ),
          },
        },
      };
    });
  };

  const switchCard = (direction = 1) => {
    if (!activeStepDef || !activeStepState) return;
    const stepId = String(activeStepDef.id);
    updateWorkflowState(
      (prev) => {
        const step = prev?.steps?.[stepId];
        if (!step) return prev;
        const cards = Array.isArray(step.cards) ? step.cards : [];
        if (!cards.length) return prev;
        const current = Math.max(
          0,
          Math.min(cards.length - 1, Number(step.activeCardIndex || 0)),
        );
        const nextIndex = Math.max(
          0,
          Math.min(cards.length - 1, current + Number(direction || 0)),
        );
        if (nextIndex === current) return prev;
        return {
          ...prev,
          steps: {
            ...prev.steps,
            [stepId]: {
              ...step,
              activeCardIndex: nextIndex,
            },
          },
        };
      },
      { persist: false },
    );
    setWorkflowErrors({});
  };

  const gotoWorkflowStep = (direction = 1) => {
    const steps = Array.isArray(workflowSchema?.steps)
      ? workflowSchema.steps
      : [];
    if (!steps.length) return;
    if (direction > 0) {
      const ok = validateCurrentCard();
      if (!ok) return;
      markCurrentCardCompleted();
    }
    updateWorkflowState((prev) => {
      const nextIndex = Math.max(
        0,
        Math.min(steps.length - 1, Number(prev?.stepIndex || 0) + direction),
      );
      return {
        ...prev,
        stepIndex: nextIndex,
      };
    });
    setWorkflowErrors({});
  };

  const renderWorkflowFieldInput = (field) => {
    const value = activeCard?.values?.[field.id];
    const onChange = (next) => updateActiveCardFieldValue(field.id, next);
    if (field.type === "textarea") {
      return (
        <Input.TextArea
          value={String(value ?? "")}
          rows={field.rows || 3}
          placeholder={field.placeholder || ""}
          onChange={onChange}
        />
      );
    }
    if (field.type === "number") {
      return (
        <InputNumber
          value={Number.isFinite(Number(value)) ? Number(value) : undefined}
          min={field.min}
          max={field.max}
          hideControl
          style={{ width: "100%" }}
          placeholder={field.placeholder || ""}
          onChange={(next) => onChange(next == null ? "" : Number(next))}
        />
      );
    }
    if (field.type === "select") {
      return (
        <Select
          value={value == null || value === "" ? undefined : value}
          placeholder={field.placeholder || "请选择"}
          onChange={(next) => onChange(next ?? "")}
        >
          {field.options.map((opt) => (
            <Option key={`${field.id}-${String(opt.value)}`} value={opt.value}>
              {opt.label}
            </Option>
          ))}
        </Select>
      );
    }
    if (field.type === "radio") {
      return (
        <Radio.Group
          value={value ?? ""}
          onChange={(next) => onChange(next ?? "")}
        >
          {field.options.map((opt) => (
            <Radio key={`${field.id}-${String(opt.value)}`} value={opt.value}>
              {opt.label}
            </Radio>
          ))}
        </Radio.Group>
      );
    }
    if (field.type === "checkbox") {
      const checkedValues = Array.isArray(value) ? value : [];
      return (
        <Checkbox.Group
          value={checkedValues}
          onChange={(next) => onChange(Array.isArray(next) ? next : [])}
        >
          {field.options.map((opt) => (
            <Checkbox
              key={`${field.id}-${String(opt.value)}`}
              value={opt.value}
            >
              {opt.label}
            </Checkbox>
          ))}
        </Checkbox.Group>
      );
    }
    if (field.type === "switch") {
      return (
        <Radio.Group
          value={value ? "true" : "false"}
          onChange={(next) => onChange(String(next) === "true")}
        >
          <Radio value="true">是</Radio>
          <Radio value="false">否</Radio>
        </Radio.Group>
      );
    }
    return (
      <Input
        value={String(value ?? "")}
        placeholder={field.placeholder || ""}
        onChange={onChange}
      />
    );
  };

  return (
    <Layout className="app">
      <Header className="topbar">
        <div className="brand">影像标注平台</div>
        <Space className="topbar-actions">
          {(isQueueMode || localImageIds.length > 1) && (
            <>
              <Button
                onClick={() => switchDisplayImage(-1)}
                disabled={
                  isQueueMode ? !queueImages.length : localImageIds.length <= 1
                }
              >
                上一张
              </Button>
              <Button
                onClick={() => switchDisplayImage(1)}
                disabled={
                  isQueueMode ? !queueImages.length : localImageIds.length <= 1
                }
              >
                下一张
              </Button>
              <span
                style={{
                  color: "#cbd5e1",
                  fontSize: 12,
                  minWidth: 84,
                  textAlign: "center",
                }}
              >
                {progressTotal > 0
                  ? `${Math.max(1, progressIndex + 1)}/${progressTotal}`
                  : "0/0"}
              </span>
            </>
          )}
          <Button onClick={saveCurrentAnnotation}>
            保存
          </Button>
          <Popover trigger="click" position="bl" content={exportMenuContent}>
            <Button type="primary">导出</Button>
          </Popover>
        </Space>
      </Header>

      <Layout className="layout arco-layout-has-sider">
        <Sider className="tool-sidebar" width={188}>
          <div className="tool-sidebar-inner">
            <div className="tool-sidebar-head">
              <div className="tool-sidebar-title">标注工具</div>
              <div className="tool-sidebar-subtitle">
                {progressTotal > 0 ? `${Math.max(1, progressIndex + 1)}` : 0} /{" "}
                {progressTotal || 0}
              </div>
            </div>
            <div className="tool-sidebar-menu">
              {annotationToolsMenuContent}
            </div>
            {(tool === "brush" || tool === "clearLabel") && (
              <div className="brush-settings-panel compact">
                <div className="brush-settings-title">
                  {tool === "clearLabel" ? "橡皮擦设置" : "笔刷设置"}
                </div>
                <div className="brush-shape-selector">
                  <span className="brush-label">形状：</span>
                  <div className="brush-shape-options">
                    <button
                      type="button"
                      className={`brush-shape-btn${brushShape === "circle" ? " active" : ""}`}
                     
                      onClick={() => setBrushShape("circle")}
                      title="圆形"
                    >
                      <svg viewBox="0 0 20 20" width="16" height="16">
                        <circle
                          cx="10"
                          cy="10"
                          r="8"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`brush-shape-btn${brushShape === "square" ? " active" : ""}`}
                     
                      onClick={() => setBrushShape("square")}
                      title="方形"
                    >
                      <svg viewBox="0 0 20 20" width="16" height="16">
                        <rect
                          x="2"
                          y="2"
                          width="16"
                          height="16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="brush-size-slider">
                  <span className="brush-label">大小：{brushSize}</span>
                  <input
                    type="range"
                    min="1"
                    max="50"
                    value={brushSize}
                   
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                  />
                </div>
              </div>
            )}
            {(tool === "brush" || tool === "freehand") && (
              <div className="brush-settings-panel compact">
                <div className="brush-settings-title">Label 选择</div>
                <div className="label-select-row">
                  <Select
                    size="small"
                    className="label-select-input"
                    dropdownMenuClassName="label-select-dropdown"
                    dropdownMenuStyle={{ maxHeight: 260 }}
                    virtualListProps={{ height: 260, itemHeight: 36 }}
                    triggerProps={{ className: "label-select-popup" }}
                    getPopupContainer={(node) =>
                      node?.parentElement || document.body
                    }
                    value={activeLabelId}
                   
                    onChange={(value) => setActiveLabelId(Number(value) || 1)}
                    aria-label="选择当前标注 Label"
                  >
                    {labels.map((label) => (
                      <Option key={label.id} value={label.id}>
                        <span className="label-option-content">
                          <span
                            className="label-option-dot"
                            style={{ background: label.color }}
                          />
                          <span>{label.name}</span>
                        </span>
                      </Option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
          </div>
        </Sider>

        <Content className="viewer" ref={viewerHostRef}>
          {activeImage?.sourceFormat === "dicom" && (
            <div className="dicom-mode-toggle">
              <Button
                size="small"
                type={viewerMode === "dicom" ? "primary" : "secondary"}
                onClick={() =>
                  setViewerMode((prev) =>
                    prev === "dicom" ? "default" : "dicom",
                  )
                }
              >
                {viewerMode === "dicom"
                  ? "DICOM 专用视口"
                  : "切换 DICOM 专用视口"}
              </Button>
              {viewerMode === "dicom" && activeDicomSeries.length > 0 && (
                <div className="dicom-series-indicator">
                  <div>
                    序列 {Math.max(1, activeDicomSeriesIndex + 1)}/
                    {activeDicomSeries.length}
                  </div>
                  <div>
                    {activeImage?.dicomSeriesDescription ||
                      activeImage?.displayName ||
                      activeImage?.name}
                  </div>
                </div>
              )}
            </div>
          )}
          <Suspense
            fallback={<div className="viewer-loading">正在加载影像引擎…</div>}
          >
            <Viewer
              ref={viewerRef}
              image={activeImage}
              tool={tool}
              brushSize={brushSize}
              brushShape={brushShape}
              activeLabelValue={activeLabel?.value || 1}
              labels={labels}
              radiological2D={viewerMode === "dicom" ? true : radiological2D}
              renderMaskOnly3D
              runtimeEnv={runtimeEnv}
              selectedLesionId={selectedLesionId}
              onDrawingChange={onViewerEvent}
            />
          </Suspense>
        </Content>

        <Sider className="label-sidebar-placeholder" width={360}>
          <div className="custom-field-panel">
            <div className="custom-field-panel-head">
              <div className="custom-field-panel-title">自定义标注项</div>
              <div className="custom-field-panel-subtitle">
                ID:{" "}
                {activeImage?.remoteImageId ||
                  externalCtx.imageId ||
                  activeImage?.id ||
                  "-"}{" "}
                {activeImage?.displayName || activeImage?.name || ""}
              </div>
            </div>
            <div className="custom-field-meta">
              标注统计：{lesionItems.length}
            </div>
            {Array.isArray(workflowSchema?.steps) &&
            workflowSchema.steps.length > 0 ? (
              <div className="custom-field-meta custom-field-step-indicator">
                标注项 {Math.max(1, Number(workflowState?.stepIndex || 0) + 1)}{" "}
                / {workflowSchema.steps.length}
                {" · "}
                {activeStepDef?.title || "标注项"}
              </div>
            ) : null}
            {!activeStepDef ? (
              <div className="custom-field-empty">
                当前任务未配置自定义标注项
              </div>
            ) : (
              <div className="custom-field-list">
                <div className="custom-field-item workflow-card active">
                  <div className="workflow-card-header">
                    <span className="workflow-card-status completed">
                      {activeStepDef?.title || "标注项"}
                    </span>
                  </div>
                  {(workflowSchema.mainCategoryOptions || []).length > 0 && (
                    <div className="workflow-main-category">
                      <div className="custom-field-label">
                        {workflowSchema.mainCategoryTitle || "主分类项"}
                        <span className="custom-field-required">*</span>
                      </div>
                      <Radio.Group
                        value={String(activeCard?.mainCategory ?? "")}
                        onChange={(next) =>
                          updateActiveCardMainCategory(String(next ?? ""))
                        }
                      >
                        {(workflowSchema.mainCategoryOptions || []).map((opt) => (
                          <Radio key={`mc-${opt.value}`} value={String(opt.value)}>
                            {opt.label}
                          </Radio>
                        ))}
                      </Radio.Group>
                      {workflowErrors.mainCategory ? (
                        <div className="workflow-error">{workflowErrors.mainCategory}</div>
                      ) : null}
                    </div>
                  )}
                  {(activeStepDef?.fields || [])
                    .filter((field) => !isLesionCheckboxField(field))
                    .map((field) => (
                    <div
                      key={`single-${field.id}`}
                      className="custom-field-label-wrap"
                    >
                      <div className="custom-field-label">
                        {field.label}
                        {field.required ? (
                          <span className="custom-field-required">*</span>
                        ) : null}
                      </div>
                      {renderWorkflowFieldInput(field)}
                      {workflowErrors[field.id] ? (
                        <div className="workflow-error">{workflowErrors[field.id]}</div>
                      ) : null}
                    </div>
                  ))}
                  <div className="workflow-section-title">病灶列表（{lesionItems.length}）</div>
                  {lesionItems.length === 0 ? (
                    <div className="custom-field-empty">暂无病灶，请先使用笔刷或自由曲线标注病灶区域</div>
                  ) : (
                    <div className="custom-field-list">
                      {lesionItems.map((lesion, idx) => (
                        <button
                          key={lesion.key}
                          type="button"
                          className={`annotation-menu-item${selectedLesionId === lesion.lesionId ? " active" : ""}`}
                          onClick={() => {
                            setSelectedLesionId(lesion.lesionId);
                            viewerRef.current?.jumpToLesion?.(lesion.lesionId);
                          }}
                        >
                          <span className="annotation-menu-name">
                            {lesion.name}
                            {Array.isArray(lesion.coord)
                              ? `  (${lesion.coord.join(", ")})`
                              : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Sider>
      </Layout>
    </Layout>
  );
}
