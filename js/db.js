const DATABASE_VERSION = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(
      transaction.error || new Error('IndexedDB transaction failed'),
    );
  });
}

export async function openDB(address) {
  const request = indexedDB.open(`doodlemail-${address}`, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    const messages = database.createObjectStore('messages', { keyPath: 'id' });
    messages.createIndex('mid', 'mid', { unique: false });
    messages.createIndex('threadId', 'threadId', { unique: false });
    database.createObjectStore('blobs', { keyPath: 'id' });
    database.createObjectStore('outbox', { keyPath: 'id' });
    database.createObjectStore('kv', { keyPath: 'k' });
  };

  const database = await requestResult(request);

  function storeOperation(storeName, mode, operation) {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = operation(store);
    return Promise.all([Promise.resolve(result), transactionDone(transaction)])
      .then(([value]) => value);
  }

  const messages = {
    put: rec => storeOperation('messages', 'readwrite', store => requestResult(store.put(rec))),
    get: id => storeOperation('messages', 'readonly', store => requestResult(store.get(id))),
    all: () => storeOperation('messages', 'readonly', store => requestResult(store.getAll())),
    delete: id => storeOperation('messages', 'readwrite', store => requestResult(store.delete(id))),
    byMid: mid => storeOperation('messages', 'readonly', store => (
      requestResult(store.index('mid').getAll(mid))
    )),
    bulkPut: recs => storeOperation('messages', 'readwrite', store => Promise.all(
      recs.map(rec => requestResult(store.put(rec))),
    )),
  };

  const blobs = {
    put: (id, blob) => storeOperation('blobs', 'readwrite', store => (
      requestResult(store.put({ id, blob }))
    )),
    get: async id => {
      const record = await storeOperation('blobs', 'readonly', store => (
        requestResult(store.get(id))
      ));
      return record?.blob;
    },
    delete: id => storeOperation('blobs', 'readwrite', store => requestResult(store.delete(id))),
  };

  const outbox = {
    put: item => storeOperation('outbox', 'readwrite', store => requestResult(store.put(item))),
    get: id => storeOperation('outbox', 'readonly', store => requestResult(store.get(id))),
    all: () => storeOperation('outbox', 'readonly', store => requestResult(store.getAll())),
    delete: id => storeOperation('outbox', 'readwrite', store => requestResult(store.delete(id))),
  };

  const kv = {
    get: async k => {
      const record = await storeOperation('kv', 'readonly', store => requestResult(store.get(k)));
      return record?.v;
    },
    set: (k, v) => storeOperation('kv', 'readwrite', store => (
      requestResult(store.put({ k, v }))
    )),
    delete: k => storeOperation('kv', 'readwrite', store => requestResult(store.delete(k))),
  };

  return {
    messages,
    blobs,
    outbox,
    kv,
    close: () => database.close(),
  };
}

export async function deleteDB(address) {
  const request = indexedDB.deleteDatabase(`doodlemail-${address}`);
  await requestResult(request);
}
