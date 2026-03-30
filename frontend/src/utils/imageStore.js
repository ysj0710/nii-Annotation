const DB_BASE_NAME = 'nii-annotation'
const DB_VERSION = 3
const STORE_NAME = 'images'
let DB_NAMESPACE = 'default'
let META_BACKEND_ORIGIN = ''
let META_BACKEND_TOKEN = ''
let META_SYNC_QUEUE = Promise.resolve()
const META_SYNC_TIMEOUT_MS = 4500

const BLOB_KEYS = ['data', 'sourceData', 'mask', 'sourceMask']

const resolveDefaultMetaBackendOrigin = () => {
  try {
    return String(
      import.meta.env?.VITE_ANNOTATION_BACKEND_ORIGIN ||
        import.meta.env?.VITE_META_BACKEND_ORIGIN ||
        ''
    )
      .trim()
      .replace(/\/+$/, '')
  } catch {
    return ''
  }
}

META_BACKEND_ORIGIN = resolveDefaultMetaBackendOrigin()

const sanitizeNamespace = (value = '') =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, '_')
    .slice(0, 160) || 'default'

const resolveDbName = () => `${DB_BASE_NAME}__${sanitizeNamespace(DB_NAMESPACE)}`

const arrayBufferFrom = (value) => {
  if (!value) return null
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  }
  return null
}

const hasAnyBlobField = (record) =>
  BLOB_KEYS.some((key) => !!arrayBufferFrom(record?.[key]))

const encodeArrayBufferToBase64 = (buffer) => {
  const source = arrayBufferFrom(buffer)
  if (!source) return ''
  const bytes = new Uint8Array(source)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

const decodeBase64ToArrayBuffer = (raw) => {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  } catch {
    return null
  }
}

const toImageMeta = (record) => {
  if (!record) return null
  return {
    id: record.id,
    name: record.name,
    displayName: record.displayName,
    baseName: record.baseName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceFormat: record.sourceFormat,
    sourceName: record.sourceName,
    remoteImageId: record.remoteImageId,
    remoteBatchId: record.remoteBatchId,
    isMaskOnly: !!record.isMaskOnly,
    maskAttached: record.maskAttached,
    maskVersion: record.maskVersion,
    thumbnail: record.thumbnail,
    dicomStudyUID: record.dicomStudyUID,
    dicomStudyID: record.dicomStudyID,
    dicomSeriesUID: record.dicomSeriesUID,
    dicomSeriesDescription: record.dicomSeriesDescription,
    dicomSeriesNumber: record.dicomSeriesNumber,
    dicomSeriesOrder: record.dicomSeriesOrder,
    dicomAccessionNumber: record.dicomAccessionNumber,
    hasMask: !!(record.sourceMask || record.mask || record.hasMask)
  }
}

const toMetaPayload = (record) => {
  if (!record || !record.id) return null
  return {
    id: String(record.id),
    name: String(record.name || ''),
    displayName: record.displayName ?? null,
    baseName: record.baseName ?? null,
    createdAt: Number(record.createdAt || 0),
    updatedAt: Number(record.updatedAt || 0),
    sourceFormat: record.sourceFormat ?? null,
    sourceName: record.sourceName ?? null,
    remoteImageId: record.remoteImageId ? String(record.remoteImageId) : '',
    remoteBatchId: record.remoteBatchId ? String(record.remoteBatchId) : '',
    isMaskOnly: !!record.isMaskOnly,
    hasMask:
      typeof record.hasMask === 'boolean'
        ? record.hasMask
        : !!(record.sourceMask || record.mask),
    maskAttached: record.maskAttached !== false,
    maskVersion: Number(record.maskVersion || 0),
    maskName: record.maskName ?? null,
    sourceMaskName: record.sourceMaskName ?? null,
    hash: record.hash || null,
    thumbnail: record.thumbnail || '',
    dicomStudyUID: record.dicomStudyUID || '',
    dicomStudyID: record.dicomStudyID || '',
    dicomSeriesUID: record.dicomSeriesUID || '',
    dicomSeriesDescription: record.dicomSeriesDescription || '',
    dicomSeriesNumber: Number(record.dicomSeriesNumber || 0),
    dicomSeriesOrder: Number(record.dicomSeriesOrder || 0),
    dicomAccessionNumber: record.dicomAccessionNumber || '',
    importBatchId: record.importBatchId || null,
    modifiedByUser: !!record.modifiedByUser,
    customFields:
      record.customFields && typeof record.customFields === 'object' && !Array.isArray(record.customFields)
        ? record.customFields
        : {},
    overlayAnnotations: Array.isArray(record.overlayAnnotations) ? record.overlayAnnotations : [],
    lastClientEnvReport:
      record.lastClientEnvReport &&
      typeof record.lastClientEnvReport === 'object' &&
      !Array.isArray(record.lastClientEnvReport)
        ? record.lastClientEnvReport
        : {}
  }
}

const toMetaPatchPayload = (patch, currentRecord = null) => {
  if (!patch || typeof patch !== 'object') return {}
  const cleaned = { ...patch }
  delete cleaned.data
  delete cleaned.sourceData
  delete cleaned.mask
  delete cleaned.sourceMask
  const merged = { ...(currentRecord || {}), ...cleaned }
  const hasMask =
    typeof cleaned.hasMask === 'boolean'
      ? cleaned.hasMask
      : !!(merged.sourceMask || merged.mask || merged.hasMask)
  return {
    ...cleaned,
    hasMask
  }
}

const toBlobPayload = (record) => {
  if (!record?.id) return null
  const data = arrayBufferFrom(record.data)
  const sourceData = arrayBufferFrom(record.sourceData)
  const mask = arrayBufferFrom(record.mask)
  const sourceMask = arrayBufferFrom(record.sourceMask)
  if (!data && !sourceData && !mask && !sourceMask) return null
  return {
    id: String(record.id),
    dataB64: encodeArrayBufferToBase64(data),
    sourceDataB64: encodeArrayBufferToBase64(sourceData),
    maskB64: encodeArrayBufferToBase64(mask),
    sourceMaskB64: encodeArrayBufferToBase64(sourceMask),
    updatedAt: Number(record.updatedAt || Date.now())
  }
}

const applyBlobPayloadToRecord = (record, blobPayload = null) => {
  if (!record) return null
  if (!blobPayload || typeof blobPayload !== 'object') return record
  const dataBuffer = decodeBase64ToArrayBuffer(blobPayload.dataB64)
  const sourceDataBuffer = decodeBase64ToArrayBuffer(blobPayload.sourceDataB64)
  const maskBuffer = decodeBase64ToArrayBuffer(blobPayload.maskB64)
  const sourceMaskBuffer = decodeBase64ToArrayBuffer(blobPayload.sourceMaskB64)
  return {
    ...record,
    data: dataBuffer || record.data || null,
    sourceData: sourceDataBuffer || record.sourceData || null,
    mask: maskBuffer || record.mask || null,
    sourceMask: sourceMaskBuffer || record.sourceMask || null
  }
}

export const setImageStoreNamespace = (namespace) => {
  DB_NAMESPACE = sanitizeNamespace(namespace)
}

export const setImageStoreBackendConfig = ({ origin = '', token = '' } = {}) => {
  META_BACKEND_ORIGIN = String(origin || '')
    .trim()
    .replace(/\/+$/, '')
  META_BACKEND_TOKEN = String(token || '').trim()
}

const metaSyncEnabled = () => !!META_BACKEND_ORIGIN

const buildAuthHeaders = () => {
  const raw = String(META_BACKEND_TOKEN || '').trim()
  if (!raw) return {}
  const value = /^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`
  return { Authorization: value }
}

const enqueueMetaSync = (task) => {
  META_SYNC_QUEUE = META_SYNC_QUEUE
    .then(task)
    .catch((error) => {
      console.warn('[imageStore] remote sync failed', error)
    })
  return META_SYNC_QUEUE
}

const callMetaApi = async (path, { method = 'GET', body = null, params = {} } = {}) => {
  if (!metaSyncEnabled()) return null
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === '') continue
    query.set(key, String(value))
  }
  const url = `${META_BACKEND_ORIGIN}${path}${query.toString() ? `?${query.toString()}` : ''}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), META_SYNC_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...buildAuthHeaders()
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    if (!response.ok) return null
    return await response.json().catch(() => null)
  } finally {
    clearTimeout(timer)
  }
}

const syncMetaUpsertBatch = async (images) => {
  const items = (Array.isArray(images) ? images : []).map(toMetaPayload).filter(Boolean)
  if (!items.length) return
  await callMetaApi('/meta/images/upsert-batch', {
    method: 'POST',
    body: {
      namespace: DB_NAMESPACE,
      items
    }
  })
}

const syncBlobUpsertBatch = async (images) => {
  const items = (Array.isArray(images) ? images : []).map(toBlobPayload).filter(Boolean)
  if (!items.length) return
  await callMetaApi('/meta/images/blob-upsert-batch', {
    method: 'POST',
    body: {
      namespace: DB_NAMESPACE,
      items
    }
  })
}

const syncMetaPatch = async (id, patch, currentRecord = null) => {
  const imageId = String(id || '').trim()
  if (!imageId) return
  await callMetaApi(`/meta/images/${encodeURIComponent(imageId)}`, {
    method: 'PATCH',
    params: { namespace: DB_NAMESPACE },
    body: toMetaPatchPayload(patch, currentRecord)
  })
}

const syncMetaDelete = async (id) => {
  const imageId = String(id || '').trim()
  if (!imageId) return
  await callMetaApi(`/meta/images/${encodeURIComponent(imageId)}`, {
    method: 'DELETE',
    params: { namespace: DB_NAMESPACE }
  })
}

const syncBlobDelete = async (id) => {
  const imageId = String(id || '').trim()
  if (!imageId) return
  await callMetaApi(`/meta/images/${encodeURIComponent(imageId)}/blob`, {
    method: 'DELETE',
    params: { namespace: DB_NAMESPACE }
  })
}

const syncMetaClear = async () => {
  await callMetaApi('/meta/images', {
    method: 'DELETE',
    params: { namespace: DB_NAMESPACE }
  })
}

const syncBlobClear = async () => {
  await callMetaApi('/meta/images/blob', {
    method: 'DELETE',
    params: { namespace: DB_NAMESPACE }
  })
}

const fetchRemoteCount = async () => {
  const payload = await callMetaApi('/meta/images/count', {
    method: 'GET',
    params: { namespace: DB_NAMESPACE }
  })
  const count = Number(payload?.count)
  return Number.isFinite(count) && count >= 0 ? count : null
}

const fetchRemoteIdOrder = async () => {
  const payload = await callMetaApi('/meta/images/id-order', {
    method: 'GET',
    params: { namespace: DB_NAMESPACE }
  })
  return Array.isArray(payload?.ids) ? payload.ids.map((id) => String(id)) : null
}

const fetchRemoteMetasByIds = async (ids) => {
  const cleanIds = (Array.isArray(ids) ? ids : [])
    .filter((id) => id != null)
    .map((id) => String(id))
  if (!cleanIds.length) return []
  const payload = await callMetaApi('/meta/images/by-ids', {
    method: 'POST',
    body: {
      namespace: DB_NAMESPACE,
      ids: cleanIds
    }
  })
  return Array.isArray(payload?.items) ? payload.items : null
}

const fetchRemoteMetaById = async (id) => {
  const imageId = String(id || '').trim()
  if (!imageId) return null
  const payload = await callMetaApi(`/meta/images/${encodeURIComponent(imageId)}`, {
    method: 'GET',
    params: { namespace: DB_NAMESPACE }
  })
  return payload?.item || null
}

const fetchRemoteBlobById = async (id) => {
  const imageId = String(id || '').trim()
  if (!imageId) return null
  const payload = await callMetaApi(`/meta/images/${encodeURIComponent(imageId)}/blob`, {
    method: 'GET',
    params: { namespace: DB_NAMESPACE }
  })
  return payload?.item || null
}

const fetchRemoteMetasByRemoteImageId = async (remoteImageId) => {
  const value = String(remoteImageId || '').trim()
  if (!value) return []
  const payload = await callMetaApi(`/meta/images/by-remote/${encodeURIComponent(value)}`, {
    method: 'GET',
    params: { namespace: DB_NAMESPACE }
  })
  return Array.isArray(payload?.items) ? payload.items : null
}

const fetchRemoteMetasByHash = async (hash) => {
  const value = String(hash || '').trim()
  if (!value) return []
  const payload = await callMetaApi(`/meta/images/by-hash/${encodeURIComponent(value)}`, {
    method: 'GET',
    params: { namespace: DB_NAMESPACE }
  })
  return Array.isArray(payload?.items) ? payload.items : null
}

const openDB = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(resolveDbName(), DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        store.createIndex('remoteImageId', 'remoteImageId')
        store.createIndex('hash', 'hash')
        return
      }
      const tx = request.transaction
      const store = tx?.objectStore(STORE_NAME)
      if (store && !store.indexNames.contains('createdAt')) {
        store.createIndex('createdAt', 'createdAt')
      }
      if (store && !store.indexNames.contains('remoteImageId')) {
        store.createIndex('remoteImageId', 'remoteImageId')
      }
      if (store && !store.indexNames.contains('hash')) {
        store.createIndex('hash', 'hash')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const withStore = async (mode, fn) => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const store = tx.objectStore(STORE_NAME)
    const result = fn(store)
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
  })
}

const putImagesLocal = async (images) =>
  withStore('readwrite', (store) => {
    for (const image of Array.isArray(images) ? images : []) {
      if (!image?.id) continue
      store.put(image)
    }
  })

const getAllImagesLocal = async () =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  )

const getImageByIdLocal = async (id) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const request = store.get(id)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  )

const getImageByRemoteImageIdLocal = async (remoteImageId) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const index = store.index('remoteImageId')
      const request = index.get(String(remoteImageId || ''))
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  )

const getImagesByRemoteImageIdLocal = async (remoteImageId) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const index = store.index('remoteImageId')
      const request = index.getAll(String(remoteImageId || ''))
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
      request.onerror = () => reject(request.error)
    })
  )

const getImagesByHashLocal = async (hash) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const value = String(hash || '')
      if (!value) {
        resolve([])
        return
      }
      const index = store.index('hash')
      const request = index.getAll(value)
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
      request.onerror = () => reject(request.error)
    })
  )

const getImageCountLocal = async () =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const request = store.count()
      request.onsuccess = () => resolve(Number(request.result || 0))
      request.onerror = () => reject(request.error)
    })
  )

const getImageIdOrderLocal = async () =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const ids = []
      const index = store.index('createdAt')
      const request = index.openKeyCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve(ids)
          return
        }
        ids.push(String(cursor.primaryKey))
        cursor.continue()
      }
      request.onerror = () => reject(request.error)
    })
  )

const getImageMetasByIdsLocal = async (ids) =>
  withStore('readonly', (store) =>
    Promise.all(
      (Array.isArray(ids) ? ids : [])
        .filter((id) => id != null)
        .map(
          (id) =>
            new Promise((resolve, reject) => {
              const request = store.get(id)
              request.onsuccess = () => resolve(toImageMeta(request.result))
              request.onerror = () => reject(request.error)
            })
        )
    ).then((items) => items.filter(Boolean))
  )

const getRemoteRecordById = async (id) => {
  const meta = await fetchRemoteMetaById(id)
  if (!meta) return null
  const local = await getImageByIdLocal(id)
  const blob = await fetchRemoteBlobById(id).catch(() => null)
  const hydrated = applyBlobPayloadToRecord({ ...local, ...meta }, blob)
  await putImagesLocal([hydrated])
  return hydrated
}

export const getAllImages = async () => {
  if (!metaSyncEnabled()) return getAllImagesLocal()
  const ids = await fetchRemoteIdOrder().catch(() => null)
  if (!Array.isArray(ids) || !ids.length) return getAllImagesLocal()
  const records = []
  for (const id of ids) {
    const record = await getRemoteRecordById(id)
    if (record) records.push(record)
  }
  return records
}

export const getImageById = async (id) => {
  if (!metaSyncEnabled()) return getImageByIdLocal(id)
  const remote = await getRemoteRecordById(id)
  if (remote) return remote
  return getImageByIdLocal(id)
}

export const getImageByRemoteImageId = async (remoteImageId) => {
  if (!metaSyncEnabled()) return getImageByRemoteImageIdLocal(remoteImageId)
  const metas = await fetchRemoteMetasByRemoteImageId(remoteImageId).catch(() => null)
  const first = Array.isArray(metas) ? metas[0] : null
  if (first?.id) {
    const remote = await getRemoteRecordById(first.id)
    if (remote) return remote
  }
  return getImageByRemoteImageIdLocal(remoteImageId)
}

export const getImagesByRemoteImageId = async (remoteImageId) => {
  if (!metaSyncEnabled()) return getImagesByRemoteImageIdLocal(remoteImageId)
  const metas = await fetchRemoteMetasByRemoteImageId(remoteImageId).catch(() => null)
  if (Array.isArray(metas) && metas.length > 0) {
    const records = []
    for (const meta of metas) {
      const record = await getRemoteRecordById(meta?.id)
      if (record) records.push(record)
    }
    if (records.length > 0) return records
  }
  return getImagesByRemoteImageIdLocal(remoteImageId)
}

export const getImagesByHash = async (hash) => {
  if (!metaSyncEnabled()) return getImagesByHashLocal(hash)
  const metas = await fetchRemoteMetasByHash(hash).catch(() => null)
  if (Array.isArray(metas) && metas.length > 0) {
    const records = []
    for (const meta of metas) {
      const record = await getRemoteRecordById(meta?.id)
      if (record) records.push(record)
    }
    if (records.length > 0) return records
  }
  return getImagesByHashLocal(hash)
}

export const saveImages = async (images) =>
  putImagesLocal(images).then((result) => {
    if (metaSyncEnabled()) {
      void enqueueMetaSync(async () => {
        await syncMetaUpsertBatch(images)
        await syncBlobUpsertBatch(images)
      })
    }
    return result
  })

export const updateImage = async (id, patch) =>
  withStore('readwrite', (store) =>
    new Promise((resolve, reject) => {
      const request = store.get(id)
      request.onsuccess = () => {
        const record = request.result
        if (!record) {
          resolve(null)
          return
        }
        const next = { ...record, ...patch }
        store.put(next)
        resolve(next)
      }
      request.onerror = () => reject(request.error)
    })
  ).then((updated) => {
    if (updated && metaSyncEnabled()) {
      void enqueueMetaSync(async () => {
        await syncMetaPatch(id, patch, updated)
        if (hasAnyBlobField(updated) || BLOB_KEYS.some((key) => Object.prototype.hasOwnProperty.call(patch || {}, key))) {
          await syncBlobUpsertBatch([updated])
        }
      })
    }
    return updated
  })

export const deleteImage = async (id) =>
  withStore('readwrite', (store) => {
    store.delete(id)
  }).then((result) => {
    if (metaSyncEnabled()) {
      void enqueueMetaSync(async () => {
        await syncMetaDelete(id)
        await syncBlobDelete(id)
      })
    }
    return result
  })

export const clearAllImages = async ({ syncBackend = false } = {}) =>
  withStore('readwrite', (store) => {
    store.clear()
  }).then((result) => {
    if (syncBackend && metaSyncEnabled()) {
      void enqueueMetaSync(async () => {
        await syncMetaClear()
        await syncBlobClear()
      })
    }
    return result
  })

export const getImageCount = async () => {
  if (!metaSyncEnabled()) return getImageCountLocal()
  const remoteCount = await fetchRemoteCount().catch(() => null)
  if (Number.isFinite(remoteCount) && remoteCount >= 0) return remoteCount
  return getImageCountLocal()
}

export const getImageIdOrder = async () => {
  const localIds = await getImageIdOrderLocal()
  if (!metaSyncEnabled()) return localIds
  const remoteIds = await fetchRemoteIdOrder().catch(() => null)
  if (!Array.isArray(remoteIds)) return localIds
  const seen = new Set()
  const merged = []
  for (const id of remoteIds) {
    const key = String(id || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(key)
  }
  for (const id of localIds) {
    const key = String(id || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(key)
  }
  return merged
}

export const getImageMetasByIds = async (ids) => {
  if (!metaSyncEnabled()) return getImageMetasByIdsLocal(ids)
  const remoteItems = await fetchRemoteMetasByIds(ids).catch(() => null)
  if (Array.isArray(remoteItems) && remoteItems.length > 0) {
    const byId = new Map(remoteItems.map((item) => [String(item?.id || ''), item]))
    const localMetas = await getImageMetasByIdsLocal(ids)
    const localById = new Map(localMetas.map((item) => [String(item?.id || ''), item]))
    const ordered = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const key = String(id || '')
      const remote = byId.get(key)
      const local = localById.get(key)
      if (remote || local) {
        ordered.push({
          ...(local || {}),
          ...(remote || {})
        })
      }
    }
    if (ordered.length > 0) return ordered
  }
  return getImageMetasByIdsLocal(ids)
}

export const backfillLocalDataToBackend = async () => {
  if (!metaSyncEnabled()) return { synced: 0, enabled: false }
  const all = await getAllImagesLocal()
  if (!all.length) return { synced: 0, enabled: true }
  await enqueueMetaSync(async () => {
    await syncMetaUpsertBatch(all)
    await syncBlobUpsertBatch(all)
  })
  return { synced: all.length, enabled: true }
}

export const backfillLocalMetaToBackend = async () => backfillLocalDataToBackend()
