import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Niivue, NVImage } from "@niivue/niivue";
import { resolveAutoWindowRange } from "../utils/windowPresets.js";

const ANNOTATION_TOOLS = new Set(["freehand", "brush", "clearLabel"]);
const FOCUS_PLANES = ["A", "S", "C"];
const PANE_ORDER = ["C", "S", "A", "R"];
const PANE_CONFIGS = {
  C: { key: "C", axCorSag: 1, fixedAxis: 1, is2D: true, title: "Coronal" },
  S: { key: "S", axCorSag: 2, fixedAxis: 0, is2D: true, title: "Sagittal" },
  A: { key: "A", axCorSag: 0, fixedAxis: 2, is2D: true, title: "Axial" },
  R: {
    key: "R",
    axCorSag: null,
    fixedAxis: null,
    is2D: false,
    title: "Render",
  },
};
const AX_COR_SAG_TO_PANE = { 0: "A", 1: "C", 2: "S" };
const THREE_D_CROSSHAIR_COLOR = [0.23, 0.56, 1.0, 1.0];
const THREE_D_CROSSHAIR_MIN_WIDTH = 2;
const ORIENTATION_TEXT_COLOR = [0.95, 0.98, 1.0, 1.0];
const SAGITTAL_NOSE_LEFT = true;
const DEFAULT_PAN2D_VIEW = [0, 0, 0, 0.98];
const FREEHAND_CLOSE_PX = 10;
const FREEHAND_RESUME_PX = 28;
const FREEHAND_SAMPLE_STEP_PX = 1.5;
const FREEHAND_OPEN_COLOR = "#db70db";
const MAX_MARKER_POINTS = 24000;
const FRAC_EPSILON = 1e-3;
const FRAC_SOFT_MARGIN = 0.2;

const isRasterImageName = (name) =>
  /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(name || "");
const isAnnotationTool = (tool) => ANNOTATION_TOOLS.has(tool);
const isBrushLikeTool = (tool) => tool === "brush" || tool === "clearLabel";
const isVec3Like = (value) =>
  (Array.isArray(value) || ArrayBuffer.isView(value)) &&
  Number(value?.length || 0) >= 3;

const toArrayBuffer = (data) => {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    );
  }
  return null;
};

const cloneAnnotations = (items) => {
  if (!Array.isArray(items)) return [];
  try {
    return JSON.parse(JSON.stringify(items));
  } catch {
    return [];
  }
};

const hexToRgba = (hex, alpha = 0.45) => {
  const cleaned = String(hex || "").replace("#", "");
  if (cleaned.length !== 6) return `rgba(147, 197, 253, ${alpha})`;
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b))
    return `rgba(147, 197, 253, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const toFixedNum = (value, digits = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
};

const safeInt = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const isViewerDebugEnabled = () => {
  try {
    return (
      typeof window !== "undefined" && window.__NII_VIEWER_DEBUG__ === true
    );
  } catch {
    return false;
  }
};

const compactPoints = (points, maxPoints) => {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const compacted = [];
  for (let i = 0; i < points.length; i += step) compacted.push(points[i]);
  if (compacted[compacted.length - 1] !== points[points.length - 1]) {
    compacted.push(points[points.length - 1]);
  }
  return compacted;
};

const normalizeFrac = (frac) => {
  if (!isVec3Like(frac)) return null;
  const values = [0, 1, 2].map((axis) => Number(frac[axis]));
  if (!values.every((value) => Number.isFinite(value))) return null;
  if (
    values.some(
      (value) => value < -FRAC_EPSILON || value > 1 + FRAC_EPSILON,
    )
  ) {
    return null;
  }
  return values.map((value) => clamp(value, 0, 1));
};

const normalizeFracSoft = (frac, margin = FRAC_SOFT_MARGIN) => {
  if (!isVec3Like(frac)) return null;
  const values = [0, 1, 2].map((axis) => Number(frac[axis]));
  if (!values.every((value) => Number.isFinite(value))) return null;
  if (values.some((value) => value < -margin || value > 1 + margin))
    return null;
  return values.map((value) => clamp(value, 0, 1));
};

const resolveFracForNv = (nv, frac, paneKey = null) => {
  const normalized = normalizeFrac(frac);
  if (normalized) return normalized;
  const soft = normalizeFracSoft(frac);
  if (soft) return soft;
  if (!isVec3Like(frac)) return null;
  const cfg = paneKey ? PANE_CONFIGS[paneKey] : null;
  const fixedAxis =
    cfg?.is2D && Number.isInteger(cfg?.fixedAxis) ? Number(cfg.fixedAxis) : null;
  if (!Number.isInteger(fixedAxis)) return null;
  const inPlaneAxes = [0, 1, 2].filter((axis) => axis !== fixedAxis);
  const inPlaneValid = inPlaneAxes.every((axis) => {
    const value = Number(frac[axis]);
    return (
      Number.isFinite(value) &&
      value >= -FRAC_SOFT_MARGIN &&
      value <= 1 + FRAC_SOFT_MARGIN
    );
  });
  if (!inPlaneValid) return null;
  const crosshair = normalizeFrac(nv?.scene?.crosshairPos);
  const fixedValueRaw = Number(frac[fixedAxis]);
  const fixedValue = Number.isFinite(fixedValueRaw)
    ? fixedValueRaw
    : Number(crosshair?.[fixedAxis]);
  if (
    !Number.isFinite(fixedValue) ||
    fixedValue < -FRAC_SOFT_MARGIN ||
    fixedValue > 1 + FRAC_SOFT_MARGIN
  ) {
    return null;
  }
  return [0, 1, 2].map((axis) => {
    if (axis === fixedAxis) return clamp(fixedValue, 0, 1);
    return clamp(Number(frac[axis]), 0, 1);
  });
};

const resolveVoxForNv = (nv, vox, paneKey = null) => {
  if (!isVec3Like(vox)) return null;
  const dims = nv?.back?.dims;
  const axisMax = [0, 1, 2].map((axis) =>
    Math.max(0, Number(dims?.[axis + 1] || 1) - 1),
  );
  const clampVox = (values) =>
    [0, 1, 2].map((axis) =>
      clamp(Number(values[axis] || 0), 0, axisMax[axis]),
    );
  const fullyValid = [0, 1, 2].every((axis) =>
    Number.isFinite(Number(vox[axis])),
  );
  if (fullyValid) {
    const resolved = clampVox(vox);
    return resolved.every((value) => Number.isFinite(value)) ? resolved : null;
  }
  const cfg = paneKey ? PANE_CONFIGS[paneKey] : null;
  const fixedAxis =
    cfg?.is2D && Number.isInteger(cfg?.fixedAxis) ? Number(cfg.fixedAxis) : null;
  if (!Number.isInteger(fixedAxis)) return null;
  const inPlaneAxes = [0, 1, 2].filter((axis) => axis !== fixedAxis);
  const inPlaneValid = inPlaneAxes.every((axis) =>
    Number.isFinite(Number(vox[axis])),
  );
  if (!inPlaneValid) return null;
  const crosshairFrac = normalizeFrac(nv?.scene?.crosshairPos);
  if (!crosshairFrac || typeof nv?.frac2vox !== "function") return null;
  const crosshairVox = nv.frac2vox(crosshairFrac);
  const fixedFallback = Number(crosshairVox?.[fixedAxis]);
  if (!Number.isFinite(fixedFallback)) return null;
  const resolved = clampVox([
    Number(vox[0]),
    Number(vox[1]),
    Number(vox[2]),
  ]);
  resolved[fixedAxis] = clamp(fixedFallback, 0, axisMax[fixedAxis]);
  return resolved.every((value) => Number.isFinite(value)) ? resolved : null;
};

const calcDet3 = (m) => {
  if (!Array.isArray(m) || m.length < 3) return null;
  const a00 = Number(m?.[0]?.[0] || 0);
  const a01 = Number(m?.[0]?.[1] || 0);
  const a02 = Number(m?.[0]?.[2] || 0);
  const a10 = Number(m?.[1]?.[0] || 0);
  const a11 = Number(m?.[1]?.[1] || 0);
  const a12 = Number(m?.[1]?.[2] || 0);
  const a20 = Number(m?.[2]?.[0] || 0);
  const a21 = Number(m?.[2]?.[1] || 0);
  const a22 = Number(m?.[2]?.[2] || 0);
  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);
  return Number.isFinite(det) ? det : null;
};

const formatAffineRow = (row = []) => [
  toFixedNum(row?.[0], 5),
  toFixedNum(row?.[1], 5),
  toFixedNum(row?.[2], 5),
  toFixedNum(row?.[3], 5),
];

const isSingleSliceVolume = (hdr) => {
  const dims = hdr?.dims;
  const hdrIntent = Number(hdr?.intent_code ?? hdr?.intentCode ?? 0);
  const hdrDim0 = Number(dims?.[0] ?? 0);
  const hdrDim3 = Number(dims?.[3] ?? 1);
  const hdrDim5 = Number(dims?.[5] ?? 0);
  const isVector2D = (hdrIntent === 1007 || hdrDim5 > 1) && hdrDim3 <= 1;
  return hdrDim0 <= 2 || hdrDim3 <= 1 || isVector2D;
};

const inferAxisSignature = (affine) => {
  if (!Array.isArray(affine) || affine.length < 3) return null;
  const rows = [affine[0] || [], affine[1] || [], affine[2] || []];
  const axisName = ["X", "Y", "Z"];
  const parts = [];
  for (let col = 0; col < 3; col += 1) {
    let bestRow = -1;
    let bestAbs = -1;
    let bestValue = 0;
    for (let row = 0; row < 3; row += 1) {
      const value = Number(rows[row]?.[col] || 0);
      const absValue = Math.abs(value);
      if (absValue > bestAbs) {
        bestAbs = absValue;
        bestRow = row;
        bestValue = value;
      }
    }
    if (bestRow < 0 || bestAbs <= 0) {
      parts.push(`${axisName[col]}:?`);
      continue;
    }
    parts.push(
      `${axisName[col]}:${axisName[bestRow]}${bestValue >= 0 ? "+" : "-"}`,
    );
  }
  return parts.join(" ");
};

const affinesDiffer = (a, b, epsilon = 1e-4) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      const av = Number(a?.[row]?.[col] || 0);
      const bv = Number(b?.[row]?.[col] || 0);
      if (Math.abs(av - bv) > epsilon) return true;
    }
  }
  return false;
};

const normalizeVolumeOrientationFromQform = (
  volume,
  image,
  context = "base",
) => {
  const hdr = volume?.hdr;
  if (
    !hdr ||
    typeof volume?.setAffine !== "function" ||
    typeof hdr?.getQformMat !== "function"
  )
    return null;
  const qformCode = safeInt(hdr?.qform_code ?? hdr?.qformCode, 0);
  const sformCode = safeInt(hdr?.sform_code ?? hdr?.sformCode, 0);
  const shouldPreferQform =
    qformCode > 0 && (sformCode < 1 || sformCode < qformCode);
  if (!shouldPreferQform) return null;
  let qAffine = null;
  try {
    qAffine = hdr.getQformMat();
  } catch {
    qAffine = null;
  }
  if (!Array.isArray(qAffine) || !affinesDiffer(hdr?.affine, qAffine))
    return null;
  const beforeSignature = inferAxisSignature(hdr?.affine);
  const afterSignature = inferAxisSignature(qAffine);
  volume.setAffine(qAffine);
  if (isViewerDebugEnabled()) {
    console.info("[ViewerFix] normalized-orientation", {
      context,
      imageName: image?.displayName || image?.name || "",
      qformCode,
      sformCode,
      beforeSignature,
      afterSignature,
    });
  }
  return { qformCode, sformCode, beforeSignature, afterSignature };
};

const getOrientationInfoFromVolume = (volume) => {
  const hdr = volume?.hdr;
  const affine = hdr?.affine;
  const orientationText = [];
  try {
    if (
      typeof hdr?.getQformMat === "function" &&
      typeof hdr?.convertNiftiSFormToNEMA === "function"
    ) {
      const qAffine = hdr.getQformMat();
      orientationText.push(
        `qform:${hdr.convertNiftiSFormToNEMA(qAffine) || "n/a"}`,
      );
    }
    if (
      Array.isArray(affine) &&
      typeof hdr?.convertNiftiSFormToNEMA === "function"
    ) {
      orientationText.push(
        `sform:${hdr.convertNiftiSFormToNEMA(affine) || "n/a"}`,
      );
    }
  } catch {
    // ignore diagnostics conversion errors
  }
  return {
    qformCode: safeInt(hdr?.qform_code ?? hdr?.qformCode, 0),
    sformCode: safeInt(hdr?.sform_code ?? hdr?.sformCode, 0),
    pixDims: Array.isArray(hdr?.pixDims)
      ? [
          toFixedNum(hdr.pixDims[0], 5),
          toFixedNum(hdr.pixDims[1], 5),
          toFixedNum(hdr.pixDims[2], 5),
          toFixedNum(hdr.pixDims[3], 5),
        ]
      : null,
    qfac: toFixedNum(hdr?.pixDims?.[0], 5),
    permRAS: Array.isArray(volume?.permRAS)
      ? volume.permRAS.map((v) => safeInt(v, 0))
      : null,
    dimsRAS: Array.isArray(volume?.dimsRAS)
      ? volume.dimsRAS.map((v) => safeInt(v, 0))
      : null,
    pixDimsRAS: Array.isArray(volume?.pixDimsRAS)
      ? [
          toFixedNum(volume.pixDimsRAS[1], 5),
          toFixedNum(volume.pixDimsRAS[2], 5),
          toFixedNum(volume.pixDimsRAS[3], 5),
        ]
      : null,
    affineDet: toFixedNum(calcDet3(affine), 6),
    axisSignature: inferAxisSignature(affine),
    affineRows: Array.isArray(affine)
      ? [
          formatAffineRow(affine[0]),
          formatAffineRow(affine[1]),
          formatAffineRow(affine[2]),
        ]
      : null,
    orientationText: orientationText.length
      ? orientationText.join(" | ")
      : null,
  };
};

const cloneHeaderTemplateFromVolume = (volume) => {
  const hdr = volume?.hdr;
  if (!hdr) return null;
  const cloneAffine = (affine) => {
    if (!Array.isArray(affine) || affine.length < 3) return null;
    return [0, 1, 2].map((row) =>
      [0, 1, 2, 3].map((col) => Number(affine?.[row]?.[col] || 0)),
    );
  };
  const pixDims = Array.isArray(hdr?.pixDims)
    ? Array.from(hdr.pixDims).map((value) => Number(value || 0))
    : null;
  return {
    pixDims,
    affine: cloneAffine(hdr?.affine),
    sform_code: Number(hdr?.sform_code ?? hdr?.sformCode ?? 1),
    qform_code: 0,
    xyzt_units: Number(hdr?.xyzt_units ?? 10),
    quatern_b: 0,
    quatern_c: 0,
    quatern_d: 0,
    qoffset_x: 0,
    qoffset_y: 0,
    qoffset_z: 0,
  };
};

const getPaneSliceType = (nv, paneKey) => {
  if (paneKey === "A") return nv.sliceTypeAxial;
  if (paneKey === "C") return nv.sliceTypeCoronal;
  if (paneKey === "S") return nv.sliceTypeSagittal;
  return nv.sliceTypeRender;
};

const ViewerPublicApi = forwardRef(function ViewerPublicApi(
  {
    image,
    tool,
    brushSize,
    brushShape = "circle",
    activeLabelValue,
    labels = [],
    radiological2D = true,
    onDrawingChange,
    renderMaskOnly3D = true,
    runtimeEnv = null,
    selectedAnnotationIndex = -1,
  },
  ref,
) {
  const rootRef = useRef(null);
  const nvRef = useRef(null);
  const paneCanvasRefs = useRef({});
  const paneMarkerCanvasRefs = useRef({});
  const paneNvsRef = useRef({});
  const paneResizeObserversRef = useRef({});
  const volumeTemplateCacheRef = useRef(new Map());
  const imageLoadGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const sharedDrawBitmapRef = useRef(null);
  const visiblePaneKeysRef = useRef([...PANE_ORDER]);
  const actionHistoryRef = useRef([]);
  const historyRef = useRef({ stack: [], index: -1 });
  const imageKeyRef = useRef("");
  const annotationsByImageRef = useRef(new Map());
  const annotationDraftRef = useRef(null);
  const annotationStepsRef = useRef([]);
  const curvePlaneRef = useRef(null);
  const curvePaneKeyRef = useRef(null);
  const curveSliceIndexRef = useRef(null);
  const toolRef = useRef(tool);
  const brushSizeRef = useRef(brushSize);
  const brushShapeRef = useRef(brushShape);
  const activeLabelValueRef = useRef(activeLabelValue);
  const labelsRef = useRef(labels);
  const selectedAnnotationIndexRef = useRef(selectedAnnotationIndex);
  const onDrawingChangeRef = useRef(onDrawingChange);
  const runtimeEnvRef = useRef(runtimeEnv);
  const renderMaskOnly3DRef = useRef(renderMaskOnly3D);
  const crosshairWidthRef = useRef(THREE_D_CROSSHAIR_MIN_WIDTH);
  const markerRedrawRafRef = useRef(null);
  const markerDrawRafRef = useRef(null);
  const drawRefreshPendingRef = useRef(false);
  const pendingDrawRefreshPayloadRef = useRef(null);
  const paneLayoutSyncRafRef = useRef(null);
  const crosshairSyncRafRef = useRef(null);
  const pendingCrosshairSyncRef = useRef(null);
  const syncingLocationRef = useRef(false);
  const activePointerIdRef = useRef(null);
  const activePointerPaneKeyRef = useRef(null);
  const freehandDrawingRef = useRef(false);
  const fillActiveRef = useRef(false);
  const fillAxCorSagRef = useRef(0);
  const lastBrushVoxRef = useRef(null);
  const brushStrokeDirtyRef = useRef(false);
  const refreshTelemetryRef = useRef({ last: null });
  const refreshPerfRef = useRef({ emaMs: 0, samples: 0 });
  const labelAnalysisRef = useRef({ dirty: true, stats: {}, centroids: {} });
  const [panesReady, setPanesReady] = useState(false);
  const [focusedPlane, setFocusedPlane] = useState(null);
  const [canFocusPlanes, setCanFocusPlanes] = useState(false);
  const [visiblePaneKeys, setVisiblePaneKeys] = useState([...PANE_ORDER]);

  imageKeyRef.current = image?.id ? String(image.id) : "";

  const setPaneCanvasRef = (key) => (node) => {
    paneCanvasRefs.current[key] = node;
  };

  const setPaneMarkerCanvasRef = (key) => (node) => {
    paneMarkerCanvasRefs.current[key] = node;
  };

  const getPaneCanvas = (key) => paneCanvasRefs.current[key] || null;
  const getPaneMarkerCanvas = (key) =>
    paneMarkerCanvasRefs.current[key] || null;
  const getPaneNv = (key) => paneNvsRef.current[key] || null;
  const getVisiblePaneKeys = () =>
    visiblePaneKeysRef.current.filter((key) => !!getPaneNv(key));
  const getPrimaryPaneKey = () =>
    visiblePaneKeysRef.current.includes("A")
      ? "A"
      : visiblePaneKeysRef.current[0] || null;
  const getPrimaryNv = () => {
    const key = getPrimaryPaneKey();
    return key ? getPaneNv(key) : null;
  };

  const getImageKey = () => imageKeyRef.current;
  const getCurrentAnnotations = () => {
    const key = getImageKey();
    if (!key) return [];
    return annotationsByImageRef.current.get(key) || [];
  };
  const setCurrentAnnotations = (next) => {
    const key = getImageKey();
    if (!key) return;
    annotationsByImageRef.current.set(key, next);
  };
  const emitDrawingChange = (reason) => {
    const notify = onDrawingChangeRef.current;
    if (typeof notify === "function") notify(reason);
  };

  const getCurrentAnnotationColor = () =>
    labelsRef.current.find(
      (item) =>
        Number(item.value || 0) === Number(activeLabelValueRef.current || 0),
    )?.color || "#60a5fa";

  const makeFreehandDraft = (points, { nearClosed = false } = {}) => ({
    type: "freehand",
    points: [...points],
    label: "",
    color: nearClosed ? getCurrentAnnotationColor() : FREEHAND_OPEN_COLOR,
    closeColor: getCurrentAnnotationColor(),
    nearClosed,
    closed: false,
    axCorSag: curvePlaneRef.current,
    paneKey: curvePaneKeyRef.current,
    sliceIndex: curveSliceIndexRef.current,
  });

  const addAnnotation = (annotation, options = {}) => {
    const { recordHistory = true, emitChange = true } = options;
    const key = getImageKey();
    if (!key) return;
    setCurrentAnnotations([...getCurrentAnnotations(), annotation]);
    if (recordHistory)
      actionHistoryRef.current.push({ type: "annotation", imageKey: key });
    if (emitChange) emitDrawingChange("annotate");
  };

  const getDrawingDimsInfo = (nv = getPrimaryNv()) => {
    if (!nv?.back?.dims) return null;
    const dims = nv.back.dims;
    const nx = Number(dims?.[1] || 0);
    const ny = Number(dims?.[2] || 0);
    const nz = Math.max(1, Number(dims?.[3] || 1));
    if (nx < 1 || ny < 1 || nz < 1) return null;
    return { dims, nx, ny, nz, voxelCount: nx * ny * nz };
  };

  const getViewerPerfProfile = () => {
    const runtime = runtimeEnvRef.current || {};
    const profile = runtime.viewerProfile || {};
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const dpr =
      typeof window !== "undefined" ? Number(window.devicePixelRatio || 1) : 1;
    const hw = Number(nav?.hardwareConcurrency || 0);
    const mem = Number(nav?.deviceMemory || 0);
    const tier = String(runtime?.webgl?.tier || "");
    const lowPowerMode =
      typeof profile.lowPowerMode === "boolean"
        ? profile.lowPowerMode
        : tier === "low" || (hw > 0 && hw <= 4) || (mem > 0 && mem <= 4);
    const mediumPowerMode =
      typeof profile.mediumPowerMode === "boolean"
        ? profile.mediumPowerMode
        : !lowPowerMode &&
          (tier === "medium" || (hw > 0 && hw <= 8) || (mem > 0 && mem <= 8));
    const forceDevicePixelRatio = clamp(
      Number(profile.forceDevicePixelRatio) ||
        (lowPowerMode
          ? 1
          : mediumPowerMode
            ? Math.min(1.25, dpr)
            : Math.min(1.5, dpr)),
      1,
      2,
    );
    return {
      lowPowerMode,
      mediumPowerMode,
      forceDevicePixelRatio,
      strokeRefreshTarget:
        profile.strokeRefreshTarget ||
        (lowPowerMode || mediumPowerMode ? "source-only" : "all-2d"),
      liveCrosshairDuringAnnotation: !!profile.liveCrosshairDuringAnnotation,
    };
  };

  const touchTemplateCacheEntry = (cacheKey) => {
    const cache = volumeTemplateCacheRef.current;
    const entry = cache.get(cacheKey);
    if (!entry) return null;
    cache.delete(cacheKey);
    cache.set(cacheKey, entry);
    return entry;
  };

  const pruneTemplateCache = () => {
    const cache = volumeTemplateCacheRef.current;
    const perfProfile = getViewerPerfProfile();
    const maxEntries = perfProfile.lowPowerMode
      ? 4
      : perfProfile.mediumPowerMode
        ? 6
        : 10;
    const now = Date.now();
    const maxAgeMs = perfProfile.lowPowerMode
      ? 90 * 1000
      : perfProfile.mediumPowerMode
        ? 3 * 60 * 1000
        : 6 * 60 * 1000;
    const currentGeneration = Number(imageLoadGenerationRef.current || 0);
    for (const [key, entry] of cache.entries()) {
      const updatedAt = Number(entry?.updatedAt || 0);
      const generation = Number(entry?.generation || 0);
      const expired = !updatedAt || now - updatedAt > maxAgeMs;
      const staleGeneration = currentGeneration - generation > 2;
      if (expired || staleGeneration) cache.delete(key);
    }
    while (cache.size > maxEntries) {
      const firstKey = cache.keys().next().value;
      if (typeof firstKey === "undefined") break;
      cache.delete(firstKey);
    }
  };

  const loadVolumeTemplate = async ({
    cacheKey,
    buffer,
    name,
    imageMeta,
    context = "base",
    allowCache = true,
    generation = 0,
  }) => {
    if (allowCache) {
      const cached = touchTemplateCacheEntry(cacheKey);
      if (cached?.template) return cached.template.clone();
    }
    const loaded = await NVImage.loadFromUrl({
      url: name,
      name,
      buffer,
    });
    normalizeVolumeOrientationFromQform(loaded, imageMeta, context);
    if (allowCache) {
      volumeTemplateCacheRef.current.set(cacheKey, {
        template: loaded.clone(),
        updatedAt: Date.now(),
        generation: Number(generation || 0),
      });
      pruneTemplateCache();
    }
    return loaded;
  };

  const invalidateLabelAnalysis = () => {
    labelAnalysisRef.current.dirty = true;
  };

  const getLabelAnalysis = () => {
    if (!labelAnalysisRef.current.dirty) return labelAnalysisRef.current;
    const bitmap = getSharedBitmap();
    const dims = getPrimaryNv()?.back?.dims;
    const nx = Number(dims?.[1] || 0);
    const ny = Number(dims?.[2] || 0);
    const nz = Math.max(1, Number(dims?.[3] || 1));
    if (!bitmap?.length || nx < 1 || ny < 1 || nz < 1) {
      labelAnalysisRef.current = { dirty: false, stats: {}, centroids: {} };
      return labelAnalysisRef.current;
    }
    const xy = nx * ny;
    const stats = {};
    const sums = {};
    for (let z = 0; z < nz; z += 1) {
      const zOff = z * xy;
      for (let y = 0; y < ny; y += 1) {
        const yOff = zOff + y * nx;
        for (let x = 0; x < nx; x += 1) {
          const idx = yOff + x;
          const v = Number(bitmap[idx] || 0);
          if (v <= 0) continue;
          stats[v] = (stats[v] || 0) + 1;
          const sum = sums[v] || (sums[v] = { sx: 0, sy: 0, sz: 0 });
          sum.sx += x;
          sum.sy += y;
          sum.sz += z;
        }
      }
    }
    const centroids = {};
    for (const [labelValue, count] of Object.entries(stats)) {
      const numericCount = Number(count || 0);
      const sum = sums[labelValue];
      if (!sum || numericCount <= 0) continue;
      centroids[labelValue] = [
        sum.sx / numericCount,
        sum.sy / numericCount,
        sum.sz / numericCount,
      ];
    }
    labelAnalysisRef.current = { dirty: false, stats, centroids };
    return labelAnalysisRef.current;
  };

  const hasRefreshableDrawingBitmap = (nv) => {
    const dimsInfo = getDrawingDimsInfo(nv);
    if (!dimsInfo) return false;
    return !!(nv?.drawBitmap && nv.drawBitmap.length === dimsInfo.voxelCount);
  };

  const getSharedBitmap = () =>
    sharedDrawBitmapRef.current || getPrimaryNv()?.drawBitmap || null;

  const applySharedBitmap = (
    bitmap,
    {
      refresh = true,
      reason = "commit",
      sourcePaneKey = null,
      targetVox = null,
    } = {},
  ) => {
    if (!bitmap) return false;
    invalidateLabelAnalysis();
    sharedDrawBitmapRef.current = bitmap;
    const primary = getPrimaryNv();
    if (primary) {
      if (!primary.drawBitmap || primary.drawBitmap.length !== bitmap.length) {
        primary.createEmptyDrawing?.();
      }
      primary.drawBitmap = bitmap;
    }
    for (const key of getVisiblePaneKeys()) {
      const nv = getPaneNv(key);
      if (!nv) continue;
      if (!nv.drawBitmap || nv.drawBitmap.length !== bitmap.length) {
        nv.createEmptyDrawing?.();
      }
      nv.drawBitmap = bitmap;
    }
    if (refresh) {
      pendingDrawRefreshPayloadRef.current = {
        reason,
        sourcePaneKey,
        targetVox,
      };
      drawRefreshPendingRef.current = false;
      refreshDrawingAcrossPanes({ reason, sourcePaneKey, targetVox });
    }
    return true;
  };

  const syncSharedBitmapBindings = () => {
    const bitmap = getSharedBitmap();
    if (!bitmap) return false;
    let rebound = false;
    for (const key of getVisiblePaneKeys()) {
      const nv = getPaneNv(key);
      if (!nv) continue;
      if (!nv.drawBitmap || nv.drawBitmap.length !== bitmap.length) {
        nv.createEmptyDrawing?.();
      }
      if (nv.drawBitmap !== bitmap) {
        nv.drawBitmap = bitmap;
        rebound = true;
      }
    }
    const primary = getPrimaryNv();
    if (primary && primary.drawBitmap !== bitmap) {
      if (!primary.drawBitmap || primary.drawBitmap.length !== bitmap.length) {
        primary.createEmptyDrawing?.();
      }
      primary.drawBitmap = bitmap;
      rebound = true;
    }
    if (sharedDrawBitmapRef.current !== bitmap) {
      sharedDrawBitmapRef.current = bitmap;
      rebound = true;
    }
    return rebound;
  };

  const ensureBaseSnapshot = (bitmap) => {
    const history = historyRef.current;
    if (history.stack.length > 0 || !bitmap) return;
    history.stack = [new Uint8Array(bitmap)];
    history.index = 0;
  };

  const pushSnapshot = (bitmap) => {
    if (!bitmap) return false;
    const history = historyRef.current;
    if (history.index < history.stack.length - 1) {
      history.stack = history.stack.slice(0, history.index + 1);
    }
    const last = history.stack[history.stack.length - 1];
    if (last && last.length === bitmap.length) {
      let same = true;
      for (let i = 0; i < bitmap.length; i += 1) {
        if (last[i] !== bitmap[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        history.index = history.stack.length - 1;
        return false;
      }
    }
    history.stack.push(new Uint8Array(bitmap));
    history.index = history.stack.length - 1;
    return true;
  };

  const applySnapshot = (snapshot) => {
    if (!snapshot) return false;
    const next = new Uint8Array(snapshot);
    applySharedBitmap(next, { refresh: true, reason: "commit" });
    return true;
  };

  const getPaneCurrentSliceIndex = (paneKey) => {
    const cfg = PANE_CONFIGS[paneKey];
    const nv = getPaneNv(paneKey);
    if (!cfg?.is2D || !nv?.scene?.crosshairPos) return null;
    const dims = nv.back?.dims;
    const dimLen = Number(dims?.[cfg.fixedAxis + 1] || 0);
    if (dimLen < 1) return null;
    const frac = Number(nv.scene.crosshairPos[cfg.fixedAxis] || 0);
    if (!Number.isFinite(frac)) return null;
    return Math.max(
      0,
      Math.min(dimLen - 1, Math.round(frac * Math.max(1, dimLen - 1))),
    );
  };

  const getCurrentSliceIndex = (axCorSag) => {
    const paneKey = AX_COR_SAG_TO_PANE[Number(axCorSag)];
    return paneKey ? getPaneCurrentSliceIndex(paneKey) : null;
  };

  const syncMarkerCanvasSize = (paneKey) => {
    const canvas = getPaneCanvas(paneKey);
    const markerCanvas = getPaneMarkerCanvas(paneKey);
    if (!canvas || !markerCanvas) return;
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    if (markerCanvas.width !== nextWidth) markerCanvas.width = nextWidth;
    if (markerCanvas.height !== nextHeight) markerCanvas.height = nextHeight;
  };

  const getPaneCanvasSize = (paneKey) => {
    const canvas = getPaneCanvas(paneKey);
    if (!canvas) return { width: 1, height: 1 };
    const rect = canvas.getBoundingClientRect?.();
    return {
      width: Math.max(
        1,
        Math.round(rect?.width || canvas.clientWidth || canvas.width || 1),
      ),
      height: Math.max(
        1,
        Math.round(rect?.height || canvas.clientHeight || canvas.height || 1),
      ),
    };
  };

  const isDisplayedAsSinglePane = (paneKey) =>
    PANE_CONFIGS[paneKey]?.is2D &&
    ((visiblePaneKeysRef.current.length === 1 &&
      visiblePaneKeysRef.current[0] === paneKey) ||
      focusedPlane === paneKey);

  const getPaneBounds = (paneKey) => {
    const { width, height } = getPaneCanvasSize(paneKey);
    if (!PANE_CONFIGS[paneKey]?.is2D) {
      const renderInsetPx = clamp(
        Math.round(Math.min(width, height) * 0.04),
        10,
        28,
      );
      const insetX = clamp(renderInsetPx / width, 0.02, 0.12);
      const insetY = clamp(renderInsetPx / height, 0.02, 0.12);
      return [insetX, insetY, 1 - insetX, 1 - insetY];
    }
    if (isDisplayedAsSinglePane(paneKey)) {
      const minSide = Math.max(1, Math.min(width, height));
      const sideInsetPx = clamp(Math.round(minSide * 0.07), 28, 72);
      const topInsetPx = clamp(Math.round(minSide * 0.08), 28, 76);
      const bottomInsetPx = clamp(Math.round(minSide * 0.11), 36, 96);
      const insetX = clamp(sideInsetPx / width, 0.04, 0.14);
      const insetY = clamp(topInsetPx / height, 0.04, 0.14);
      const insetBottom = clamp(bottomInsetPx / height, 0.06, 0.18);
      return [insetX, insetY, 1 - insetX, 1 - insetBottom];
    }
    const sideInsetPx = clamp(Math.round(width * 0.075), 24, 52);
    const verticalInsetPx = clamp(Math.round(height * 0.1), 24, 60);
    const insetX = clamp(sideInsetPx / width, 0.04, 0.18);
    const insetY = clamp(verticalInsetPx / height, 0.05, 0.2);
    return [insetX, insetY, 1 - insetX, 1 - insetY];
  };

  const getCanvasCssSize = (canvas) => {
    if (!canvas) return { width: 1, height: 1 };
    const rect = canvas.getBoundingClientRect?.();
    return {
      width: Math.max(
        1,
        Math.round(rect?.width || canvas.clientWidth || canvas.width || 1),
      ),
      height: Math.max(
        1,
        Math.round(rect?.height || canvas.clientHeight || canvas.height || 1),
      ),
    };
  };

  const mapOverlayPxToNvCanvasPos = (paneKey, pt, canvas = null) => {
    if (!pt) return null;
    const overlaySize = canvas ? getCanvasCssSize(canvas) : getPaneCanvasSize(paneKey);
    const paneSize = getPaneCanvasSize(paneKey);
    return {
      x:
        (Number(pt.x || 0) * Math.max(1, Number(paneSize.width || 1))) /
        Math.max(1, Number(overlaySize.width || 1)),
      y:
        (Number(pt.y || 0) * Math.max(1, Number(paneSize.height || 1))) /
        Math.max(1, Number(overlaySize.height || 1)),
    };
  };

  const mapNvCanvasPosToOverlayPx = (paneKey, pt, canvas = null) => {
    if (!pt) return null;
    const paneSize = getPaneCanvasSize(paneKey);
    const overlaySize = canvas ? getCanvasCssSize(canvas) : paneSize;
    return {
      x:
        (Number(pt.x || 0) * Math.max(1, Number(overlaySize.width || 1))) /
        Math.max(1, Number(paneSize.width || 1)),
      y:
        (Number(pt.y || 0) * Math.max(1, Number(overlaySize.height || 1))) /
        Math.max(1, Number(paneSize.height || 1)),
    };
  };

  const applyPaneBounds = (paneKey) => {
    const nv = getPaneNv(paneKey);
    if (!nv || typeof nv.setBounds !== "function") return false;
    const [x1, y1, x2, y2] = getPaneBounds(paneKey);
    nv.setBounds([x1, y1, x2, y2]);
    if (nv.opts) nv.opts.showBoundsBorder = false;
    return true;
  };

  const scheduleMarkerRedraw = (delayFrames = 0) => {
    if (markerRedrawRafRef.current !== null) {
      cancelAnimationFrame(markerRedrawRafRef.current);
      markerRedrawRafRef.current = null;
    }
    const run = (remaining) => {
      markerRedrawRafRef.current = requestAnimationFrame(() => {
        if (remaining > 0) {
          run(remaining - 1);
          return;
        }
        markerRedrawRafRef.current = null;
        drawStrokeMarkers(true);
      });
    };
    run(Math.max(0, Number(delayFrames) || 0));
  };

  const toStoredPoint = (paneKey, pt, canvas = null) => {
    const paneSize = canvas
      ? getCanvasCssSize(canvas)
      : getPaneCanvasSize(paneKey);
    const sx = clamp(
      Number(pt?.x || 0) / Math.max(1, Number(paneSize.width || 1)),
      0,
      1,
    );
    const sy = clamp(
      Number(pt?.y || 0) / Math.max(1, Number(paneSize.height || 1)),
      0,
      1,
    );
    const fallback = { paneKey, sx, sy };
    const nv = getPaneNv(paneKey);
    if (!nv || !pt) return fallback;
    const dpr = nv.uiData?.dpr || 1;
    const nvPos = mapOverlayPxToNvCanvasPos(paneKey, pt, canvas);
    if (!nvPos) return fallback;
    const frac = resolveFracForNv(
      nv,
      nv.canvasPos2frac([
        Number(nvPos.x || 0) * dpr,
        Number(nvPos.y || 0) * dpr,
      ]),
      paneKey,
    );
    if (!frac) return fallback;
    const rawVox = typeof nv.frac2vox === "function" ? nv.frac2vox(frac) : null;
    const resolvedVox = resolveVoxForNv(nv, rawVox, paneKey);
    const vox = resolvedVox
      ? [
          Math.round(Number(resolvedVox[0] || 0)),
          Math.round(Number(resolvedVox[1] || 0)),
          Math.round(Number(resolvedVox[2] || 0)),
        ]
      : null;
    return {
      paneKey,
      frac: [Number(frac[0]), Number(frac[1]), Number(frac[2])],
      vox: vox ? [Number(vox[0]), Number(vox[1]), Number(vox[2])] : undefined,
      px: Number(pt?.x || 0),
      py: Number(pt?.y || 0),
      sx,
      sy,
    };
  };

  const toPxPoint = (pt, canvas, paneKey = null) => {
    const resolvedPaneKey = paneKey || pt?.paneKey || null;
    const nv = resolvedPaneKey ? getPaneNv(resolvedPaneKey) : null;

    const fracToPx = (frac) => {
      const resolvedFrac = resolveFracForNv(nv, frac, resolvedPaneKey);
      if (!nv || !resolvedFrac || typeof nv.frac2canvasPos !== "function")
        return null;
      const pos = nv.frac2canvasPos([
        Number(resolvedFrac[0] || 0),
        Number(resolvedFrac[1] || 0),
        Number(resolvedFrac[2] || 0),
      ]);
      if (!Array.isArray(pos) || pos.length < 2) return null;
      const dpr = nv.uiData?.dpr || 1;
      const overlayPos = mapNvCanvasPosToOverlayPx(
        resolvedPaneKey,
        {
          x: Number(pos[0] || 0) / dpr,
          y: Number(pos[1] || 0) / dpr,
        },
        canvas,
      );
      const x = Number(overlayPos?.x);
      const y = Number(overlayPos?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)
        return null;
      return { x, y };
    };

    const byFrac = fracToPx(pt?.frac);
    if (byFrac) return byFrac;

    if (
      nv &&
      isVec3Like(pt?.vox) &&
      typeof nv.vox2frac === "function" &&
      typeof nv.frac2canvasPos === "function"
    ) {
      const fracFromVox = normalizeFrac(
        nv.vox2frac([
          Number(pt.vox[0] || 0),
          Number(pt.vox[1] || 0),
          Number(pt.vox[2] || 0),
        ]),
      );
      const byVox = fracToPx(fracFromVox);
      if (byVox) return byVox;
    }
    if (Number.isFinite(Number(pt?.sx)) && Number.isFinite(Number(pt?.sy))) {
      return {
        x: Number(pt.sx) * canvas.width,
        y: Number(pt.sy) * canvas.height,
      };
    }
    return {
      x: Number(pt?.x || 0) * canvas.width,
      y: Number(pt?.y || 0) * canvas.height,
    };
  };

  const toVoxPoint = (pt, paneKey = null) => {
    if (isVec3Like(pt?.vox)) {
      return [
        Math.round(Number(pt.vox[0] || 0)),
        Math.round(Number(pt.vox[1] || 0)),
        Math.round(Number(pt.vox[2] || 0)),
      ];
    }
    const resolvedPaneKey = paneKey || pt?.paneKey || null;
    const nv = resolvedPaneKey ? getPaneNv(resolvedPaneKey) : null;
    const frac = resolveFracForNv(nv, pt?.frac, resolvedPaneKey);
    if (nv && frac && typeof nv.frac2vox === "function") {
      const rawVox = nv.frac2vox([
        Number(frac[0] || 0),
        Number(frac[1] || 0),
        Number(frac[2] || 0),
      ]);
      const resolved = resolveVoxForNv(nv, rawVox, resolvedPaneKey);
      if (resolved) {
        return [
          Math.round(Number(resolved[0] || 0)),
          Math.round(Number(resolved[1] || 0)),
          Math.round(Number(resolved[2] || 0)),
        ];
      }
    }
    return null;
  };

  const pointDistancePx = (a, b, canvas, paneKey = null) => {
    if (!a || !b || !canvas) return Number.POSITIVE_INFINITY;
    const pa = toPxPoint(a, canvas, paneKey);
    const pb = toPxPoint(b, canvas, paneKey);
    if (!pa || !pb) return Number.POSITIVE_INFINITY;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  };

  const isPxNearCanvas = (pt, canvas, margin = 24) => {
    if (!pt || !canvas) return false;
    const x = Number(pt.x);
    const y = Number(pt.y);
    const width = Math.max(1, Number(canvas.width || 1));
    const height = Math.max(1, Number(canvas.height || 1));
    return (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= -margin &&
      x <= width + margin &&
      y >= -margin &&
      y <= height + margin
    );
  };

  const shouldResetDraftForCanvas = (points, canvas, paneKey) => {
    if (!Array.isArray(points) || !points.length || !canvas) return false;
    const firstPx = toPxPoint(points[0], canvas, paneKey);
    const lastPx = toPxPoint(points[points.length - 1], canvas, paneKey);
    return (
      !isPxNearCanvas(firstPx, canvas) || !isPxNearCanvas(lastPx, canvas)
    );
  };

  const canvasPosToVox = (paneKey, pt, canvas = null) => {
    const nv = getPaneNv(paneKey);
    if (!nv || !pt) return null;
    const dpr = nv.uiData?.dpr || 1;
    const nvPos = mapOverlayPxToNvCanvasPos(paneKey, pt, canvas);
    if (!nvPos) return null;
    const frac = resolveFracForNv(
      nv,
      nv.canvasPos2frac([nvPos.x * dpr, nvPos.y * dpr]),
      paneKey,
    );
    if (!frac) return null;
    const vox = resolveVoxForNv(nv, nv.frac2vox(frac), paneKey);
    if (!vox) return null;
    return [Number(vox[0] || 0), Number(vox[1] || 0), Number(vox[2] || 0)];
  };

  const setCrosshairFromVox = (vox, { redraw = true } = {}) => {
    const primary = getPrimaryNv();
    if (!primary || typeof primary.vox2frac !== "function") return false;
    const frac = primary.vox2frac([
      Number(vox[0] || 0),
      Number(vox[1] || 0),
      Number(vox[2] || 0),
    ]);
    if (!Array.isArray(frac) || frac.length < 3) return false;
    for (const key of getVisiblePaneKeys()) {
      const nv = getPaneNv(key);
      if (!nv?.scene?.crosshairPos) continue;
      nv.scene.crosshairPos[0] = Number(frac[0] || 0);
      nv.scene.crosshairPos[1] = Number(frac[1] || 0);
      nv.scene.crosshairPos[2] = Number(frac[2] || 0);
      if (redraw && typeof nv.drawScene === "function") nv.drawScene();
    }
    if (hasVisibleMarkerWork()) scheduleMarkerRedraw(1);
    return true;
  };

  const getAnnotationFocusVox = (annotation) => {
    if (!annotation || typeof annotation !== "object") return null;
    const paneKey =
      String(annotation?.paneKey || "").trim().toUpperCase() ||
      AX_COR_SAG_TO_PANE[Number(annotation?.axCorSag)] ||
      null;
    const points = Array.isArray(annotation?.points) ? annotation.points : [];
    const voxPoints = points
      .map((pt) => toVoxPoint(pt, paneKey))
      .filter((pt) => Array.isArray(pt) && pt.length >= 3);
    if (voxPoints.length > 0) {
      const center = [0, 0, 0];
      for (const pt of voxPoints) {
        center[0] += Number(pt[0] || 0);
        center[1] += Number(pt[1] || 0);
        center[2] += Number(pt[2] || 0);
      }
      return [
        Math.round(center[0] / voxPoints.length),
        Math.round(center[1] / voxPoints.length),
        Math.round(center[2] / voxPoints.length),
      ];
    }
    const axCorSag = Number(annotation?.axCorSag);
    const sliceIndex = Number(annotation?.sliceIndex);
    if (!Number.isInteger(axCorSag) || !Number.isInteger(sliceIndex)) return null;
    const axis = axCorSag === 0 ? 2 : axCorSag === 1 ? 1 : 0;
    const primary = getPrimaryNv();
    const currentFrac = primary?.scene?.crosshairPos;
    const currentVox =
      primary &&
      Array.isArray(currentFrac) &&
      typeof primary.frac2vox === "function"
        ? resolveVoxForNv(primary, primary.frac2vox(currentFrac))
        : null;
    const base = Array.isArray(currentVox) && currentVox.length >= 3 ? [...currentVox] : [0, 0, 0];
    base[axis] = Number(sliceIndex);
    return [
      Math.round(Number(base[0] || 0)),
      Math.round(Number(base[1] || 0)),
      Math.round(Number(base[2] || 0)),
    ];
  };

  const crosshairEquals = (a, b, epsilon = 1e-6) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3)
      return false;
    for (let i = 0; i < 3; i += 1) {
      if (Math.abs(Number(a[i] || 0) - Number(b[i] || 0)) > epsilon)
        return false;
    }
    return true;
  };

  const normalizeCrosshair = (crosshair) => {
    if (!Array.isArray(crosshair) || crosshair.length < 3) return null;
    const next = [0, 1, 2].map((axis) =>
      clamp(Number(crosshair[axis] || 0), 0, 1),
    );
    return next.every((value) => Number.isFinite(value)) ? next : null;
  };

  const applyManualCrosshairSync = (sourcePaneKey, crosshair) => {
    const nextCrosshair = normalizeCrosshair(crosshair);
    if (!nextCrosshair || syncingLocationRef.current) return false;
    syncingLocationRef.current = true;
    let changed = false;
    try {
      for (const key of getVisiblePaneKeys()) {
        if (key === sourcePaneKey) continue;
        const nv = getPaneNv(key);
        if (
          !nv?.scene?.crosshairPos ||
          crosshairEquals(nv.scene.crosshairPos, nextCrosshair)
        )
          continue;
        nv.scene.crosshairPos[0] = nextCrosshair[0];
        nv.scene.crosshairPos[1] = nextCrosshair[1];
        nv.scene.crosshairPos[2] = nextCrosshair[2];
        nv.drawScene?.();
        changed = true;
      }
    } finally {
      syncingLocationRef.current = false;
    }
    return changed;
  };

  const scheduleCrosshairSync = (sourcePaneKey) => {
    const sourceNv = getPaneNv(sourcePaneKey);
    const crosshair = normalizeCrosshair(sourceNv?.scene?.crosshairPos);
    if (!crosshair) return;
    pendingCrosshairSyncRef.current = { sourcePaneKey, crosshair };
    if (crosshairSyncRafRef.current !== null) return;
    crosshairSyncRafRef.current = requestAnimationFrame(() => {
      crosshairSyncRafRef.current = null;
      const pending = pendingCrosshairSyncRef.current;
      pendingCrosshairSyncRef.current = null;
      if (!pending) return;
      applyManualCrosshairSync(pending.sourcePaneKey, pending.crosshair);
    });
  };

  const getBrushLabelValue = () =>
    toolRef.current === "clearLabel"
      ? 0
      : Number(activeLabelValueRef.current || 1);

  const ensureDrawingBitmap = () => {
    const bitmap = getSharedBitmap();
    if (bitmap) return true;
    const primary = getPrimaryNv();
    if (!primary) return false;
    primary.createEmptyDrawing?.();
    const dimsInfo = getDrawingDimsInfo(primary);
    const next =
      primary.drawBitmap?.length === dimsInfo?.voxelCount
        ? new Uint8Array(primary.drawBitmap)
        : new Uint8Array(dimsInfo?.voxelCount || 0);
    return applySharedBitmap(next, { refresh: false });
  };

  const drawBrushAt = (vox, axCorSag, shape, size, labelValue) => {
    const nv = getPrimaryNv();
    if (!nv || !nv.drawBitmap) return false;
    const dims = nv.back?.dims;
    const nx = Number(dims?.[1] || 0);
    const ny = Number(dims?.[2] || 0);
    const nz = Math.max(1, Number(dims?.[3] || 1));
    if (nx < 1 || ny < 1 || nz < 1) return false;
    const center = [Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2])];
    const radius = Math.max(1, Math.round(size / 2));
    const fillLabel = Math.max(0, Math.min(255, Number(labelValue || 0)));
    const fixedAxis = axCorSag === 0 ? 2 : axCorSag === 1 ? 1 : 0;
    const axes = [0, 1, 2].filter((axis) => axis !== fixedAxis);
    const hAxis = axes[0];
    const vAxis = axes[1];
    const xy = nx * ny;
    let changed = false;
    for (let dv = -radius; dv <= radius; dv += 1) {
      for (let dh = -radius; dh <= radius; dh += 1) {
        if (shape !== "square" && Math.hypot(dh, dv) > radius) continue;
        const coords = [...center];
        coords[hAxis] = center[hAxis] + dh;
        coords[vAxis] = center[vAxis] + dv;
        const x = coords[0];
        const y = coords[1];
        const z = coords[2];
        if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue;
        const idx = z * xy + y * nx + x;
        if (nv.drawBitmap[idx] !== fillLabel) {
          nv.drawBitmap[idx] = fillLabel;
          changed = true;
        }
      }
    }
    if (changed) invalidateLabelAnalysis();
    return changed;
  };

  const drawBrushLine = (vox1, vox2, axCorSag, shape, size, labelValue) => {
    const dist = Math.sqrt(
      (vox2[0] - vox1[0]) ** 2 +
        (vox2[1] - vox1[1]) ** 2 +
        (vox2[2] - vox1[2]) ** 2,
    );
    const steps = Math.max(1, Math.ceil(dist));
    let changed = false;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const vox = [
        vox1[0] + (vox2[0] - vox1[0]) * t,
        vox1[1] + (vox2[1] - vox1[1]) * t,
        vox1[2] + (vox2[2] - vox1[2]) * t,
      ];
      if (drawBrushAt(vox, axCorSag, shape, size, labelValue)) changed = true;
    }
    return changed;
  };

  const drawAnnotation = (ctx, canvas, annotation, paneKey) => {
    const points = (annotation?.points || [])
      .map((p) => {
        if (
          annotation?.closed !== true &&
          Number.isFinite(Number(p?.px)) &&
          Number.isFinite(Number(p?.py))
        ) {
          return {
            x: Number(p.px),
            y: Number(p.py),
          };
        }
        return toPxPoint(p, canvas, paneKey);
      })
      .filter(Boolean);
    if (!points.length) return;
    const annotationIndex = Number(annotation?.__annotationIndex ?? -1);
    const isSelected =
      Number.isInteger(annotationIndex) &&
      annotationIndex >= 0 &&
      Number(selectedAnnotationIndexRef.current) === annotationIndex;
    ctx.save();
    ctx.strokeStyle = isSelected
      ? "rgba(250, 204, 21, 0.98)"
      : annotation.color || "rgba(147, 197, 253, 0.95)";
    ctx.fillStyle = annotation.color || "rgba(147, 197, 253, 0.95)";
    ctx.lineWidth = isSelected ? 3.2 : 1.8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (points.length === 1) {
      const pt = points[0];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1)
      ctx.lineTo(points[i].x, points[i].y);
    if (
      annotation.type === "freehand" &&
      annotation.closed &&
      points.length >= 3
    ) {
      ctx.closePath();
      ctx.save();
      ctx.fillStyle = hexToRgba(annotation.color || "#93c5fd", 0.45);
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();
    if (
      annotation.type === "freehand" &&
      !annotation.closed &&
      points.length >= 2
    ) {
      const first = points[0];
      const last = points[points.length - 1];
      ctx.save();
      ctx.fillStyle = annotation.nearClosed
        ? annotation.closeColor || getCurrentAnnotationColor()
        : annotation.color || FREEHAND_OPEN_COLOR;
      ctx.beginPath();
      ctx.arc(first.x, first.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(last.x, last.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      if (annotation.nearClosed) {
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(first.x, first.y);
        ctx.strokeStyle = annotation.closeColor || getCurrentAnnotationColor();
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  };

  const drawStrokeMarkersNow = () => {
    for (const paneKey of PANE_ORDER) {
      const markerCanvas = getPaneMarkerCanvas(paneKey);
      if (!markerCanvas) continue;
      const ctx = markerCanvas.getContext("2d");
      if (!ctx) continue;
      ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height);
      if (
        !visiblePaneKeysRef.current.includes(paneKey) ||
        !PANE_CONFIGS[paneKey].is2D
      )
        continue;
      const current = getCurrentAnnotations();
      for (let annotationIndex = 0; annotationIndex < current.length; annotationIndex += 1) {
        const annotation = {
          ...(current[annotationIndex] || {}),
          __annotationIndex: annotationIndex,
        };
        if (annotation?.type !== "freehand") continue;
        if (AX_COR_SAG_TO_PANE[Number(annotation?.axCorSag)] !== paneKey)
          continue;
        const currentSlice = getPaneCurrentSliceIndex(paneKey);
        const sliceIndex = Number(annotation?.sliceIndex);
        if (
          Number.isInteger(sliceIndex) &&
          Number.isInteger(currentSlice) &&
          currentSlice !== sliceIndex
        )
          continue;
        if (annotation?.renderOnMarker === false) continue;
        drawAnnotation(ctx, markerCanvas, annotation, paneKey);
      }
      const draft = annotationDraftRef.current;
      if (draft && AX_COR_SAG_TO_PANE[Number(draft?.axCorSag)] === paneKey) {
        const currentSlice = getPaneCurrentSliceIndex(paneKey);
        const sliceIndex = Number(draft?.sliceIndex);
        if (
          !Number.isInteger(sliceIndex) ||
          !Number.isInteger(currentSlice) ||
          currentSlice === sliceIndex
        ) {
          drawAnnotation(ctx, markerCanvas, draft, paneKey);
        }
      }
    }
  };

  const hasVisibleMarkerWork = () => {
    if (annotationDraftRef.current) return true;
    const annotations = getCurrentAnnotations();
    return annotations.some(
      (annotation) =>
        annotation?.type === "freehand" && annotation?.renderOnMarker !== false,
    );
  };

  const drawStrokeMarkers = (immediate = false) => {
    if (immediate) {
      if (markerDrawRafRef.current !== null) {
        cancelAnimationFrame(markerDrawRafRef.current);
        markerDrawRafRef.current = null;
      }
      drawStrokeMarkersNow();
      return;
    }
    if (markerDrawRafRef.current !== null) return;
    markerDrawRafRef.current = requestAnimationFrame(() => {
      markerDrawRafRef.current = null;
      drawStrokeMarkersNow();
    });
  };

  const redrawPaneDrawing = (paneKey) => {
    const nv = getPaneNv(paneKey);
    if (!nv) return false;
    if (
      hasRefreshableDrawingBitmap(nv) &&
      typeof nv.refreshDrawing === "function"
    ) {
      nv.refreshDrawing(false);
    }
    if (typeof nv.drawScene === "function") nv.drawScene();
    return true;
  };

  const syncPaneLayoutNow = (paneKey) => {
    const nv = getPaneNv(paneKey);
    if (!nv) return false;
    nv.resizeListener?.();
    syncMarkerCanvasSize(paneKey);
    applyPaneBounds(paneKey);
    const rebound = syncSharedBitmapBindings();
    if (rebound && hasRefreshableDrawingBitmap(nv)) {
      nv.refreshDrawing?.(false);
    }
    nv.drawScene?.();
    return true;
  };

  const schedulePaneLayoutSync = (
    paneKeys = getVisiblePaneKeys(),
    { redrawMarkers = true } = {},
  ) => {
    const targetKeys = Array.isArray(paneKeys)
      ? paneKeys.filter((key) => !!getPaneNv(key))
      : getVisiblePaneKeys();
    if (!targetKeys.length) return;
    if (paneLayoutSyncRafRef.current !== null) {
      cancelAnimationFrame(paneLayoutSyncRafRef.current);
      paneLayoutSyncRafRef.current = null;
    }
    paneLayoutSyncRafRef.current = requestAnimationFrame(() => {
      paneLayoutSyncRafRef.current = requestAnimationFrame(() => {
        paneLayoutSyncRafRef.current = null;
        for (const key of targetKeys) syncPaneLayoutNow(key);
        const rebound = syncSharedBitmapBindings();
        if (rebound) {
          for (const key of targetKeys) redrawPaneDrawing(key);
        }
        if (redrawMarkers) drawStrokeMarkers(true);
      });
    });
  };

  const withTemporarySliceNudge = (paneKey, targetVox, run) => {
    const cfg = PANE_CONFIGS[paneKey];
    const nv = getPaneNv(paneKey);
    if (!cfg?.is2D || !nv?.scene?.crosshairPos) return false;
    const dims = nv.back?.dims;
    const dimLen = Number(dims?.[cfg.fixedAxis + 1] || 0);
    if (dimLen < 2) return false;
    const prev = [...nv.scene.crosshairPos];
    const currentIndex = Number.isFinite(Number(targetVox?.[cfg.fixedAxis]))
      ? Math.max(
          0,
          Math.min(dimLen - 1, Math.round(Number(targetVox[cfg.fixedAxis]))),
        )
      : getPaneCurrentSliceIndex(paneKey);
    if (!Number.isInteger(currentIndex)) return false;
    const altIndex =
      currentIndex < dimLen - 1 ? currentIndex + 1 : currentIndex - 1;
    nv.scene.crosshairPos[cfg.fixedAxis] = altIndex / Math.max(1, dimLen - 1);
    run?.();
    nv.scene.crosshairPos[0] = prev[0];
    nv.scene.crosshairPos[1] = prev[1];
    nv.scene.crosshairPos[2] = prev[2];
    run?.();
    return true;
  };

  const refreshDrawingAcrossPanes = ({
    reason = "commit",
    sourcePaneKey = null,
    targetVox = null,
  } = {}) => {
    const startedAt =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const runtime = runtimeEnvRef.current || {};
    const perfProfile = getViewerPerfProfile();
    const refreshPolicy = runtime.refreshPolicy || {};
    const configuredMaxTier =
      reason === "stroke" || reason === "load"
        ? 1
        : Math.max(1, Math.min(3, Number(refreshPolicy.maxTier || 1)));
    const budgetMs = Math.max(
      40,
      Math.min(100, Number(runtime.refreshBudgetMs || 100)),
    );
    const perfState = refreshPerfRef.current || { emaMs: 0, samples: 0 };
    let effectiveMaxTier = configuredMaxTier;
    if (Number(perfState.emaMs || 0) > 32) effectiveMaxTier = 1;
    else if (Number(perfState.emaMs || 0) > 20)
      effectiveMaxTier = Math.min(effectiveMaxTier, 2);
    const tiers = [];
    const visibleKeys = getVisiblePaneKeys();
    let redrawKeys = visibleKeys;
    if (reason === "stroke") {
      if (perfProfile.strokeRefreshTarget === "source-only" && sourcePaneKey) {
        redrawKeys = visibleKeys.filter((key) => key === sourcePaneKey);
      } else {
        redrawKeys = visibleKeys.filter((key) => PANE_CONFIGS[key]?.is2D);
      }
    }
    if (!redrawKeys.length && sourcePaneKey) redrawKeys = [sourcePaneKey];
    for (const key of redrawKeys) redrawPaneDrawing(key);
    tiers.push("standard");
    const nowMs =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const withinBudget = () => {
      const currentNow =
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      return currentNow - startedAt < budgetMs;
    };
    const refresh2DKeys = visibleKeys.filter((key) => PANE_CONFIGS[key]?.is2D);
    const preferredPane =
      sourcePaneKey && PANE_CONFIGS[sourcePaneKey]?.is2D
        ? sourcePaneKey
        : refresh2DKeys[0] || null;
    if (
      reason === "commit" &&
      effectiveMaxTier >= 2 &&
      preferredPane &&
      withinBudget()
    ) {
      if (
        withTemporarySliceNudge(preferredPane, targetVox, () =>
          redrawPaneDrawing(preferredPane),
        )
      ) {
        tiers.push("perturb");
      }
    }
    if (
      reason === "commit" &&
      effectiveMaxTier >= 3 &&
      refresh2DKeys.length > 0 &&
      withinBudget()
    ) {
      let nudged = false;
      const snapshots = refresh2DKeys
        .map((key) => {
          const nv = getPaneNv(key);
          return nv?.scene?.crosshairPos
            ? { key, crosshair: [...nv.scene.crosshairPos] }
            : null;
        })
        .filter(Boolean);
      for (const key of refresh2DKeys) {
        const cfg = PANE_CONFIGS[key];
        const nv = getPaneNv(key);
        const dims = nv?.back?.dims;
        const dimLen = Number(dims?.[cfg.fixedAxis + 1] || 0);
        const currentIndex = getPaneCurrentSliceIndex(key);
        if (
          !nv?.scene?.crosshairPos ||
          dimLen < 2 ||
          !Number.isInteger(currentIndex)
        )
          continue;
        const altIndex =
          currentIndex < dimLen - 1 ? currentIndex + 1 : currentIndex - 1;
        nv.scene.crosshairPos[cfg.fixedAxis] =
          altIndex / Math.max(1, dimLen - 1);
        nudged = true;
      }
      if (nudged) {
        for (const key of refresh2DKeys) redrawPaneDrawing(key);
        for (const snapshot of snapshots) {
          const nv = getPaneNv(snapshot.key);
          if (!nv?.scene?.crosshairPos) continue;
          nv.scene.crosshairPos[0] = snapshot.crosshair[0];
          nv.scene.crosshairPos[1] = snapshot.crosshair[1];
          nv.scene.crosshairPos[2] = snapshot.crosshair[2];
        }
        for (const key of refresh2DKeys) redrawPaneDrawing(key);
        tiers.push("simulated-slice-switch");
      }
    }
    if (hasVisibleMarkerWork()) scheduleMarkerRedraw(1);
    const finishedAt =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const durationMs = Math.round((finishedAt - startedAt) * 100) / 100;
    const prevEma = Number(perfState.emaMs || 0);
    const nextEma = prevEma > 0 ? prevEma * 0.8 + durationMs * 0.2 : durationMs;
    refreshPerfRef.current = {
      emaMs: nextEma,
      samples: Math.min(999, Number(perfState.samples || 0) + 1),
    };
    refreshTelemetryRef.current.last = {
      reason,
      strategy: tiers,
      durationMs,
      budgetMs,
      configuredMaxTier,
      effectiveMaxTier,
      emaMs: Math.round(nextEma * 100) / 100,
      sourcePaneKey: sourcePaneKey || null,
    };
    void nowMs;
  };

  const requestDrawingRefresh = (payload = {}) => {
    pendingDrawRefreshPayloadRef.current = payload;
    if (drawRefreshPendingRef.current) return;
    drawRefreshPendingRef.current = true;
    requestAnimationFrame(() => {
      drawRefreshPendingRef.current = false;
      const next = pendingDrawRefreshPayloadRef.current || {};
      pendingDrawRefreshPayloadRef.current = null;
      refreshDrawingAcrossPanes({ reason: "stroke", ...next });
    });
  };

  const rasterizeClosedAnnotationToMask = (normPoints, options = {}) => {
    const { recordHistory = true, emitChange = true, sourcePaneKey = null } =
      options;
    const sourceNv = sourcePaneKey ? getPaneNv(sourcePaneKey) : null;
    const nv = sourceNv || getPrimaryNv();
    if (!nv || !Array.isArray(normPoints) || normPoints.length < 3)
      return false;
    if (!ensureDrawingBitmap()) return false;
    const paneKey = sourcePaneKey || curvePaneKeyRef.current || null;
    const markerCanvas = paneKey ? getPaneMarkerCanvas(paneKey) : null;
    if (!paneKey || !markerCanvas) return false;
    const paneCfg = PANE_CONFIGS[paneKey];
    if (!paneCfg?.is2D || !Number.isInteger(paneCfg.fixedAxis)) return false;
    const currentSliceIndex = getPaneCurrentSliceIndex(paneKey);
    const dims = nv.back?.dims;
    const nx = Number(dims?.[1] || 0);
    const ny = Number(dims?.[2] || 0);
    const nz = Math.max(1, Number(dims?.[3] || 1));
    if (nx < 1 || ny < 1 || nz < 1) return false;

    const fillLabel = Math.max(
      1,
      Math.min(255, Number(activeLabelValueRef.current || 1)),
    );
    const xy = nx * ny;
    let changed = false;
    let changedCount = 0;
    let lastTargetVox = null;

    const setVoxelAt = (vox) => {
      if (!Array.isArray(vox) || vox.length < 3) return;
      const resolved = [
        Math.round(Number(vox[0] || 0)),
        Math.round(Number(vox[1] || 0)),
        Math.round(Number(vox[2] || 0)),
      ];
      if (Number.isInteger(currentSliceIndex)) {
        resolved[paneCfg.fixedAxis] = currentSliceIndex;
      }
      const x = resolved[0];
      const y = resolved[1];
      const z = resolved[2];
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return;
      const idx = z * xy + y * nx + x;
      if (nv.drawBitmap[idx] === fillLabel) return;
      nv.drawBitmap[idx] = fillLabel;
      changed = true;
      changedCount += 1;
      lastTargetVox = [x, y, z];
    };

    ensureBaseSnapshot(nv.drawBitmap);
    const rasterizeByCanvas = () => {
      // Use the exact screen-space polygon the user drew, then map filled pixels
      // back through Niivue's canvas->frac->vox conversion. This stays faithful
      // for focused single-pane views and non-rectangular displayed slices.
      const pxPoints = normPoints
        .map((pt) => {
          if (
            Number.isFinite(Number(pt?.px)) &&
            Number.isFinite(Number(pt?.py))
          ) {
            return {
              x: Number(pt.px),
              y: Number(pt.py),
            };
          }
          if (
            Number.isFinite(Number(pt?.sx)) &&
            Number.isFinite(Number(pt?.sy))
          ) {
            return {
              x: Number(pt.sx) * markerCanvas.width,
              y: Number(pt.sy) * markerCanvas.height,
            };
          }
          return toPxPoint(pt, markerCanvas, paneKey);
        })
        .filter(
          (pt) =>
            pt &&
            Number.isFinite(Number(pt.x)) &&
            Number.isFinite(Number(pt.y)),
        );
      if (pxPoints.length < 3) return false;
      const first = pxPoints[0];
      const last = pxPoints[pxPoints.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) > 0.5) {
        pxPoints.push({ x: first.x, y: first.y });
      }
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const pt of pxPoints) {
        minX = Math.min(minX, Number(pt.x));
        minY = Math.min(minY, Number(pt.y));
        maxX = Math.max(maxX, Number(pt.x));
        maxY = Math.max(maxY, Number(pt.y));
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return false;
      const canvasW = Math.max(1, Math.round(Number(markerCanvas.width || 1)));
      const canvasH = Math.max(1, Math.round(Number(markerCanvas.height || 1)));
      const x0 = clamp(Math.floor(minX) - 1, 0, canvasW - 1);
      const y0 = clamp(Math.floor(minY) - 1, 0, canvasH - 1);
      const x1 = clamp(Math.ceil(maxX) + 1, 0, canvasW - 1);
      const y1 = clamp(Math.ceil(maxY) + 1, 0, canvasH - 1);
      if (x1 < x0 || y1 < y0) return false;
      const tmpCanvas = document.createElement("canvas");
      const supersample = 4;
      tmpCanvas.width = (x1 - x0 + 1) * supersample;
      tmpCanvas.height = (y1 - y0 + 1) * supersample;
      const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
      if (!tmpCtx) return false;
      tmpCtx.clearRect(0, 0, tmpCanvas.width, tmpCanvas.height);
      tmpCtx.beginPath();
      tmpCtx.moveTo(
        (pxPoints[0].x - x0) * supersample,
        (pxPoints[0].y - y0) * supersample,
      );
      for (let i = 1; i < pxPoints.length; i += 1) {
        tmpCtx.lineTo(
          (pxPoints[i].x - x0) * supersample,
          (pxPoints[i].y - y0) * supersample,
        );
      }
      tmpCtx.closePath();
      tmpCtx.fillStyle = "#ffffff";
      tmpCtx.fill();
      tmpCtx.strokeStyle = "#ffffff";
      tmpCtx.lineWidth = 1.25 * supersample;
      tmpCtx.stroke();
      const alpha = tmpCtx.getImageData(
        0,
        0,
        tmpCanvas.width,
        tmpCanvas.height,
      ).data;
      for (let py = 0; py < tmpCanvas.height; py += 1) {
        const rowOffset = py * tmpCanvas.width * 4;
        for (let px = 0; px < tmpCanvas.width; px += 1) {
          const a = Number(alpha[rowOffset + px * 4 + 3] || 0);
          if (a < 8) continue;
          const vox = canvasPosToVox(
            paneKey,
            {
              x: x0 + (px + 0.5) / supersample,
              y: y0 + (py + 0.5) / supersample,
            },
            markerCanvas,
          );
          setVoxelAt(vox);
        }
      }
      return true;
    };

    if (!rasterizeByCanvas()) return false;

    if (!changed) return false;
    if (isViewerDebugEnabled()) {
      console.info("[Viewer2D] freehand-rasterize-result", {
        paneKey,
        changedCount,
        lastTargetVox,
      });
    }
    invalidateLabelAnalysis();
    refreshDrawingAcrossPanes({
      reason: "commit",
      sourcePaneKey: paneKey,
      targetVox: lastTargetVox,
    });
    const pushed = pushSnapshot(nv.drawBitmap);
    if (pushed && recordHistory) {
      const imageKey = getImageKey();
      if (imageKey) actionHistoryRef.current.push({ type: "mask", imageKey });
    }
    if (emitChange) emitDrawingChange("draw");
    return true;
  };

  const getWindowInfo = (nv = getPrimaryNv()) => {
    const vol = nv?.volumes?.[0];
    const calMin = Number(vol?.cal_min);
    const calMax = Number(vol?.cal_max);
    if (
      !Number.isFinite(calMin) ||
      !Number.isFinite(calMax) ||
      calMax <= calMin
    ) {
      return { calMin: null, calMax: null, ww: null, wl: null };
    }
    const ww = calMax - calMin;
    const wl = (calMax + calMin) * 0.5;
    return {
      calMin: toFixedNum(calMin, 2),
      calMax: toFixedNum(calMax, 2),
      ww: toFixedNum(ww, 2),
      wl: toFixedNum(wl, 2),
    };
  };

  const logViewerDiagnostics = (stage, extra = {}) => {
    if (!isViewerDebugEnabled()) return;
    const panes = {};
    for (const key of getVisiblePaneKeys()) {
      const nv = getPaneNv(key);
      const canvas = getPaneCanvas(key);
      if (!nv) continue;
      panes[key] = {
        canvas: {
          width: Number(canvas?.width || 0),
          height: Number(canvas?.height || 0),
        },
        dims: Array.isArray(nv?.back?.dims)
          ? [nv.back.dims[1], nv.back.dims[2], nv.back.dims[3]]
          : null,
        crosshairPos: Array.isArray(nv?.scene?.crosshairPos)
          ? [
              toFixedNum(nv.scene.crosshairPos[0], 4),
              toFixedNum(nv.scene.crosshairPos[1], 4),
              toFixedNum(nv.scene.crosshairPos[2], 4),
            ]
          : null,
        pan2Dxyzmm: Array.isArray(nv?.scene?.pan2Dxyzmm)
          ? [
              toFixedNum(nv.scene.pan2Dxyzmm[0], 4),
              toFixedNum(nv.scene.pan2Dxyzmm[1], 4),
              toFixedNum(nv.scene.pan2Dxyzmm[2], 4),
              toFixedNum(nv.scene.pan2Dxyzmm[3], 4),
            ]
          : null,
        sliceType: key,
        window: getWindowInfo(nv),
        orientation: getOrientationInfoFromVolume(nv?.volumes?.[0]),
      };
    }
    console.info("[ViewerDiag]", {
      stage,
      imageId: String(image?.id || ""),
      imageName: image?.displayName || image?.name || "",
      panes,
      windowSource: extra?.windowSource || null,
      refresh: refreshTelemetryRef.current?.last || null,
    });
  };

  const applyToolSettings = (currentTool) => {
    for (const key of PANE_ORDER) {
      const nv = getPaneNv(key);
      if (!nv) continue;
      const showCrosshair = key === "R" ? true : currentTool === "pan";
      nv.setCrosshairVisible?.(showCrosshair);
      if (nv.opts) nv.opts.show3Dcrosshair = key === "R";
      if (
        typeof nv.setCrosshairWidth === "function" &&
        Number.isFinite(crosshairWidthRef.current)
      ) {
        nv.setCrosshairWidth(showCrosshair ? crosshairWidthRef.current : 0);
      }
      nv.setDrawingEnabled?.(false);
      if (currentTool === "pan") {
        nv.setDragMode?.(key === "R" ? "slicer3D" : "pan");
      } else {
        nv.setDragMode?.("none");
      }
      nv.drawScene?.();
    }
  };

  const applyDrawColormap = () => {
    const entries = [
      { value: 0, name: "", color: "#000000" },
      ...labelsRef.current,
    ]
      .map((label) => ({
        value: Math.max(0, Math.min(255, Number(label.value ?? 0))),
        name: label.name ?? "",
        color: label.color ?? "#ff0000",
      }))
      .filter(
        (label, index, arr) =>
          arr.findIndex((l) => l.value === label.value) === index,
      )
      .sort((a, b) => a.value - b.value);
    const toRgb = (hex) => {
      if (typeof hex !== "string") return [255, 0, 0];
      const cleaned = hex.replace("#", "");
      if (cleaned.length !== 6) return [255, 0, 0];
      const r = parseInt(cleaned.slice(0, 2), 16);
      const g = parseInt(cleaned.slice(2, 4), 16);
      const b = parseInt(cleaned.slice(4, 6), 16);
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b))
        return [255, 0, 0];
      return [r, g, b];
    };
    const R = [];
    const G = [];
    const B = [];
    const A = [];
    const I = [];
    const labelNames = [];
    for (const entry of entries) {
      const [r, g, b] = toRgb(entry.color);
      R.push(r);
      G.push(g);
      B.push(b);
      A.push(entry.value === 0 ? 0 : 255);
      I.push(entry.value);
      labelNames.push(entry.name ?? "");
    }
    for (const key of getVisiblePaneKeys()) {
      const nv = getPaneNv(key);
      nv?.setDrawColormap?.({ R, G, B, A, I, labels: labelNames });
    }
  };

  const clearFreehandDraft = () => {
    annotationDraftRef.current = null;
    annotationStepsRef.current = [];
    curvePlaneRef.current = null;
    curvePaneKeyRef.current = null;
    curveSliceIndexRef.current = null;
    freehandDrawingRef.current = false;
  };

  const clearStrokeState = () => {
    activePointerIdRef.current = null;
    activePointerPaneKeyRef.current = null;
    fillActiveRef.current = false;
    lastBrushVoxRef.current = null;
    brushStrokeDirtyRef.current = false;
  };

  const configurePaneSync = () => {
    for (const key of PANE_ORDER) {
      const nv = getPaneNv(key);
      if (!nv) continue;
      nv.broadcastTo?.([], {});
    }
  };

  const initializePaneInstances = async () => {
    if (initializedRef.current) return;
    const canvasesReady = PANE_ORDER.every((key) => !!getPaneCanvas(key));
    if (!canvasesReady) return;
    await Promise.all(
      PANE_ORDER.map(async (key) => {
        const canvas = getPaneCanvas(key);
        if (!canvas) return;
        const perfProfile = getViewerPerfProfile();
        const nv = new Niivue({
          show3Dcrosshair: false,
          logLevel: "error",
          fontColor: [...ORIENTATION_TEXT_COLOR],
          sagittalNoseLeft: SAGITTAL_NOSE_LEFT,
          loadingText: "",
          forceDevicePixelRatio: perfProfile.forceDevicePixelRatio,
        });
        await nv.attachToCanvas(canvas);
        nv.setIsOrientationTextVisible?.(true);
        nv.setShowAllOrientationMarkers?.(true);
        nv.setCornerOrientationText?.(false);
        nv.setSliceMM?.(false);
        nv.setCrosshairColor?.([...THREE_D_CROSSHAIR_COLOR]);
        crosshairWidthRef.current = Math.max(
          THREE_D_CROSSHAIR_MIN_WIDTH,
          Number(nv?.opts?.crosshairWidth || THREE_D_CROSSHAIR_MIN_WIDTH),
        );
        nv.setCrosshairWidth?.(crosshairWidthRef.current);
        nv.setSliceType(getPaneSliceType(nv, key));
        applyPaneBounds(key);
        nv.onLocationChange = () => {
          if (!syncingLocationRef.current) scheduleCrosshairSync(key);
          if (
            curvePaneKeyRef.current &&
            curvePaneKeyRef.current === key &&
            Number.isInteger(curveSliceIndexRef.current)
          ) {
            const currentSlice = getPaneCurrentSliceIndex(key);
            if (
              Number.isInteger(currentSlice) &&
              currentSlice !== curveSliceIndexRef.current
            ) {
              clearFreehandDraft();
            }
          }
          if (hasVisibleMarkerWork()) scheduleMarkerRedraw(1);
        };
        paneNvsRef.current[key] = nv;
        const markerCanvas = getPaneMarkerCanvas(key);
        if (markerCanvas) syncMarkerCanvasSize(key);
        const observer = new ResizeObserver(() => {
          schedulePaneLayoutSync([key], { redrawMarkers: true });
        });
        observer.observe(canvas.parentElement || canvas);
        paneResizeObserversRef.current[key] = observer;
      }),
    );
    initializedRef.current = true;
    nvRef.current = getPrimaryNv();
    configurePaneSync();
    setPanesReady(true);
    applyToolSettings(toolRef.current);
  };

  const loadImageIntoPanes = async () => {
    imageLoadGenerationRef.current += 1;
    const generation = Number(imageLoadGenerationRef.current || 0);
    pruneTemplateCache();
    const imageBuffer = toArrayBuffer(image?.data);
    if (!imageBuffer) return;
    for (const key of PANE_ORDER) {
      const nv = getPaneNv(key);
      nv?.broadcastTo?.([], {});
    }
    const imageCacheKey = `image:${String(image?.id || image?.name || "")}`;
    const baseTemplate = await loadVolumeTemplate({
      cacheKey: imageCacheKey,
      buffer: imageBuffer,
      name: image.name,
      imageMeta: image,
      context: "base",
      allowCache: true,
      generation,
    });

    const sourceName = image?.displayName || image?.sourceName || image?.name;
    const windowRange = !image?.isMaskOnly
      ? resolveAutoWindowRange({
          volume: baseTemplate,
          imageMeta: {
            name: sourceName,
            seriesDescription: image?.dicomSeriesDescription || "",
          },
        })
      : null;
    const hdr = baseTemplate?.hdr;
    const dims = hdr?.dims;
    const is2D = isSingleSliceVolume(hdr);
    const nextVisiblePaneKeys = is2D ? ["A"] : [...PANE_ORDER];
    visiblePaneKeysRef.current = nextVisiblePaneKeys;
    setVisiblePaneKeys(nextVisiblePaneKeys);
    setCanFocusPlanes(!is2D);
    if (is2D && focusedPlane) {
      setFocusedPlane(null);
    }

    for (const key of PANE_ORDER) {
      const nv = getPaneNv(key);
      if (!nv) continue;
      if (nv.volumes?.length) {
        for (const vol of [...nv.volumes]) nv.removeVolume(vol);
      }
      nv.closeDrawing?.();
      nv.scene.crosshairPos[0] = 0.5;
      nv.scene.crosshairPos[1] = 0.5;
      nv.scene.crosshairPos[2] = 0.5;
      if (!nextVisiblePaneKeys.includes(key)) {
        applyPaneBounds(key);
        nv.drawScene?.();
        continue;
      }
      const paneVolume =
        key === getPrimaryPaneKey() ? baseTemplate : baseTemplate.clone();
      if (windowRange) {
        paneVolume.cal_min = Number(windowRange.min);
        paneVolume.cal_max = Number(windowRange.max);
      }
      nv.addVolume(paneVolume);
      nv.setRadiologicalConvention(
        isRasterImageName(sourceName) ? true : !!radiological2D,
      );
      nv.setSliceType(getPaneSliceType(nv, key));
      nv.setSliceMM?.(false);
      applyPaneBounds(key);
      if (PANE_CONFIGS[key]?.is2D) {
        nv.setPan2Dxyzmm?.([...DEFAULT_PAN2D_VIEW]);
      }
      if (key === "R" && !image?.isMaskOnly) {
        nv.setOpacity?.(0, renderMaskOnly3DRef.current ? 0 : 1);
      } else {
        nv.setOpacity?.(0, 1);
      }
      if (image?.isMaskOnly && typeof nv.setColormap === "function") {
        nv.setColormap("itksnap");
      }
    }

    const primary = getPrimaryNv();
    if (!primary) return;
    if (!image?.isMaskOnly && image?.mask && image?.maskAttached !== false) {
      const maskBuffer = toArrayBuffer(image.mask);
      if (maskBuffer) {
        const maskTemplate = await loadVolumeTemplate({
          cacheKey: `mask:${String(image?.id || image?.name || "")}:${String(image?.maskVersion || 0)}`,
          buffer: maskBuffer,
          name: image.maskName || image.name,
          imageMeta: image,
          context: "mask",
          allowCache: true,
          generation,
        });
        primary.loadDrawing(maskTemplate);
      } else {
        primary.createEmptyDrawing?.();
      }
    } else {
      primary.createEmptyDrawing?.();
    }

    const dimsInfo = getDrawingDimsInfo(primary);
    const sharedBitmap =
      primary.drawBitmap?.length === dimsInfo?.voxelCount
        ? new Uint8Array(primary.drawBitmap)
        : new Uint8Array(dimsInfo?.voxelCount || 0);
    applySharedBitmap(sharedBitmap, { refresh: false });
    historyRef.current = { stack: [], index: -1 };
    actionHistoryRef.current = [];
    ensureBaseSnapshot(sharedBitmap);
    configurePaneSync();
    applyDrawColormap();
    applyToolSettings(toolRef.current);
    refreshDrawingAcrossPanes({ reason: "load", sourcePaneKey: "A" });
    logViewerDiagnostics("after-load", {
      windowSource: windowRange?.preset
        ? `preset:${windowRange.preset.id}`
        : windowRange
          ? "volume:auto-range"
          : "none",
    });
    emitDrawingChange("load");
  };

  useImperativeHandle(ref, () => ({
    refreshOverlay: () => {
      drawStrokeMarkers();
      return true;
    },
    toggleFocusPlane: (planeKey) => {
      const normalized = String(planeKey || "")
        .trim()
        .toUpperCase();
      if (!FOCUS_PLANES.includes(normalized) || !canFocusPlanes)
        return focusedPlane;
      const next = focusedPlane === normalized ? null : normalized;
      setFocusedPlane(next);
      requestAnimationFrame(() => {
        for (const key of getVisiblePaneKeys()) syncMarkerCanvasSize(key);
        drawStrokeMarkers(true);
      });
      return next;
    },
    getFocusedPlane: () => focusedPlane,
    zoomToFit: () => {
      for (const key of getVisiblePaneKeys()) {
        const nv = getPaneNv(key);
        if (PANE_CONFIGS[key]?.is2D)
          nv?.setPan2Dxyzmm?.([...DEFAULT_PAN2D_VIEW]);
      }
      requestAnimationFrame(() => {
        for (const key of getVisiblePaneKeys()) redrawPaneDrawing(key);
        drawStrokeMarkers(true);
      });
      return true;
    },
    undoToolAction: () => {
      const currentImageKey = getImageKey();
      if (!currentImageKey) return false;
      const history = historyRef.current;
      const actionHistory = actionHistoryRef.current;
      while (actionHistory.length > 0) {
        const action = actionHistory.pop();
        const actionType = typeof action === "string" ? action : action?.type;
        const actionImageKey =
          typeof action === "string" ? currentImageKey : action?.imageKey;
        if (actionImageKey !== currentImageKey) continue;
        if (actionType === "annotation") {
          const current = getCurrentAnnotations();
          if (!current.length) continue;
          setCurrentAnnotations(current.slice(0, -1));
          drawStrokeMarkers(true);
          emitDrawingChange("undo");
          return true;
        }
        if (actionType === "freehand-complete") {
          const hasMask = !!action?.hasMask;
          if (hasMask && history.index > 0) {
            history.index -= 1;
            applySnapshot(history.stack[history.index]);
          }
          const current = getCurrentAnnotations();
          if (current.length > 0) setCurrentAnnotations(current.slice(0, -1));
          drawStrokeMarkers();
          emitDrawingChange("undo");
          return true;
        }
        if (actionType === "mask") {
          if (history.index <= 0) continue;
          history.index -= 1;
          applySnapshot(history.stack[history.index]);
          emitDrawingChange("undo");
          return true;
        }
      }
      return false;
    },
    clearAnnotations: () => {
      const key = getImageKey();
      if (key) annotationsByImageRef.current.delete(key);
      clearFreehandDraft();
      actionHistoryRef.current = actionHistoryRef.current.filter((item) => {
        const actionType = typeof item === "string" ? item : item?.type;
        const actionImageKey = typeof item === "string" ? key : item?.imageKey;
        return !(
          actionImageKey === key &&
          (actionType === "annotation" || actionType === "freehand-complete")
        );
      });
      drawStrokeMarkers();
      emitDrawingChange("clear");
    },
    undo: () => {
      const history = historyRef.current;
      if (history.index <= 0) return;
      history.index -= 1;
      applySnapshot(history.stack[history.index]);
      emitDrawingChange("undo");
    },
    redo: () => {
      const history = historyRef.current;
      if (history.index >= history.stack.length - 1) return;
      history.index += 1;
      applySnapshot(history.stack[history.index]);
      emitDrawingChange("redo");
    },
    clear: () => {
      const bitmap = getSharedBitmap();
      if (!bitmap) return;
      ensureBaseSnapshot(bitmap);
      const empty = new Uint8Array(bitmap.length);
      const pushed = pushSnapshot(empty);
      if (pushed) {
        const imageKey = getImageKey();
        if (imageKey) actionHistoryRef.current.push({ type: "mask", imageKey });
      }
      applySnapshot(empty);
      emitDrawingChange("clear");
    },
    exportDrawing: async () => {
      const nv = getPrimaryNv();
      if (!nv) return null;
      const result = await nv.saveImage({ filename: "", isSaveDrawing: true });
      return result instanceof Uint8Array ? result : null;
    },
    exportPersistState: () => {
      const dimsInfo = getDrawingDimsInfo();
      const bitmap = getSharedBitmap();
      const primaryVolume = getPrimaryNv()?.volumes?.[0] || null;
      const headerTemplate = cloneHeaderTemplateFromVolume(primaryVolume);
      if (!dimsInfo || !bitmap || bitmap.length !== dimsInfo.voxelCount) {
        return {
          bitmap: null,
          dims: dimsInfo ? [dimsInfo.nx, dimsInfo.ny, dimsInfo.nz] : null,
          hasMask: false,
          headerTemplate,
          overlayAnnotations: cloneAnnotations(getCurrentAnnotations()),
        };
      }
      const nextBitmap = new Uint8Array(bitmap.length);
      let hasMask = false;
      for (let i = 0; i < bitmap.length; i += 1) {
        const value = Number(bitmap[i] || 0);
        nextBitmap[i] = value;
        if (!hasMask && value !== 0) hasMask = true;
      }
      return {
        bitmap: nextBitmap,
        dims: [dimsInfo.nx, dimsInfo.ny, dimsInfo.nz],
        hasMask,
        headerTemplate,
        overlayAnnotations: cloneAnnotations(getCurrentAnnotations()),
      };
    },
    exportAnnotations: () => cloneAnnotations(getCurrentAnnotations()),
    getRefreshDiagnostics: () => ({ ...(refreshTelemetryRef.current || {}) }),
    getAnnotationCount: () => getCurrentAnnotations().length,
    getLabelStats: () => ({ ...(getLabelAnalysis().stats || {}) }),
    jumpToLabel: (labelValue) => {
      const target = Math.max(0, Math.min(255, Number(labelValue || 0)));
      const analysis = getLabelAnalysis();
      const vox =
        analysis?.centroids?.[target] ||
        analysis?.centroids?.[String(target)] ||
        null;
      if (!Array.isArray(vox) || vox.length < 3) return false;
      setCrosshairFromVox(vox, { redraw: true });
      return true;
    },
    jumpToAnnotation: (indexOrAnnotation) => {
      const annotations = getCurrentAnnotations();
      let annotation = null;
      if (
        Number.isInteger(Number(indexOrAnnotation)) &&
        Number(indexOrAnnotation) >= 0 &&
        Number(indexOrAnnotation) < annotations.length
      ) {
        annotation = annotations[Number(indexOrAnnotation)];
      } else if (indexOrAnnotation && typeof indexOrAnnotation === "object") {
        annotation = indexOrAnnotation;
      }
      if (!annotation) return false;
      const paneKey = AX_COR_SAG_TO_PANE[Number(annotation?.axCorSag)] || null;
      if (paneKey && canFocusPlanes) {
        setFocusedPlane(paneKey);
      }
      const vox = getAnnotationFocusVox(annotation);
      if (!Array.isArray(vox) || vox.length < 3) return false;
      return setCrosshairFromVox(vox, { redraw: true });
    },
  }));

  useEffect(() => {
    initializePaneInstances().catch((error) => {
      console.error("Viewer 初始化失败", error);
    });
    return () => {
      if (paneLayoutSyncRafRef.current !== null)
        cancelAnimationFrame(paneLayoutSyncRafRef.current);
      if (crosshairSyncRafRef.current !== null)
        cancelAnimationFrame(crosshairSyncRafRef.current);
      if (markerRedrawRafRef.current !== null)
        cancelAnimationFrame(markerRedrawRafRef.current);
      if (markerDrawRafRef.current !== null)
        cancelAnimationFrame(markerDrawRafRef.current);
      for (const observer of Object.values(paneResizeObserversRef.current)) {
        observer?.disconnect?.();
      }
      volumeTemplateCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    toolRef.current = tool;
    clearFreehandDraft();
    clearStrokeState();
    applyToolSettings(tool);
    drawStrokeMarkers();
  }, [tool]);

  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);

  useEffect(() => {
    brushShapeRef.current = brushShape;
  }, [brushShape]);

  useEffect(() => {
    activeLabelValueRef.current = activeLabelValue;
  }, [activeLabelValue]);

  useEffect(() => {
    labelsRef.current = labels;
    applyDrawColormap();
  }, [labels]);

  useEffect(() => {
    selectedAnnotationIndexRef.current = Number(selectedAnnotationIndex);
    drawStrokeMarkers(true);
  }, [selectedAnnotationIndex]);

  useEffect(() => {
    onDrawingChangeRef.current = onDrawingChange;
  }, [onDrawingChange]);

  useEffect(() => {
    runtimeEnvRef.current = runtimeEnv || null;
  }, [runtimeEnv]);

  useEffect(() => {
    renderMaskOnly3DRef.current = !!renderMaskOnly3D;
    const renderNv = getPaneNv("R");
    if (renderNv?.volumes?.length) {
      renderNv.setOpacity?.(0, renderMaskOnly3D ? 0 : 1);
      renderNv.drawScene?.();
    }
  }, [renderMaskOnly3D]);

  useEffect(() => {
    if (!panesReady || !image?.id || !image?.data) return;
    let cancelled = false;
    imageKeyRef.current = String(image.id);
    annotationsByImageRef.current.set(
      String(image.id),
      cloneAnnotations(image.overlayAnnotations),
    );
    clearFreehandDraft();
    clearStrokeState();
    drawStrokeMarkers();
    loadImageIntoPanes().catch((error) => {
      if (cancelled) return;
      console.error("Viewer 加载影像失败", error);
    });
    return () => {
      cancelled = true;
    };
  }, [panesReady, image?.id, image?.maskVersion, radiological2D]);

  useEffect(() => {
    const cleanups = [];
    for (const paneKey of ["A", "C", "S"]) {
      const canvas = getPaneCanvas(paneKey);
      if (!canvas) continue;
      const getCanvasPos = (event, targetCanvas = canvas) => {
        const rect =
          targetCanvas?.getBoundingClientRect?.() ||
          canvas.getBoundingClientRect();
        const xByRect = Number(event?.clientX) - rect.left;
        const yByRect = Number(event?.clientY) - rect.top;
        if (
          Number.isFinite(xByRect) &&
          Number.isFinite(yByRect) &&
          Number.isFinite(rect?.width) &&
          Number.isFinite(rect?.height) &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          return { x: xByRect, y: yByRect };
        }
        if (
          Number.isFinite(Number(event?.offsetX)) &&
          Number.isFinite(Number(event?.offsetY))
        ) {
          return { x: Number(event.offsetX), y: Number(event.offsetY) };
        }
        return { x: 0, y: 0 };
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const currentTool = toolRef.current;
        if (!isAnnotationTool(currentTool)) return;
        const paneCfg = PANE_CONFIGS[paneKey];
        const markerCanvas = getPaneMarkerCanvas(paneKey);
        if (!markerCanvas) return;
        if (isDisplayedAsSinglePane(paneKey)) {
          syncPaneLayoutNow(paneKey);
        }
        syncMarkerCanvasSize(paneKey);
        const pos = getCanvasPos(event, markerCanvas);
        const norm = toStoredPoint(paneKey, pos, markerCanvas);
        if (currentTool === "freehand") {
          if (!norm) return;
          event.preventDefault();
          const perfProfile = getViewerPerfProfile();
          const currentSliceIndex = getPaneCurrentSliceIndex(paneKey);
          if (!Number.isInteger(currentSliceIndex)) return;
          let nextSteps = [...annotationStepsRef.current];
          if (shouldResetDraftForCanvas(nextSteps, markerCanvas, paneKey)) {
            nextSteps = [];
            clearFreehandDraft();
          }
          if (
            nextSteps.length > 0 &&
            (curvePaneKeyRef.current !== paneKey ||
              curveSliceIndexRef.current !== currentSliceIndex)
          ) {
            nextSteps = [];
          }
          curvePaneKeyRef.current = paneKey;
          curvePlaneRef.current = paneCfg.axCorSag;
          curveSliceIndexRef.current = currentSliceIndex;
          if (nextSteps.length === 0) {
            nextSteps = [norm];
          } else {
            const last = nextSteps[nextSteps.length - 1];
            const distToLast = pointDistancePx(
              last,
              norm,
              markerCanvas,
              paneKey,
            );
            if (distToLast <= FREEHAND_RESUME_PX) {
              if (distToLast > FREEHAND_SAMPLE_STEP_PX)
                nextSteps = [...nextSteps, norm];
            } else {
              nextSteps = [norm];
            }
          }
          annotationStepsRef.current = compactPoints(
            nextSteps,
            MAX_MARKER_POINTS,
          );
          const nearClosed =
            annotationStepsRef.current.length > 2 &&
            pointDistancePx(
              annotationStepsRef.current[0],
              annotationStepsRef.current[annotationStepsRef.current.length - 1],
              markerCanvas,
              paneKey,
            ) <= FREEHAND_CLOSE_PX;
          annotationDraftRef.current = makeFreehandDraft(
            annotationStepsRef.current,
            { nearClosed },
          );
          const vox = canvasPosToVox(paneKey, pos, markerCanvas);
          if (vox)
            setCrosshairFromVox(vox, {
              redraw: perfProfile.liveCrosshairDuringAnnotation,
            });
          freehandDrawingRef.current = true;
          activePointerIdRef.current = event.pointerId;
          activePointerPaneKeyRef.current = paneKey;
          canvas.setPointerCapture?.(event.pointerId);
          drawStrokeMarkers();
          return;
        }
        if (isBrushLikeTool(currentTool)) {
          event.preventDefault();
          if (!ensureDrawingBitmap()) return;
          const vox = canvasPosToVox(paneKey, pos);
          if (!vox) return;
          ensureBaseSnapshot(getSharedBitmap());
          fillAxCorSagRef.current = paneCfg.axCorSag;
          const fixedAxis = paneCfg.fixedAxis;
          const currentSliceIndex = getPaneCurrentSliceIndex(paneKey);
          vox[fixedAxis] = Number.isInteger(currentSliceIndex)
            ? currentSliceIndex
            : Math.round(vox[fixedAxis]);
          activePointerIdRef.current = event.pointerId;
          activePointerPaneKeyRef.current = paneKey;
          canvas.setPointerCapture?.(event.pointerId);
          fillActiveRef.current = true;
          brushStrokeDirtyRef.current = false;
          const brushLabelValue = getBrushLabelValue();
          if (
            drawBrushAt(
              vox,
              paneCfg.axCorSag,
              brushShapeRef.current,
              brushSizeRef.current,
              brushLabelValue,
            )
          ) {
            brushStrokeDirtyRef.current = true;
            setCrosshairFromVox(vox, { redraw: false });
            requestDrawingRefresh({ sourcePaneKey: paneKey, targetVox: vox });
          }
          lastBrushVoxRef.current = [...vox];
        }
      };

      const onPointerMove = (event) => {
        const currentTool = toolRef.current;
        if (currentTool === "freehand") {
          if (!freehandDrawingRef.current) return;
          const perfProfile = getViewerPerfProfile();
          if (
            activePointerIdRef.current !== null &&
            event.pointerId !== activePointerIdRef.current
          )
            return;
          if (activePointerPaneKeyRef.current !== paneKey) return;
          const markerCanvas = getPaneMarkerCanvas(paneKey);
          if (!markerCanvas) return;
          syncMarkerCanvasSize(paneKey);
          const pos = getCanvasPos(event, markerCanvas);
          const currentSliceIndex = getPaneCurrentSliceIndex(paneKey);
          if (
            Number.isInteger(curveSliceIndexRef.current) &&
            Number.isInteger(currentSliceIndex) &&
            curveSliceIndexRef.current !== currentSliceIndex
          )
            return;
          const norm = toStoredPoint(paneKey, pos, markerCanvas);
          if (!norm) return;
          const current = annotationStepsRef.current;
          if (!current.length) {
            annotationStepsRef.current = [norm];
            annotationDraftRef.current = makeFreehandDraft([norm], {
              nearClosed: false,
            });
            drawStrokeMarkers(true);
            return;
          }
          const last = current[current.length - 1];
          const dist = pointDistancePx(last, norm, markerCanvas, paneKey);
          if (dist < FREEHAND_SAMPLE_STEP_PX) return;
          annotationStepsRef.current = compactPoints(
            [...current, norm],
            MAX_MARKER_POINTS,
          );
          const nearClosed =
            annotationStepsRef.current.length > 2 &&
            pointDistancePx(
              annotationStepsRef.current[0],
              annotationStepsRef.current[annotationStepsRef.current.length - 1],
              markerCanvas,
              paneKey,
            ) <= FREEHAND_CLOSE_PX;
          annotationDraftRef.current = makeFreehandDraft(
            annotationStepsRef.current,
            { nearClosed },
          );
          const vox = canvasPosToVox(paneKey, pos, markerCanvas);
          if (vox)
            setCrosshairFromVox(vox, {
              redraw: perfProfile.liveCrosshairDuringAnnotation,
            });
          drawStrokeMarkers(true);
          return;
        }
        if (isBrushLikeTool(currentTool)) {
          if (!fillActiveRef.current) return;
          if (
            activePointerIdRef.current !== null &&
            event.pointerId !== activePointerIdRef.current
          )
            return;
          if (activePointerPaneKeyRef.current !== paneKey) return;
          const pos = getCanvasPos(event);
          const vox = canvasPosToVox(paneKey, pos);
          if (!vox) return;
          const fixedAxis = PANE_CONFIGS[paneKey].fixedAxis;
          const currentSliceIndex = getPaneCurrentSliceIndex(paneKey);
          vox[fixedAxis] = Number.isInteger(currentSliceIndex)
            ? currentSliceIndex
            : Math.round(vox[fixedAxis]);
          if (lastBrushVoxRef.current) {
            const brushLabelValue = getBrushLabelValue();
            if (
              drawBrushLine(
                lastBrushVoxRef.current,
                vox,
                fillAxCorSagRef.current,
                brushShapeRef.current,
                brushSizeRef.current,
                brushLabelValue,
              )
            ) {
              brushStrokeDirtyRef.current = true;
              setCrosshairFromVox(vox, { redraw: false });
              requestDrawingRefresh({ sourcePaneKey: paneKey, targetVox: vox });
            }
          }
          lastBrushVoxRef.current = [...vox];
        }
      };

      const onPointerUp = (event) => {
        const currentTool = toolRef.current;
        if (currentTool === "freehand") {
          if (!freehandDrawingRef.current) return;
          if (
            activePointerIdRef.current !== null &&
            event.pointerId !== activePointerIdRef.current
          )
            return;
          const capturedId = activePointerIdRef.current;
          activePointerIdRef.current = null;
          activePointerPaneKeyRef.current = null;
          freehandDrawingRef.current = false;
          if (capturedId !== null && canvas.hasPointerCapture?.(capturedId)) {
            canvas.releasePointerCapture?.(capturedId);
          }
          const markerCanvas = getPaneMarkerCanvas(paneKey);
          if (markerCanvas && annotationStepsRef.current.length > 0) {
            const nearClosed =
              annotationStepsRef.current.length > 2 &&
              pointDistancePx(
                annotationStepsRef.current[0],
                annotationStepsRef.current[
                  annotationStepsRef.current.length - 1
                ],
                markerCanvas,
                paneKey,
              ) <= FREEHAND_CLOSE_PX;
            annotationDraftRef.current = makeFreehandDraft(
              annotationStepsRef.current,
              { nearClosed },
            );
            drawStrokeMarkers(true);
          }
          return;
        }
        if (isBrushLikeTool(currentTool)) {
          if (
            activePointerIdRef.current !== null &&
            event.pointerId !== activePointerIdRef.current
          )
            return;
          if (activePointerPaneKeyRef.current !== paneKey) return;
          const wasDirty = brushStrokeDirtyRef.current;
          const finalVox = Array.isArray(lastBrushVoxRef.current)
            ? [...lastBrushVoxRef.current]
            : null;
          if (activePointerIdRef.current !== null)
            canvas.releasePointerCapture?.(activePointerIdRef.current);
          activePointerIdRef.current = null;
          activePointerPaneKeyRef.current = null;
          fillActiveRef.current = false;
          const bitmap = getSharedBitmap();
          if (wasDirty && bitmap) {
            const pushed = pushSnapshot(bitmap);
            if (pushed) {
              const imageKey = getImageKey();
              if (imageKey)
                actionHistoryRef.current.push({ type: "mask", imageKey });
            }
            refreshDrawingAcrossPanes({
              reason: "commit",
              sourcePaneKey: paneKey,
              targetVox: finalVox,
            });
            emitDrawingChange("draw");
          }
          brushStrokeDirtyRef.current = false;
          lastBrushVoxRef.current = null;
        }
      };

      const onPointerCancel = () => {
        clearFreehandDraft();
        clearStrokeState();
        drawStrokeMarkers(true);
      };

      const onWheel = () => {
        if (hasVisibleMarkerWork()) scheduleMarkerRedraw(2);
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("wheel", onWheel, { passive: true });
      cleanups.push(() => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("wheel", onWheel);
      });
    }

    const onKeyDown = (event) => {
      if (event.key !== "Enter") return;
      if (
        toolRef.current !== "freehand" ||
        annotationStepsRef.current.length <= 2
      )
        return;
      event.preventDefault();
      const paneKey = curvePaneKeyRef.current;
      const markerCanvas = paneKey ? getPaneMarkerCanvas(paneKey) : null;
      if (!paneKey || !markerCanvas) return;
      if (isDisplayedAsSinglePane(paneKey)) {
        syncPaneLayoutNow(paneKey);
      }
      const rawPoints = [...annotationStepsRef.current];
      const first = rawPoints[0];
      const last = rawPoints[rawPoints.length - 1];
      const isNearClosed =
        pointDistancePx(first, last, markerCanvas, paneKey) <=
        FREEHAND_CLOSE_PX;
      const closedPoints = [...rawPoints];
      if (
        !isNearClosed ||
        pointDistancePx(first, last, markerCanvas, paneKey) > 1e-3
      ) {
        closedPoints.push(first);
      } else {
        closedPoints[closedPoints.length - 1] = first;
      }
      const maskChanged = rasterizeClosedAnnotationToMask(closedPoints, {
        recordHistory: false,
        emitChange: true,
        axCorSag: curvePlaneRef.current,
        sliceIndex: curveSliceIndexRef.current,
        sourcePaneKey: paneKey,
      });
      if (!maskChanged) {
        drawStrokeMarkers(true);
        return;
      }
      addAnnotation(
        {
          type: "freehand",
          points: closedPoints,
          label: "",
          color: getCurrentAnnotationColor(),
          closed: true,
          renderOnMarker: false,
          axCorSag: curvePlaneRef.current,
          paneKey,
          sliceIndex: curveSliceIndexRef.current,
        },
        { recordHistory: false, emitChange: false },
      );
      const imageKey = getImageKey();
      if (imageKey) {
        actionHistoryRef.current.push({
          type: "freehand-complete",
          imageKey,
          hasMask: maskChanged,
        });
      }
      clearFreehandDraft();
      drawStrokeMarkers(true);
      emitDrawingChange("curve-complete");
    };

    window.addEventListener("keydown", onKeyDown);
    cleanups.push(() => window.removeEventListener("keydown", onKeyDown));

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [panesReady]);

  useEffect(() => {
    if (!panesReady) return;
    clearFreehandDraft();
    clearStrokeState();
    schedulePaneLayoutSync(getVisiblePaneKeys(), { redrawMarkers: true });
  }, [panesReady, focusedPlane, visiblePaneKeys]);

  const canShowPlaneSwitch = !!image && canFocusPlanes;
  const showPlaneButtonsByPane = canShowPlaneSwitch && !focusedPlane;
  const showPlaneButtonsStack = canShowPlaneSwitch && !!focusedPlane;
  const planeButtonStyles = {
    S: {
      left: "calc(100% - 18px)",
      top: "25%",
      transform: "translate(-50%, -50%)",
    },
    A: { left: "50%", top: "75%", transform: "translate(-50%, -50%)" },
    C: { left: "50%", top: "25%", transform: "translate(-50%, -50%)" },
  };

  const containerClassNames = [
    "viewer-container",
    visiblePaneKeys.length === 1 ? "single-pane" : "quad-pane",
    visiblePaneKeys.length === 1 && visiblePaneKeys[0] === "A" ? "mode-2d" : "",
    focusedPlane ? `focus-${focusedPlane}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={rootRef} className={containerClassNames}>
      <div className="viewer-pane-grid">
        {PANE_ORDER.map((paneKey) => {
          const visible = visiblePaneKeys.includes(paneKey);
          const isFocused = focusedPlane ? focusedPlane === paneKey : false;
          const className = [
            "viewer-pane",
            `viewer-pane-${paneKey}`,
            visible ? "visible" : "hidden",
            focusedPlane ? (isFocused ? "focused" : "focus-hidden") : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={paneKey} className={className} data-pane={paneKey}>
              <div className="viewer-pane-inner">
                <canvas
                  ref={setPaneCanvasRef(paneKey)}
                  className="viewer-pane-canvas"
                />
                {PANE_CONFIGS[paneKey].is2D && (
                  <canvas
                    ref={setPaneMarkerCanvasRef(paneKey)}
                    className="viewer-marker-canvas"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {showPlaneButtonsByPane && (
        <div
          className="viewer-plane-switch-pane"
          role="group"
          aria-label="视口切换"
        >
          {FOCUS_PLANES.map((plane) => (
            <button
              key={plane}
              type="button"
              className="viewer-plane-btn viewer-plane-btn-pane"
              style={planeButtonStyles[plane]}
              onClick={() => setFocusedPlane(plane)}
              title={`切换 ${plane} 到主视口`}
              aria-label={`切换 ${plane} 到主视口`}
            >
              {plane}
            </button>
          ))}
        </div>
      )}
      {showPlaneButtonsStack && (
        <div className="viewer-plane-switch" role="group" aria-label="视口切换">
          {FOCUS_PLANES.map((plane) => {
            const active = focusedPlane === plane;
            return (
              <button
                key={plane}
                type="button"
                className={`viewer-plane-btn${active ? " active" : ""}`}
                onClick={() => setFocusedPlane(active ? null : plane)}
                title={active ? "返回四视口" : `切换 ${plane} 到主视口`}
                aria-label={
                  active
                    ? `返回四视口（当前 ${plane}）`
                    : `切换 ${plane} 到主视口`
                }
              >
                {active ? "▣" : plane}
              </button>
            );
          })}
        </div>
      )}
      {!image && <div className="empty">上传 .nii/.nii.gz 或 .zip 开始</div>}
    </div>
  );
});

export default ViewerPublicApi;
