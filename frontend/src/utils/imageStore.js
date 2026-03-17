const DB_NAME = 'nii-annotation'
const DB_VERSION = 1
const STORE_NAME = 'images'

const openDB = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
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
