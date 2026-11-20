/* Full browser reset after authentication. Business records are backed up on the
   local PC before deletion and recovered before the application can accept sales. */
(() => {
  "use strict";
  const requestValue = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("storage_request_failed"));
    request.onblocked = () => reject(new Error("other_windows_open"));
  });
  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("storage_transaction_failed"));
  });
  const readStorage = storage => Object.fromEntries(Array.from({length:storage.length}, (_, index) => {
    const key = storage.key(index); return [key, storage.getItem(key)];
  }));
  const snapshotDatabase = async info => {
    const database = await requestValue(indexedDB.open(info.name));
    database.onversionchange = () => database.close();
    try {
      const names = Array.from(database.objectStoreNames);
      const stores = [];
      if (names.length) {
        const transaction = database.transaction(names, "readonly"), done = transactionDone(transaction);
        await Promise.all(names.map(async name => {
          const store = transaction.objectStore(name);
          const values = requestValue(store.getAll()), keys = requestValue(store.getAllKeys());
          stores.push({ name, keyPath:store.keyPath, autoIncrement:store.autoIncrement,
            indexes:Array.from(store.indexNames, name => {
              const index = store.index(name); return {name, keyPath:index.keyPath, unique:index.unique, multiEntry:index.multiEntry};
            }), values:await values, keys:await keys });
        }));
        await done;
      }
      return {name:database.name, version:database.version, stores};
    } finally { database.close(); }
  };
  const snapshot = async () => ({ version:1, createdAt:new Date().toISOString(), origin:location.origin,
    local:readStorage(localStorage), session:readStorage(sessionStorage),
    databases:await Promise.all((await indexedDB.databases()).filter(info => info.name).map(snapshotDatabase)) });
  const disposable = key => ["tienda_napoles_income_report_cache_v1", "tienda_napoles_sync_journal_v1"].includes(key)
    || key.startsWith("receipt_sound_") || key.startsWith("chat_receipt_sound_");
  const restore = async data => {
    for (const [key,value] of Object.entries(data.local)) if (!disposable(key)) localStorage.setItem(key,value);
    for (const [key,value] of Object.entries(data.session)) sessionStorage.setItem(key,value);
    for (const info of data.databases) {
      const request = indexedDB.open(info.name, info.version);
      request.onupgradeneeded = () => {
        for (const store of info.stores) {
          const target = request.result.createObjectStore(store.name, {keyPath:store.keyPath, autoIncrement:store.autoIncrement});
          for (const index of store.indexes) target.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:index.multiEntry});
        }
      };
      const database = await requestValue(request);
      database.onversionchange = () => database.close();
      try {
        if (!info.stores.length) continue;
        const transaction = database.transaction(info.stores.map(store => store.name), "readwrite"), done = transactionDone(transaction);
        for (const store of info.stores) {
          const target = transaction.objectStore(store.name);
          store.values.forEach((value,index) => {
            if (disposable(String(value?.key || ""))) return;
            if (info.name === "tienda-napoles-offline-sync-v1" && value?.status === "confirmed") return;
            store.keyPath === null ? target.put(value,store.keys[index]) : target.put(value);
          });
        }
        await done;
      } finally { database.close(); }
    }
  };
  const backupRequest = async body => {
    const response = await fetch("/__tienda_napoles_browser_reset", {method:"POST", cache:"no-store", credentials:"same-origin",
      headers:{"Content-Type":"application/json","X-Tienda-Napoles-Reset":"1"}, body:JSON.stringify(body)});
    if (!response.ok) { const error = new Error("local_backup_unavailable"); error.status = response.status; throw error; }
    return response.json();
  };
  const recover = async () => {
    const result = await backupRequest({action:"recover"});
    if (!result.ok) throw new Error("local_recovery_unavailable");
    if (result.recovery) {
      if (result.recovery.origin !== location.origin) throw new Error("invalid_recovery_origin");
      await restore(result.recovery);
      await backupRequest({action:"complete",resetId:result.resetId});
    }
    return {ok:true,recovered:Boolean(result.recovery)};
  };
  const reset = async ({beforeClear = async () => {}, afterClear = async () => {}} = {}) => {
    if (!["127.0.0.1","localhost","[::1]"].includes(location.hostname) || !indexedDB.databases) return {ok:false, reason:"local_server_required"};
    let data, deleted = false, resetRequested = false, pausedWorker = null, previousNetwork = false;
    try {
      const worker = navigator.serviceWorker.controller;
      if (worker) {
        const prepared = await new Promise(resolve => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => {channel.port1.close();resolve({ok:false,reason:"worker_reset_unavailable"});}, 15000);
          channel.port1.onmessage = event => {clearTimeout(timer);channel.port1.close();resolve(event.data);};
          worker.postMessage({type:"PREPARE_BROWSER_RESET"},[channel.port2]);
        });
        if (!prepared?.ok) throw new Error(prepared?.reason || "worker_reset_unavailable");
        pausedWorker = worker;
        previousNetwork = prepared.online === true;
      }
      await beforeClear();
      await recover();
      data = await snapshot();
      // Do not use a JSON clone that could silently lose IndexedDB binary data.
      const body = JSON.stringify(data, (_key,value) => {
        if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Map || value instanceof Set)
          throw new Error("unsupported_backup_data");
        return value;
      });
      resetRequested = true;
      const response = await fetch("/__tienda_napoles_browser_reset", {method:"POST", cache:"no-store", credentials:"same-origin",
        headers:{"Content-Type":"application/json","X-Tienda-Napoles-Reset":"1"}, body});
      if (!response.ok) throw new Error("local_backup_unavailable");
      const result = await response.json();
      if (!result.ok || !result.backupSaved) throw new Error("local_backup_unconfirmed");
      deleted = true;
      // Clear-Site-Data also removes HttpOnly cookies and the HTTP cache. Explicit
      // API deletion makes the checked DevTools categories verifiable here.
      for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      await Promise.all((await caches.keys()).map(name => caches.delete(name)));
      localStorage.clear(); sessionStorage.clear();
      for (const info of await indexedDB.databases()) if (info.name) await requestValue(indexedDB.deleteDatabase(info.name));
      const empty = !localStorage.length && !sessionStorage.length && !(await caches.keys()).length
        && !(await indexedDB.databases()).length && !(await navigator.serviceWorker.getRegistrations()).length;
      if (!empty) throw new Error("browser_reset_incomplete");
      // At this point all the selected storage categories are empty. Restore
      // operational records so offline inventory, drafts and queues keep working.
      await restore(data);
      await afterClear();
      await backupRequest({action:"complete",resetId:result.resetId});
      return {ok:true, cleared:true, verifiedEmpty:true, backupSaved:true};
    } catch (error) {
      if (resetRequested && data) {
        await restore(data);
        await afterClear();
      }
      return {ok:false, reason:String(error?.message || error), backupSaved:deleted};
    } finally {
      try { pausedWorker?.postMessage({type:"SET_NETWORK_STATUS",online:previousNetwork}); } catch (_) { /* The old worker may already be unregistered. */ }
    }
  };
  window.OfflineLoginReset = Object.freeze({reset,recover});
})();
