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
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function accountKey(userId) {
    return `${window.location.origin}|${String(userId)}`;
  }

  function currentAccount() {
    return enabled && accountId ? accountId : '';
  }

  function messageBytes(messages) {
    try { return new Blob([JSON.stringify(messages || [])]).size; } catch (_) { return 0; }
  }

  async function trim() {
    const key = currentAccount();
    if (!key) return;
    const [assets, conversations] = await Promise.all([
      transaction(['assets'], 'readonly', (tx) => requestValue(tx.objectStore('assets').getAll())),
      transaction(['messages'], 'readonly', (tx) => requestValue(tx.objectStore('messages').getAll()))
    ]);
    const accountAssets = assets.filter((row) => row.accountId === key);
    const accountConversations = conversations.filter((row) => row.accountId === key);
    let total = accountAssets.reduce((sum, row) => sum + Number(row.size || 0), 0)
      + accountConversations.reduce((sum, row) => sum + Number(row.size || 0), 0);
    if (total <= MAX_BYTES) return;
    await transaction(['assets', 'messages'], 'readwrite', (tx) => {
      const assetStore = tx.objectStore('assets');
      const messageStore = tx.objectStore('messages');
      for (const row of accountAssets.sort((a, b) => Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0))) {
        if (total <= MAX_BYTES) break;
        assetStore.delete([key, row.url]);
        total -= Number(row.size || 0);
      }
      for (const row of accountConversations.sort((a, b) => Number(a.lastOpenedAt || 0) - Number(b.lastOpenedAt || 0))) {
        if (total <= MAX_BYTES) break;
        messageStore.delete([key, row.sessionId]);
        total -= Number(row.size || 0);
      }
    });
  }

  async function getAllForAccount(storeName) {
    const key = currentAccount();
    if (!key) return [];
    const all = await transaction([storeName], 'readonly', (tx) => requestValue(tx.objectStore(storeName).getAll()));
    return all.filter((row) => row.accountId === key);
  }

  const api = {
    async openForUser(userId) {
      accountId = accountKey(userId);
      try { enabled = localStorage.getItem('rai_conversation_cache_enabled') !== '0'; } catch (_) { enabled = true; }
      if (enabled) await openDb();
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
      const row = await transaction(['messages'], 'readwrite', (tx) => {
        const store = tx.objectStore('messages');
        const request = store.get([key, String(sessionId)]);
        request.onsuccess = () => {
          const value = request.result;
          if (value && options.touch !== false) { value.lastOpenedAt = Date.now(); store.put(value); }
        };
        return requestValue(request);
      });
      if (row && Number(row.formatVersion || 0) !== MESSAGE_FORMAT_VERSION) {
        await transaction(['messages'], 'readwrite', (tx) => {
          tx.objectStore('messages').delete([key, String(sessionId)]);
        });
        return null;
      }
      return row || null;
    },
    async putConversation(sessionId, messages, revision, etag, options = {}) {
      const key = currentAccount();
      if (!key || !sessionId || !Array.isArray(messages)) return;
      const lastOpenedAt = options.touch === false
        ? Number(options.lastOpenedAt || 0)
        : Date.now();
      await transaction(['messages'], 'readwrite', (tx) => tx.objectStore('messages').put({
        accountId: key, sessionId: String(sessionId), messages, revision: Number(revision || 0), etag: String(etag || ''),
        formatVersion: MESSAGE_FORMAT_VERSION, size: messageBytes(messages), lastOpenedAt, updatedAt: Date.now()
      }));
      await trim();
    },
    async deleteConversation(sessionId) {
      const key = currentAccount();
      if (!key || !sessionId) return;
      await transaction(['messages'], 'readwrite', (tx) => tx.objectStore('messages').delete([key, String(sessionId)]));
    },
    async cachedConversationIds() {
      return (await getAllForAccount('messages')).map((row) => String(row.sessionId));
    },
    async cachedConversationRevisions() {
      return (await getAllForAccount('messages'))
        .filter((row) => Number(row.formatVersion || 0) === MESSAGE_FORMAT_VERSION)
        .map((row) => ({
          sessionId: String(row.sessionId),
          revision: Number(row.revision || 0)
        }));
    },
    async getAsset(url) {
      const key = currentAccount();
      if (!key || !url) return null;
      const row = await transaction(['assets'], 'readwrite', (tx) => {
        const store = tx.objectStore('assets');
        const request = store.get([key, String(url)]);
        request.onsuccess = () => { if (request.result) { request.result.lastUsedAt = Date.now(); store.put(request.result); } };
        return requestValue(request);
      });
      if (row?.expiresAt && Number(row.expiresAt) <= Date.now()) {
        await transaction(['assets'], 'readwrite', (tx) => tx.objectStore('assets').delete([key, String(url)]));
        return null;
      }
      return row || null;
    },
    async putAsset(url, blob, options = {}) {
      const key = currentAccount();
      if (!key || !url || !(blob instanceof Blob) || blob.size > MAX_RESOURCE_BYTES) return false;
      const expiresAt = Number(options.expiresAt || 0);
      if (expiresAt && expiresAt <= Date.now()) return false;
      await transaction(['assets'], 'readwrite', (tx) => tx.objectStore('assets').put({
        accountId: key, url: String(url), blob, etag: String(options.etag || ''), expiresAt,
        size: blob.size, lastUsedAt: Date.now(), updatedAt: Date.now()
      }));
      await trim();
      return true;
    },
    async deleteAsset(url) {
      const key = currentAccount();
      if (!key || !url) return;
      await transaction(['assets'], 'readwrite', (tx) => tx.objectStore('assets').delete([key, String(url)]));
    },
    async usage() {
      const [assets, messages] = await Promise.all([getAllForAccount('assets'), getAllForAccount('messages')]);
      return assets.reduce((sum, row) => sum + Number(row.size || 0), 0) + messages.reduce((sum, row) => sum + Number(row.size || 0), 0);
    },
    async clearCurrentAccount() {
      const key = accountId;
      if (!key) return;
      await transaction(['meta', 'sessions', 'messages', 'assets'], 'readwrite', (tx) => {
        ['meta', 'sessions', 'messages', 'assets'].forEach((name) => {
          const store = tx.objectStore(name);
          const request = store.getAllKeys();
          request.onsuccess = () => request.result.forEach((storeKey) => {
            const belongsToAccount = name === 'meta'
              ? storeKey === `manifest:${key}`
              : Array.isArray(storeKey) && storeKey[0] === key;
            if (belongsToAccount) store.delete(storeKey);
          });
        });
      });
    }
  };

  window.RAIConversationCache = api;
}());
