/* Extension-origin IndexedDB is not the mailbox page's origin. Content scripts
   must use the restricted runtime message interface, even on older Chromium. */
(() => {
  'use strict';
  const ready = new Promise((resolve, reject) => {
    const request = indexedDB.open('etsy-sentinel-private', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('values');
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(new Error('无法打开插件本地数据库。'));
    request.onblocked = () => reject(new Error('插件数据库升级被占用，请关闭旧管理页后重新打开。'));
  });
  async function transact(mode, work) {
    const database = await ready;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('values', mode), store = transaction.objectStore('values');
      let value;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = transaction.onabort = () => reject(new Error('本地保存失败，请检查浏览器可用空间；尚未确认的记录不会上传。'));
      try { work(store, result => { value = result; }); }
      catch (_) { transaction.abort(); }
    });
  }
  globalThis.MailWatchStorage = {
    ready,
    get: key => transact('readonly', (store, result) => { const request = store.get(key); request.onsuccess = () => result({ [key]: request.result }); }),
    set: values => transact('readwrite', store => { for (const [key, value] of Object.entries(values)) store.put(value, key); }),
    remove: key => transact('readwrite', store => store.delete(key))
  };
})();
