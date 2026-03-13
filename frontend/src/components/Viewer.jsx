import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Niivue, NVImage } from '@niivue/niivue'

const isRasterImageName = (name) => /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(name || '')

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

  const safeCall = (fn, ...args) => {
    const nv = nvRef.current
    if (!nv || typeof nv[fn] !== 'function') return
    nv[fn](...args)
  }

  const ensureBaseSnapshot = (bitmap) => {
    const history = historyRef.current
    if (history.stack.length > 0 || !bitmap) return
    const empty = new Uint8Array(bitmap.length)
    history.stack = [empty]
    history.index = 0
  }

  const pushSnapshot = (bitmap) => {
    if (!bitmap) return
    const history = historyRef.current
    if (history.index < history.stack.length - 1) {
      history.stack = history.stack.slice(0, history.index + 1)
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

    if (currentTool === 'pan') {
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
    const markerCanvas = markerCanvasRef.current
    const ctx = markerCanvas?.getContext?.('2d')
    if (ctx && markerCanvas) {
      ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height)
    }
  }

  const drawStrokeMarkers = () => {
    const markerCanvas = markerCanvasRef.current
    if (!markerCanvas) return
    const ctx = markerCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height)
    const pts = markerPtsRef.current
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
    const dist = Math.sqrt(dx * dx + dy * dy)
    const closed = dist <= 3.8

    if (closed) {
      nv.drawPenFillPts = pts
      nv.drawPenAxCorSag = axCorSag
      nv.drawPenFilled()
    }

    resetFillTracking()
  }

  useImperativeHandle(ref, () => ({
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
        if (action !== 'draw') return
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
      if (nv.volumes?.length) {
        const existing = [...nv.volumes]
        existing.forEach((vol) => nv.removeVolume(vol))
      }
      if (typeof nv.closeDrawing === 'function') {
        nv.closeDrawing()
      }

      historyRef.current = { stack: [], index: -1 }
      await nv.loadFromArrayBuffer(image.data, image.name)
      if (cancelled) return

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
        const maskVolume = await NVImage.loadFromUrl({ url: image.mask, name: maskName })
        if (cancelled) return
        nv.loadDrawing(maskVolume)
      } else if (typeof nv.closeDrawing === 'function') {
        nv.closeDrawing()
      }

      applyToolSettings(toolRef.current, brushSize, activeLabelValue)
      if (typeof onDrawingChange === 'function') {
        onDrawingChange('load')
      }
    }

    load()
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
      if (toolRef.current !== 'brush') return
      if (!nv.opts?.drawingEnabled) return

      const pos = getCanvasPos(event)
      const dpr = nv.uiData?.dpr || 1
      const tile = nv.tileIndex(pos.x * dpr, pos.y * dpr)
      if (tile < 0 || !nv.screenSlices?.[tile]) return

      fillAxCorSagRef.current = nv.screenSlices[tile].axCorSag
      fillPtsRef.current = []
      markerPtsRef.current = [{ x: pos.x, y: pos.y }]
      drawStrokeMarkers()
      fillActiveRef.current = true
    }

    const onPointerMove = (event) => {
      if (!fillActiveRef.current) return
      if (toolRef.current !== 'brush') return
      const pos = getCanvasPos(event)
      // niivue 的坐标换算使用 dpr 缩放后的画布坐标；
      // 这里若直接用 CSS 像素，会在 2D/3D 上引入系统性偏移。
      const dpr = nv.uiData?.dpr || 1
      const frac = nv.canvasPos2frac([pos.x * dpr, pos.y * dpr])
      if (!frac || frac[0] < 0) return
      const vox = nv.frac2vox(frac)
      fillPtsRef.current.push([vox[0], vox[1], vox[2]])
      markerPtsRef.current.push({ x: pos.x, y: pos.y })
      if (markerPtsRef.current.length > 800) {
        markerPtsRef.current.splice(0, markerPtsRef.current.length - 800)
      }
      drawStrokeMarkers()
    }

    const onPointerUp = () => {
      if (!fillActiveRef.current) return
      maybeFillClosedStroke()
    }

    const onPointerLeave = () => {
      resetFillTracking()
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)

    return () => {
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
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
