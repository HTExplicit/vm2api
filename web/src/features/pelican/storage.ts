import type { PelicanBatch } from './types'

type StoredBatch = {
  scope: string
  id: string
  batch: PelicanBatch
}

let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('vm2api-pelican', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('batches', {
        keyPath: ['scope', 'id'],
      })
      store.createIndex('scope', 'scope')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}

export async function loadPelicanBatches(
  scope: string
): Promise<PelicanBatch[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('batches', 'readonly')
    const request = transaction
      .objectStore('batches')
      .index('scope')
      .getAll(scope)
    transaction.oncomplete = () => {
      const rows = request.result as StoredBatch[]
      resolve(
        rows.map((row) => row.batch).sort((a, b) => b.createdAt - a.createdAt)
      )
    }
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function savePelicanBatch(
  scope: string,
  batch: PelicanBatch
): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('batches', 'readwrite')
    transaction
      .objectStore('batches')
      .put({ scope, id: batch.id, batch } satisfies StoredBatch)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function clearPelicanBatches(scope: string): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('batches', 'readwrite')
    const request = transaction
      .objectStore('batches')
      .index('scope')
      .openCursor(scope)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      cursor.delete()
      cursor.continue()
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
}
