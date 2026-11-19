/* Raw, private conversation cache. Tokens, cookies and rendered HTML never enter IndexedDB. */
(function () {
  'use strict';

  const DB_NAME = 'rai-conversation-cache-v1';
  const DB_VERSION = 1;
  const MESSAGE_FORMAT_VERSION = 3;
  const MAX_BYTES = 250 * 1024 * 1024;
  const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
  let dbPromise = null;
  let accountId = '';
  let enabled = true;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: ['accountId', 'sessionId'] });
        if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: ['accountId', 'sessionId'] });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: ['accountId', 'url'] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function transaction(stores, mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try { result = callback(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function accountRange(key) {
    return IDBKeyRange.bound([key], [key, []]);
  }

  function clearAccount(key) {
    return transaction(['meta', 'sessions', 'messages', 'assets'], 'readwrite', (tx) => {
      tx.objectStore('meta').delete(`manifest:${key}`);
      tx.objectStore('meta').delete(accountRange(key));
      for (const name of ['sessions', 'messages', 'assets']) tx.objectStore(name).delete(accountRange(key));
    });
  }

  async function readCachedRow(storeName, rowKey, read) {
    let result = null;
    await transaction([storeName, 'meta'], 'readwrite', (tx) => {
      const store = tx.objectStore(storeName);
      const request = store.get(rowKey);
      const metaKey = [rowKey[0], storeName, rowKey[1]];
      const meta = tx.objectStore('meta');
      const info = meta.get(metaKey);
      info.onsuccess = () => {
        if (!request.result && !info.result) return;
        const previousTime = info.result?.time;
        result = request.result && info.result ? read(request.result, info.result) : null;
        if (!result) { store.delete(rowKey); meta.delete(metaKey); }
        else if (info.result.time !== previousTime) meta.put(info.result);
      };
    });
    return result;
  }

  function currentAccount() {
    return enabled && accountId ? accountId : '';
  }

  function messageBytes(messages) {
    try { return new Blob([JSON.stringify(messages || [])]).size; } catch (_) { return 0; }
  }

  function putCachedRow(storeName, id, row, time) {
    return transaction(['assets', 'messages', 'meta'], 'readwrite', tx => {
      const meta = tx.objectStore('meta');
      tx.objectStore(storeName).put(row);
      meta.put({ key: [row.accountId, storeName, id], size: row.size, time, revision: row.revision, formatVersion: row.formatVersion });
      const request = meta.getAll(accountRange(row.accountId));
      request.onsuccess = () => {
        const entries = request.result;
        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (total <= MAX_BYTES) return;
        entries.sort((left, right) => (left.key[1] === 'messages') - (right.key[1] === 'messages') || left.time - right.time);
        for (const entry of entries) {
          if (total <= MAX_BYTES) break;
          const [account, store, item] = entry.key;
          tx.objectStore(store).delete([account, item]);
          meta.delete(entry.key);
          total -= entry.size;
        }
      };
    });
  }

  function deleteCachedRow(storeName, account, id) {
    return transaction([storeName, 'meta'], 'readwrite', tx => {
      tx.objectStore(storeName).delete([account, id]);
      tx.objectStore('meta').delete([account, storeName, id]);
    });
  }

  async function cacheEntries(storeName) {
    const key = currentAccount();
    if (!key) return [];
    const range = storeName ? IDBKeyRange.bound([key, storeName], [key, storeName, []]) : accountRange(key);
    return transaction(['meta'], 'readonly', tx => requestValue(tx.objectStore('meta').getAll(range)));
  }

  const api = {
    async openForUser(userId) {
      accountId = `${new URL(window.RAI_API_BASE, window.location.href).href}|${String(userId)}`;
      try { enabled = localStorage.getItem('rai_conversation_cache_enabled') !== '0'; } catch (_) { enabled = true; }
      if (enabled) await clearAccount(`${window.location.origin}|${String(userId)}`);
      return enabled;
    },
    isEnabled() { return enabled; },
    async setEnabled(next) {
      enabled = next !== false;
      try { localStorage.setItem('rai_conversation_cache_enabled', enabled ? '1' : '0'); } catch (_) { /* private mode */ }
      if (!enabled && accountId) await this.clearCurrentAccount();
      return enabled;
    },
    async getManifest() {
      const key = currentAccount();
      if (!key) return null;
      return transaction(['meta'], 'readonly', (tx) => requestValue(tx.objectStore('meta').get(`manifest:${key}`)));
    },
    async putManifest(manifest, etag) {
      const key = currentAccount();
      if (!key || !manifest) return;
      await transaction(['meta'], 'readwrite', (tx) => tx.objectStore('meta').put({
        key: `manifest:${key}`, accountId: key, manifest, etag: String(etag || ''), updatedAt: Date.now()
      }));
    },
    async getConversation(sessionId, options = {}) {
      const key = currentAccount();
      if (!key || !sessionId) return null;
      const rowKey = [key, String(sessionId)];
      return readCachedRow('messages', rowKey, (row, metadata) => {
        if (Number(row.formatVersion || 0) !== MESSAGE_FORMAT_VERSION) return null;
        if (options.touch !== false) metadata.time = Date.now();
        row.lastOpenedAt = metadata.time;
        return row;
      });
    },
    async putConversation(sessionId, messages, revision, etag, options = {}) {
      const key = currentAccount();
      if (!key || !sessionId || !Array.isArray(messages)) return;
      const lastOpenedAt = options.touch === false
        ? Number(options.lastOpenedAt || 0)
        : Date.now();
      await putCachedRow('messages', String(sessionId), {
        accountId: key, sessionId: String(sessionId), messages, revision: Number(revision || 0), etag: String(etag || ''),
        formatVersion: MESSAGE_FORMAT_VERSION, size: messageBytes(messages), updatedAt: Date.now()
      }, lastOpenedAt);
    },
    async deleteConversation(sessionId) {
      const key = currentAccount();
      if (!key || !sessionId) return;
      await deleteCachedRow('messages', key, String(sessionId));
    },
    async cachedConversationIds() {
      return (await cacheEntries('messages')).map(entry => entry.key[2]);
    },
    async cachedConversationRevisions() {
      return (await cacheEntries('messages'))
        .filter((row) => Number(row.formatVersion || 0) === MESSAGE_FORMAT_VERSION)
        .map((row) => ({
          sessionId: row.key[2],
          revision: Number(row.revision || 0)
        }));
    },
    async getAsset(url) {
      const key = currentAccount();
      if (!key || !url) return null;
      const rowKey = [key, String(url)];
      return readCachedRow('assets', rowKey, (row, metadata) => {
        if (row.expiresAt && Number(row.expiresAt) <= Date.now()) return null;
        row.lastUsedAt = metadata.time = Date.now();
        return row;
      });
    },
    async putAsset(url, blob, options = {}) {
      const key = currentAccount();
      if (!key || !url || !(blob instanceof Blob) || blob.size > MAX_RESOURCE_BYTES) return false;
      const expiresAt = Number(options.expiresAt || 0);
      if (expiresAt && expiresAt <= Date.now()) return false;
      try {
        await putCachedRow('assets', String(url), {
          accountId: key, url: String(url), blob, etag: String(options.etag || ''), expiresAt,
          size: blob.size, updatedAt: Date.now()
        }, Date.now());
      } catch (error) {
        if (error?.name === 'QuotaExceededError' || error?.name === 'UnknownError') return false;
        throw error;
      }
      return true;
    },
    async deleteAsset(url) {
      const key = currentAccount();
      if (!key || !url) return;
      await deleteCachedRow('assets', key, String(url));
    },
    async usage() {
      return (await cacheEntries()).reduce((sum, row) => sum + row.size, 0);
    },
    async clearCurrentAccount() {
      if (accountId) await clearAccount(accountId);
    }
  };

  window.RAIConversationCache = api;
}());
