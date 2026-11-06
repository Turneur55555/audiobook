/**
 * Écoute hors ligne : les MP3 téléchargés sont rangés dans le cache « audio-v1 » du navigateur,
 * et le service worker (public/sw.js) les sert à l'adresse /offline-audio?src=<URL d'origine>.
 */
export const AUDIO_CACHE = "audio-v1";
const OFFLINE_PATH = "/offline-audio";

const hasWindow = () => typeof window !== "undefined";
export const canDownload = () => hasWindow() && "caches" in window && "serviceWorker" in navigator;

/** Adresse normalisée (clé du cache). */
export const norm = (url: string) => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

export const offlineUrl = (src: string) => `${OFFLINE_PATH}?src=${encodeURIComponent(src)}`;
/** Lisible sans réseau : copie servie par le service worker, ou copie locale en mémoire (blob:). */
export const isOfflineUrl = (u?: string) => !!u && (u.startsWith(OFFLINE_PATH) || u.startsWith("blob:"));

/**
 * Copie locale d'un épisode téléchargé, sous forme d'adresse blob:. Safari sur iPhone ne permet pas
 * toujours d'avancer/reculer dans un fichier servi par le service worker ; dans un blob, si.
 */
export async function blobUrlFor(src: string): Promise<string | null> {
  if (!canDownload()) return null;
  const res = await (await caches.open(AUDIO_CACHE)).match(norm(src));
  if (!res) return null;
  const blob = await res.blob();
  return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "audio/mpeg" }));
}

/** Le service worker contrôle-t-il la page ? (sinon /offline-audio n'existerait pas côté serveur) */
export const swControls = () => hasWindow() && !!navigator.serviceWorker?.controller;

export async function registerServiceWorker(): Promise<void> {
  if (!hasWindow() || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (e) {
    console.error("[offline] service worker non installé :", e);
  }
}

export async function listDownloaded(): Promise<Set<string>> {
  if (!canDownload()) return new Set();
  const keys = await (await caches.open(AUDIO_CACHE)).keys();
  return new Set(keys.map((r) => norm(r.url)));
}

/** Télécharge un MP3 en entier, avec progression, puis le range dans le cache. */
export async function downloadAudio(src: string, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<number> {
  let res: Response;
  try {
    res = await fetch(src, { mode: "cors", cache: "no-store", ...(signal ? { signal } : {}) });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new Error("connexion interrompue, réessaie avec du réseau.");
  }
  if (!res.ok || !res.body) throw new Error(`téléchargement impossible (${res.status})`);
  const total = Number(res.headers.get("Content-Length") || 0);
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read().catch((e: Error) => {
      if (e?.name === "AbortError") throw e;
      throw new Error("connexion interrompue pendant le téléchargement, réessaie.");
    });
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  const blob = new Blob(chunks, { type: res.headers.get("Content-Type") || "audio/mpeg" });
  if (total && blob.size !== total) throw new Error("téléchargement incomplet, réessayez.");
  try {
    await (await caches.open(AUDIO_CACHE)).put(
      norm(src),
      new Response(blob, { headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) } }),
    );
  } catch (e) {
    if ((e as Error)?.name === "QuotaExceededError") throw new Error("plus de place disponible sur l’appareil.");
    throw e;
  }
  onProgress(1);
  return blob.size;
}

export async function removeDownload(src: string) {
  if (!canDownload()) return;
  await (await caches.open(AUDIO_CACHE)).delete(norm(src));
}

/** Place occupée par les épisodes téléchargés (octets). */
export async function downloadedBytes(): Promise<number> {
  if (!canDownload()) return 0;
  const cache = await caches.open(AUDIO_CACHE);
  let n = 0;
  for (const r of await cache.keys()) {
    const res = await cache.match(r);
    n += Number(res?.headers.get("Content-Length") || 0);
  }
  return n;
}

/** Estimation de la taille d'un MP3 à 64 kbit/s, pour annoncer le volume avant téléchargement. */
export const estimateBytes = (durationSec?: number) => Math.round((durationSec ?? 420) * 8000);

export const fmtMo = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} Mo`;
