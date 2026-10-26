/**
 * Signing identities kept on this device (IndexedDB "fusion-pdfsig"). The private key is a non-extractable WebCrypto
 * CryptoKey: IndexedDB stores it by structured clone, so the key bytes are never exposed to page script, never sent
 * to the server and cannot be exported back out. Clearing site data deletes them.
 * TT79: v2 adds "anchors" — the user's own trusted certificates (Fusion ships no trust list); a signature whose chain
 * reaches one of them is reported as trusted. Upgrading from v1 keeps every identity.
 */
import type { Identity } from "./pdfsig";

const DB = "fusion-pdfsig", STORE = "ids", ANCHORS = "anchors";
export interface StoredIdentity extends Identity { id: string; created: number; source: "device" | "imported" | "pkcs12" }
export interface StoredAnchor { id: string; der: Uint8Array; subject: string; added: number }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    if (typeof indexedDB === "undefined") { rej(new Error("this browser has no IndexedDB")); return; }
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" });
      if (!r.result.objectStoreNames.contains(ANCHORS)) r.result.createObjectStore(ANCHORS, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error ?? new Error("IndexedDB open failed"));
  });
}
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return open().then((db) => new Promise<T>((res, rej) => {
    const t = db.transaction(store, mode); const rq = fn(t.objectStore(store));
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error ?? new Error("IndexedDB request failed"));
    t.oncomplete = () => db.close();
  }));
}
export const listIdentities = () => tx<StoredIdentity[]>("readonly", (s) => s.getAll() as IDBRequest<StoredIdentity[]>).then((a) => a.sort((x, y) => x.created - y.created));
export const putIdentity = (id: StoredIdentity) => tx("readwrite", (s) => s.put(id));
export const deleteIdentity = (id: string) => tx("readwrite", (s) => s.delete(id));
export const listAnchors = () => tx<StoredAnchor[]>("readonly", (s) => s.getAll() as IDBRequest<StoredAnchor[]>, ANCHORS).then((a) => a.sort((x, y) => x.added - y.added));
/** keyed by the certificate's SHA-256, so trusting the same certificate twice keeps one entry */
export async function putAnchor(der: Uint8Array, subject: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", der.slice().buffer as ArrayBuffer)); const id = Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
  await tx("readwrite", (s) => s.put({ id, der, subject, added: Date.now() } satisfies StoredAnchor), ANCHORS); return id;
}
export const deleteAnchor = (id: string) => tx("readwrite", (s) => s.delete(id), ANCHORS);
