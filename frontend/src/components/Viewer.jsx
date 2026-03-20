import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Niivue, NVImage } from '@niivue/niivue'
import { resolveAutoWindowRange } from '../utils/windowPresets.js'

const isRasterImageName = (name) => /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(name || '')
const MASK_TOOLS = new Set(['eraser'])
const ANNOTATION_TOOLS = new Set([
  'freehand',
  'brush'
])
const FOCUS_PLANES = ['A', 'S', 'C']

const isAnnotationTool = (tool) => ANNOTATION_TOOLS.has(tool)
const toArrayBuffer = (data) => {
  if (!data) return null
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    const view = data
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
  }
  return null
}

const THREE_D_CROSSHAIR_COLOR = [0.23, 0.56, 1.0, 1.0]
const THREE_D_CROSSHAIR_MIN_WIDTH = 2

const formatNumber = (value, digits = 1) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--'
  return num.toFixed(digits)
}

const hexToRgba = (hex, alpha = 0.45) => {
  const cleaned = String(hex || '').replace('#', '')
  if (cleaned.length !== 6) return `rgba(147, 197, 253, ${alpha})`
  const r = parseInt(cleaned.slice(0, 2), 16)
  const g = parseInt(cleaned.slice(2, 4), 16)
  const b = parseInt(cleaned.slice(4, 6), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return `rgba(147, 197, 253, ${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const Viewer = forwardRef(function Viewer(
  {
    image,
    tool,
    brushSize,
    brushShape = 'circle',
    activeLabelValue,
    labels = [],
    radiological2D = true,
    onDrawingChange,
    renderMaskOnly3D = true,
    runtimeEnv = null
  },
  ref
) {
  const canvasRef = useRef(null)
  const markerCanvasRef = useRef(null)
  const nvRef = useRef(null)
  const historyRef = useRef({ stack: [], index: -1 })
  const actionHistoryRef = useRef([])
  const toolRef = useRef(tool)
  const crosshairWidthRef = useRef(null)
  const fillPtsRef = useRef([])
  const fillAxCorSagRef = useRef(0)
  const fillActiveRef = useRef(false)
  const markerPtsRef = useRef([])
  const activePointerIdRef = useRef(null)
  const imageKeyRef = useRef('')
  const annotationsByImageRef = useRef(new Map())
  const annotationDraftRef = useRef(null)
  const annotationStepsRef = useRef([])
  const curvePlaneRef = useRef(null)
  const curveSliceIndexRef = useRef(null)
  const curveTileIndexRef = useRef(null)
  const focusedPlaneRef = useRef(null)
  const [focusedPlane, setFocusedPlane] = useState(null)
  const [canFocusPlanes, setCanFocusPlanes] = useState(false)
  const canFocusPlanesRef = useRef(false)
  const lastBrushVoxRef = useRef(null)
  const brushSizeRef = useRef(brushSize)
  const brushShapeRef = useRef(brushShape)
  const activeLabelValueRef = useRef(activeLabelValue)
  const labelsRef = useRef(labels)
  const onDrawingChangeRef = useRef(onDrawingChange)
  const renderMaskOnly3DRef = useRef(renderMaskOnly3D)
  const runtimeEnvRef = useRef(runtimeEnv)
  const originalDraw3DRef = useRef(null)
  const originalDrawImage3DRef = useRef(null)
  const maskOnly3DActiveRef = useRef(false)
  const refreshTelemetryRef = useRef({
    last: null
  })
  const brushStrokeDirtyRef = useRef(false)
  const drawRefreshPendingRef = useRef(false)
  const markerRedrawRafRef = useRef(null)
  const markerDrawRafRef = useRef(null)
  const quadRecenterRafRef = useRef(null)
  const lastLocationRefreshAtRef = useRef(0)
  const refreshPerfRef = useRef({
    emaMs: 0,
    samples: 0,
    lastEscalationAt: 0
  })
  const suppressDrawingChangedRef = useRef(false)
  const freehandDrawingRef = useRef(false)
  const last2DTextureSliceRef = useRef(null)
  const MAX_MARKER_POINTS = 24000
  const MAX_FILL_POINTS = 32000
  const FREEHAND_CONNECT_PX = 14
  const FREEHAND_CLOSE_PX = 12
  const FREEHAND_RESUME_PX = 28
  const FREEHAND_SAMPLE_STEP_PX = 2.5
  const FREEHAND_OPEN_COLOR = '#db70db'
  imageKeyRef.current = image?.id ? String(image.id) : ''

  const getImageKey = () => {
    return imageKeyRef.current
  }
  const getCurrentAnnotations = () => {
    const key = getImageKey()
    if (!key) return []
    return annotationsByImageRef.current.get(key) || []
  }
  const setCurrentAnnotations = (next) => {
    const key = getImageKey()
    if (!key) return
    annotationsByImageRef.current.set(key, next)
  }
  const addAnnotation = (annotation, options = {}) => {
    const { recordHistory = true, emitChange = true } = options
    const key = getImageKey()
    if (!key) return
    setCurrentAnnotations([...getCurrentAnnotations(), annotation])
    if (recordHistory) {
      actionHistoryRef.current.push({ type: 'annotation', imageKey: key })
    }
    if (emitChange) {
      const notify = onDrawingChangeRef.current
      if (typeof notify === 'function') notify('annotate')
    }
  }
  const cloneAnnotations = (items) => {
    if (!Array.isArray(items)) return []
    try {
      return JSON.parse(JSON.stringify(items))
    } catch {
      return []
    }
  }
  const getCurrentAnnotationColor = () =>
    labelsRef.current.find((item) => Number(item.value || 0) === Number(activeLabelValueRef.current || 0))?.color || '#60a5fa'

  const makeFreehandDraft = (points, { nearClosed = false } = {}) => ({
    type: 'freehand',
    points: [...points],
    label: '',
    color: nearClosed ? getCurrentAnnotationColor() : FREEHAND_OPEN_COLOR,
    closed: false,
    axCorSag: curvePlaneRef.current,
    sliceIndex: curveSliceIndexRef.current
  })

  const emitDrawingChange = (reason) => {
    const notify = onDrawingChangeRef.current
    if (typeof notify === 'function') notify(reason)
  }

  const sync2DShaderDrawSliceByVox = (vox) => {
    const nv = nvRef.current
    if (!nv?.opts?.is2DSliceShader || !Array.isArray(nv.scene?.crosshairPos) || !Array.isArray(vox)) return
    const dims = nv.back?.dims
    const nz = Number(dims?.[3] || 0)
    if (nz < 1) return
    const z = Math.max(0, Math.min(nz - 1, Math.round(Number(vox[2] || 0))))
    nv.scene.crosshairPos[2] = nz > 1 ? z / (nz - 1) : 0
  }

  const getCurrent2DShaderSliceIndex = (nv = nvRef.current) => {
    if (!nv?.opts?.is2DSliceShader) return null
    const dims = nv.back?.dims
    const nz = Number(dims?.[3] || 0)
    if (nz < 1 || typeof nv.frac2vox !== 'function') return null
    const vox = nv.frac2vox(nv.scene?.crosshairPos || [0, 0, 0])
    const raw = Number(vox?.[2] || 0)
    if (!Number.isFinite(raw)) return null
    return Math.max(0, Math.min(nz - 1, Math.round(raw)))
  }

  const getDrawingDimsInfo = (nv = nvRef.current) => {
    if (!nv?.back?.dims) return null
    const dims = nv.back.dims
    const nx = Number(dims?.[1] || 0)
    const ny = Number(dims?.[2] || 0)
    const nz = Math.max(1, Number(dims?.[3] || 1))
    if (nx < 1 || ny < 1 || nz < 1) return null
    return {
      dims,
      nx,
      ny,
      nz,
      voxelCount: nx * ny * nz
    }
  }

  const hasRefreshableDrawingBitmap = (nv = nvRef.current) => {
    const dimsInfo = getDrawingDimsInfo(nv)
    if (!dimsInfo) return false
    return !!(nv?.drawBitmap && nv.drawBitmap.length === dimsInfo.voxelCount)
  }

  const requestDrawingRefresh = (targetVox = null) => {
    sync2DShaderDrawSliceByVox(targetVox)
    if (drawRefreshPendingRef.current) return
    drawRefreshPendingRef.current = true
    requestAnimationFrame(() => {
      drawRefreshPendingRef.current = false
      redrawDrawingOverlaySilently()
      const current2DSlice = getCurrent2DShaderSliceIndex()
      if (Number.isInteger(current2DSlice)) {
        last2DTextureSliceRef.current = current2DSlice
      }
    })
  }

  useEffect(() => {
    renderMaskOnly3DRef.current = !!renderMaskOnly3D
  }, [renderMaskOnly3D])

  useEffect(() => {
    runtimeEnvRef.current = runtimeEnv || null
  }, [runtimeEnv])

  useEffect(() => {
    canFocusPlanesRef.current = !!canFocusPlanes
  }, [canFocusPlanes])

  const scheduleMarkerRedraw = (delayFrames = 1) => {
    if (markerRedrawRafRef.current !== null) {
      cancelAnimationFrame(markerRedrawRafRef.current)
      markerRedrawRafRef.current = null
    }
    const waitFrames = Math.max(0, Math.floor(Number(delayFrames) || 0))
    const run = (remaining) => {
      markerRedrawRafRef.current = requestAnimationFrame(() => {
        if (remaining > 0) {
          run(remaining - 1)
          return
        }
        markerRedrawRafRef.current = null
        drawStrokeMarkers(true)
      })
    }
    run(waitFrames)
  }

  const compactPoints = (points, maxPoints) => {
    if (!Array.isArray(points) || points.length <= maxPoints) return points
    const step = Math.ceil(points.length / maxPoints)
    const compacted = []
    for (let i = 0; i < points.length; i += step) {
      compacted.push(points[i])
    }
    if (compacted[compacted.length - 1] !== points[points.length - 1]) {
      compacted.push(points[points.length - 1])
    }
    return compacted
  }

  const safeCall = (fn, ...args) => {
    const nv = nvRef.current
    if (!nv || typeof nv[fn] !== 'function') return
    nv[fn](...args)
  }

  const ensureBaseSnapshot = (bitmap) => {
    const history = historyRef.current
    if (history.stack.length > 0 || !bitmap) return
    history.stack = [new Uint8Array(bitmap)]
    history.index = 0
  }

  const pushSnapshot = (bitmap) => {
    if (!bitmap) return false
    const history = historyRef.current
    if (history.index < history.stack.length - 1) {
      history.stack = history.stack.slice(0, history.index + 1)
    }
    const last = history.stack[history.stack.length - 1]
    if (last && last.length === bitmap.length) {
      let same = true
      for (let i = 0; i < bitmap.length; i += 1) {
        if (last[i] !== bitmap[i]) {
          same = false
          break
        }
      }
      if (same) {
        history.index = history.stack.length - 1
        return false
      }
    }
    history.stack.push(new Uint8Array(bitmap))
    history.index = history.stack.length - 1
    return true
  }

  const applySnapshot = (snapshot) => {
    const nv = nvRef.current
    if (!nv || !snapshot) return
    if (!ensureDrawingBitmap()) return
    if (!nv.drawBitmap || nv.drawBitmap.length !== snapshot.length) {
      if (typeof nv.createEmptyDrawing === 'function') {
        nv.createEmptyDrawing()
      }
    }
    if (!nv.drawBitmap || nv.drawBitmap.length !== snapshot.length) {
      nv.drawBitmap = new Uint8Array(snapshot.length)
    }
    nv.drawBitmap.set(snapshot)
    redrawDrawingOverlaySilently()
    requestAnimationFrame(() => {
      redrawDrawingOverlaySilently()
    })
  }

  const redrawDrawingOverlay = () => {
    const nv = nvRef.current
    if (!nv) return
    if (hasRefreshableDrawingBitmap(nv) && typeof nv.refreshDrawing === 'function') {
      nv.refreshDrawing(false)
    }
    if (typeof nv.drawScene === 'function') {
      nv.drawScene()
    }
  }

  const redrawDrawingOverlaySilently = () => {
    suppressDrawingChangedRef.current = true
    redrawDrawingOverlay()
    requestAnimationFrame(() => {
      suppressDrawingChangedRef.current = false
    })
  }

  const refreshDrawingOnTargetSlice = ({ fixedAxis = null, fixedSlice = null, voxPoints = [] } = {}) => {
    const nv = nvRef.current
    if (!nv) return
    const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())
    const startedAt = nowMs()
    const runtimeEnv = runtimeEnvRef.current || {}
    const refreshPolicy = runtimeEnv.refreshPolicy || {}
    const configuredMaxTier = Math.max(1, Math.min(3, Number(refreshPolicy.maxTier || 1)))
    const budgetMs = Math.max(40, Math.min(100, Number(runtimeEnv.refreshBudgetMs || 100)))
    const perfState = refreshPerfRef.current || {
      emaMs: 0,
      samples: 0,
      lastEscalationAt: 0
    }
    let effectiveMaxTier = configuredMaxTier
    const emaMs = Number(perfState.emaMs || 0)
    if (emaMs > 32) {
      effectiveMaxTier = 1
    } else if (emaMs > 20) {
      effectiveMaxTier = Math.min(effectiveMaxTier, 2)
    }
    const escalationCooldownMs = Math.max(20, Number(refreshPolicy.escalationCooldownMs || 80))
    const canEscalateNow = nowMs() - Number(perfState.lastEscalationAt || 0) >= escalationCooldownMs
    const finalizeTelemetry = (strategy) => {
      const durationMs = Math.round((nowMs() - startedAt) * 100) / 100
      const prev = refreshPerfRef.current || {
        emaMs: 0,
        samples: 0,
        lastEscalationAt: 0
      }
      const prevEma = Number(prev.emaMs || 0)
      const nextEma = prevEma > 0 ? prevEma * 0.8 + durationMs * 0.2 : durationMs
      refreshPerfRef.current = {
        ...prev,
        emaMs: nextEma,
        samples: Math.min(999, Number(prev.samples || 0) + 1)
      }
      refreshTelemetryRef.current.last = {
        strategy,
        durationMs,
        budgetMs,
        maxTier: configuredMaxTier,
        effectiveMaxTier,
        emaMs: Math.round(nextEma * 100) / 100,
        on2DShader: !!nv.opts?.is2DSliceShader
      }
    }
    const dims = nv.back?.dims
    if (!hasRefreshableDrawingBitmap(nv)) {
      if (typeof nv.drawScene === 'function') {
        nv.drawScene()
      }
      finalizeTelemetry(['draw-scene-only'])
      return
    }
    const pickAxis = nv.opts?.is2DSliceShader ? 2 : (Number.isInteger(fixedAxis) ? Number(fixedAxis) : 2)
    const dimLen = Number(dims?.[pickAxis + 1] || 0)
    const calcMeanIndex = (axis) => {
      let sum = 0
      let count = 0
      for (const pt of voxPoints) {
        const v = Number(pt?.[axis])
        if (!Number.isFinite(v)) continue
        sum += v
        count += 1
      }
      if (count < 1) return null
      return Math.round(sum / count)
    }
    let targetIndex = null
    if (Number.isInteger(fixedAxis) && Number.isInteger(fixedSlice) && Number(fixedAxis) === pickAxis) {
      targetIndex = Number(fixedSlice)
    } else {
      targetIndex = calcMeanIndex(pickAxis)
    }
    const clampIndex = (idx) => {
      if (!Number.isFinite(idx) || dimLen < 1) return null
      return Math.max(0, Math.min(dimLen - 1, Math.round(idx)))
    }
    targetIndex = clampIndex(targetIndex)
    const applyIndex = (idx) => {
      if (!Array.isArray(nv.scene?.crosshairPos) || dimLen < 1) return false
      const v = clampIndex(idx)
      if (!Number.isInteger(v)) return false
      nv.scene.crosshairPos[pickAxis] = dimLen > 1 ? v / (dimLen - 1) : 0
      return true
    }
    const canEscalate = () => {
      return !!nv.opts?.is2DSliceShader && effectiveMaxTier > 1 && canEscalateNow
    }
    const withinBudget = () => nowMs() - startedAt < budgetMs
    const tiers = []

    // 1) 标准刷新
    if (Number.isInteger(targetIndex)) applyIndex(targetIndex)
    redrawDrawingOverlaySilently()
    tiers.push('standard')
    if (!withinBudget() || !canEscalate()) {
      finalizeTelemetry(tiers)
      return
    }

    // 2) 强制扰动刷新
    if (effectiveMaxTier >= 2) {
      if (dimLen > 1 && Number.isInteger(targetIndex)) {
        const alt = targetIndex < dimLen - 1 ? targetIndex + 1 : targetIndex - 1
        applyIndex(alt)
        redrawDrawingOverlaySilently()
        applyIndex(targetIndex)
        redrawDrawingOverlaySilently()
        tiers.push('perturb')
      } else if (Array.isArray(nv.scene?.crosshairPos)) {
        const prev = Number(nv.scene.crosshairPos[2] || 0)
        const nudged = Math.max(0, Math.min(1, prev + 1e-4))
        nv.scene.crosshairPos[2] = nudged
        redrawDrawingOverlaySilently()
        nv.scene.crosshairPos[2] = prev
        redrawDrawingOverlaySilently()
        tiers.push('perturb')
      }
      refreshPerfRef.current = {
        ...(refreshPerfRef.current || perfState),
        lastEscalationAt: nowMs()
      }
    }
    if (!withinBudget() || effectiveMaxTier < 3) {
      finalizeTelemetry(tiers)
      return
    }

    // 3) 模拟切片切换刷新
    if (effectiveMaxTier >= 3 && dimLen > 1 && Number.isInteger(targetIndex)) {
      const alt = targetIndex > 0 ? targetIndex - 1 : targetIndex + 1
      applyIndex(alt)
      redrawDrawingOverlaySilently()
      applyIndex(targetIndex)
      redrawDrawingOverlaySilently()
      tiers.push('simulated-slice-switch')
    }
    finalizeTelemetry(tiers)
  }

  const ensureDrawingBitmap = () => {
    const nv = nvRef.current
    if (!nv) return false
    const dimsInfo = getDrawingDimsInfo(nv)
    if (!dimsInfo) return false
    if (nv.drawBitmap?.length === dimsInfo.voxelCount) return true
    if (typeof nv.createEmptyDrawing === 'function') {
      nv.createEmptyDrawing()
      return !!(nv.drawBitmap && nv.drawBitmap.length === dimsInfo.voxelCount)
    }
    nv.drawBitmap = new Uint8Array(dimsInfo.voxelCount)
    redrawDrawingOverlay()
    return !!(nv.drawBitmap && nv.drawBitmap.length === dimsInfo.voxelCount)
  }

  const applyToolSettings = (currentTool, currentBrushSize, currentLabelValue) => {
    const nv = nvRef.current
    if (!nv) return

    const showCrosshair = currentTool === 'pan'
    if (typeof nv.setCrosshairVisible === 'function') {
      nv.setCrosshairVisible(showCrosshair)
    }
    if (nv.opts) {
      nv.opts.show3Dcrosshair = showCrosshair
    }
    if (typeof nv.setCrosshairWidth === 'function' && crosshairWidthRef.current !== null) {
      nv.setCrosshairWidth(showCrosshair ? crosshairWidthRef.current : 0)
    }

    if (currentTool === 'pan' || isAnnotationTool(currentTool)) {
      safeCall('setDrawingEnabled', false)
      redrawDrawingOverlay()
      return
    }

    safeCall('setDrawingEnabled', true)
    if (currentTool === 'eraser') {
      safeCall('setPenValue', 0, false)
    } else {
      safeCall('setPenValue', currentLabelValue || 1, false)
    }
    if (typeof currentBrushSize === 'number') {
      safeCall('setPenSize', currentBrushSize)
    }
    redrawDrawingOverlay()
  }

  // 笔刷绘制函数 - 在当前平面绘制圆形或方形（非 3D 球体）
  const drawBrushAt = (vox, axCorSag, shape, size, labelValue) => {
    const nv = nvRef.current
    if (!nv || !nv.drawBitmap) return
    
    const dims = nv.back?.dims
    const nx = Number(dims?.[1] || 0)
    const ny = Number(dims?.[2] || 0)
    const nz = Math.max(1, Number(dims?.[3] || 1))
    if (nx < 1 || ny < 1 || nz < 1) return
    
    const center = [Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2])]
    const radius = Math.max(1, Math.round(size / 2))
    const fillLabel = Math.max(1, Math.min(255, Number(labelValue || 1)))
    const fixedAxis = axCorSag === 0 ? 2 : axCorSag === 1 ? 1 : 0
    const axes = [0, 1, 2].filter((axis) => axis !== fixedAxis)
    const hAxis = axes[0]
    const vAxis = axes[1]
    const xy = nx * ny
    let changed = false

    for (let dv = -radius; dv <= radius; dv++) {
      for (let dh = -radius; dh <= radius; dh++) {
        if (shape !== 'square' && Math.hypot(dh, dv) > radius) continue
        const coords = [...center]
        coords[hAxis] = center[hAxis] + dh
        coords[vAxis] = center[vAxis] + dv
        const x = coords[0]
        const y = coords[1]
        const z = coords[2]
        if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue
        const idx = z * xy + y * nx + x
        if (nv.drawBitmap[idx] !== fillLabel) {
          nv.drawBitmap[idx] = fillLabel
          changed = true
        }
      }
    }

    return changed
  }

  // 在两点之间插值绘制笔刷线条
  const drawBrushLine = (vox1, vox2, axCorSag, shape, size, labelValue) => {
    const nv = nvRef.current
    if (!nv || !nv.drawBitmap) return
    
    const dims = nv.back?.dims
    const nx = Number(dims?.[1] || 0)
    const ny = Number(dims?.[2] || 0)
    const nz = Math.max(1, Number(dims?.[3] || 1))
    if (nx < 1 || ny < 1 || nz < 1) return
    
    const x1 = vox1[0], y1 = vox1[1], z1 = vox1[2]
    const x2 = vox2[0], y2 = vox2[1], z2 = vox2[2]
    
    // 计算距离和步数
    const dist = Math.sqrt((x2-x1)**2 + (y2-y1)**2 + (z2-z1)**2)
    const steps = Math.max(1, Math.ceil(dist))
    
    let changed = false
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const vox = [
        x1 + (x2 - x1) * t,
        y1 + (y2 - y1) * t,
        z1 + (z2 - z1) * t
      ]
      if (drawBrushAt(vox, axCorSag, shape, size, labelValue)) {
        changed = true
      }
    }
    return changed
  }

  const resetFillTracking = () => {
    fillPtsRef.current = []
    fillActiveRef.current = false
    markerPtsRef.current = []
    activePointerIdRef.current = null
  }

  const toNormPoint = (pt, canvas) => ({
    x: Math.max(0, Math.min(1, pt.x / Math.max(1, canvas.width))),
    y: Math.max(0, Math.min(1, pt.y / Math.max(1, canvas.height)))
  })

  const toStoredPoint = (pt, canvas) => {
    const sx = Math.max(0, Math.min(1, Number(pt?.x || 0) / Math.max(1, canvas?.width || 1)))
    const sy = Math.max(0, Math.min(1, Number(pt?.y || 0) / Math.max(1, canvas?.height || 1)))
    const nv = nvRef.current
    if (nv && canvas) {
      const dpr = nv.uiData?.dpr || 1
      const frac = nv.canvasPos2frac([pt.x * dpr, pt.y * dpr])
      if (frac && frac[0] >= 0) {
        return {
          frac: [Number(frac[0]), Number(frac[1]), Number(frac[2])],
          sx,
          sy
        }
      }
    }
    const fallback = toNormPoint(pt, canvas)
    return {
      ...fallback,
      sx,
      sy
    }
  }

  const toPxPoint = (pt, canvas) => {
    if (Number.isFinite(Number(pt?.sx)) && Number.isFinite(Number(pt?.sy))) {
      return {
        x: Number(pt.sx) * canvas.width,
        y: Number(pt.sy) * canvas.height
      }
    }
    const nv = nvRef.current
    const frac = pt?.frac
    if (
      nv &&
      Array.isArray(frac) &&
      frac.length >= 3 &&
      typeof nv.frac2canvasPos === 'function'
    ) {
      const pos = nv.frac2canvasPos([Number(frac[0]), Number(frac[1]), Number(frac[2])])
      // 过滤掉不在当前视图平面上的点（NiiVue 返回负值表示不可见）
      if (Array.isArray(pos) && pos.length >= 2) {
        const dpr = nv.uiData?.dpr || 1
        const x = Number(pos[0] || 0) / dpr
        const y = Number(pos[1] || 0) / dpr
        // 如果坐标为负，表示该点不在当前平面视图中
        if (x < 0 || y < 0) return null
        return { x, y }
      }
      return null
    }
    return {
      x: Number(pt?.x || 0) * canvas.width,
      y: Number(pt?.y || 0) * canvas.height
    }
  }

  const pointDistancePx = (a, b, canvas) => {
    if (!a || !b || !canvas) return Number.POSITIVE_INFINITY
    const pa = toPxPoint(a, canvas)
    const pb = toPxPoint(b, canvas)
    if (!pa || !pb) return Number.POSITIVE_INFINITY
    return Math.hypot(pa.x - pb.x, pa.y - pb.y)
  }

  const getFixedAxisByPlane = (axCorSag) => (axCorSag === 0 ? 2 : axCorSag === 1 ? 1 : 0)

  const getSliceIndexFromFrac = (axCorSag, fracVec) => {
    const nv = nvRef.current
    const dims = nv?.back?.dims
    if (!dims || !Array.isArray(fracVec) || fracVec.length < 3) return null
    const fixedAxis = getFixedAxisByPlane(axCorSag)
    const dimLen = Number(dims[fixedAxis + 1] || 0)
    if (dimLen < 1) return null
    const frac = Number(fracVec[fixedAxis])
    if (!Number.isFinite(frac)) return null
    return Math.max(0, Math.min(dimLen - 1, Math.round(frac * Math.max(1, dimLen - 1))))
  }

  const getCurrentSliceIndex = (axCorSag) => {
    const nv = nvRef.current
    const screenSlice = Array.isArray(nv?.screenSlices)
      ? nv.screenSlices.find((item) => Number(item?.axCorSag) === Number(axCorSag))
      : null
    const dims = nv?.back?.dims
    const fixedAxis = getFixedAxisByPlane(axCorSag)
    const dimLen = Number(dims?.[fixedAxis + 1] || 0)
    const sliceFrac = Number(screenSlice?.sliceFrac)
    if (dimLen > 0 && Number.isFinite(sliceFrac)) {
      return Math.max(0, Math.min(dimLen - 1, Math.round(sliceFrac * Math.max(1, dimLen - 1))))
    }
    return getSliceIndexFromFrac(axCorSag, nv?.scene?.crosshairPos || null)
  }

  const canvasPosToVox = (pt) => {
    const nv = nvRef.current
    if (!nv || !pt) return null
    const dpr = nv.uiData?.dpr || 1
    const frac = nv.canvasPos2frac([pt.x * dpr, pt.y * dpr])
    if (!frac || frac[0] < 0) return null
    const vox = nv.frac2vox(frac)
    return [Number(vox?.[0] || 0), Number(vox?.[1] || 0), Number(vox?.[2] || 0)]
  }

  const getVoxelValue = (pt) => {
    const nv = nvRef.current
    const vox = canvasPosToVox(pt)
    const dims = nv?.back?.dims
    const data = nv?.back?.img || nv?.volumes?.[0]?.img
    if (!vox || !dims || !data) return null
    const nx = Number(dims[1] || 0)
    const ny = Number(dims[2] || 0)
    const nz = Math.max(1, Number(dims[3] || 1))
    const x = Math.max(0, Math.min(nx - 1, Math.round(vox[0])))
    const y = Math.max(0, Math.min(ny - 1, Math.round(vox[1])))
    const z = Math.max(0, Math.min(nz - 1, Math.round(vox[2])))
    const idx = z * nx * ny + y * nx + x
    const value = Number(data[idx])
    if (!Number.isFinite(value)) return null
    return value
  }

  const lineDistanceMM = (a, b) => {
    const nv = nvRef.current
    const va = canvasPosToVox(a)
    const vb = canvasPosToVox(b)
    const spacing = nv?.volumes?.[0]?.hdr?.pixDims || [0, 1, 1, 1]
    if (va && vb) {
      const dx = (va[0] - vb[0]) * Number(spacing?.[1] || 1)
      const dy = (va[1] - vb[1]) * Number(spacing?.[2] || 1)
      const dz = (va[2] - vb[2]) * Number(spacing?.[3] || 1)
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    const dx = Number(a?.x || 0) - Number(b?.x || 0)
    const dy = Number(a?.y || 0) - Number(b?.y || 0)
    return Math.hypot(dx, dy)
  }

  const computeAngle = (p0, p1, p2) => {
    const ax = p0.x - p1.x
    const ay = p0.y - p1.y
    const bx = p2.x - p1.x
    const by = p2.y - p1.y
    const dot = ax * bx + ay * by
    const den = Math.hypot(ax, ay) * Math.hypot(bx, by)
    if (den <= 1e-6) return 0
    const rad = Math.acos(Math.max(-1, Math.min(1, dot / den)))
    return (rad * 180) / Math.PI
  }

  const smoothPath = (pts) => {
    if (!Array.isArray(pts) || pts.length < 4) return pts || []
    const out = [pts[0]]
    for (let i = 1; i < pts.length - 1; i += 1) {
      out.push({
        x: (pts[i - 1].x + pts[i].x + pts[i + 1].x) / 3,
        y: (pts[i - 1].y + pts[i].y + pts[i + 1].y) / 3
      })
    }
    out.push(pts[pts.length - 1])
    return out
  }

  const drawAnnotation = (ctx, canvas, annotation) => {
    const points = (annotation?.points || []).map((p) => toPxPoint(p, canvas)).filter((p) => p !== null)
    if (!points.length) return
    ctx.save()
    ctx.strokeStyle = annotation.color || 'rgba(147, 197, 253, 0.95)'
    ctx.fillStyle = annotation.color || 'rgba(147, 197, 253, 0.95)'
    ctx.lineWidth = 1.8
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    const drawLabel = (text, x, y) => {
      if (!text) return
      ctx.font = '12px sans-serif'
      const w = ctx.measureText(text).width + 8
      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)'
      ctx.fillRect(x + 6, y - 18, w, 16)
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText(text, x + 10, y - 6)
      ctx.fillStyle = annotation.color || 'rgba(147, 197, 253, 0.95)'
    }

    {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      // freehand 类型：显示为折线，不自动填充
      if (annotation.type === 'freehand' && annotation.closed && points.length >= 3) {
        ctx.closePath()
        ctx.save()
        const fillAlpha = 0.45
        ctx.fillStyle = hexToRgba(annotation.color || '#93c5fd', fillAlpha)
        ctx.fill()
        ctx.restore()
      }
      ctx.stroke()
      drawLabel(annotation.label, points[points.length - 1].x, points[points.length - 1].y)
    }
    ctx.restore()
  }

  const drawStrokeMarkersNow = () => {
    const markerCanvas = markerCanvasRef.current
    if (!markerCanvas) return
    const ctx = markerCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height)
    const annotations = getCurrentAnnotations()
    const isAnnotationVisibleOnCurrentSlice = (annotation) => {
      if (annotation?.type !== 'freehand') return true
      const plane = Number(annotation?.axCorSag)
      const sliceIndex = Number(annotation?.sliceIndex)
      if (!Number.isInteger(plane) || !Number.isInteger(sliceIndex)) return true
      const currentSlice = getCurrentSliceIndex(plane)
      if (!Number.isInteger(currentSlice)) return true
      return currentSlice === sliceIndex
    }
    for (const annotation of annotations) {
      if (annotation?.renderOnMarker === false) continue
      if (!isAnnotationVisibleOnCurrentSlice(annotation)) continue
      drawAnnotation(ctx, markerCanvas, annotation)
    }
    const shouldDrawFreehandDraft = (() => {
      const draft = annotationDraftRef.current
      if (!draft || draft.type !== 'freehand') return !!draft
      if (!Number.isInteger(curvePlaneRef.current) || !Number.isInteger(curveSliceIndexRef.current)) return true
      const currentSlice = getCurrentSliceIndex(curvePlaneRef.current)
      if (!Number.isInteger(currentSlice)) return true
      return currentSlice === curveSliceIndexRef.current
    })()
    if (annotationDraftRef.current && shouldDrawFreehandDraft) {
      drawAnnotation(ctx, markerCanvas, annotationDraftRef.current)
    }
    const pts = markerPtsRef.current
    if (pts.length > 1) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i += 1) {
        ctx.lineTo(pts[i].x, pts[i].y)
      }
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255, 220, 40, 0.9)'
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }
    for (const pt of pts) {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 2.4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 220, 40, 0.95)'
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255, 180, 0, 0.95)'
      ctx.stroke()
    }
    // freehand 草稿仅保留线条本身：未闭合粉紫、接近/闭合时按标签色（通常红色）
  }

  const drawStrokeMarkers = (immediate = false) => {
    if (immediate) {
      if (markerDrawRafRef.current !== null) {
        cancelAnimationFrame(markerDrawRafRef.current)
        markerDrawRafRef.current = null
      }
      drawStrokeMarkersNow()
      return
    }
    if (markerDrawRafRef.current !== null) return
    markerDrawRafRef.current = requestAnimationFrame(() => {
      markerDrawRafRef.current = null
      drawStrokeMarkersNow()
    })
  }

  const maybeFillClosedStroke = () => {
    const nv = nvRef.current
    if (!nv || toolRef.current !== 'brush') {
      resetFillTracking()
      return
    }
    const pts = fillPtsRef.current
    if (pts.length < 4) {
      resetFillTracking()
      return
    }

    const axCorSag = fillAxCorSagRef.current
    const [h, v] = axCorSag === 0 ? [0, 1] : axCorSag === 1 ? [0, 2] : [1, 2]
    const first = pts[0]
    const last = pts[pts.length - 1]
    const dx = first[h] - last[h]
    const dy = first[v] - last[v]
    const distVox = Math.sqrt(dx * dx + dy * dy)
    const mp = markerPtsRef.current
    const m0 = mp[0]
    const m1 = mp[mp.length - 1]
    const distPx = m0 && m1 ? Math.hypot(m0.x - m1.x, m0.y - m1.y) : Number.POSITIVE_INFINITY
    const closed = distVox <= 6.5 || distPx <= 20

    if (closed) {
      const dims = nv.back?.dims
      const nx = Number(dims?.[1] || 0)
      const ny = Number(dims?.[2] || 0)
      const nz = Math.max(1, Number(dims?.[3] || 1))
      if (nx > 0 && ny > 0 && nz > 0 && nv.drawBitmap) {
        ensureBaseSnapshot(nv.drawBitmap)
        const fillLabel = Math.max(1, Math.min(255, Number(activeLabelValueRef.current || 1)))

        const project = (p) => [Number(p[h] || 0), Number(p[v] || 0)]
        const poly = [...pts.map(project), project(pts[0])]
        const polyNoDup = []
        for (const [px, py] of poly) {
          const prev = polyNoDup[polyNoDup.length - 1]
          if (!prev || prev[0] !== px || prev[1] !== py) {
            polyNoDup.push([px, py])
          }
        }

        const pointInPolygon = (x, y, vertices) => {
          let inside = false
          for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
            const xi = vertices[i][0]
            const yi = vertices[i][1]
            const xj = vertices[j][0]
            const yj = vertices[j][1]
            const intersect =
              yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi
            if (intersect) inside = !inside
          }
          return inside
        }

        let minH = Number.POSITIVE_INFINITY
        let maxH = Number.NEGATIVE_INFINITY
        let minV = Number.POSITIVE_INFINITY
        let maxV = Number.NEGATIVE_INFINITY
        let fixed = 0
        const axisFixed = axCorSag === 0 ? 2 : axCorSag === 1 ? 1 : 0
        for (const p of pts) {
          const hh = Number(p[h] || 0)
          const vv = Number(p[v] || 0)
          minH = Math.min(minH, hh)
          maxH = Math.max(maxH, hh)
          minV = Math.min(minV, vv)
          maxV = Math.max(maxV, vv)
          fixed += Number(p[axisFixed] || 0)
        }
        fixed = Math.round(fixed / pts.length)

        const hStart = Math.floor(minH)
        const hEnd = Math.ceil(maxH)
        const vStart = Math.floor(minV)
        const vEnd = Math.ceil(maxV)
        const xy = nx * ny
        let changed = false

        const setVoxelByHV = (hh, vv) => {
          let x = 0
          let y = 0
          let z = 0
          if (axCorSag === 0) {
            x = hh
            y = vv
            z = fixed
          } else if (axCorSag === 1) {
            x = hh
            y = fixed
            z = vv
          } else {
            x = fixed
            y = hh
            z = vv
          }
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return
          const idx = z * xy + y * nx + x
          if (nv.drawBitmap[idx] === fillLabel) return
          nv.drawBitmap[idx] = fillLabel
          changed = true
        }

        const drawSegmentHV = (h0, v0, h1, v1) => {
          const steps = Math.max(1, Math.ceil(Math.max(Math.abs(h1 - h0), Math.abs(v1 - v0)) * 2))
          for (let s = 0; s <= steps; s += 1) {
            const t = s / steps
            const hh = Math.round(h0 + (h1 - h0) * t)
            const vv = Math.round(v0 + (v1 - v0) * t)
            setVoxelByHV(hh, vv)
          }
        }

        for (let i = 1; i < polyNoDup.length; i += 1) {
          drawSegmentHV(polyNoDup[i - 1][0], polyNoDup[i - 1][1], polyNoDup[i][0], polyNoDup[i][1])
        }

        for (let vv = vStart; vv <= vEnd; vv += 1) {
          for (let hh = hStart; hh <= hEnd; hh += 1) {
            if (!pointInPolygon(hh + 0.5, vv + 0.5, polyNoDup)) continue
            setVoxelByHV(hh, vv)
          }
        }

        const smoothLabelInBox = () => {
          const hMin = Math.max(1, hStart - 1)
          const hMax = Math.min((axCorSag === 2 ? ny : nx) - 2, hEnd + 1)
          const vMin = Math.max(1, vStart - 1)
          const vMax = Math.min((axCorSag === 0 ? ny : nz) - 2, vEnd + 1)
          if (hMin > hMax || vMin > vMax) return

          const sampleByHV = (hh, vv) => {
            let x = 0
            let y = 0
            let z = 0
            if (axCorSag === 0) {
              x = hh
              y = vv
              z = fixed
            } else if (axCorSag === 1) {
              x = hh
              y = fixed
              z = vv
            } else {
              x = fixed
              y = hh
              z = vv
            }
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0
            const idx = z * xy + y * nx + x
            return nv.drawBitmap[idx] === fillLabel ? 1 : 0
          }

          const toSet = []
          for (let vv = vMin; vv <= vMax; vv += 1) {
            for (let hh = hMin; hh <= hMax; hh += 1) {
              const center = sampleByHV(hh, vv)
              let neighbors = 0
              for (let dvv = -1; dvv <= 1; dvv += 1) {
                for (let dhh = -1; dhh <= 1; dhh += 1) {
                  if (dvv === 0 && dhh === 0) continue
                  neighbors += sampleByHV(hh + dhh, vv + dvv)
                }
              }
              if (center === 0 && neighbors >= 6) {
                toSet.push([hh, vv])
              }
            }
          }
          for (const [hh, vv] of toSet) setVoxelByHV(hh, vv)
        }
        smoothLabelInBox()

        if (changed) {
          refreshDrawingOnTargetSlice({ fixedAxis: axisFixed, fixedSlice: fixed, voxPoints: pts })
          const pushed = pushSnapshot(nv.drawBitmap)
          if (pushed) {
            const imageKey = getImageKey()
            if (imageKey) actionHistoryRef.current.push({ type: 'mask', imageKey })
          }
          emitDrawingChange('draw')
        }
      } else {
        const closedPts = [...pts, [...pts[0]]]
        nv.drawPenFillPts = closedPts
        nv.drawPenAxCorSag = axCorSag
        nv.drawPenFilled()
      }
    }

    resetFillTracking()
  }

  const rasterizeClosedAnnotationToMask = (normPoints, options = {}) => {
    const { recordHistory = true, emitChange = true, axCorSag = null, sliceIndex = null } = options
    const nv = nvRef.current
    const markerCanvas = markerCanvasRef.current
    if (!nv || !markerCanvas || !Array.isArray(normPoints) || normPoints.length < 3) return false
    if (!ensureDrawingBitmap()) return false

    const voxPoints = normPoints
      .map((pt) => {
        const frac = Array.isArray(pt?.frac) && pt.frac.length >= 3
          ? [Number(pt.frac[0]), Number(pt.frac[1]), Number(pt.frac[2])]
          : null
        if (frac && frac.every((v) => Number.isFinite(v)) && typeof nv.frac2vox === 'function') {
          const vox = nv.frac2vox(frac)
          if (Array.isArray(vox) && vox.length >= 3) {
            return [Number(vox[0]), Number(vox[1]), Number(vox[2])]
          }
        }
        const px = toPxPoint(pt, markerCanvas)
        if (!px) return null
        const vox = canvasPosToVox(px)
        if (!Array.isArray(vox) || vox.length < 3) return null
        return [Number(vox[0]), Number(vox[1]), Number(vox[2])]
      })
      .filter((pt) =>
        Array.isArray(pt) &&
        pt.length >= 3 &&
        Number.isFinite(pt[0]) &&
        Number.isFinite(pt[1]) &&
        Number.isFinite(pt[2])
      )
    if (voxPoints.length < 3) return false

    const dims = nv.back?.dims
    const nx = Number(dims?.[1] || 0)
    const ny = Number(dims?.[2] || 0)
    const nz = Math.max(1, Number(dims?.[3] || 1))
    if (nx < 1 || ny < 1 || nz < 1) return false

    const forcedPlane = Number.isInteger(axCorSag) ? Number(axCorSag) : null
    let fixedAxis = 0
    let hAxis = 0
    let vAxis = 1
    if (forcedPlane === 0) {
      fixedAxis = 2
      hAxis = 0
      vAxis = 1
    } else if (forcedPlane === 1) {
      fixedAxis = 1
      hAxis = 0
      vAxis = 2
    } else if (forcedPlane === 2) {
      fixedAxis = 0
      hAxis = 1
      vAxis = 2
    } else {
      const ranges = [0, 1, 2].map((axis) => {
        let min = Number.POSITIVE_INFINITY
        let max = Number.NEGATIVE_INFINITY
        for (const p of voxPoints) {
          const v = Number(p[axis] || 0)
          min = Math.min(min, v)
          max = Math.max(max, v)
        }
        return max - min
      })
      fixedAxis = 0
      if (ranges[1] < ranges[fixedAxis]) fixedAxis = 1
      if (ranges[2] < ranges[fixedAxis]) fixedAxis = 2
      const axes = [0, 1, 2].filter((axis) => axis !== fixedAxis)
      hAxis = axes[0]
      vAxis = axes[1]
    }

    let fixed = 0
    const forcedSlice = Number.isInteger(sliceIndex) ? Number(sliceIndex) : null
    if (forcedSlice !== null && forcedPlane !== null) {
      const fixedDimLen = Number(dims?.[fixedAxis + 1] || 0)
      fixed = Math.max(0, Math.min(Math.max(0, fixedDimLen - 1), forcedSlice))
    } else {
      for (const p of voxPoints) fixed += Number(p[fixedAxis] || 0)
      fixed = Math.round(fixed / voxPoints.length)
    }

    const toHV = (p) => [Number(p[hAxis] || 0), Number(p[vAxis] || 0)]
    const poly = voxPoints.map(toHV)
    const first = poly[0]
    const last = poly[poly.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) poly.push([first[0], first[1]])

    const polyNoDup = []
    for (const [hh, vv] of poly) {
      const prev = polyNoDup[polyNoDup.length - 1]
      if (!prev || prev[0] !== hh || prev[1] !== vv) polyNoDup.push([hh, vv])
    }
    if (polyNoDup.length < 4) return false

    let minH = Number.POSITIVE_INFINITY
    let maxH = Number.NEGATIVE_INFINITY
    let minV = Number.POSITIVE_INFINITY
    let maxV = Number.NEGATIVE_INFINITY
    for (const [hh, vv] of polyNoDup) {
      minH = Math.min(minH, hh)
      maxH = Math.max(maxH, hh)
      minV = Math.min(minV, vv)
      maxV = Math.max(maxV, vv)
    }
    const hStart = Math.floor(minH)
    const hEnd = Math.ceil(maxH)
    const vStart = Math.floor(minV)
    const vEnd = Math.ceil(maxV)
    const fillLabel = Math.max(1, Math.min(255, Number(activeLabelValueRef.current || 1)))
    const xy = nx * ny
    let changed = false

    const pointInPolygon = (x, y, vertices) => {
      let inside = false
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
        const xi = vertices[i][0]
        const yi = vertices[i][1]
        const xj = vertices[j][0]
        const yj = vertices[j][1]
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi
        if (intersect) inside = !inside
      }
      return inside
    }

    const setVoxelByHV = (hh, vv) => {
      const coords = [0, 0, 0]
      coords[fixedAxis] = fixed
      coords[hAxis] = hh
      coords[vAxis] = vv
      const x = coords[0]
      const y = coords[1]
      const z = coords[2]
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return
      const idx = z * xy + y * nx + x
      if (nv.drawBitmap[idx] === fillLabel) return
      nv.drawBitmap[idx] = fillLabel
      changed = true
    }

    const drawSegmentHV = (h0, v0, h1, v1) => {
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(h1 - h0), Math.abs(v1 - v0)) * 2))
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps
        const hh = Math.round(h0 + (h1 - h0) * t)
        const vv = Math.round(v0 + (v1 - v0) * t)
        setVoxelByHV(hh, vv)
      }
    }

    ensureBaseSnapshot(nv.drawBitmap)
    for (let i = 1; i < polyNoDup.length; i += 1) {
      drawSegmentHV(polyNoDup[i - 1][0], polyNoDup[i - 1][1], polyNoDup[i][0], polyNoDup[i][1])
    }
    for (let vv = vStart; vv <= vEnd; vv += 1) {
      for (let hh = hStart; hh <= hEnd; hh += 1) {
        if (!pointInPolygon(hh + 0.5, vv + 0.5, polyNoDup)) continue
        setVoxelByHV(hh, vv)
      }
    }

    if (!changed) return false
    refreshDrawingOnTargetSlice({ fixedAxis, fixedSlice: fixed, voxPoints })
    const pushed = pushSnapshot(nv.drawBitmap)
    if (pushed && recordHistory) {
      const imageKey = getImageKey()
      if (imageKey) actionHistoryRef.current.push({ type: 'mask', imageKey })
    }
    if (emitChange) emitDrawingChange('draw')
    return true
  }

  const normalizeFocusPlane = (planeKey) => {
    const key = String(planeKey || '').trim().toUpperCase()
    return FOCUS_PLANES.includes(key) ? key : null
  }

  const configureMultiplanarGrid = () => {
    const nv = nvRef.current
    if (!nv) return
    if (typeof nv.setHeroImage === 'function') {
      nv.setHeroImage(0)
    } else if (nv?.opts) {
      nv.opts.heroImageFraction = 0
    }
    if (typeof nv.setMultiplanarLayout === 'function') {
      nv.setMultiplanarLayout(2)
    } else if (nv?.opts) {
      nv.opts.multiplanarLayout = 2
    }
    if (typeof nv.setMultiplanarPadPixels === 'function') {
      // 四窗行列间距需要覆盖方向字母高度，避免上排下边界字母被下一排切片覆盖。
      nv.setMultiplanarPadPixels(10)
    } else if (nv?.opts) {
      nv.opts.multiplanarPadPixels = 10
    }
    if (nv?.opts) {
      nv.opts.multiplanarShowRender = 1
      // 关闭强制等大布局，避免非等方体素数据在四窗里产生“被挤压”的观感。
      nv.opts.multiplanarEqualSize = false
      // 使用稳定小边距，避免贴边但不造成整体下沉。
      nv.opts.tileMargin = 2
    }
    if (typeof nv.clearCustomLayout === 'function') {
      try {
        nv.clearCustomLayout()
      } catch {
        // ignore
      }
    }
    if (typeof nv.setIsOrientationTextVisible === 'function') {
      nv.setIsOrientationTextVisible(true)
    } else if (nv?.opts) {
      nv.opts.isOrientationTextVisible = true
    }
    if (typeof nv.setShowAllOrientationMarkers === 'function') {
      nv.setShowAllOrientationMarkers(true)
    } else if (nv?.opts) {
      nv.opts.showAllOrientationMarkers = true
    }
    if (typeof nv.setCornerOrientationText === 'function') {
      nv.setCornerOrientationText(false)
    } else if (nv?.opts) {
      nv.opts.isCornerOrientationText = false
    }
    if (typeof nv.setSliceMM === 'function') {
      // 与 ITK-SNAP 一致使用 world-space 切片，保证方向与空间显示一致性。
      nv.setSliceMM(true)
    } else if (nv?.opts) {
      nv.opts.isSliceMM = true
    }
  }

  const normalizePanForQuad = () => {
    const nv = nvRef.current
    if (!nv?.scene) return
    // 四窗统一复位：中心对齐 + 默认缩放，避免人为缩放导致视口看起来“被压扁”。
    const next = [0, 0, 0, 1]
    if (typeof nv.setPan2Dxyzmm === 'function') {
      nv.setPan2Dxyzmm(next)
    } else {
      nv.scene.pan2Dxyzmm = next
      if (typeof nv.drawScene === 'function') {
        nv.drawScene()
      }
    }
  }

  const scheduleQuadRecenter = () => {
    if (quadRecenterRafRef.current !== null) {
      cancelAnimationFrame(quadRecenterRafRef.current)
      quadRecenterRafRef.current = null
    }
    quadRecenterRafRef.current = requestAnimationFrame(() => {
      quadRecenterRafRef.current = null
      if (!canFocusPlanesRef.current || focusedPlaneRef.current) return
      normalizePanForQuad()
    })
  }

  const setSliceTypeForPlane = (planeKey, options = {}) => {
    const { normalizePan = false } = options
    const nv = nvRef.current
    if (!nv || typeof nv.setSliceType !== 'function') return false
    const key = normalizeFocusPlane(planeKey)
    if (key === 'A') {
      nv.setSliceType(nv.sliceTypeAxial)
      return true
    }
    if (key === 'S') {
      nv.setSliceType(nv.sliceTypeSagittal)
      return true
    }
    if (key === 'C') {
      nv.setSliceType(nv.sliceTypeCoronal)
      return true
    }
    if (nv?.opts) {
      nv.opts.multiplanarShowRender = 1
      nv.opts.multiplanarLayout = 2
    }
    nv.setSliceType(nv.sliceTypeMultiplanar)
    configureMultiplanarGrid()
    if (normalizePan) {
      normalizePanForQuad()
    }
    return true
  }

  const zoomToFitInternal = () => {
    const nv = nvRef.current
    if (!nv) return false
    const defaultPan2D = [0, 0, 0, 1]
    if (typeof nv.setPan2Dxyzmm === 'function') {
      nv.setPan2Dxyzmm(defaultPan2D)
    } else if (nv.scene) {
      nv.scene.pan2Dxyzmm = [...defaultPan2D]
      if (typeof nv.drawScene === 'function') {
        nv.drawScene()
      }
    } else {
      return false
    }
    requestAnimationFrame(() => {
      redrawDrawingOverlaySilently()
      drawStrokeMarkers()
    })
    return true
  }

  const toggleFocusPlaneInternal = (planeKey) => {
    const normalized = normalizeFocusPlane(planeKey)
    if (normalized && !canFocusPlanes) return focusedPlaneRef.current
    const prev = focusedPlaneRef.current
    const next = focusedPlaneRef.current === normalized ? null : normalized
    focusedPlaneRef.current = next
    setFocusedPlane(next)
    setSliceTypeForPlane(next, { normalizePan: prev !== null && next === null })
    requestAnimationFrame(() => {
      redrawDrawingOverlaySilently()
      drawStrokeMarkers()
    })
    return next
  }

  useImperativeHandle(ref, () => ({
    refreshOverlay: () => {
      drawStrokeMarkers()
      return true
    },
    toggleFocusPlane: (planeKey) => toggleFocusPlaneInternal(planeKey),
    getFocusedPlane: () => focusedPlaneRef.current,
    zoomToFit: () => zoomToFitInternal(),
    undoToolAction: () => {
      const currentImageKey = getImageKey()
      if (!currentImageKey) return false
      const history = historyRef.current
      const actionHistory = actionHistoryRef.current
      while (actionHistory.length > 0) {
        const action = actionHistory.pop()
        const actionType = typeof action === 'string' ? action : action?.type
        const actionImageKey = typeof action === 'string' ? currentImageKey : action?.imageKey
        if (actionImageKey !== currentImageKey) continue
        if (actionType === 'annotation') {
          const current = getCurrentAnnotations()
          if (!current.length) continue
          setCurrentAnnotations(current.slice(0, -1))
          drawStrokeMarkers()
          emitDrawingChange('undo')
          return true
        }
        if (actionType === 'freehand-complete') {
          const hasMask = !!action?.hasMask
          if (hasMask && history.index > 0) {
            history.index -= 1
            applySnapshot(history.stack[history.index])
          }
          const current = getCurrentAnnotations()
          if (current.length > 0) {
            setCurrentAnnotations(current.slice(0, -1))
          }
          drawStrokeMarkers()
          emitDrawingChange('undo')
          return true
        }
        if (actionType === 'mask') {
          if (history.index <= 0) continue
          history.index -= 1
          applySnapshot(history.stack[history.index])
          emitDrawingChange('undo')
          return true
        }
      }
      const current = getCurrentAnnotations()
      if (current.length > 0) {
        setCurrentAnnotations(current.slice(0, -1))
        drawStrokeMarkers()
        emitDrawingChange('undo')
        return true
      }
      if (history.index <= 0) return false
      history.index -= 1
      applySnapshot(history.stack[history.index])
      emitDrawingChange('undo')
      return true
    },
    clearAnnotations: () => {
      const key = getImageKey()
      if (key) annotationsByImageRef.current.delete(key)
      annotationDraftRef.current = null
      annotationStepsRef.current = []
      curvePlaneRef.current = null
      curveSliceIndexRef.current = null
      curveTileIndexRef.current = null
      const currentImageKey = getImageKey()
      actionHistoryRef.current = actionHistoryRef.current.filter((item) => {
        const actionType = typeof item === 'string' ? item : item?.type
        const actionImageKey = typeof item === 'string' ? currentImageKey : item?.imageKey
        const isCurrent = actionImageKey === currentImageKey
        return !(
          isCurrent &&
          (actionType === 'annotation' || actionType === 'freehand-complete')
        )
      })
      resetFillTracking()
      drawStrokeMarkers()
      emitDrawingChange('clear')
    },
    undo: () => {
      const history = historyRef.current
      if (history.index <= 0) return
      history.index -= 1
      applySnapshot(history.stack[history.index])
      emitDrawingChange('undo')
    },
    redo: () => {
      const history = historyRef.current
      if (history.index >= history.stack.length - 1) return
      history.index += 1
      applySnapshot(history.stack[history.index])
      emitDrawingChange('redo')
    },
    clear: () => {
      const nv = nvRef.current
      if (!nv?.drawBitmap) return
      ensureBaseSnapshot(nv.drawBitmap)
      const empty = new Uint8Array(nv.drawBitmap.length)
      const pushed = pushSnapshot(empty)
      if (pushed) {
        const imageKey = getImageKey()
        if (imageKey) actionHistoryRef.current.push({ type: 'mask', imageKey })
      }
      applySnapshot(empty)
      emitDrawingChange('clear')
    },
    exportDrawing: async () => {
      const nv = nvRef.current
      if (!nv) return null
      const result = await nv.saveImage({ filename: '', isSaveDrawing: true })
      if (result instanceof Uint8Array) {
        return result
      }
      return null
    },
    exportAnnotations: () => cloneAnnotations(getCurrentAnnotations()),
    getRefreshDiagnostics: () => ({ ...(refreshTelemetryRef.current || {}) }),
    getAnnotationCount: () => getCurrentAnnotations().length,
    getLabelStats: () => {
      const nv = nvRef.current
      const bitmap = nv?.drawBitmap
      if (!bitmap?.length) return {}
      const stats = {}
      for (let i = 0; i < bitmap.length; i += 1) {
        const v = bitmap[i]
        if (v <= 0) continue
        stats[v] = (stats[v] || 0) + 1
      }
      return stats
    },
    jumpToLabel: (labelValue) => {
      const nv = nvRef.current
      const bitmap = nv?.drawBitmap
      const dims = nv?.back?.dims
      const nx = Number(dims?.[1] || 0)
      const ny = Number(dims?.[2] || 0)
      const nz = Math.max(1, Number(dims?.[3] || 1))
      if (!bitmap?.length || nx < 1 || ny < 1 || nz < 1) return false

      const target = Math.max(0, Math.min(255, Number(labelValue || 0)))
      const xy = nx * ny
      let count = 0
      let sx = 0
      let sy = 0
      let sz = 0

      for (let z = 0; z < nz; z += 1) {
        const zOff = z * xy
        for (let y = 0; y < ny; y += 1) {
          const yOff = zOff + y * nx
          for (let x = 0; x < nx; x += 1) {
            const idx = yOff + x
            if (bitmap[idx] !== target) continue
            count += 1
            sx += x
            sy += y
            sz += z
          }
        }
      }

      if (count === 0) return false

      const cx = sx / count
      const cy = sy / count
      const cz = sz / count
      if (nv.scene?.crosshairPos) {
        nv.scene.crosshairPos[0] = nx > 1 ? cx / (nx - 1) : 0.5
        nv.scene.crosshairPos[1] = ny > 1 ? cy / (ny - 1) : 0.5
        nv.scene.crosshairPos[2] = nz > 1 ? cz / (nz - 1) : 0.5
      }
      if (typeof nv.drawScene === 'function') {
        nv.drawScene()
      }
      return true
    }
  }))

  useEffect(() => {
    if (!canvasRef.current) return
    if (!nvRef.current) {
      nvRef.current = new Niivue({ show3Dcrosshair: false })
      nvRef.current.attachToCanvas(canvasRef.current)
      const nv = nvRef.current
      if (nv?.opts?.crosshairWidth !== undefined) {
        const baseWidth = Number(nv.opts.crosshairWidth || 1)
        crosshairWidthRef.current = Math.max(THREE_D_CROSSHAIR_MIN_WIDTH, baseWidth)
      } else {
        crosshairWidthRef.current = THREE_D_CROSSHAIR_MIN_WIDTH
      }
      if (typeof nv?.setCrosshairColor === 'function') {
        nv.setCrosshairColor([...THREE_D_CROSSHAIR_COLOR])
      } else if (nv?.opts) {
        nv.opts.crosshairColor = [...THREE_D_CROSSHAIR_COLOR]
      }
      if (typeof nv?.setCrosshairWidth === 'function' && Number.isFinite(crosshairWidthRef.current)) {
        nv.setCrosshairWidth(crosshairWidthRef.current)
      }
      const originalMouseClick = nv.mouseClick?.bind(nv)
      if (originalMouseClick) {
        nv.mouseClick = (x, y, posChange = 0, isDelta = true) => {
          const shouldLockCrosshair = toolRef.current !== 'pan' && posChange === 0 && isDelta === true
          if (!shouldLockCrosshair) {
            return originalMouseClick(x, y, posChange, isDelta)
          }

          const prev = nv.scene?.crosshairPos ? [...nv.scene.crosshairPos] : null
          const result = originalMouseClick(x, y, posChange, isDelta)

          if (prev && nv.scene?.crosshairPos) {
            nv.scene.crosshairPos[0] = prev[0]
            nv.scene.crosshairPos[1] = prev[1]
            nv.scene.crosshairPos[2] = prev[2]
            if (typeof nv.drawScene === 'function') {
              nv.drawScene()
            }
          }

          return result
        }
      }
      if (typeof nvRef.current.setCrosshairVisible === 'function') {
        nvRef.current.setCrosshairVisible(false)
      }
      const setRenderBackOpacity = (opacityValue) => {
        const gl = nv?.gl
        const shader = nv?.renderShader
        const uniform = shader?.uniforms?.backOpacity
        if (!gl || !shader || uniform == null) return false
        shader.use(gl)
        gl.uniform1f(uniform, Math.max(0, Number(opacityValue || 0)))
        return true
      }
      const runMaskOnly3D = (renderFn) => {
        if (!renderMaskOnly3DRef.current || maskOnly3DActiveRef.current) return renderFn()
        const baseVolume = Array.isArray(nv.volumes) ? nv.volumes[0] : null
        const baseOpacity = Number(baseVolume?.opacity ?? baseVolume?._opacity ?? 1)
        maskOnly3DActiveRef.current = true
        let usedUniformMode = setRenderBackOpacity(0)
        if (!usedUniformMode && baseVolume) {
          baseVolume.opacity = 0
          baseVolume._opacity = 0
        }
        try {
          return renderFn()
        } finally {
          if (usedUniformMode) {
            setRenderBackOpacity(baseOpacity)
          } else if (baseVolume) {
            baseVolume.opacity = baseOpacity
            baseVolume._opacity = baseOpacity
          }
          maskOnly3DActiveRef.current = false
        }
      }
      if (typeof nv.drawImage3D === 'function') {
        originalDrawImage3DRef.current = nv.drawImage3D.bind(nv)
        nv.drawImage3D = (...args) => {
          const originalDrawImage3D = originalDrawImage3DRef.current
          if (typeof originalDrawImage3D !== 'function') return undefined
          return runMaskOnly3D(() => originalDrawImage3D(...args))
        }
      }
      if (typeof nv.draw3D === 'function') {
        originalDraw3DRef.current = nv.draw3D.bind(nv)
        nv.draw3D = (...args) => {
          const originalDraw3D = originalDraw3DRef.current
          if (typeof originalDraw3D !== 'function') return undefined
          return runMaskOnly3D(() => originalDraw3D(...args))
        }
      }
      const previousOnLocationChange = nvRef.current.onLocationChange
      nvRef.current.onLocationChange = (location) => {
        if (typeof previousOnLocationChange === 'function') {
          previousOnLocationChange(location)
        }
        if (
          toolRef.current === 'freehand' &&
          annotationStepsRef.current.length > 0 &&
          Number.isInteger(curvePlaneRef.current) &&
          Number.isInteger(curveSliceIndexRef.current)
        ) {
          const currentSlice = getCurrentSliceIndex(curvePlaneRef.current)
          if (Number.isInteger(currentSlice) && currentSlice !== curveSliceIndexRef.current) {
            annotationDraftRef.current = null
            annotationStepsRef.current = []
            curvePlaneRef.current = null
            curveSliceIndexRef.current = null
            curveTileIndexRef.current = null
            freehandDrawingRef.current = false
            if (activePointerIdRef.current !== null) {
              const pid = activePointerIdRef.current
              activePointerIdRef.current = null
              const canvas = canvasRef.current
              if (canvas?.hasPointerCapture?.(pid)) {
                canvas.releasePointerCapture?.(pid)
              }
            }
          }
        }
        if (nv.opts?.is2DSliceShader && hasRefreshableDrawingBitmap(nv)) {
          const current2DSlice = getCurrent2DShaderSliceIndex(nv)
          if (Number.isInteger(current2DSlice) && current2DSlice !== last2DTextureSliceRef.current) {
            const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
            const minInterval = Math.max(
              20,
              Number(runtimeEnvRef.current?.refreshPolicy?.locationRefreshMinIntervalMs || 48)
            )
            if (now - Number(lastLocationRefreshAtRef.current || 0) >= minInterval) {
              lastLocationRefreshAtRef.current = now
              requestDrawingRefresh()
            }
          }
        }
        scheduleMarkerRedraw(1)
      }
      nvRef.current.onDrawingChanged = (action) => {
        if (suppressDrawingChangedRef.current) return
        const nv = nvRef.current
        if (!nv?.drawBitmap) return
        if (toolRef.current === 'brush') return
        if (action === 'undo' || action === 'redo') {
          emitDrawingChange(action)
          return
        }
        ensureBaseSnapshot(nv.drawBitmap)
        const pushed = pushSnapshot(nv.drawBitmap)
        if (pushed) {
          const imageKey = getImageKey()
          if (imageKey) actionHistoryRef.current.push({ type: 'mask', imageKey })
        }
        emitDrawingChange(action)
      }
      applyToolSettings(toolRef.current, brushSizeRef.current, activeLabelValueRef.current)
    }
  }, [])

  useEffect(() => {
    brushSizeRef.current = brushSize
  }, [brushSize])

  useEffect(() => {
    brushShapeRef.current = brushShape
  }, [brushShape])

  useEffect(() => {
    activeLabelValueRef.current = activeLabelValue
  }, [activeLabelValue])

  useEffect(() => {
    labelsRef.current = labels
  }, [labels])

  useEffect(() => {
    onDrawingChangeRef.current = onDrawingChange
  }, [onDrawingChange])

  useEffect(() => {
    toolRef.current = tool
    annotationDraftRef.current = null
    annotationStepsRef.current = []
    curvePlaneRef.current = null
    curveSliceIndexRef.current = null
    curveTileIndexRef.current = null
    resetFillTracking()
    lastBrushVoxRef.current = null
    brushStrokeDirtyRef.current = false
    freehandDrawingRef.current = false
    last2DTextureSliceRef.current = null
    lastLocationRefreshAtRef.current = 0
    drawStrokeMarkers()
  }, [tool])

  useEffect(
    () => () => {
      if (markerRedrawRafRef.current !== null) {
        cancelAnimationFrame(markerRedrawRafRef.current)
        markerRedrawRafRef.current = null
      }
      if (markerDrawRafRef.current !== null) {
        cancelAnimationFrame(markerDrawRafRef.current)
        markerDrawRafRef.current = null
      }
      if (quadRecenterRafRef.current !== null) {
        cancelAnimationFrame(quadRecenterRafRef.current)
        quadRecenterRafRef.current = null
      }
    },
    []
  )

  useEffect(() => {
    // 切换影像时清空临时态，避免上一张的草稿/轨迹残留到下一张。
    imageKeyRef.current = image?.id ? String(image.id) : ''
    annotationDraftRef.current = null
    annotationStepsRef.current = []
    curvePlaneRef.current = null
    curveSliceIndexRef.current = null
    curveTileIndexRef.current = null
    markerPtsRef.current = []
    fillPtsRef.current = []
    fillActiveRef.current = false
    activePointerIdRef.current = null
    lastBrushVoxRef.current = null
    brushStrokeDirtyRef.current = false
    freehandDrawingRef.current = false
    last2DTextureSliceRef.current = null
    lastLocationRefreshAtRef.current = 0
    drawStrokeMarkers()
  }, [image?.id])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !labels?.length) return

    const toRgb = (hex) => {
      if (typeof hex !== 'string') return [255, 0, 0]
      const cleaned = hex.replace('#', '')
      if (cleaned.length !== 6) return [255, 0, 0]
      const r = parseInt(cleaned.slice(0, 2), 16)
      const g = parseInt(cleaned.slice(2, 4), 16)
      const b = parseInt(cleaned.slice(4, 6), 16)
      if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return [255, 0, 0]
      return [r, g, b]
    }

    const entries = [{ value: 0, name: '', color: '#000000' }, ...labels]
      .map((label) => ({
        value: Math.max(0, Math.min(255, Number(label.value ?? 0))),
        name: label.name ?? '',
        color: label.color ?? '#ff0000'
      }))
      .filter((label, index, arr) => arr.findIndex((l) => l.value === label.value) === index)
      .sort((a, b) => a.value - b.value)

    const R = []
    const G = []
    const B = []
    const A = []
    const I = []
    const labelNames = []

    for (const entry of entries) {
      const [r, g, b] = toRgb(entry.color)
      R.push(r)
      G.push(g)
      B.push(b)
      A.push(entry.value === 0 ? 0 : 255)
      I.push(entry.value)
      labelNames.push(entry.name ?? '')
    }

    nv.setDrawColormap({
      R,
      G,
      B,
      A,
      I,
      labels: labelNames
    })
  }, [labels])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !image?.data || !image?.id) return

    let cancelled = false
    const load = async () => {
      const imageBuffer = toArrayBuffer(image.data)
      if (!imageBuffer) {
        console.error('Viewer 无法识别影像数据类型，跳过渲染', image?.id)
        return
      }

      // 在第一个 await 之前同步恢复标注数据，防止异步加载期间新增的标注被覆盖
      const imageKeyEarly = getImageKey()
      if (imageKeyEarly) {
        annotationsByImageRef.current.set(imageKeyEarly, cloneAnnotations(image.overlayAnnotations))
        drawStrokeMarkers()
      }

      const nextVolume = await NVImage.loadFromUrl({
        url: image.name,
        name: image.name,
        buffer: imageBuffer
      })
      if (cancelled) return

      historyRef.current = { stack: [], index: -1 }
      actionHistoryRef.current = []
      if (nv.volumes?.length) {
        const existing = [...nv.volumes]
        existing.forEach((vol) => nv.removeVolume(vol))
      }
      if (typeof nv.closeDrawing === 'function') {
        nv.closeDrawing()
      }
      nv.addVolume(nextVolume)
      if (cancelled) return

      if (typeof nv.setInterpolation === 'function') {
        // 使用最近邻插值，让视口细节与缩略图观感更一致。
        nv.setInterpolation(true)
      }

      const baseVolume = nv.volumes?.[0]
      const sourceName = image?.displayName || image?.sourceName || image?.name
      const windowRange =
        baseVolume && !image.isMaskOnly
          ? resolveAutoWindowRange({
              volume: baseVolume,
              imageMeta: {
                name: sourceName,
                seriesDescription: image?.dicomSeriesDescription || ''
              }
            })
          : null
      if (baseVolume && windowRange) {
        baseVolume.cal_min = Number(windowRange.min)
        baseVolume.cal_max = Number(windowRange.max)
        if (typeof nv.updateGLVolume === 'function') {
          nv.updateGLVolume()
        } else if (typeof nv.drawScene === 'function') {
          nv.drawScene()
        }
      }

      const dims = nv.back?.dims
      const hdr = nv.volumes?.[0]?.hdr
      const hdrDims = hdr?.dims
      const hdrIntent = Number(hdr?.intent_code ?? hdr?.intentCode ?? 0)
      const hdrDim5 = Number(hdrDims?.[5] ?? 0)
      const hdrDim3 = Number(hdrDims?.[3] ?? 1)
      const isVector2D = (hdrIntent === 1007 || hdrDim5 > 1) && hdrDim3 <= 1
      const is2D = !!(dims && (dims[0] <= 2 || dims[3] <= 1 || isVector2D))
      const isRaster2D = isRasterImageName(sourceName)
      if (is2D) {
        if (cancelled) return
        setCanFocusPlanes(false)
        focusedPlaneRef.current = null
        setFocusedPlane(null)
        if (typeof nv.clearCustomLayout === 'function') {
          try {
            nv.clearCustomLayout()
          } catch {
            // ignore
          }
        }
        nv.setRadiologicalConvention(isRaster2D ? true : !!radiological2D)
        if (Array.isArray(nv.scene?.crosshairPos)) {
          nv.scene.crosshairPos[0] = 0.5
          nv.scene.crosshairPos[1] = 0.5
          nv.scene.crosshairPos[2] = 0.5
        }
        nv.setSliceType(nv.sliceTypeAxial)
      } else {
        if (cancelled) return
        setCanFocusPlanes(true)
        // 3D/四窗同样遵循 radiological 约定，避免 L/R 显示反向。
        nv.setRadiologicalConvention(!!radiological2D)
        if (Array.isArray(nv.scene?.crosshairPos)) {
          nv.scene.crosshairPos[0] = 0.5
          nv.scene.crosshairPos[1] = 0.5
          nv.scene.crosshairPos[2] = 0.5
        }
        const preferredPlane = normalizeFocusPlane(focusedPlaneRef.current)
        focusedPlaneRef.current = preferredPlane
        setFocusedPlane(preferredPlane)
        setSliceTypeForPlane(preferredPlane, { normalizePan: preferredPlane === null })
      }

      if (image.isMaskOnly) {
        if (typeof nv.setColormap === 'function') {
          nv.setColormap('itksnap')
        }
      }

      if (!image.isMaskOnly && image.mask && image.maskAttached !== false) {
        const maskName = image.maskName || image.name
        const maskBuffer = toArrayBuffer(image.mask)
        if (maskBuffer) {
          const maskVolume = await NVImage.loadFromUrl({
            url: maskName,
            name: maskName,
            buffer: maskBuffer
          })
          if (cancelled) return
          nv.loadDrawing(maskVolume)
          redrawDrawingOverlay()
        }
      } else if (typeof nv.createEmptyDrawing === 'function') {
        nv.createEmptyDrawing()
        redrawDrawingOverlay()
      } else if (typeof nv.closeDrawing === 'function') {
        nv.closeDrawing()
      }

      applyToolSettings(toolRef.current, brushSizeRef.current, activeLabelValueRef.current)
      drawStrokeMarkers()
      requestAnimationFrame(() => {
        redrawDrawingOverlay()
        drawStrokeMarkers()
      })
      emitDrawingChange('load')
    }

    load().catch((error) => {
      if (cancelled) return
      console.error('Viewer 加载影像失败', error)
    })
    return () => {
      cancelled = true
    }
  }, [image?.id, image?.maskVersion, radiological2D])

  useEffect(() => {
    applyToolSettings(tool, brushSize, activeLabelValue)
  }, [tool, brushSize, activeLabelValue])

  useEffect(() => {
    const canvas = canvasRef.current
    const markerCanvas = markerCanvasRef.current
    const nv = nvRef.current
    if (!canvas || !markerCanvas || !nv) return

    const syncMarkerSize = () => {
      const rect = canvas.getBoundingClientRect()
      markerCanvas.width = Math.max(1, Math.round(rect.width))
      markerCanvas.height = Math.max(1, Math.round(rect.height))
      drawStrokeMarkers()
      scheduleQuadRecenter()
    }

    syncMarkerSize()
    const resizeObserver = new ResizeObserver(syncMarkerSize)
    resizeObserver.observe(canvas)

    const getCanvasPos = (event) => {
      const rect = canvas.getBoundingClientRect()
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      }
    }

    const onPointerDown = (event) => {
      if (event.button !== 0) return
      const pos = getCanvasPos(event)
      const currentTool = toolRef.current
      if (isAnnotationTool(currentTool)) {
        event.preventDefault()
        const markerCanvas = markerCanvasRef.current
        if (!markerCanvas) return
        const norm = toStoredPoint(pos, markerCanvas)

        if (currentTool === 'freehand') {
          const dpr = nv.uiData?.dpr || 1
          const tile = nv.tileIndex(pos.x * dpr, pos.y * dpr)
          const currentPlane = tile >= 0 && nv.screenSlices?.[tile] ? nv.screenSlices[tile].axCorSag : null
          if (currentPlane === null) return
          const currentSliceIndex =
            getSliceIndexFromFrac(currentPlane, norm?.frac || null) ??
            getCurrentSliceIndex(currentPlane)
          if (!Number.isInteger(currentSliceIndex)) return

          let nextSteps = [...annotationStepsRef.current]
          // 平面变化时，丢弃旧草稿并在当前平面重新开始
          if (
            nextSteps.length > 0 &&
            (
              (Number.isInteger(curveTileIndexRef.current) && curveTileIndexRef.current !== tile) ||
              (curvePlaneRef.current !== null && curvePlaneRef.current !== currentPlane) ||
              (Number.isInteger(curveSliceIndexRef.current) && curveSliceIndexRef.current !== currentSliceIndex)
            )
          ) {
            nextSteps = []
          }
          curveTileIndexRef.current = tile
          curvePlaneRef.current = currentPlane
          curveSliceIndexRef.current = currentSliceIndex

          if (nextSteps.length === 0) {
            nextSteps = [norm]
          } else {
            const last = nextSteps[nextSteps.length - 1]
            const distToLast = pointDistancePx(last, norm, markerCanvas)
            if (distToLast <= FREEHAND_RESUME_PX) {
              // 仅在终点附近续画时自动接线，避免跨视口/跨区域长线发散。
              if (distToLast > FREEHAND_SAMPLE_STEP_PX) {
                nextSteps = [...nextSteps, norm]
              }
            } else {
              // 与上一落点距离过大，判定为新一笔，不与历史草稿硬连接。
              nextSteps = [norm]
            }
          }

          annotationStepsRef.current = compactPoints(nextSteps, MAX_MARKER_POINTS)
          const nearClosed =
            annotationStepsRef.current.length > 2 &&
            pointDistancePx(
              annotationStepsRef.current[0],
              annotationStepsRef.current[annotationStepsRef.current.length - 1],
              markerCanvas
            ) <= FREEHAND_CLOSE_PX
          annotationDraftRef.current = makeFreehandDraft(annotationStepsRef.current, { nearClosed })
          freehandDrawingRef.current = true
          activePointerIdRef.current = event.pointerId
          canvas.setPointerCapture?.(event.pointerId)
          drawStrokeMarkers()
          return
        }

      }

      // brush 工具处理
      if (toolRef.current === 'brush') {
        if (!ensureDrawingBitmap()) return
        const bitmap = nv.drawBitmap
        if (!bitmap) return
        ensureBaseSnapshot(bitmap)
        brushStrokeDirtyRef.current = false
        fillPtsRef.current = []
        markerPtsRef.current = []
        const dpr = nv.uiData?.dpr || 1
        const frac = nv.canvasPos2frac([pos.x * dpr, pos.y * dpr])
        if (frac && frac[0] >= 0) {
          const vox = nv.frac2vox(frac)
          const tile = nv.tileIndex(pos.x * dpr, pos.y * dpr)
          if (tile >= 0 && nv.screenSlices?.[tile]) {
            fillAxCorSagRef.current = nv.screenSlices[tile].axCorSag
            // 锁定Z轴（平面绘制）
            vox[fillAxCorSagRef.current === 0 ? 2 : fillAxCorSagRef.current === 1 ? 1 : 0] = 
              Math.round(vox[fillAxCorSagRef.current === 0 ? 2 : fillAxCorSagRef.current === 1 ? 1 : 0])
            
            // 绘制笔刷
            if (
              drawBrushAt(
                vox,
                fillAxCorSagRef.current,
                brushShapeRef.current,
                brushSizeRef.current,
                activeLabelValueRef.current
              )
            ) {
              brushStrokeDirtyRef.current = true
              requestDrawingRefresh(vox)
            }
            // 记录起始位置
            lastBrushVoxRef.current = [...vox]
          }
        }
        activePointerIdRef.current = event.pointerId
        canvas.setPointerCapture?.(event.pointerId)
        fillActiveRef.current = true
        return
      }

      if (toolRef.current === 'eraser') return
      if (!nv.opts?.drawingEnabled) return

      const dpr = nv.uiData?.dpr || 1
      const tile = nv.tileIndex(pos.x * dpr, pos.y * dpr)
      if (tile < 0 || !nv.screenSlices?.[tile]) return

      fillAxCorSagRef.current = nv.screenSlices[tile].axCorSag
      fillPtsRef.current = []
      markerPtsRef.current = [{ x: pos.x, y: pos.y }]
      activePointerIdRef.current = event.pointerId
      canvas.setPointerCapture?.(event.pointerId)
      const frac0 = nv.canvasPos2frac([pos.x * dpr, pos.y * dpr])
      if (frac0 && frac0[0] >= 0) {
        const vox0 = nv.frac2vox(frac0)
        fillPtsRef.current.push([vox0[0], vox0[1], vox0[2]])
      }
      drawStrokeMarkers()
      fillActiveRef.current = true
    }

    const onPointerMove = (event) => {
      if (toolRef.current === 'freehand') {
        if (!freehandDrawingRef.current) return
        if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
        const markerCanvas = markerCanvasRef.current
        if (!markerCanvas) return
        const pos = getCanvasPos(event)
        const dpr = nv.uiData?.dpr || 1
        const tile = nv.tileIndex(pos.x * dpr, pos.y * dpr)
        if (Number.isInteger(curveTileIndexRef.current) && tile !== curveTileIndexRef.current) return
        const currentPlane = tile >= 0 && nv.screenSlices?.[tile] ? nv.screenSlices[tile].axCorSag : null
        if (currentPlane === null || curvePlaneRef.current === null || currentPlane !== curvePlaneRef.current) return
        const currentSliceIndex = getCurrentSliceIndex(currentPlane)
        if (
          Number.isInteger(curveSliceIndexRef.current) &&
          Number.isInteger(currentSliceIndex) &&
          currentSliceIndex !== curveSliceIndexRef.current
        ) return

        const norm = toStoredPoint(pos, markerCanvas)
        const current = annotationStepsRef.current
        if (!current.length) {
          annotationStepsRef.current = [norm]
          annotationDraftRef.current = makeFreehandDraft([norm], { nearClosed: false })
          drawStrokeMarkers()
          return
        }
        const last = current[current.length - 1]
        const dist = pointDistancePx(last, norm, markerCanvas)
        if (dist < FREEHAND_SAMPLE_STEP_PX) return

        const next = [...current, norm]
        annotationStepsRef.current = compactPoints(next, MAX_MARKER_POINTS)
        const nearClosed =
          annotationStepsRef.current.length > 2 &&
          pointDistancePx(
            annotationStepsRef.current[0],
            annotationStepsRef.current[annotationStepsRef.current.length - 1],
            markerCanvas
          ) <= FREEHAND_CLOSE_PX
        annotationDraftRef.current = makeFreehandDraft(annotationStepsRef.current, { nearClosed })
        drawStrokeMarkers()
        return
      }

      if (!fillActiveRef.current) return
      
      // brush 工具的连续绘制 - 插值绘制线条
      if (toolRef.current === 'brush') {
        if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
        const pos = getCanvasPos(event)
        const dpr = nv.uiData?.dpr || 1
        const frac = nv.canvasPos2frac([pos.x * dpr, pos.y * dpr])
        if (!frac || frac[0] < 0) return
        const vox = nv.frac2vox(frac)
        // 锁定Z轴
        vox[fillAxCorSagRef.current === 0 ? 2 : fillAxCorSagRef.current === 1 ? 1 : 0] = 
          Math.round(vox[fillAxCorSagRef.current === 0 ? 2 : fillAxCorSagRef.current === 1 ? 1 : 0])
        
        // 如果有上一个位置，插值绘制线条
        if (lastBrushVoxRef.current) {
          if (
            drawBrushLine(
              lastBrushVoxRef.current,
              vox,
              fillAxCorSagRef.current,
              brushShapeRef.current,
              brushSizeRef.current,
              activeLabelValueRef.current
            )
          ) {
            brushStrokeDirtyRef.current = true
            requestDrawingRefresh(vox)
          }
        }
        lastBrushVoxRef.current = [...vox]
        return
      }
      
      if (toolRef.current !== 'eraser') return
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
      const pos = getCanvasPos(event)
      // niivue 的坐标换算使用 dpr 缩放后的画布坐标；
      // 这里若直接用 CSS 像素，会在 2D/3D 上引入系统性偏移。
      const dpr = nv.uiData?.dpr || 1
      const frac = nv.canvasPos2frac([pos.x * dpr, pos.y * dpr])
      if (!frac || frac[0] < 0) return
      const vox = nv.frac2vox(frac)
      const prevVox = fillPtsRef.current[fillPtsRef.current.length - 1]
      const prevMarker = markerPtsRef.current[markerPtsRef.current.length - 1]
      if (prevVox) {
        const stepCount = Math.max(
          1,
          Math.ceil(
            Math.max(
              Math.abs(vox[0] - prevVox[0]),
              Math.abs(vox[1] - prevVox[1]),
              Math.abs(vox[2] - prevVox[2]),
              prevMarker ? Math.hypot(pos.x - prevMarker.x, pos.y - prevMarker.y) / 2 : 1
            )
          )
        )
        for (let s = 1; s <= stepCount; s += 1) {
          const t = s / stepCount
          fillPtsRef.current.push([
            prevVox[0] + (vox[0] - prevVox[0]) * t,
            prevVox[1] + (vox[1] - prevVox[1]) * t,
            prevVox[2] + (vox[2] - prevVox[2]) * t
          ])
          if (prevMarker) {
            markerPtsRef.current.push({
              x: prevMarker.x + (pos.x - prevMarker.x) * t,
              y: prevMarker.y + (pos.y - prevMarker.y) * t
            })
          }
        }
      } else {
        fillPtsRef.current.push([vox[0], vox[1], vox[2]])
        markerPtsRef.current.push({ x: pos.x, y: pos.y })
      }
      fillPtsRef.current = compactPoints(fillPtsRef.current, MAX_FILL_POINTS)
      markerPtsRef.current = compactPoints(markerPtsRef.current, MAX_MARKER_POINTS)
      drawStrokeMarkers()
    }

    const onPointerUp = (event) => {
      if (toolRef.current === 'freehand') {
        if (!freehandDrawingRef.current) return
        if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
        // freehand 在 pointerUp 不清空，等待继续加点或按 Enter 完成
        const capturedId = activePointerIdRef.current
        activePointerIdRef.current = null
        freehandDrawingRef.current = false
        if (capturedId !== null && canvas.hasPointerCapture?.(capturedId)) {
          canvas.releasePointerCapture?.(capturedId)
        }
        if (annotationStepsRef.current.length > 0) {
          const markerCanvas = markerCanvasRef.current
          const nearClosed =
            !!markerCanvas &&
            annotationStepsRef.current.length > 2 &&
            pointDistancePx(
              annotationStepsRef.current[0],
              annotationStepsRef.current[annotationStepsRef.current.length - 1],
              markerCanvas
            ) <= FREEHAND_CLOSE_PX
          annotationDraftRef.current = makeFreehandDraft(annotationStepsRef.current, { nearClosed })
          drawStrokeMarkers()
        }
        return
      }

      if (toolRef.current === 'brush') {
        if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
        if (activePointerIdRef.current !== null) {
          canvas.releasePointerCapture?.(activePointerIdRef.current)
        }
        activePointerIdRef.current = null
        fillActiveRef.current = false
        fillPtsRef.current = []
        markerPtsRef.current = []
        lastBrushVoxRef.current = null
        const nv = nvRef.current
        if (brushStrokeDirtyRef.current && nv?.drawBitmap) {
          const pushed = pushSnapshot(nv.drawBitmap)
          if (pushed) {
            const imageKey = getImageKey()
            if (imageKey) actionHistoryRef.current.push({ type: 'mask', imageKey })
          }
          emitDrawingChange('draw')
        }
        brushStrokeDirtyRef.current = false
        return
      }

      if (!fillActiveRef.current) return
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
      const pos = getCanvasPos(event)
      const dpr = nv.uiData?.dpr || 1
      const frac = nv.canvasPos2frac([pos.x * dpr, pos.y * dpr])
      if (frac && frac[0] >= 0) {
        const vox = nv.frac2vox(frac)
        fillPtsRef.current.push([vox[0], vox[1], vox[2]])
        markerPtsRef.current.push({ x: pos.x, y: pos.y })
      }
      if (activePointerIdRef.current !== null) {
        canvas.releasePointerCapture?.(activePointerIdRef.current)
      }
      activePointerIdRef.current = null
      maybeFillClosedStroke()
    }

    const onPointerCancel = () => {
      activePointerIdRef.current = null
      annotationDraftRef.current = null
      lastBrushVoxRef.current = null
      brushStrokeDirtyRef.current = false
      freehandDrawingRef.current = false
      curvePlaneRef.current = null
      curveSliceIndexRef.current = null
      curveTileIndexRef.current = null
      resetFillTracking()
      drawStrokeMarkers()
    }

    // 键盘事件：按回车完成 curve 标注
    const onKeyDown = (event) => {
      if (event.key === 'Enter') {
        // curve 工具使用 annotationStepsRef
        if (toolRef.current === 'freehand' && annotationStepsRef.current.length > 2) {
          event.preventDefault()
          const markerCanvas = markerCanvasRef.current
          const rawPoints = [...annotationStepsRef.current]
          if (!markerCanvas || rawPoints.length < 3) return
          const first = rawPoints[0]
          const last = rawPoints[rawPoints.length - 1]
          const isNearClosed = pointDistancePx(first, last, markerCanvas) <= FREEHAND_CLOSE_PX
          const closedPoints = [...rawPoints]
          if (!isNearClosed || pointDistancePx(first, last, markerCanvas) > 1e-3) {
            closedPoints.push(first)
          } else {
            closedPoints[closedPoints.length - 1] = first
          }

          const maskChanged = rasterizeClosedAnnotationToMask(closedPoints, {
            recordHistory: false,
            emitChange: true,
            axCorSag: curvePlaneRef.current,
            sliceIndex: curveSliceIndexRef.current
          })
          const freehandAnnotation = {
            type: 'freehand',
            points: closedPoints,
            label: '',
            color: getCurrentAnnotationColor(),
            closed: true,
            renderOnMarker: false,
            axCorSag: curvePlaneRef.current,
            sliceIndex: curveSliceIndexRef.current
          }
          addAnnotation(freehandAnnotation, { recordHistory: false, emitChange: false })
          const imageKey = getImageKey()
          if (imageKey) {
            actionHistoryRef.current.push({
              type: 'freehand-complete',
              imageKey,
              hasMask: maskChanged
            })
          }
          if (activePointerIdRef.current !== null) {
            const capturedId = activePointerIdRef.current
            activePointerIdRef.current = null
            if (canvas.hasPointerCapture?.(capturedId)) {
              canvas.releasePointerCapture?.(capturedId)
            }
          }
          freehandDrawingRef.current = false
          annotationStepsRef.current = []
          curvePlaneRef.current = null
          curveSliceIndexRef.current = null
          curveTileIndexRef.current = null
          annotationDraftRef.current = null
          drawStrokeMarkers()
          // 通知父组件 curve 已完成
          emitDrawingChange('curve-complete')
        }

      }
    }

    const onWheel = () => {
      // 滚轮切层时，等 NiiVue 完成场景刷新后重绘 marker，避免上一层辅助线残留。
      scheduleMarkerRedraw(2)
      if (nv.opts?.is2DSliceShader && hasRefreshableDrawingBitmap(nv)) {
        requestDrawingRefresh()
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('keydown', onKeyDown)

    return () => {
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const canShowPlaneSwitch = !!image && canFocusPlanes
  const showPlaneButtonsByPane = canShowPlaneSwitch && !focusedPlane
  const showPlaneButtonsStack = canShowPlaneSwitch && !!focusedPlane
  const firstRowCenter = '25%'
  const secondRowCenter = '75%'
  const centerGapX = '50%'
  const rightGapX = '98.2%'
  const planeButtonStyles = {
    S: { left: centerGapX, top: firstRowCenter, transform: 'translate(-50%, -50%)' },
    A: { left: centerGapX, top: secondRowCenter, transform: 'translate(-50%, -50%)' },
    C: { left: rightGapX, top: firstRowCenter, transform: 'translate(-50%, -50%)' }
  }

  return (
    <div className="viewer-container">
      <canvas ref={canvasRef} className="viewer-canvas" />
      <canvas ref={markerCanvasRef} className="viewer-marker-canvas" />
      {showPlaneButtonsByPane && (
        <div className="viewer-plane-switch-pane" role="group" aria-label="视口切换">
          {FOCUS_PLANES.map((plane) => {
            const active = focusedPlane === plane
            return (
              <button
                key={plane}
                type="button"
                className={`viewer-plane-btn viewer-plane-btn-pane${active ? ' active' : ''}`}
                style={planeButtonStyles[plane]}
                onClick={() => toggleFocusPlaneInternal(plane)}
                title={`切换 ${plane} 到主视口`}
                aria-label={`切换 ${plane} 到主视口`}
              >
                {plane}
              </button>
            )
          })}
        </div>
      )}
      {showPlaneButtonsStack && (
        <>
          <div className="viewer-plane-switch" role="group" aria-label="视口切换">
            {FOCUS_PLANES.map((plane) => {
              const active = focusedPlane === plane
              return (
                <button
                  key={plane}
                  type="button"
                  className={`viewer-plane-btn${active ? ' active' : ''}`}
                  onClick={() => toggleFocusPlaneInternal(plane)}
                  title={active ? '返回四视口' : `切换 ${plane} 到主视口`}
                  aria-label={active ? `返回四视口（当前 ${plane}）` : `切换 ${plane} 到主视口`}
                >
                  {active ? '▣' : plane}
                </button>
              )
            })}
          </div>
        </>
      )}
      {!image && <div className="empty">上传 .nii/.nii.gz 或 .zip 开始</div>}
    </div>
  )
})

export default Viewer
