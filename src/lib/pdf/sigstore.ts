/**
 * Signing identities kept on this device (IndexedDB "fusion-pdfsig"). The private key is a non-extractable WebCrypto
 * CryptoKey: IndexedDB stores it by structured clone, so the key bytes are never exposed to page script, never sent
 * to the server and cannot be exported back out. Clearing site data deletes them.
 */
import type { Identity } from "./pdfsig";

const DB = "fusion-pdfsig", STORE = "ids";
export interface StoredIdentity extends Identity { id: string; created: number; source: "device" | "imported" }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") { rej(new Error("this browser has no IndexedDB")); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error("IndexedDB open failed"));
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(STORE, mode); const rq = fn(t.objectStore(STORE));
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error ?? new Error("IndexedDB request failed"));
    t.oncomplete = () => db.close();
  }));
}
export const listIdentities = () => tx<StoredIdentity[]>("readonly", (s) => s.getAll() as IDBRequest<StoredIdentity[]>).then((a) => a.sort((x, y) => x.created - y.created));
export const putIdentity = (id: StoredIdentity) => tx("readwrite", (s) => s.put(id));
export const deleteIdentity = (id: string) => tx("readwrite", (s) => s.delete(id));
