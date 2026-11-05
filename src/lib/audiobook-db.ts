/** Local, per-device storage: listening positions, "listened" marks, settings, last chapter. */
export interface LocalPos {
  id: string;
  position: number;
  duration?: number | undefined;
  done?: boolean | undefined;
  updatedAt: number;
}

type Store = "positions" | "meta";
let dbp: Promise<IDBDatabase> | null = null;

function openDb() {
  if (!dbp)
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("audiobook-perso", 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("positions")) d.createObjectStore("positions", { keyPath: "id" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  return dbp;
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (d) =>
      new Promise<T>((res, rej) => {
        const tx = d.transaction(store, mode);
        const r = fn(tx.objectStore(store));
        tx.oncomplete = () => res(r.result as T);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      }),
  );
}

export const getAllPositions = () => run<LocalPos[]>("positions", "readonly", (s) => s.getAll());
export const putPosition = (p: LocalPos) => run("positions", "readwrite", (s) => s.put(p));
export const getMeta = <T>(k: string) => run<T | undefined>("meta", "readonly", (s) => s.get(k));
export const setMeta = (k: string, v: unknown) => run("meta", "readwrite", (s) => s.put(v, k));

export async function exportPositions(): Promise<Blob> {
  const positions = await getAllPositions();
  const meta = { lastId: await getMeta("lastId"), settings: await getMeta("settings") };
  return new Blob(
    [JSON.stringify({ app: "audiobook-perso", kind: "positions", version: 2, exportedAt: new Date().toISOString(), positions, meta })],
    { type: "application/json" },
  );
}

export async function importPositions(file: File): Promise<LocalPos[]> {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data?.positions)) throw new Error("fichier de sauvegarde invalide");
  const out: LocalPos[] = [];
  for (const raw of data.positions) {
    if (typeof raw?.id !== "string" || typeof raw.position !== "number") continue;
    const p: LocalPos = { id: raw.id, position: raw.position, duration: raw.duration, done: !!raw.done, updatedAt: raw.updatedAt ?? Date.now() };
    await putPosition(p);
    out.push(p);
  }
  if (data.meta?.settings) await setMeta("settings", data.meta.settings);
  if (data.meta?.lastId) await setMeta("lastId", data.meta.lastId);
  return out;
}

export function audioDuration(blob: Blob) {
  return new Promise<number | undefined>((res) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v?: number) => {
      URL.revokeObjectURL(url);
      res(v);
    };
    const t = setTimeout(() => done(undefined), 8000);
    a.preload = "metadata";
    a.onloadedmetadata = () => {
      clearTimeout(t);
      done(isFinite(a.duration) ? a.duration : undefined);
    };
    a.onerror = () => {
      clearTimeout(t);
      done(undefined);
    };
    a.src = url;
  });
}
