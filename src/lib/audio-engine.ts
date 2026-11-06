/** Single shared <audio> element for the whole app (client only, never rendered by React). */
import { diag } from "./diag";

export interface EngineHooks {
  getNext: () => ({ id: string; url?: string | undefined } & NowPlaying) | null;
  onLeave: (id: string, seconds: number) => void;
  shouldStopAtEnd: () => boolean;
  onChapterEnded: (endedId: string, duration: number, nextId: string | null) => void;
}

export interface NowPlaying {
  title: string;
  series: string;
  episode: number | null;
}

export function setNowPlaying(c: NowPlaying) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: c.title,
    artist: [c.series, c.episode != null ? `Épisode ${c.episode}` : ""].filter(Boolean).join(" · ") || "Audiobook",
    album: c.series || "Mon Audiobook",
    artwork: [{ src: new URL("/cover-512.png", location.origin).href, sizes: "512x512", type: "image/png" }],
  });
}

let lastPositionState = 0;
/**
 * Tell the lock screen where we really are. iOS extrapolates the position between two updates:
 * without regular updates, every buffering pause (4G) makes the lock screen run ahead of the audio
 * — up to « −0:00 » while one or two minutes are still left.
 */
export function updatePositionState(a: HTMLAudioElement) {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = a.duration;
  if (!isFinite(d) || d <= 0) return;
  lastPositionState = Date.now();
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: a.playbackRate || 1, position: Math.min(a.currentTime, d) });
  } catch {
    /* ignore */
  }
}

const srcKind = (s: string) => (s.startsWith("blob:") ? "blob" : s.includes("/offline-audio") ? "téléchargé" : s ? "réseau" : "aucun");

let el: HTMLAudioElement | null = null;
let currentId: string | null = null;
let hooks: EngineHooks | null = null;
/**
 * Start position requested for the loaded chapter, until loadedmetadata applies it.
 * iOS Safari does not preload media before a user gesture, so currentTime can stay at 0
 * for a long time: without this, leaving the page would overwrite the saved position with 0.
 */
let pendingStart: number | null = null;
/**
 * Last real position of the loaded chapter. After a long pause iOS may drop the audio from memory:
 * the element then comes back at 0:00 and « Lire » would restart the episode (and sync that 0).
 */
let lastKnown = 0;

/**
 * Position demandée mais pas encore confirmée par le lecteur. Safari sur iPhone ignore parfois un
 * saut demandé juste après le chargement (fichier pas encore prêt) : la lecture partait alors de 0:00,
 * et ce 0:00 était enregistré puis synchronisé. On redemande le saut jusqu'à ce qu'il soit pris.
 */
let verifyTarget: number | null = null;
let verifyTries = 0;

function requestPosition(a: HTMLAudioElement, target: number) {
  verifyTarget = target > 1 ? target : null;
  verifyTries = 0;
  a.currentTime = target;
}

/** Appelé à chaque étape du chargement / de la lecture : le saut a-t-il bien été pris ? */
function verifyPosition(a: HTMLAudioElement) {
  if (verifyTarget === null || !currentId) return;
  if (Math.abs(a.currentTime - verifyTarget) < 3) {
    verifyTarget = null;
    return;
  }
  if (++verifyTries > 12) {
    diag("reprise impossible", { ch: currentId.slice(0, 8), voulu: Math.round(verifyTarget), t: Math.round(a.currentTime) });
    verifyTarget = null;
    return;
  }
  if (a.readyState >= 1 && !a.seeking) {
    diag("reprise forcée", { ch: currentId.slice(0, 8), voulu: Math.round(verifyTarget), t: Math.round(a.currentTime), essai: verifyTries });
    a.currentTime = verifyTarget;
  }
}

/** Apply pendingStart once the metadata is there (loadChapter, or a restore after a purge). */
function applyWhenLoaded(a: HTMLAudioElement, id: string, fallback: number) {
  const onMeta = () => {
    a.removeEventListener("loadedmetadata", onMeta);
    if (currentId !== id) return;
    const s = pendingStart ?? fallback; // may have been moved by seek() meanwhile
    pendingStart = null;
    requestPosition(a, s > 0 && s < a.duration - 1 ? s : 0);
  };
  a.addEventListener("loadedmetadata", onMeta);
}

/** Adresse sans le repère de départ « #t= » (pour comparer deux sources). */
const bare = (u: string) => u.split("#")[0]!;

export function getAudio(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
    const a0 = el;
    for (const ev of ["loadedmetadata", "durationchange", "play", "pause", "ratechange", "seeked", "playing", "waiting", "stalled", "ended"])
      a0.addEventListener(ev, () => updatePositionState(a0));
    for (const ev of ["canplay", "canplaythrough", "playing", "seeked", "progress"]) a0.addEventListener(ev, () => verifyPosition(a0));
    a0.addEventListener("timeupdate", () => {
      verifyPosition(a0);
      if (currentId && pendingStart === null && verifyTarget === null && a0.currentTime > 0.5) lastKnown = a0.currentTime;
      if (Date.now() - lastPositionState > 2000) updatePositionState(a0);
    });
    a0.addEventListener("playing", () => {
      // Filet de sécurité : le son joue mais la position de départ n'a pas été appliquée.
      if (currentId && pendingStart !== null && a0.readyState >= 1) {
        const s = pendingStart;
        pendingStart = null;
        requestPosition(a0, s);
      }
    });
    a0.addEventListener("play", () => {
      // Back at 0:00 without having asked for it (audio dropped by iOS): return to where we were.
      if (!currentId || pendingStart !== null || verifyTarget !== null) return;
      const d = isFinite(a0.duration) && a0.duration > 0 ? a0.duration : Infinity;
      if (a0.currentTime < 1 && lastKnown > 3 && lastKnown < d - 3) {
        diag("position restaurée", { ch: currentId.slice(0, 8), à: Math.round(lastKnown), prêt: a0.readyState });
        if (a0.readyState >= 1) requestPosition(a0, lastKnown);
        else {
          pendingStart = lastKnown;
          applyWhenLoaded(a0, currentId, lastKnown);
        }
      }
    });
    // Journal de lecture (diagnostic sur iPhone, où l'on ne peut pas ouvrir la console).
    for (const ev of ["play", "playing", "pause", "waiting", "stalled", "ended", "error", "loadedmetadata"])
      a0.addEventListener(ev, () =>
        diag(ev, {
          ch: currentId?.slice(0, 8),
          t: Math.round(a0.currentTime),
          d: isFinite(a0.duration) ? Math.round(a0.duration) : String(a0.duration),
          src: srcKind(a0.currentSrc || a0.src),
          ...(ev === "error" ? { code: a0.error?.code, msg: a0.error?.message } : {}),
        }),
      );
    el.addEventListener("ended", () => {
      const a = el!;
      const endedId = currentId;
      const duration = a.duration;
      if (!endedId) return;
      let nextId: string | null = null;
      if (hooks && !hooks.shouldStopAtEnd()) {
        const n = hooks.getNext();
        if (n?.url) {
          setNowPlaying(n);
          playChapter(n.id, n.url, 0);
          nextId = n.id;
        }
      }
      diag("enchaînement", { fini: endedId.slice(0, 8), suivant: nextId?.slice(0, 8) ?? "aucun" });
      hooks?.onChapterEnded(endedId, isFinite(duration) ? duration : 0, nextId);
    });
  }
  return el;
}

export const loadedChapterId = () => currentId;

/** Real listening position of the loaded chapter (the requested start until metadata is loaded). */
export function position(): number {
  // Tant que le saut n'est pas confirmé, la « vraie » position est celle demandée (jamais un 0 parasite).
  return pendingStart ?? verifyTarget ?? getAudio().currentTime;
}

export function loadChapter(id: string, url: string, start: number) {
  const a = getAudio();
  if (currentId === id) {
    // Same chapter: keep it, unless it is paused and a different source is now available
    // (the downloaded copy) — then switch to it without losing the place.
    if (a.paused && a.src && bare(a.src) !== bare(new URL(url, location.href).href)) start = position();
    else return;
  } else if (currentId) hooks?.onLeave(currentId, position());
  currentId = id;
  pendingStart = start;
  lastKnown = start;
  verifyTarget = null;
  // « #t= » : Safari démarre lui-même à cette position (première sécurité, avant applyWhenLoaded).
  a.src = start > 1 ? `${url}#t=${start.toFixed(1)}` : url;
  applyWhenLoaded(a, id, start);
}

/** True while the shared element is actually playing a chapter. */
export const isPlaying = () => !!el && !!currentId && !el.paused;

/**
 * Go to a position in the loaded chapter and return the position actually requested.
 * On iPhone, Safari loads nothing before the first play: duration and currentTime are unknown
 * (NaN / 0) and a currentTime set now would be lost. The target then becomes the start position,
 * applied as soon as the metadata arrives.
 */
export function seek(seconds: number, knownDuration?: number): number {
  const a = getAudio();
  const d = isFinite(a.duration) && a.duration > 0 ? a.duration : knownDuration && knownDuration > 0 ? knownDuration : Infinity;
  const target = Math.max(0, Math.min(isFinite(seconds) ? seconds : 0, d - 0.5));
  lastKnown = target;
  // Fichier déjà chargé : on saute vraiment (sinon seule la barre bougeait, pas le son).
  if (pendingStart !== null && a.readyState < 1) pendingStart = target;
  else {
    pendingStart = null;
    requestPosition(a, target);
  }
  return target;
}

/**
 * Remplace la source de l'épisode chargé (copie locale prête) sans perdre la position,
 * et relance la lecture si elle était en cours.
 */
export function swapSource(id: string, url: string) {
  const a = getAudio();
  if (currentId !== id || bare(a.src) === bare(url)) return;
  const wasPlaying = !a.paused;
  const pos = position();
  pendingStart = pos;
  verifyTarget = null;
  a.src = pos > 1 ? `${url}#t=${pos.toFixed(1)}` : url;
  applyWhenLoaded(a, id, pos);
  diag("source locale", { ch: id.slice(0, 8), t: Math.round(pos), lecture: wasPlaying });
  if (wasPlaying) a.play().catch((e) => diag("play refusé", { ch: id.slice(0, 8), err: (e as Error)?.name }));
}

/** Adresse actuellement chargée dans le lecteur (sans « #t= »). */
export const currentSource = () => (el ? bare(el.src) : "");

/** Move the already-loaded (paused) chapter to a position received from another device. */
export function seekLoaded(id: string, seconds: number) {
  if (currentId !== id || !el) return;
  seek(seconds);
}

export function playChapter(id: string, url: string, start: number) {
  loadChapter(id, url, start);
  getAudio()
    .play()
    .catch((e) => {
      diag("play refusé", { ch: id.slice(0, 8), err: (e as Error)?.name });
      console.error("[audio-engine] play() refusé :", e);
    });
}

export function setRate(r: number) {
  const a = getAudio();
  a.defaultPlaybackRate = r;
  a.playbackRate = r;
}

export function setHooks(h: EngineHooks) {
  hooks = h;
}

export function stop() {
  if (!el) return;
  el.pause();
  if (currentId) hooks?.onLeave(currentId, position());
  currentId = null;
  pendingStart = null;
  verifyTarget = null;
  lastKnown = 0;
}
