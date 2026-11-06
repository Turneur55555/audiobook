/*
 * Service worker de Mon Audiobook : ouverture du site et écoute des épisodes téléchargés sans réseau.
 *
 * - Page « / » : réseau d'abord, copie en cache en secours (hors ligne).
 * - Fichiers du site (/assets, icônes) et polices Google : cache, mis à jour en arrière-plan.
 * - /offline-audio?src=<URL du MP3> : sert le MP3 téléchargé (cache « audio-v1 »), y compris les
 *   requêtes partielles (Range) qu'exige Safari sur iPhone ; s'il n'est pas téléchargé, redirige vers l'original.
 * - Tout le reste (Supabase, synchronisation…) n'est pas intercepté.
 */
const SHELL = "shell-v1";
const AUDIO = "audio-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== SHELL && k !== AUDIO) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

async function precache() {
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return;
    const html = await res.clone().text();
    const cache = await caches.open(SHELL);
    await cache.put("/", res);
    const urls = new Set(["/favicon.png", "/apple-touch-icon.png", "/cover-512.png", "/manifest.webmanifest"]);
    for (const m of html.matchAll(/(?:src|href)="(\/[^"?#]+\.(?:js|css|png|webmanifest))"/g)) urls.add(m[1]);
    await Promise.all([...urls].map((u) => cache.add(u).catch(() => undefined)));
  } catch {
    /* hors ligne pendant l'installation : la mise en cache se fera à la prochaine visite */
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname === "/offline-audio") {
    event.respondWith(serveAudio(req, url.searchParams.get("src") || ""));
  } else if (req.mode === "navigate" && sameOrigin) {
    event.respondWith(page(req));
  } else if (sameOrigin && /^\/(assets\/|favicon|apple-touch-icon|cover-|manifest)/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function page(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok && new URL(req.url).pathname === "/") await cache.put("/", res.clone());
    return res;
  } catch {
    return (await cache.match("/")) || new Response("Hors ligne", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then((res) => {
      if (res.ok || res.type === "opaque") cache.put(req, res.clone()).catch(() => undefined);
      return res;
    })
    .catch(() => undefined);
  return hit || (await update) || new Response("", { status: 504 });
}

async function serveAudio(req, src) {
  if (!/^https:\/\//.test(src)) return new Response("Bad request", { status: 400 });
  const hit = await (await caches.open(AUDIO)).match(src);
  if (!hit) return Response.redirect(src, 302);
  const blob = await hit.blob();
  const size = blob.size;
  const type = hit.headers.get("Content-Type") || "audio/mpeg";
  const range = req.headers.get("Range");
  if (!range) {
    return new Response(blob, { status: 200, headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = size - 1;
  if (m && m[1] === "" && m[2] !== "") start = Math.max(0, size - Number(m[2]));
  else if (m) {
    start = Number(m[1] || 0);
    if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
    },
  });
}
