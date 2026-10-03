// storage.js — 編集プロジェクトを IndexedDB に保存
//
// 動画本体は保存しない（数百MB〜GBになりブラウザの容量を圧迫するため）。
// 保存するのは「ファイル名・サイズ・更新日時」と編集内容・解析結果だけ。
// 再開時は同じ動画を選び直してもらい、名前とサイズで照合する。

const DB_NAME = 'kiritoru';
const STORE = 'projects';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const saveProject = (project) => tx('readwrite', (s) => s.put(project));
export const deleteProject = (id) => tx('readwrite', (s) => s.delete(id));

export async function listProjects() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 選ばれたファイルに対応する保存済みプロジェクトを探す */
export async function findByFile(file) {
  const all = await listProjects();
  return all.find((p) => p.source.name === file.name && p.source.size === file.size) ?? null;
}

/** ブラウザに「勝手に消さないで」と依頼（対応ブラウザのみ） */
export async function requestPersist() {
  try { await navigator.storage?.persist?.(); } catch { /* noop */ }
}
