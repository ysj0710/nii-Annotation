import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Niivue, NVImage } from '@niivue/niivue'

const isRasterImageName = (name) => /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(name || '')
const MASK_TOOLS = new Set(['brush', 'eraser'])
const ANNOTATION_TOOLS = new Set([
  'hu',
  'ellipse',
  'rect',
  'angle',
  'cobb',
  'length',
  'arrow',
  'text',
  'ratio',
  'curve',
  'dynamic',
  'freehand',
  'bidirectional'
])

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

const shouldResetWindow = (volume) => {
  const calMin = Number(volume?.cal_min)
  const calMax = Number(volume?.cal_max)
  const robustMin = Number(volume?.robust_min)
  const robustMax = Number(volume?.robust_max)
  if (!Number.isFinite(robustMin) || !Number.isFinite(robustMax) || robustMax <= robustMin) return false
  if (!Number.isFinite(calMin) || !Number.isFinite(calMax) || calMax <= calMin) return true
  const calSpan = calMax - calMin
  const robustSpan = robustMax - robustMin
  return calSpan <= Math.max(1e-6, robustSpan * 1e-3)
}

const formatNumber = (value, digits = 1) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--'
  return num.toFixed(digits)
}

const Viewer = forwardRef(function Viewer(
  { image, tool, brushSize, activeLabelValue, labels = [], radiological2D = true, onDrawingChange },
  ref
) {
  const canvasRef = useRef(null)
  const markerCanvasRef = useRef(null)
  const nvRef = useRef(null)
  const historyRef = useRef({ stack: [], index: -1 })
  const toolRef = useRef(tool)
  const crosshairWidthRef = useRef(null)
  const fillPtsRef = useRef([])
  const fillAxCorSagRef = useRef(0)
  const fillActiveRef = useRef(false)
  const markerPtsRef = useRef([])
  const activePointerIdRef = useRef(null)
  const annotationsByImageRef = useRef(new Map())
  const annotationDraftRef = useRef(null)
  const annotationStepsRef = useRef([])
  const curveLastTapRef = useRef(0)
  const MAX_MARKER_POINTS = 24000
  const MAX_FILL_POINTS = 32000

  const getImageKey = () => image?.id || '__no_image__'
  const getCurrentAnnotations = () => annotationsByImageRef.current.get(getImageKey()) || []
  const setCurrentAnnotations = (next) => {
    annotationsByImageRef.current.set(getImageKey(), next)
  }
  const addAnnotation = (annotation) => {
    setCurrentAnnotations([...getCurrentAnnotations(), annotation])
  }
  const getCurrentAnnotationColor = () =>
    labels.find((item) => Number(item.value || 0) === Number(activeLabelValue || 0))?.color || '#60a5fa'

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
    if (!bitmap) return
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
        return
      }
    }
    history.stack.push(new Uint8Array(bitmap))
    history.index = history.stack.length - 1
  }

  const applySnapshot = (snapshot) => {
    const nv = nvRef.current
    if (!nv || !snapshot) return
    if (!nv.drawBitmap || nv.drawBitmap.length !== snapshot.length) {
      nv.drawBitmap = new Uint8Array(snapshot.length)
    }
    nv.drawBitmap.set(snapshot)
    if (typeof nv.refreshDrawing === 'function') {
      nv.refreshDrawing(true)
    }
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

  const toPxPoint = (pt, canvas) => ({
    x: Number(pt?.x || 0) * canvas.width,
    y: Number(pt?.y || 0) * canvas.height
  })

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
    const points = (annotation?.points || []).map((p) => toPxPoint(p, canvas))
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

    if (annotation.type === 'rect' || annotation.type === 'ratio' || annotation.type === 'ellipse') {
      const p0 = points[0]
      const p1 = points[1] || points[0]
      const x = Math.min(p0.x, p1.x)
      const y = Math.min(p0.y, p1.y)
      const w = Math.abs(p1.x - p0.x)
      const h = Math.abs(p1.y - p0.y)
      if (annotation.type === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        ctx.strokeRect(x, y, w, h)
      }
      drawLabel(annotation.label, x, y)
    } else if (annotation.type === 'line' || annotation.type === 'arrow') {
      const p0 = points[0]
      const p1 = points[1] || points[0]
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.lineTo(p1.x, p1.y)
      ctx.stroke()
      if (annotation.type === 'arrow') {
        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x)
        const len = 10
        ctx.beginPath()
        ctx.moveTo(p1.x, p1.y)
        ctx.lineTo(p1.x - len * Math.cos(ang - Math.PI / 7), p1.y - len * Math.sin(ang - Math.PI / 7))
        ctx.moveTo(p1.x, p1.y)
        ctx.lineTo(p1.x - len * Math.cos(ang + Math.PI / 7), p1.y - len * Math.sin(ang + Math.PI / 7))
        ctx.stroke()
      }
      drawLabel(annotation.label, p1.x, p1.y)
    } else if (annotation.type === 'bidirectional') {
      const p0 = points[0]
      const p1 = points[1] || points[0]
      const mx = (p0.x + p1.x) / 2
      const my = (p0.y + p1.y) / 2
      const dx = p1.x - p0.x
      const dy = p1.y - p0.y
      const len = Math.hypot(dx, dy) / 2
      const nx = len ? -dy / Math.hypot(dx, dy) : 0
      const ny = len ? dx / Math.hypot(dx, dy) : 0
      ctx.beginPath()
      ctx.moveTo(p0.x, p0.y)
      ctx.lineTo(p1.x, p1.y)
      ctx.moveTo(mx - nx * len * 0.5, my - ny * len * 0.5)
      ctx.lineTo(mx + nx * len * 0.5, my + ny * len * 0.5)
      ctx.stroke()
      drawLabel(annotation.label, p1.x, p1.y)
    } else if (annotation.type === 'angle' || annotation.type === 'cobb') {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      ctx.lineTo(points[1].x, points[1].y)
      ctx.lineTo(points[2].x, points[2].y)
      if (annotation.type === 'cobb' && points[3]) {
        ctx.moveTo(points[2].x, points[2].y)
        ctx.lineTo(points[3].x, points[3].y)
      }
      ctx.stroke()
      drawLabel(annotation.label, points[1].x, points[1].y)
    } else if (annotation.type === 'text' || annotation.type === 'hu') {
      const p = points[0]
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
      ctx.fill()
      drawLabel(annotation.label, p.x, p.y)
    } else {
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.stroke()
      drawLabel(annotation.label, points[points.length - 1].x, points[points.length - 1].y)
    }
    ctx.restore()
  }

  const drawStrokeMarkers = () => {
    const markerCanvas = markerCanvasRef.current
    if (!markerCanvas) return
    const ctx = markerCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height)
    const annotations = getCurrentAnnotations()
    for (const annotation of annotations) {
      drawAnnotation(ctx, markerCanvas, annotation)
    }
    if (annotationDraftRef.current) {
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
        const fillLabel = Math.max(1, Math.min(255, Number(activeLabelValue || 1)))

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
          if (typeof nv.refreshDrawing === 'function') {
            nv.refreshDrawing(true)
          }
          pushSnapshot(nv.drawBitmap)
          if (typeof onDrawingChange === 'function') {
            onDrawingChange('draw')
          }
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

  useImperativeHandle(ref, () => ({
    undoToolAction: () => {
      if (isAnnotationTool(toolRef.current)) {
        const current = getCurrentAnnotations()
        if (!current.length) return false
        setCurrentAnnotations(current.slice(0, -1))
        drawStrokeMarkers()
        return true
      }
      const history = historyRef.current
      if (history.index <= 0) return false
      history.index -= 1
      applySnapshot(history.stack[history.index])
      if (typeof onDrawingChange === 'function') onDrawingChange('undo')
      return true
    },
    clearAnnotations: () => {
      const key = getImageKey()
      annotationsByImageRef.current.delete(key)
      annotationDraftRef.current = null
      annotationStepsRef.current = []
      resetFillTracking()
      drawStrokeMarkers()
    },
    undo: () => {
      const history = historyRef.current
      if (history.index <= 0) return
      history.index -= 1
      applySnapshot(history.stack[history.index])
      if (typeof onDrawingChange === 'function') {
        onDrawingChange('undo')
      }
    },
    redo: () => {
      const history = historyRef.current
      if (history.index >= history.stack.length - 1) return
      history.index += 1
      applySnapshot(history.stack[history.index])
      if (typeof onDrawingChange === 'function') {
        onDrawingChange('redo')
      }
    },
    clear: () => {
      const nv = nvRef.current
      if (!nv?.drawBitmap) return
      ensureBaseSnapshot(nv.drawBitmap)
      const empty = new Uint8Array(nv.drawBitmap.length)
      pushSnapshot(empty)
      applySnapshot(empty)
      if (typeof onDrawingChange === 'function') {
        onDrawingChange('clear')
      }
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
        crosshairWidthRef.current = nv.opts.crosshairWidth
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
      nvRef.current.onDrawingChanged = (action) => {
        const nv = nvRef.current
        if (!nv?.drawBitmap) return
        ensureBaseSnapshot(nv.drawBitmap)
        pushSnapshot(nv.drawBitmap)
        if (typeof onDrawingChange === 'function') {
          onDrawingChange(action)
        }
      }
      applyToolSettings(toolRef.current, brushSize, activeLabelValue)
    }
  }, [])

  useEffect(() => {
    toolRef.current = tool
    annotationDraftRef.current = null
    annotationStepsRef.current = []
    drawStrokeMarkers()
  }, [tool])

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
      if (nv.volumes?.length) {
        const existing = [...nv.volumes]
        existing.forEach((vol) => nv.removeVolume(vol))
      }
      if (typeof nv.closeDrawing === 'function') {
        nv.closeDrawing()
      }

      historyRef.current = { stack: [], index: -1 }
      await nv.loadFromArrayBuffer(imageBuffer, image.name)
      if (cancelled) return

      if (typeof nv.setInterpolation === 'function') {
        // 使用最近邻插值，让视口细节与缩略图观感更一致。
        nv.setInterpolation(true)
      }

      const baseVolume = nv.volumes?.[0]
      if (baseVolume && !image.isMaskOnly && shouldResetWindow(baseVolume)) {
        baseVolume.cal_min = Number(baseVolume.robust_min)
        baseVolume.cal_max = Number(baseVolume.robust_max)
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
      const sourceName = image?.displayName || image?.name
      const isRaster2D = isRasterImageName(sourceName)
      if (is2D) {
        nv.setRadiologicalConvention(isRaster2D ? true : !!radiological2D)
        nv.setSliceType(nv.sliceTypeAxial)
      } else {
        nv.setSliceType(nv.sliceTypeMultiplanar)
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
        }
      } else if (typeof nv.closeDrawing === 'function') {
        nv.closeDrawing()
      }

      applyToolSettings(toolRef.current, brushSize, activeLabelValue)
      drawStrokeMarkers()
      if (typeof onDrawingChange === 'function') {
        onDrawingChange('load')
      }
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
        const now = Date.now()
        const markerCanvas = markerCanvasRef.current
        if (!markerCanvas) return
        const norm = toNormPoint(pos, markerCanvas)

        if (currentTool === 'text') {
          const text = window.prompt('请输入标注文字', '文字标注')
          if (text) addAnnotation({ type: 'text', points: [norm], label: text, color: getCurrentAnnotationColor() })
          drawStrokeMarkers()
          return
        }
        if (currentTool === 'hu') {
          const value = getVoxelValue(pos)
          addAnnotation({
            type: 'hu',
            points: [norm],
            label: `HU ${value === null ? '--' : formatNumber(value, 1)}`,
            color: getCurrentAnnotationColor()
          })
          drawStrokeMarkers()
          return
        }

        if (currentTool === 'angle' || currentTool === 'cobb') {
          annotationStepsRef.current = [...annotationStepsRef.current, norm]
          const need = currentTool === 'angle' ? 3 : 4
          if (annotationStepsRef.current.length >= need) {
            const pts = annotationStepsRef.current.slice(0, need)
            const p0 = toPxPoint(pts[0], markerCanvas)
            const p1 = toPxPoint(pts[1], markerCanvas)
            const p2 = toPxPoint(pts[2], markerCanvas)
            const angle = computeAngle(p0, p1, p2)
            addAnnotation({
              type: currentTool,
              points: pts,
              label: `${formatNumber(angle, 1)}°`,
              color: getCurrentAnnotationColor()
            })
            annotationStepsRef.current = []
          }
          annotationDraftRef.current =
            annotationStepsRef.current.length > 1
              ? { type: currentTool, points: annotationStepsRef.current, label: '继续点击完成', color: getCurrentAnnotationColor() }
              : null
          drawStrokeMarkers()
          return
        }

        if (currentTool === 'curve') {
          const gap = now - curveLastTapRef.current
          curveLastTapRef.current = now
          annotationStepsRef.current = [...annotationStepsRef.current, norm]
          if (gap < 280 && annotationStepsRef.current.length > 2) {
            addAnnotation({
              type: 'curve',
              points: [...annotationStepsRef.current],
              label: `${annotationStepsRef.current.length}点`,
              color: getCurrentAnnotationColor()
            })
            annotationStepsRef.current = []
            annotationDraftRef.current = null
          } else {
            annotationDraftRef.current = {
              type: 'curve',
              points: [...annotationStepsRef.current],
              label: '双击结束',
              color: getCurrentAnnotationColor()
            }
          }
          drawStrokeMarkers()
          return
        }

        // drag based tools
        annotationDraftRef.current = {
          type: currentTool === 'length' ? 'line' : currentTool,
          points: [norm, norm],
          label: '',
          color: getCurrentAnnotationColor()
        }
        if (currentTool === 'freehand' || currentTool === 'dynamic') {
          annotationDraftRef.current.points = [norm]
        }
        activePointerIdRef.current = event.pointerId
        canvas.setPointerCapture?.(event.pointerId)
        drawStrokeMarkers()
        return
      }

      if (toolRef.current !== 'brush') return
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
      if (isAnnotationTool(toolRef.current)) {
        if (!annotationDraftRef.current) return
        if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
        const markerCanvas = markerCanvasRef.current
        if (!markerCanvas) return
        const pos = getCanvasPos(event)
        const norm = toNormPoint(pos, markerCanvas)
        const draft = annotationDraftRef.current
        if (toolRef.current === 'freehand' || toolRef.current === 'dynamic') {
          draft.points = [...draft.points, norm]
          draft.points = compactPoints(draft.points, MAX_MARKER_POINTS)
        } else {
          draft.points[1] = norm
        }
        annotationDraftRef.current = { ...draft }
        drawStrokeMarkers()
        return
      }

      if (!fillActiveRef.current) return
      if (toolRef.current !== 'brush') return
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
      if (isAnnotationTool(toolRef.current)) {
        if (!annotationDraftRef.current) return
        if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) return
        const markerCanvas = markerCanvasRef.current
        const pos = getCanvasPos(event)
        if (markerCanvas) {
          const norm = toNormPoint(pos, markerCanvas)
          const draft = annotationDraftRef.current
          if (draft.points.length > 1) draft.points[draft.points.length - 1] = norm
          const pxPoints = draft.points.map((p) => toPxPoint(p, markerCanvas))
          if (toolRef.current === 'length') {
            draft.label = `${formatNumber(lineDistanceMM(pxPoints[0], pxPoints[1]), 2)}mm`
          } else if (toolRef.current === 'ratio') {
            const w = Math.abs(pxPoints[1].x - pxPoints[0].x)
            const h = Math.abs(pxPoints[1].y - pxPoints[0].y)
            draft.label = `比值 ${formatNumber(w / Math.max(1e-6, h), 2)}`
          } else if (toolRef.current === 'bidirectional') {
            draft.label = `${formatNumber(lineDistanceMM(pxPoints[0], pxPoints[1]), 2)}mm`
          } else if (toolRef.current === 'arrow') {
            draft.label = '箭头标注'
          } else if (toolRef.current === 'dynamic') {
            draft.points = smoothPath(draft.points)
            draft.label = `${draft.points.length}点`
          } else if (toolRef.current === 'freehand') {
            draft.label = `${draft.points.length}点`
          }
          addAnnotation({ ...draft })
        }
        annotationDraftRef.current = null
        activePointerIdRef.current = null
        canvas.releasePointerCapture?.(event.pointerId)
        drawStrokeMarkers()
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
      resetFillTracking()
      drawStrokeMarkers()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)

    return () => {
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [])

  return (
    <div className="viewer-container">
      <canvas ref={canvasRef} className="viewer-canvas" />
      <canvas ref={markerCanvasRef} className="viewer-marker-canvas" />
      {!image && <div className="empty">上传 .nii/.nii.gz 或 .zip 开始</div>}
    </div>
  )
})

export default Viewer
