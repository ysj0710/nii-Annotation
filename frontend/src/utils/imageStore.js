const DB_BASE_NAME = 'nii-annotation'
const DB_VERSION = 3
const STORE_NAME = 'images'
let DB_NAMESPACE = 'default'

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

const sanitizeNamespace = (value = '') =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, '_')
    .slice(0, 160) || 'default'

const resolveDbName = () => `${DB_BASE_NAME}__${sanitizeNamespace(DB_NAMESPACE)}`

export const setImageStoreNamespace = (namespace) => {
  DB_NAMESPACE = sanitizeNamespace(namespace)
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

export const getAllImages = async () =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  )

export const getImageById = async (id) =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const request = store.get(id)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  )

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
  )

export const deleteImage = async (id) =>
  withStore('readwrite', (store) => {
    store.delete(id)
  })

export const clearAllImages = async () =>
  withStore('readwrite', (store) => {
    store.clear()
  })

export const getImageCount = async () =>
  withStore('readonly', (store) =>
    new Promise((resolve, reject) => {
      const request = store.count()
      request.onsuccess = () => resolve(Number(request.result || 0))
      request.onerror = () => reject(request.error)
    })
  )

export const getImageIdOrder = async () =>
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

export const getImageMetasByIds = async (ids) =>
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
