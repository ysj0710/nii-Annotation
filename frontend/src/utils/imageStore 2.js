const DB_BASE_NAME = 'nii-annotation'
const DB_VERSION = 3
const STORE_NAME = 'images'
let DB_NAMESPACE = 'default'
let META_BACKEND_ORIGIN = ''
let META_BACKEND_TOKEN = ''
let META_SYNC_QUEUE = Promise.resolve()
const META_SYNC_TIMEOUT_MS = 4500

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
    hasMask: !!(record.sourceMask || record.mask)
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

const sanitizeNamespace = (value = '') =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, '_')
    .slice(0, 160) || 'default'

const resolveDbName = () => `${DB_BASE_NAME}__${sanitizeNamespace(DB_NAMESPACE)}`

export const setImageStoreNamespace = (namespace) => {
  DB_NAMESPACE = sanitizeNamespace(namespace)
}

export const setImageStoreBackendConfig = ({ origin = '', token = '' } = {}) => {
  META_BACKEND_ORIGIN = String(origin || '')
    .trim()
    .replace(/\/+$/, '')
  META_BACKEND_TOKEN = String(token || '').trim()
}

const enqueueMetaSync = (task) => {
  META_SYNC_QUEUE = META_SYNC_QUEUE
    .then(task)
    .catch((error) => {
      console.warn('[imageStore] meta sync failed', error)
    })
  return META_SYNC_QUEUE
}

const metaSyncEnabled = () => !!META_BACKEND_ORIGIN

const buildAuthHeaders = () => {
  const raw = String(META_BACKEND_TOKEN || '').trim()
  if (!raw) return {}
  const value = /^Bearer\s+/i.test(raw) ? raw : `Bearer ${raw}`
  return { Authorization: value }
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

const syncMetaClear = async () => {
  await callMetaApi('/meta/images', {
    method: 'DELETE',
    params: { namespace: DB_NAMESPACE }
  })
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
        ids.push(cursor.primaryKey)
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

export const getAllImages = async () => getAllImagesLocal()

export const getImageById = async (id) => getImageByIdLocal(id)

export const getImageByRemoteImageId = async (remoteImageId) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const index = store.index('remoteImageId')
      const request = index.get(String(remoteImageId || ''))
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  )

export const getImagesByRemoteImageId = async (remoteImageId) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const index = store.index('remoteImageId')
      const request = index.getAll(String(remoteImageId || ''))
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
      request.onerror = () => reject(request.error)
    })
  )

export const getImagesByHash = async (hash) =>
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

export const saveImages = async (images) =>
  withStore('readwrite', (store) => {
    for (const image of images) {
      store.put(image)
    }
  }).then((result) => {
    if (metaSyncEnabled()) {
      void enqueueMetaSync(() => syncMetaUpsertBatch(images))
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
      void enqueueMetaSync(() => syncMetaPatch(id, patch, updated))
    }
    return updated
  })

export const deleteImage = async (id) =>
  withStore('readwrite', (store) => {
    store.delete(id)
  }).then((result) => {
    if (metaSyncEnabled()) {
      void enqueueMetaSync(() => syncMetaDelete(id))
    }
    return result
  })

export const clearAllImages = async () =>
  withStore('readwrite', (store) => {
    store.clear()
  }).then((result) => {
    if (metaSyncEnabled()) {
      void enqueueMetaSync(() => syncMetaClear())
    }
    return result
  })

export const getImageCount = async () =>
  getImageIdOrder().then((ids) => ids.length)

export const getImageIdOrder = async () => {
  const localIds = await getImageIdOrderLocal()
  if (!metaSyncEnabled()) return localIds

  const remoteIds = await fetchRemoteIdOrder().catch(() => null)
  if (!Array.isArray(remoteIds)) return localIds

  const localSet = new Set(localIds.map((id) => String(id)))
  const ordered = []
  const seen = new Set()
  for (const id of remoteIds) {
    const key = String(id || '')
    if (!key || !localSet.has(key) || seen.has(key)) continue
    ordered.push(key)
    seen.add(key)
  }
  for (const id of localIds) {
    const key = String(id || '')
    if (!key || seen.has(key)) continue
    ordered.push(key)
    seen.add(key)
  }
  return ordered
}

export const getImageMetasByIds = async (ids) => {
  if (metaSyncEnabled()) {
    const remoteItems = await fetchRemoteMetasByIds(ids).catch(() => null)
    if (Array.isArray(remoteItems) && remoteItems.length > 0) {
      const byId = new Map(remoteItems.map((item) => [String(item?.id || ''), item]))
      const ordered = []
      for (const id of Array.isArray(ids) ? ids : []) {
        const item = byId.get(String(id || ''))
        if (item) ordered.push(item)
      }
      if (ordered.length > 0) return ordered
    }
  }
  return getImageMetasByIdsLocal(ids)
}

export const backfillLocalMetaToBackend = async () => {
  if (!metaSyncEnabled()) return { synced: 0, enabled: false }
  const all = await getAllImagesLocal()
  if (!all.length) return { synced: 0, enabled: true }
  await enqueueMetaSync(() => syncMetaUpsertBatch(all))
  return { synced: all.length, enabled: true }
}
