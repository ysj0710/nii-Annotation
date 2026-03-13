import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Layout,
  Button,
  Upload,
  Space,
  Card,
  Radio,
  Input,
  Slider,
  Tooltip,
  Popover,
  Switch,
  Message
} from '@arco-design/web-react'
import {
  IconUpload,
  IconPlus,
  IconUndo,
  IconRedo,
  IconDelete,
  IconFolder,
  IconBrush,
  IconEraser,
  IconDragArrow,
  IconTool,
  IconTags,
  IconSearch
} from '@arco-design/web-react/icon'
import JSZip from 'jszip'
import * as nifti from 'nifti-reader-js'
import { Niivue } from '@niivue/niivue'
import Viewer from './components/Viewer.jsx'
import { getAllImages, getImageById, saveImages, updateImage, deleteImage } from './utils/imageStore.js'

const { Header, Sider, Content } = Layout

const labelPalette = ['#FF6B6B', '#4D96FF', '#6BCB77', '#FFD93D', '#845EC2', '#FF9671']
const THUMBNAIL_SIZE = 240

const normalizeBaseName = (name) => {
  if (!name) return ''
  const clean = name.split('/').pop()
  return clean
    .toLowerCase()
    .replace(/\.(nii\.gz|nii|nrrd|dicom|dcm|png|jpe?g|bmp|webp|tif|tiff)$/i, '')
}

const fileStem = (name) =>
  (name || '')
    .split('/')
    .pop()
    .replace(/\.(nii\.gz|nii|nrrd|dicom|dcm|png|jpe?g|bmp|webp|tif|tiff)$/i, '')

const stripMaskTokens = (base) =>
  base
    .replace(/(mask|seg|label)/gi, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')

const isNiftiFile = (name) => /\.nii(\.gz)?$/i.test(name)
const isNrrdFile = (name) => /\.nrrd$/i.test(name)
const isDicomFile = (name) => /\.(dcm|dicom)$/i.test(name)
const isImageFile = (name) => /\.(png|jpe?g|bmp|webp|tif|tiff)$/i.test(name)
const isZipFile = (name) => /\.zip$/i.test(name)
const isMaskName = (name) => /(mask|seg|label)/i.test(name)
const isSupportedImageFile = (name) =>
  isNiftiFile(name) || isNrrdFile(name) || isDicomFile(name) || isImageFile(name)

const getMimeFromName = (name) => {
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff'
  return 'application/octet-stream'
}

const toInternalNiftiName = (name) => `${fileStem(name)}.nii`

const getPngSpacingMM = (buffer) => {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  if (bytes.length < 33) return null
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < pngSig.length; i += 1) {
    if (bytes[i] !== pngSig[i]) return null
  }
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const dataOffset = offset + 8
    if (type === 'pHYs' && length >= 9 && dataOffset + 9 <= bytes.length) {
      const xPpm = view.getUint32(dataOffset, false)
      const yPpm = view.getUint32(dataOffset + 4, false)
      const unit = bytes[dataOffset + 8]
      if (unit === 1 && xPpm > 0 && yPpm > 0) {
        return [1000 / xPpm, 1000 / yPpm]
      }
      return null
    }
    offset += 12 + length
  }
  return null
}

const getJpegSpacingMM = (buffer) => {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xd9 || marker === 0xda) break
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2 || offset + 2 + length > bytes.length) break
    if (marker === 0xe0 && length >= 16) {
      const idStart = offset + 4
      const isJfif =
        bytes[idStart] === 0x4a &&
        bytes[idStart + 1] === 0x46 &&
        bytes[idStart + 2] === 0x49 &&
        bytes[idStart + 3] === 0x46 &&
        bytes[idStart + 4] === 0x00
      if (isJfif) {
        const units = bytes[idStart + 7]
        const xDen = (bytes[idStart + 8] << 8) | bytes[idStart + 9]
        const yDen = (bytes[idStart + 10] << 8) | bytes[idStart + 11]
        if (xDen > 0 && yDen > 0) {
          if (units === 1) return [25.4 / xDen, 25.4 / yDen]
          if (units === 2) return [10 / xDen, 10 / yDen]
        }
      }
    }
    offset += 2 + length
  }
  return null
}

const readRasterSpacingMM = (buffer, name) => {
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.png')) {
    return getPngSpacingMM(buffer) || [1, 1]
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return getJpegSpacingMM(buffer) || [1, 1]
  }
  return [1, 1]
}

const isNiftiBuffer = (buffer) => {
  if (!(buffer instanceof ArrayBuffer)) return false
  if (nifti.isNIFTI(buffer)) return true
  if (nifti.isCompressed(buffer)) {
    try {
      const decompressed = nifti.decompress(buffer)
      return nifti.isNIFTI(decompressed)
    } catch {
      return false
    }
  }
  return false
}

const encodeNiftiUInt8 = ({ width, height, depth = 1, components = 1, voxels, spacing = [1, 1, 1] }) => {
  const headerSize = 348
  const extSize = 4
  const imageSize = width * height * depth * components
  const out = new ArrayBuffer(headerSize + extSize + imageSize)
  const dv = new DataView(out)
  const bytes = new Uint8Array(out)

  dv.setInt32(0, 348, true)
  dv.setInt16(40, components > 1 ? 5 : 3, true)
  dv.setInt16(42, width, true)
  dv.setInt16(44, height, true)
  dv.setInt16(46, depth, true)
  dv.setInt16(48, 1, true)
  dv.setInt16(50, components, true)
  dv.setInt16(70, 2, true)
  dv.setInt16(72, 8, true)
  dv.setInt16(68, components > 1 ? 1007 : 0, true)

  dv.setFloat32(76, 1, true)
  dv.setFloat32(80, Number(spacing[0] || 1), true)
  dv.setFloat32(84, Number(spacing[1] || 1), true)
  dv.setFloat32(88, Number(spacing[2] || 1), true)

  dv.setFloat32(108, headerSize + extSize, true)
  dv.setInt16(254, 0, true)
  dv.setInt16(252, 1, true)
  dv.setInt8(123, 10)
  // 与 ITK-SNAP 常见 2D 影像约定对齐：X/Y 负方向，避免 JPG 与配对 NII 方向不一致。
  dv.setFloat32(256, 0, true)
  dv.setFloat32(260, 0, true)
  dv.setFloat32(264, 1, true)
  dv.setFloat32(268, 0, true)
  dv.setFloat32(272, 0, true)
  dv.setFloat32(276, 0, true)

  const sx = Number(spacing[0] || 1)
  const sy = Number(spacing[1] || 1)
  dv.setFloat32(280, -sx, true)
  dv.setFloat32(284, 0, true)
  dv.setFloat32(288, 0, true)
  dv.setFloat32(292, 0, true)
  dv.setFloat32(296, 0, true)
  dv.setFloat32(300, -sy, true)
  dv.setFloat32(304, 0, true)
  dv.setFloat32(308, 0, true)
  dv.setFloat32(312, 0, true)
  dv.setFloat32(316, 0, true)
  dv.setFloat32(320, 1, true)
  dv.setFloat32(324, 0, true)

  bytes[344] = 0x6e
  bytes[345] = 0x2b
  bytes[346] = 0x31
  bytes[347] = 0x00

  bytes.set(voxels, headerSize + extSize)
  return out
}

const rasterToNifti = async (buffer, name) => {
  const blob = new Blob([buffer], { type: getMimeFromName(name) })
  let bitmap = null
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    bitmap = await createImageBitmap(blob)
  }
  const width = Math.max(1, bitmap.width)
  const height = Math.max(1, bitmap.height)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    bitmap.close?.()
    throw new Error('无法创建图片解码画布')
  }

  ctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const imageData = ctx.getImageData(0, 0, width, height)
  const rgba = imageData.data
  const voxels = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    voxels[j] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)))
  }

  const [sx, sy] = readRasterSpacingMM(buffer, name)
  const niiBuffer = encodeNiftiUInt8({
    width,
    height,
    depth: 1,
    components: 1,
    voxels,
    spacing: [sx, sy, 1]
  })

  return {
    buffer: niiBuffer,
    internalName: toInternalNiftiName(name),
    spatialMeta: {
      origin: [0, 0, 0],
      spacing: [sx, sy, 1],
      direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
      sourceSummary: {
        dimensions: [width, height, 1],
        timePoints: 1,
        componentsPerVoxel: 3,
        voxelSpacing: [sx, sy, 1],
        origin: [0, 0, 0],
        orientation: 'RAI',
        dataType: 'unsigned_char'
      },
      width,
      height
    }
  }
}

const normalizeRasterNiftiToScalar = (buffer, sourceName = '') => {
  const { header, voxels, width, height, depth, components } = decodeNifti(buffer)
  const sx = Math.max(1e-6, Number(header?.pixDims?.[1] || 1))
  const sy = Math.max(1e-6, Number(header?.pixDims?.[2] || 1))
  const sz = Math.max(1e-6, Number(header?.pixDims?.[3] || 1))

  if (components <= 1 && header?.datatypeCode === nifti.NIFTI1.TYPE_UINT8) {
    return {
      buffer,
      internalName: toInternalNiftiName(sourceName || 'image'),
      spatialMeta: {
        origin: [0, 0, 0],
        spacing: [sx, sy, sz],
        direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
        sourceSummary: {
          dimensions: [width, height, depth],
          timePoints: 1,
          componentsPerVoxel: 3,
          voxelSpacing: [sx, sy, sz],
          origin: [0, 0, 0],
          orientation: 'RAI',
          dataType: 'unsigned_char'
        },
        width,
        height
      }
    }
  }

  const out = new Uint8Array(width * height * depth)
  const wh = width * height
  const frameSize = wh * depth
  for (let z = 0; z < depth; z += 1) {
    const zOff = z * wh
    for (let y = 0; y < height; y += 1) {
      const yOff = zOff + y * width
      for (let x = 0; x < width; x += 1) {
        const outIdx = yOff + x
        let gray = 0
        if (components >= 3) {
          const r = Number(voxels[outIdx] || 0)
          const g = Number(voxels[outIdx + frameSize] || 0)
          const b = Number(voxels[outIdx + 2 * frameSize] || 0)
          gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
        } else {
          gray = Number(voxels[outIdx] || 0)
        }
        out[outIdx] = Math.max(0, Math.min(255, gray))
      }
    }
  }

  const normalized = encodeNiftiUInt8({
    width,
    height,
    depth,
    components: 1,
    voxels: out,
    spacing: [sx, sy, sz]
  })

  return {
    buffer: normalized,
    internalName: toInternalNiftiName(sourceName || 'image'),
    spatialMeta: {
      origin: [0, 0, 0],
      spacing: [sx, sy, sz],
      direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1],
      sourceSummary: {
        dimensions: [width, height, depth],
        timePoints: 1,
        componentsPerVoxel: 3,
        voxelSpacing: [sx, sy, sz],
        origin: [0, 0, 0],
        orientation: 'RAI',
        dataType: 'unsigned_char'
      },
      width,
      height
    }
  }
}

const isLikelyDicomBuffer = (buffer) => {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 132) return false
  const bytes = new Uint8Array(buffer, 128, 4)
  return bytes[0] === 68 && bytes[1] === 73 && bytes[2] === 67 && bytes[3] === 77
}

const arrayBufferFrom = (data) => {
  if (!data) return null
  if (data instanceof ArrayBuffer) return data
  if (data instanceof Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
  return null
}

const hashBuffer = async (buffer) => {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = Array.from(new Uint8Array(digest))
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

const hasNonZeroMaskNifti = (maskData) => {
  const buffer = arrayBufferFrom(maskData)
  if (!buffer) return false
  try {
    let source = buffer
    if (nifti.isCompressed(source)) {
      source = nifti.decompress(source)
    }
    if (!nifti.isNIFTI(source)) return false
    const header = nifti.readHeader(source)
    const imageBuffer = nifti.readImage(header, source)
    const datatype = header.datatypeCode

    let voxels
    switch (datatype) {
      case nifti.NIFTI1.TYPE_UINT8:
        voxels = new Uint8Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_INT8:
        voxels = new Int8Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_UINT16:
        voxels = new Uint16Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_INT16:
        voxels = new Int16Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_UINT32:
        voxels = new Uint32Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_INT32:
        voxels = new Int32Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_FLOAT32:
        voxels = new Float32Array(imageBuffer)
        break
      case nifti.NIFTI1.TYPE_FLOAT64:
        voxels = new Float64Array(imageBuffer)
        break
      default:
        voxels = new Uint8Array(imageBuffer)
        break
    }
    for (let i = 0; i < voxels.length; i += 1) {
      if (Number(voxels[i]) !== 0) return true
    }
    return false
  } catch (error) {
    console.warn('检查 mask 非零体素失败', error)
    return false
  }
}

const createRasterThumbnail = async (buffer, _name) => {
  const blob = new Blob([buffer])
  const bitmap = await createImageBitmap(blob)
  const outCanvas = document.createElement('canvas')
  outCanvas.width = THUMBNAIL_SIZE
  outCanvas.height = THUMBNAIL_SIZE
  const outCtx = outCanvas.getContext('2d')
  if (!outCtx) return ''

  outCtx.fillStyle = '#000'
  outCtx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE)

  const scale = Math.min(THUMBNAIL_SIZE / bitmap.width, THUMBNAIL_SIZE / bitmap.height)
  const drawW = Math.max(1, Math.round(bitmap.width * scale))
  const drawH = Math.max(1, Math.round(bitmap.height * scale))
  const dx = Math.floor((THUMBNAIL_SIZE - drawW) / 2)
  const dy = Math.floor((THUMBNAIL_SIZE - drawH) / 2)
  outCtx.drawImage(bitmap, dx, dy, drawW, drawH)
  bitmap.close?.()
  return outCanvas.toDataURL('image/png')
}

const decodeNifti = (buffer) => {
  let source = buffer
  if (nifti.isCompressed(source)) {
    source = nifti.decompress(source)
  }
  if (!nifti.isNIFTI(source)) {
    throw new Error('Not a NIfTI file')
  }

  const header = nifti.readHeader(source)
  const imageBuffer = nifti.readImage(header, source)
  const datatype = header.datatypeCode

  let voxels
  switch (datatype) {
    case nifti.NIFTI1.TYPE_UINT8:
      voxels = new Uint8Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_INT8:
      voxels = new Int8Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_UINT16:
      voxels = new Uint16Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_INT16:
      voxels = new Int16Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_UINT32:
      voxels = new Uint32Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_INT32:
      voxels = new Int32Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_FLOAT32:
      voxels = new Float32Array(imageBuffer)
      break
    case nifti.NIFTI1.TYPE_FLOAT64:
      voxels = new Float64Array(imageBuffer)
      break
    default:
      voxels = new Uint8Array(imageBuffer)
      break
  }

  const width = Math.max(1, Number(header.dims?.[1] || 1))
  const height = Math.max(1, Number(header.dims?.[2] || 1))
  const depth = Math.max(1, Number(header.dims?.[3] || 1))
  const components = Math.max(1, Number(header.dims?.[5] || 1))
  return { header, voxels, width, height, depth, components }
}

const createNiftiThumbnail = async (buffer, _name, { isMask = false } = {}) => {
  const { voxels, width, height, depth, components } = decodeNifti(buffer)
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = width
  srcCanvas.height = height
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })
  if (!srcCtx) return ''

  const z = Math.floor((depth - 1) / 2)
  const wh = width * height
  const sliceBase = z * wh
  const imageData = srcCtx.createImageData(width, height)

  if (isMask) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const vIdx = sliceBase + y * width + x
        const pixel = (y * width + x) * 4
        const value = Number(voxels[vIdx] || 0)
        const on = value > 0
        imageData.data[pixel] = on ? 255 : 0
        imageData.data[pixel + 1] = on ? 255 : 0
        imageData.data[pixel + 2] = on ? 255 : 0
        imageData.data[pixel + 3] = 255
      }
    }
  } else if (components >= 3) {
    const frameSize = wh * depth
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = sliceBase + y * width + x
        const pixel = (y * width + x) * 4
        imageData.data[pixel] = Number(voxels[base] || 0)
        imageData.data[pixel + 1] = Number(voxels[base + frameSize] || 0)
        imageData.data[pixel + 2] = Number(voxels[base + 2 * frameSize] || 0)
        imageData.data[pixel + 3] = 255
      }
    }
  } else {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const vIdx = sliceBase + y * width + x
        const value = Number(voxels[vIdx] || 0)
        if (Number.isFinite(value)) {
          if (value < min) min = value
          if (value > max) max = value
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      min = 0
      max = 1
    }
    const span = Math.max(1e-6, max - min)

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const vIdx = sliceBase + y * width + x
        const pixel = (y * width + x) * 4
        const value = Number(voxels[vIdx] || 0)
        const gray = Math.max(0, Math.min(255, Math.round(((value - min) / span) * 255)))
        imageData.data[pixel] = gray
        imageData.data[pixel + 1] = gray
        imageData.data[pixel + 2] = gray
        imageData.data[pixel + 3] = 255
      }
    }
  }

  srcCtx.putImageData(imageData, 0, 0)

  const outCanvas = document.createElement('canvas')
  outCanvas.width = THUMBNAIL_SIZE
  outCanvas.height = THUMBNAIL_SIZE
  const outCtx = outCanvas.getContext('2d')
  if (!outCtx) return ''

  outCtx.fillStyle = '#000'
  outCtx.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE)

  const scale = Math.min(THUMBNAIL_SIZE / width, THUMBNAIL_SIZE / height)
  const drawW = Math.max(1, Math.round(width * scale))
  const drawH = Math.max(1, Math.round(height * scale))
  const dx = Math.floor((THUMBNAIL_SIZE - drawW) / 2)
  const dy = Math.floor((THUMBNAIL_SIZE - drawH) / 2)
  outCtx.imageSmoothingEnabled = false
  outCtx.drawImage(srcCanvas, dx, dy, drawW, drawH)

  return outCanvas.toDataURL('image/png')
}

const createNiivueThumbnail = async (buffer, name, { isMask = false } = {}) => {
  const canvas = document.createElement('canvas')
  canvas.width = THUMBNAIL_SIZE
  canvas.height = THUMBNAIL_SIZE
  canvas.style.position = 'absolute'
  canvas.style.opacity = '0'
  canvas.style.pointerEvents = 'none'
  document.body.appendChild(canvas)
  const nv = new Niivue({ show3Dcrosshair: false })
  try {
    nv.attachToCanvas(canvas)
    await nv.loadFromArrayBuffer(buffer, name)
    const dims = nv.back?.dims
    const is2D = dims && (dims[0] <= 2 || dims[3] <= 1)
    nv.setSliceType(nv.sliceTypeAxial)
    // 仅对 2D 图像应用 radiological 约定，避免影响 3D 体数据方位。
    if (is2D) {
      nv.setRadiologicalConvention(true)
    }
    if (isMask && typeof nv.setColormap === 'function') {
      nv.setColormap('itksnap')
    }
    nv.drawScene()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return canvas.toDataURL('image/png')
  } catch (error) {
    console.warn('Niivue 缩略图生成失败', error)
    return ''
  } finally {
    nv.removeAllListeners?.()
    document.body.removeChild(canvas)
  }
}

const createThumbnail = async (buffer, name, { isMask = false } = {}) => {
  if (isNiftiFile(name)) {
    try {
      return await createNiftiThumbnail(buffer, name, { isMask })
    } catch {
      return createNiivueThumbnail(buffer, name, { isMask })
    }
  }
  return createNiivueThumbnail(buffer, name, { isMask })
}

const toListItem = (record) => ({
  id: record.id,
  name: record.name,
  displayName: record.displayName || record.name,
  baseName: record.baseName || normalizeBaseName(record.name),
  createdAt: record.createdAt,
  hasMask: !!(record.sourceMask || record.mask),
  maskAttached: record.maskAttached !== false,
  thumbnail: record.thumbnail || ''
})

const hasAttachedMask = (record) =>
  record?.maskAttached !== false && !!(record?.mask || record?.sourceMask)

const makeImportBatchId = () => `batch-${Date.now()}-${Math.random().toString(16).slice(2)}`

export default function App() {
  const [labels, setLabels] = useState([
    { id: 1, name: 'Label 1', color: labelPalette[0], value: 1 }
  ])
  const [activeLabelId, setActiveLabelId] = useState(1)
  const [newLabelName, setNewLabelName] = useState('')
  const [tool, setTool] = useState('brush')
  const [brushSize, setBrushSize] = useState(6)
  const [radiological2D, setRadiological2D] = useState(true)
  const [labelStats, setLabelStats] = useState({})

  const [images, setImages] = useState([])
  const [activeImage, setActiveImage] = useState(null)
  const [exportDirHandle, setExportDirHandle] = useState(null)

  const viewerRef = useRef(null)
  const processedFilesRef = useRef(new Set())
  const saveTimerRef = useRef(null)
  const statsTimerRef = useRef(null)

  const activeLabel = useMemo(
    () => labels.find((label) => label.id === activeLabelId) || labels[0],
    [labels, activeLabelId]
  )

  const scheduleLabelStatsRefresh = () => {
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current)
    statsTimerRef.current = setTimeout(() => {
      const stats = viewerRef.current?.getLabelStats?.() || {}
      setLabelStats(stats)
    }, 120)
  }

  const addLabel = () => {
    const nextId = labels.length ? Math.max(...labels.map((l) => l.id)) + 1 : 1
    const nextValue = labels.length ? Math.max(...labels.map((l) => l.value)) + 1 : 1
    const color = labelPalette[(nextId - 1) % labelPalette.length]
    const name = newLabelName.trim() || `Label ${nextId}`
    setLabels((prev) => [...prev, { id: nextId, name, color, value: nextValue }])
    setActiveLabelId(nextId)
    setNewLabelName('')
  }

  const removeLabel = (id) => {
    setLabels((prev) => {
      if (prev.length <= 1) return prev
      const next = prev.filter((label) => label.id !== id)
      if (activeLabelId === id) {
        setActiveLabelId(next[0]?.id || prev[0].id)
      }
      return next
    })
  }

  const refreshImageList = async () => {
    const records = await getAllImages()
    // 将历史普通图片迁移到显式空间的 NIfTI 数据，避免坐标信息缺失。
    for (const record of records) {
      if (!record.data) continue
      const sourceName = record.displayName || record.name
      if (!isImageFile(sourceName)) continue
      if ((record.rasterConversionVersion || 0) >= 4) continue
      const originalSourceData = record.sourceData || record.data
      const dataBuffer = arrayBufferFrom(record.data)
      const migrated = dataBuffer && isNiftiBuffer(dataBuffer)
        ? normalizeRasterNiftiToScalar(dataBuffer, sourceName)
        : await rasterToNifti(record.data, sourceName).catch(() => null)
      if (!migrated) continue
      const regenerated = await createThumbnail(migrated.buffer, migrated.internalName)
      record.data = migrated.buffer
      record.name = migrated.internalName
      record.displayName = sourceName
      record.spatialMeta = migrated.spatialMeta
      record.rasterConversionVersion = 4
      record.sourceName = sourceName
      record.sourceData = originalSourceData
      record.thumbnail = regenerated || record.thumbnail
      await updateImage(record.id, {
        data: migrated.buffer,
        name: migrated.internalName,
        displayName: sourceName,
        spatialMeta: migrated.spatialMeta,
        rasterConversionVersion: 4,
        sourceName,
        sourceData: originalSourceData,
        thumbnail: record.thumbnail,
        updatedAt: Date.now()
      })
    }
    const sorted = records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    setImages(sorted.map(toListItem))
    if (!activeImage && sorted.length > 0) {
      const first = sorted[0]
      setActiveImage({
        ...first,
        maskVersion: hasAttachedMask(first) ? 1 : 0
      })
    }
  }

  useEffect(() => {
    refreshImageList()
  }, [])

  useEffect(() => {
    scheduleLabelStatsRefresh()
  }, [activeImage?.id, activeImage?.maskVersion, labels.length])

  const persistActiveDrawing = async () => {
    if (!activeImage?.id) return
    // 如果是“从原始mask临时拿下叠加”的状态，则不覆盖原始mask，也不持久化空绘图。
    if (activeImage?.maskAttached === false && activeImage?.sourceMask) return
    const exported = await viewerRef.current?.exportDrawing()
    if (!exported) return
    const buffer = arrayBufferFrom(exported)
    if (!buffer) return

    await updateImage(activeImage.id, {
      mask: buffer,
      maskName: `${fileStem(activeImage.name)}.nii.gz`,
      maskAttached: true,
      modifiedByUser: true,
      updatedAt: Date.now()
    })

    setImages((prev) =>
      prev.map((img) => (img.id === activeImage.id ? { ...img, hasMask: true, maskAttached: true } : img))
    )
    setActiveImage((prev) =>
      prev
        ? {
            ...prev,
            mask: buffer,
            maskAttached: true,
            modifiedByUser: true,
            maskVersion: (prev.maskVersion || 0) + 1
          }
        : prev
    )
  }

  const onViewerEvent = (reason = 'draw') => {
    if (reason === 'draw' || reason === 'undo' || reason === 'redo') {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        persistActiveDrawing()
      }, 800)
    }
    scheduleLabelStatsRefresh()
  }

  const locateLabel = (labelValue) => {
    const ok = viewerRef.current?.jumpToLabel?.(labelValue)
    if (!ok) {
      Message.warning('当前影像未找到该 label 的标注区域')
      return
    }
    const target = labels.find((label) => label.value === labelValue)
    if (target) setActiveLabelId(target.id)
  }

  const selectImage = async (id) => {
    if (activeImage?.id === id) return
    await persistActiveDrawing()
    const record = await getImageById(id)
    if (!record) return
    setActiveImage({
      ...record,
      maskVersion: hasAttachedMask(record) ? 1 : 0
    })
  }

  const removeImage = async (id) => {
    const nextImages = images.filter((img) => img.id !== id)
    await deleteImage(id)
    setImages(nextImages)
    if (activeImage?.id === id) {
      const next = nextImages[0]
      if (next) {
        const record = await getImageById(next.id)
        setActiveImage(record ? { ...record, maskVersion: hasAttachedMask(record) ? 1 : 0 } : null)
      } else {
        setActiveImage(null)
      }
    }
  }

  const findImageByBase = (base) => {
    if (!base) return null
    const normalized = base.toLowerCase()
    return (
      images.find((img) => img.baseName === normalized) ||
      images.find((img) => stripMaskTokens(img.baseName || '') === normalized)
    )
  }

  const applyMaskToImage = async (imageId, maskBuffer, maskName) => {
    await updateImage(imageId, {
      sourceMask: maskBuffer,
      sourceMaskName: maskName,
      mask: maskBuffer,
      maskName,
      maskAttached: true,
      updatedAt: Date.now()
    })
    setImages((prev) =>
      prev.map((img) => (img.id === imageId ? { ...img, hasMask: true, maskAttached: true } : img))
    )
    if (activeImage?.id === imageId) {
      setActiveImage((prev) => ({
        ...prev,
        sourceMask: maskBuffer,
        sourceMaskName: maskName,
        mask: maskBuffer,
        maskName,
        maskAttached: true,
        maskVersion: (prev?.maskVersion || 0) + 1
      }))
    }
  }

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
      modifiedByUser = false
    } = {}
  ) => {
    const baseName = normalizeBaseName(name)
    const finalSourceMask = sourceMask || maskBuffer || null
    const finalSourceMaskName = sourceMaskName || maskName || null
    const finalMaskAttached = finalSourceMask ? true : maskAttached

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
      sourceMask: finalSourceMask,
      sourceMaskName: finalSourceMaskName,
      mask: maskBuffer,
      maskName,
      maskAttached: finalMaskAttached,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hash,
      thumbnail
    }
  }

  const isDuplicateHash = (hash, hashSet) => hashSet.has(hash)

  const importImageFile = async (file, hashSet, importBatchId = null) => {
    const originalBuffer = await file.arrayBuffer()
    const likelyDicomByMagic = !isSupportedImageFile(file.name) && isLikelyDicomBuffer(originalBuffer)
    if (!isSupportedImageFile(file.name) && !likelyDicomByMagic) return

    const effectiveName =
      likelyDicomByMagic && !isDicomFile(file.name) ? `${file.name}.dcm` : file.name

    let buffer = originalBuffer
    let internalName = effectiveName
    let spatialMeta = null
    if (isImageFile(effectiveName)) {
      const converted = await rasterToNifti(originalBuffer, effectiveName)
      buffer = converted.buffer
      internalName = converted.internalName
      spatialMeta = converted.spatialMeta
    }

    const baseName = normalizeBaseName(effectiveName)
    const maskFile = isMaskName(file.name)
    const hash = await hashBuffer(buffer)

    if (maskFile) {
      const target = findImageByBase(stripMaskTokens(baseName)) || findImageByBase(baseName)
      if (target) {
        await applyMaskToImage(target.id, buffer, file.name)
        return
      }
    }

    if (isDuplicateHash(hash, hashSet)) return

    const thumbnail = await createThumbnail(buffer, internalName, { isMask: maskFile })
    const record = createImageRecord(internalName, buffer, hash, thumbnail, {
      displayName: effectiveName,
      isMaskOnly: maskFile,
      rasterHFlipNormalized: false,
      spatialMeta,
      rasterConversionVersion: isImageFile(effectiveName) ? 4 : 0,
      importBatchId,
      sourceName: effectiveName,
      sourceData: isImageFile(effectiveName) ? originalBuffer : buffer,
      modifiedByUser: false
    })
    await saveImages([record])
    hashSet.add(hash)

    setImages((prev) => [...prev, toListItem(record)])
    if (!activeImage) {
      setActiveImage({ ...record, maskVersion: hasAttachedMask(record) ? 1 : 0 })
    }
  }

  const importZipFile = async (file, hashSet, importBatchId = null) => {
    const buffer = await file.arrayBuffer()
    const zip = await JSZip.loadAsync(buffer)

    const imageEntries = []
    const maskEntries = []

    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue
      const name = entry.name
      if (!isSupportedImageFile(name)) continue
      const lower = name.toLowerCase()
      if (lower.includes('/mask/') || lower.startsWith('mask/')) {
        maskEntries.push(entry)
      } else {
        imageEntries.push(entry)
      }
    }

    const masks = []
    for (const entry of maskEntries) {
      const content = await entry.async('arraybuffer')
      const rawBaseName = normalizeBaseName(entry.name)
      masks.push({
        name: entry.name.split('/').pop(),
        baseName: rawBaseName,
        matchBaseName: stripMaskTokens(rawBaseName),
        buffer: content
      })
    }

    const maskByBase = new Map(masks.map((mask) => [mask.matchBaseName || mask.baseName, mask]))

    const newRecords = []
    for (const entry of imageEntries) {
      const rawContent = await entry.async('arraybuffer')
      const name = entry.name.split('/').pop()
      const baseName = normalizeBaseName(entry.name)
      let content = rawContent
      let internalName = name
      let spatialMeta = null
      if (isImageFile(name)) {
        const converted = await rasterToNifti(rawContent, name)
        content = converted.buffer
        internalName = converted.internalName
        spatialMeta = converted.spatialMeta
      }
      const hash = await hashBuffer(content)
      if (isDuplicateHash(hash, hashSet)) continue

      const maskMatch = maskByBase.get(baseName) || maskByBase.get(stripMaskTokens(baseName))
      const thumbnail = await createThumbnail(content, internalName)
      const record = createImageRecord(internalName, content, hash, thumbnail, {
        displayName: name,
        sourceMask: maskMatch?.buffer || null,
        sourceMaskName: maskMatch?.name || null,
        maskBuffer: maskMatch?.buffer || null,
        maskName: maskMatch?.name || null,
        maskAttached: !!maskMatch,
        rasterHFlipNormalized: false,
        spatialMeta,
        rasterConversionVersion: isImageFile(name) ? 4 : 0,
        importBatchId,
        sourceName: name,
        sourceData: isImageFile(name) ? rawContent : content,
        modifiedByUser: false
      })
      newRecords.push(record)
      hashSet.add(hash)
    }

    if (newRecords.length > 0) {
      await saveImages(newRecords)
      setImages((prev) => [...prev, ...newRecords.map(toListItem)])
      if (!activeImage) {
        const first = newRecords[0]
        setActiveImage({ ...first, maskVersion: hasAttachedMask(first) ? 1 : 0 })
      }
    }

    for (const mask of masks) {
      const target =
        findImageByBase(mask.matchBaseName) ||
        findImageByBase(stripMaskTokens(mask.baseName)) ||
        findImageByBase(mask.baseName)
      if (target) {
        await applyMaskToImage(target.id, mask.buffer, mask.name)
      }
    }
  }

  const handleUploadChange = async (fileList) => {
    if (!fileList?.length) return
    const importBatchId = makeImportBatchId()
    const existing = await getAllImages()
    const hashSet = new Set(existing.map((item) => item.hash).filter(Boolean))

    for (const item of fileList) {
      const originFile = item?.originFile
      if (!originFile) continue
      const key = `${originFile.name}-${originFile.size}-${originFile.lastModified}`
      if (processedFilesRef.current.has(key)) continue
      processedFilesRef.current.add(key)

      if (isZipFile(originFile.name)) {
        await importZipFile(originFile, hashSet, importBatchId)
      } else {
        await importImageFile(originFile, hashSet, importBatchId)
      }
    }
  }

  const importFolder = async () => {
    if (!window.showDirectoryPicker) return
    const dirHandle = await window.showDirectoryPicker()
    setExportDirHandle(dirHandle)

    const imgHandle = await dirHandle.getDirectoryHandle('img', { create: false }).catch(() => null)
    const maskHandle = await dirHandle.getDirectoryHandle('mask', { create: false }).catch(() => null)
    const imageRootHandle = imgHandle || dirHandle
    const importBatchId = makeImportBatchId()

    const existing = await getAllImages()
    const hashSet = new Set(existing.map((item) => item.hash).filter(Boolean))
    const imageEntries = []
    for await (const [name, handle] of imageRootHandle.entries()) {
      if (handle.kind !== 'file') continue
      if (!isSupportedImageFile(name) && !imgHandle) {
        // 兼容无扩展名的 DICOM 文件（文件夹导入场景）
        const file = await handle.getFile()
        const content = await file.arrayBuffer()
        if (isLikelyDicomBuffer(content)) {
          imageEntries.push(handle)
        }
        continue
      }
      if (isSupportedImageFile(name)) imageEntries.push(handle)
    }

    const masks = []
    if (maskHandle) {
      for await (const [name, handle] of maskHandle.entries()) {
        if (handle.kind !== 'file') continue
        if (!isSupportedImageFile(name)) continue
        const file = await handle.getFile()
        const content = await file.arrayBuffer()
        const rawBaseName = normalizeBaseName(name)
        masks.push({
          name,
          baseName: rawBaseName,
          matchBaseName: stripMaskTokens(rawBaseName),
          buffer: content
        })
      }
    }

    const maskByBase = new Map(masks.map((mask) => [mask.matchBaseName || mask.baseName, mask]))

    const newRecords = []
    for (const handle of imageEntries) {
      const file = await handle.getFile()
      const rawContent = await file.arrayBuffer()
      let content = rawContent
      let internalName = file.name
      let spatialMeta = null
      if (isImageFile(file.name)) {
        const converted = await rasterToNifti(rawContent, file.name)
        content = converted.buffer
        internalName = converted.internalName
        spatialMeta = converted.spatialMeta
      }
      const hash = await hashBuffer(content)
      if (isDuplicateHash(hash, hashSet)) continue
      const baseName = normalizeBaseName(file.name)
      const maskMatch = maskByBase.get(baseName) || maskByBase.get(stripMaskTokens(baseName))
      const thumbnail = await createThumbnail(content, internalName)
      const record = createImageRecord(internalName, content, hash, thumbnail, {
        displayName: file.name,
        sourceMask: maskMatch?.buffer || null,
        sourceMaskName: maskMatch?.name || null,
        maskBuffer: maskMatch?.buffer || null,
        maskName: maskMatch?.name || null,
        maskAttached: !!maskMatch,
        rasterHFlipNormalized: false,
        spatialMeta,
        rasterConversionVersion: isImageFile(file.name) ? 4 : 0,
        importBatchId,
        sourceName: file.name,
        sourceData: isImageFile(file.name) ? rawContent : content,
        modifiedByUser: false
      })
      newRecords.push(record)
      hashSet.add(hash)
    }

    if (newRecords.length > 0) {
      await saveImages(newRecords)
      setImages((prev) => [...prev, ...newRecords.map(toListItem)])
      if (!activeImage) {
        const first = newRecords[0]
        setActiveImage({ ...first, maskVersion: hasAttachedMask(first) ? 1 : 0 })
      }
    }
  }

  const detachMaskFromImage = async (id, knownRecord = null) => {
    const record = knownRecord || (await getImageById(id))
    if (!record) return

    await updateImage(id, {
      maskAttached: false,
      mask: null,
      updatedAt: Date.now()
    })

    const hasMask = !!(record.sourceMask || record.mask)
    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, hasMask, maskAttached: false } : img))
    )

    if (activeImage?.id === id) {
      setActiveImage((prev) =>
        prev
          ? {
              ...prev,
              maskAttached: false,
              mask: null,
              maskVersion: (prev.maskVersion || 0) + 1
            }
          : prev
      )
    }
  }

  const attachSourceMaskToImage = async (id, knownRecord = null) => {
    const record = knownRecord || (await getImageById(id))
    if (!record) return
    const sourceMask = record.sourceMask || record.mask
    const sourceMaskName = record.sourceMaskName || record.maskName
    if (!sourceMask) return

    await updateImage(id, {
      mask: sourceMask,
      maskName: sourceMaskName,
      maskAttached: true,
      updatedAt: Date.now()
    })

    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, hasMask: true, maskAttached: true } : img))
    )

    if (activeImage?.id === id) {
      setActiveImage((prev) =>
        prev
          ? {
              ...prev,
              mask: sourceMask,
              maskName: sourceMaskName,
              maskAttached: true,
              maskVersion: (prev.maskVersion || 0) + 1
            }
          : prev
      )
    }
  }

  const toggleMaskOverlay = async (id, event) => {
    event?.stopPropagation?.()
    const record = await getImageById(id)
    if (!record || !(record.sourceMask || record.mask)) return
    if (record.maskAttached === false) {
      await attachSourceMaskToImage(id, record)
    } else {
      await detachMaskFromImage(id, record)
    }
  }

  const handleClear = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const id = activeImage?.id
    if (!id) return

    viewerRef.current?.clear()

    const record = await getImageById(id)
    if (!record) return

    if (record.sourceMask) {
      await detachMaskFromImage(id, record)
      return
    }

    await updateImage(id, {
      mask: null,
      maskName: null,
      maskAttached: false,
      modifiedByUser: true,
      updatedAt: Date.now()
    })

    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, hasMask: false, maskAttached: false } : img))
    )

    setActiveImage((prev) =>
      prev
        ? {
            ...prev,
            mask: null,
            maskName: null,
            maskAttached: false,
            modifiedByUser: true,
            maskVersion: (prev.maskVersion || 0) + 1
          }
        : prev
    )
  }

  const exportAll = async () => {
    await persistActiveDrawing()
    const records = await getAllImages()
    const activeRecord = activeImage?.id ? records.find((record) => record.id === activeImage.id) : null
    const exportScope =
      activeRecord?.importBatchId
        ? records.filter((record) => record.importBatchId === activeRecord.importBatchId)
        : records
    const annotatedRecords = exportScope.filter((record) => record.mask && hasNonZeroMaskNifti(record.mask))
    if (annotatedRecords.length === 0) {
      Message.warning('当前没有可导出的标注结果')
      return
    }

    const zip = new JSZip()
    const imgFolder = zip.folder('img')
    const maskFolder = zip.folder('mask')

    for (const record of annotatedRecords) {
      const imgName = record.sourceName || record.displayName || record.name
      const imgData = record.sourceData || record.data
      if (imgData && imgFolder) {
        imgFolder.file(imgName, imgData)
      }
      if (record.mask && maskFolder) {
        const maskName = `${fileStem(imgName)}.nii.gz`
        maskFolder.file(maskName, record.mask)
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download =
      annotatedRecords.length === 1
        ? `${fileStem(annotatedRecords[0].sourceName || annotatedRecords[0].displayName || annotatedRecords[0].name)}.zip`
        : 'nii_annotations.zip'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => URL.revokeObjectURL(url), 200)

    if (exportDirHandle) {
      try {
        const imgDir = await exportDirHandle.getDirectoryHandle('img', { create: true })
        const maskDir = await exportDirHandle.getDirectoryHandle('mask', { create: true })
        for (const record of annotatedRecords) {
          const imgName = record.sourceName || record.displayName || record.name
          const imgData = record.sourceData || record.data
          if (imgData) {
            const imgHandle = await imgDir.getFileHandle(imgName, { create: true })
            const imgWritable = await imgHandle.createWritable()
            await imgWritable.write(imgData)
            await imgWritable.close()
          }
          if (!record.mask) continue
          const maskName = `${fileStem(imgName)}.nii.gz`
          const fileHandle = await maskDir.getFileHandle(maskName, { create: true })
          const writable = await fileHandle.createWritable()
          await writable.write(record.mask)
          await writable.close()
        }
      } catch (error) {
        console.warn('导出到文件夹失败', error)
      }
    }
  }

  const toolsContent = (
    <div className="floating-panel">
      <div className="floating-title">Tools</div>
      <div className="tool-icon-group">
        <Tooltip content="Brush 画笔">
          <Button
            shape="circle"
            type={tool === 'brush' ? 'primary' : 'secondary'}
            icon={<IconBrush />}
            onClick={() => setTool('brush')}
          />
        </Tooltip>
        <Tooltip content="Eraser 橡皮擦">
          <Button
            shape="circle"
            type={tool === 'eraser' ? 'primary' : 'secondary'}
            icon={<IconEraser />}
            onClick={() => setTool('eraser')}
          />
        </Tooltip>
        <Tooltip content="Pan 拖动浏览">
          <Button
            shape="circle"
            type={tool === 'pan' ? 'primary' : 'secondary'}
            icon={<IconDragArrow />}
            onClick={() => setTool('pan')}
          />
        </Tooltip>
      </div>
      <div className="tool-section">
        <div className="tool-label">Brush Size</div>
        <Slider min={1} max={30} value={brushSize} onChange={setBrushSize} />
      </div>
      <div className="tool-section">
        <div className="tool-label">2D Orientation</div>
        <Switch
          checked={radiological2D}
          checkedText="Radiological"
          uncheckedText="Neurological"
          onChange={setRadiological2D}
        />
      </div>
      <div className="tool-icon-group">
        <Tooltip content="Undo 撤销">
          <Button shape="circle" icon={<IconUndo />} onClick={() => viewerRef.current?.undo()} />
        </Tooltip>
        <Tooltip content="Redo 重做">
          <Button shape="circle" icon={<IconRedo />} onClick={() => viewerRef.current?.redo()} />
        </Tooltip>
        <Tooltip content="Clear 清空当前叠加标注">
          <Button shape="circle" status="danger" icon={<IconDelete />} onClick={handleClear} />
        </Tooltip>
      </div>
    </div>
  )

  const labelsContent = (
    <div className="floating-panel">
      <div className="floating-title">Labels</div>
      <div className="label-create">
        <Input
          size="small"
          placeholder="新标签名称"
          value={newLabelName}
          onChange={setNewLabelName}
          onPressEnter={addLabel}
        />
        <Button size="small" icon={<IconPlus />} onClick={addLabel}>
          添加
        </Button>
      </div>
      <Radio.Group className="label-list" direction="vertical" value={activeLabelId} onChange={setActiveLabelId}>
        {labels.map((label) => (
          <Radio key={label.id} value={label.id}>
            <span className="label-item">
              <span className="label-left">
                <span className="label-color" style={{ background: label.color }} />
                {label.name}
                <span className="label-stat">({labelStats[label.value] || 0})</span>
              </span>
              <span className="label-right-actions">
                <Tooltip content="定位到该 Label 标注区域">
                  <Button
                    size="mini"
                    type="text"
                    icon={<IconSearch />}
                    onClick={(event) => {
                      event.stopPropagation()
                      locateLabel(label.value)
                    }}
                  />
                </Tooltip>
                <Button
                  size="mini"
                  type="text"
                  className="label-delete"
                  icon={<IconDelete />}
                  disabled={labels.length <= 1}
                  onClick={(event) => {
                    event.stopPropagation()
                    removeLabel(label.id)
                  }}
                />
              </span>
            </span>
          </Radio>
        ))}
      </Radio.Group>
    </div>
  )

  return (
    <Layout className="app">
      <Header className="topbar">
        <div className="brand">Nii Annotation</div>
        <Space className="topbar-actions">
          <Tooltip content="导入文件夹">
            <Button icon={<IconFolder />} onClick={importFolder} disabled={!window.showDirectoryPicker}>
              导入文件夹
            </Button>
          </Tooltip>
          <Upload
            accept=".nii,.nii.gz,.nrrd,.dcm,.dicom,.png,.jpg,.jpeg,.bmp,.webp,.tif,.tiff,.zip"
            showUploadList={false}
            autoUpload={false}
            multiple
            onChange={handleUploadChange}
          >
            <Button icon={<IconUpload />}>导入影像</Button>
          </Upload>
          <Button type="primary" onClick={exportAll}>
            导出
          </Button>
        </Space>
      </Header>

      <Layout className="layout">
        <Sider className="sidebar" width={320}>
          <Card size="small" title="影像列表">
            {images.length === 0 ? (
              <div className="sidebar-empty">暂无影像，请导入 .nii/.nrrd/.dcm/图片/.zip 或文件夹</div>
            ) : (
              <div className="image-grid">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className={`image-card${activeImage?.id === img.id ? ' active' : ''}`}
                    onClick={() => selectImage(img.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="image-thumb">
                      {img.thumbnail ? (
                        <img src={img.thumbnail} alt={img.displayName || img.name} />
                      ) : (
                        <div className="image-thumb-fallback">NII</div>
                      )}
                      {img.hasMask && (
                        <span
                          className={`image-badge${img.maskAttached ? ' attached' : ' detached'}`}
                          onClick={(event) => toggleMaskOverlay(img.id, event)}
                          role="button"
                          tabIndex={0}
                        >
                          MASK
                        </span>
                      )}
                    </div>
                    <div className="image-meta">
                      <span className="image-name">{img.displayName || img.name}</span>
                      <Button
                        size="mini"
                        type="text"
                        icon={<IconDelete />}
                        className="image-delete"
                        onClick={(event) => {
                          event.stopPropagation()
                          removeImage(img.id)
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Sider>

        <Content className="viewer">
          <Viewer
            ref={viewerRef}
            image={activeImage}
            tool={tool}
            brushSize={brushSize}
            activeLabelValue={activeLabel?.value || 1}
            labels={labels}
            radiological2D={radiological2D}
            onDrawingChange={onViewerEvent}
          />
          <div className="quick-actions">
            <Popover trigger="click" position="left" content={toolsContent}>
              <Tooltip content="打开工具菜单">
                <Button className="quick-btn" shape="circle" type="primary" icon={<IconTool />} />
              </Tooltip>
            </Popover>
            <Popover trigger="click" position="left" content={labelsContent}>
              <Tooltip content="打开标签菜单">
                <Button className="quick-btn" shape="circle" type="primary" icon={<IconTags />} />
              </Tooltip>
            </Popover>
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}
