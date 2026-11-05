/** Single shared <audio> element for the whole app (client only, never rendered by React). */
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

export function updatePositionState(a: HTMLAudioElement) {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = a.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: a.playbackRate || 1, position: Math.min(a.currentTime, d) });
  } catch {
    /* ignore */
  }
}

let el: HTMLAudioElement | null = null;
let currentId: string | null = null;
let hooks: EngineHooks | null = null;
/**
 * Start position requested for the loaded chapter, until loadedmetadata applies it.
 * iOS Safari does not preload media before a user gesture, so currentTime can stay at 0
 * for a long time: without this, leaving the page would overwrite the saved position with 0.
 */
let pendingStart: number | null = null;

export function getAudio(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
    const a0 = el;
    for (const ev of ["loadedmetadata", "durationchange", "play", "pause", "ratechange", "seeked"])
      a0.addEventListener(ev, () => updatePositionState(a0));
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
      hooks?.onChapterEnded(endedId, isFinite(duration) ? duration : 0, nextId);
    });
  }
  return el;
}

export const loadedChapterId = () => currentId;

/** Real listening position of the loaded chapter (the requested start until metadata is loaded). */
export function position(): number {
  return pendingStart ?? getAudio().currentTime;
}

export function loadChapter(id: string, url: string, start: number) {
  const a = getAudio();
  if (currentId === id) return;
  if (currentId) hooks?.onLeave(currentId, position());
  currentId = id;
  pendingStart = start;
  a.src = url;
  const onMeta = () => {
    a.removeEventListener("loadedmetadata", onMeta);
    if (currentId !== id) return;
    a.currentTime = start > 0 && start < a.duration - 1 ? start : 0;
    pendingStart = null;
  };
  a.addEventListener("loadedmetadata", onMeta);
}

export function playChapter(id: string, url: string, start: number) {
  loadChapter(id, url, start);
  getAudio()
    .play()
    .catch((e) => console.error("[audio-engine] play() refusé :", e));
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
}
