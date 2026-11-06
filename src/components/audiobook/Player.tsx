import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fmtTime, splitSentences, withoutTitleLine, wordCount, type Chapter } from "@/lib/chapters";
import { getMeta, setMeta } from "@/lib/audiobook-db";
import * as engine from "@/lib/audio-engine";

export interface Settings {
  voiceFr: string;
  voiceEn: string;
  rate: number;
  audioRate: number;
}
const RATES = [0.75, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2];
const fmtRate = (r: number) => `${String(r).replace(".", ",")}×`;
const btn = "min-h-14 rounded-xl px-4 text-lg font-medium active:scale-95 transition";
const btnMain = `${btn} bg-primary text-primary-foreground min-w-24`;
const btnSoft = `${btn} bg-secondary text-secondary-foreground`;

type Update = (id: string, patch: Partial<Chapter>) => void;
interface Nav {
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}
interface PlayerProps extends Nav {
  chapter: Chapter;
  token: number;
  expanded: boolean;
  onUpdate: Update;
  onEnded: () => void;
  onOpen: () => void;
  sleepAtEnd: boolean;
  setSleepAtEnd: (v: boolean) => void;
}

export function Player(props: PlayerProps) {
  const [settings, setSettings] = useState<Settings>({ voiceFr: "", voiceEn: "", rate: 1, audioRate: 1 });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [sleepEnd, setSleepEnd] = useState<number | null>(null);
  const { sleepAtEnd, setSleepAtEnd } = props;
  const [, tick] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    getMeta<Settings>("settings").then((s) => {
      if (s) setSettings((o) => ({ ...o, ...s }));
      loaded.current = true;
    });
    if (!("speechSynthesis" in window)) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  useEffect(() => {
    if (loaded.current) void setMeta("settings", settings);
  }, [settings]);
  useEffect(() => {
    if (!sleepEnd) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [sleepEnd]);

  const lang = props.chapter.lang;
  const langVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const sorted = [...langVoices].sort(
    (a, b) => Number(b.lang === "fr-FR") - Number(a.lang === "fr-FR") || a.name.localeCompare(b.name),
  );
  const wanted = lang === "fr" ? settings.voiceFr : settings.voiceEn;
  const voice = sorted.find((v) => v.name === wanted) ?? sorted[0] ?? voices[0];
  const isAudio = !!props.chapter.audioUrl;
  const rate = isAudio ? settings.audioRate : settings.rate;

  const extras: ReactNode = (
    <div className="space-y-4 rounded-xl bg-muted p-4">
      {!isAudio && (
        <label className="block">
          <span className="text-sm text-muted-foreground">Voix ({lang.toUpperCase()})</span>
          <select
            value={voice?.name ?? ""}
            onChange={(e) =>
              setSettings((s) => ({ ...s, [lang === "fr" ? "voiceFr" : "voiceEn"]: e.target.value }))
            }
            className="mt-1 h-12 w-full rounded-lg border border-input bg-card px-3"
          >
            {(sorted.length ? sorted : voices).map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </label>
      )}
      <div>
        <span className="text-sm text-muted-foreground">Vitesse</span>
        <div className="mt-1 grid grid-cols-4 gap-1">
          {RATES.map((r) => (
            <button
              key={r}
              onClick={() => setSettings((s) => ({ ...s, [isAudio ? "audioRate" : "rate"]: r }))}
              className={`h-11 rounded-lg text-sm ${r === rate ? "bg-primary text-primary-foreground" : "bg-card"}`}
            >
              {fmtRate(r)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-sm text-muted-foreground">
          Minuteur de sommeil
          {sleepEnd ? ` — arrêt dans ${fmtTime((sleepEnd - Date.now()) / 1000)}` : sleepAtEnd ? " — arrêt à la fin du chapitre" : ""}
        </span>
        <div className="mt-1 grid grid-cols-5 gap-1">
          {[0, 15, 30, 60].map((m) => (
            <button
              key={m}
              onClick={() => { setSleepAtEnd(false); setSleepEnd(m ? Date.now() + m * 60000 : null); }}
              className={`h-11 rounded-lg text-sm ${(!m && !sleepEnd && !sleepAtEnd) ? "bg-primary text-primary-foreground" : "bg-card"}`}
            >
              {m ? `${m} min` : "Off"}
            </button>
          ))}
          <button
            onClick={() => { setSleepEnd(null); setSleepAtEnd(true); }}
            className={`h-11 rounded-lg text-sm leading-tight ${sleepAtEnd ? "bg-primary text-primary-foreground" : "bg-card"}`}
          >
            Fin du chap.
          </button>
        </div>
      </div>
    </div>
  );

  const common = {
    ...props,
    onEnded: () => {
      props.onUpdate(props.chapter.id, { done: true });
      if (sleepAtEnd) {
        setSleepAtEnd(false);
        return;
      }
      props.onEnded();
    },
    rate,
    sleepEnd,
    onSleepDone: () => setSleepEnd(null),
    extras,
  };
  return isAudio ? (
    <AudioPlayer key={props.chapter.id} {...common} />
  ) : (
    <SpeechPlayer key={props.chapter.id} {...common} voice={voice} />
  );
}

interface EngineProps extends PlayerProps {
  rate: number;
  sleepEnd: number | null;
  onSleepDone: () => void;
  extras: ReactNode;
}

function setupMediaSession(
  c: Chapter,
  h: { play: () => void; pause: () => void; prev?: (() => void) | undefined; next?: (() => void) | undefined; back: (offset?: number) => void; fwd: (offset?: number) => void; seek?: (t: number) => void },
) {
  if (!("mediaSession" in navigator)) return;
  engine.setNowPlaying(c);

  const seek = h.seek;
  const map: [MediaSessionAction, MediaSessionActionHandler | undefined][] = [
    ["play", h.play],
    ["pause", h.pause],
    ["previoustrack", h.prev],
    ["nexttrack", h.next],
    ["seekbackward", (d) => h.back(d.seekOffset ?? undefined)],
    ["seekforward", (d) => h.fwd(d.seekOffset ?? undefined)],
    ["seekto", seek ? (d) => { if (d.seekTime != null) seek(d.seekTime); } : undefined],
  ];
  for (const [a, fn] of map) {
    try {
      navigator.mediaSession.setActionHandler(a, fn ?? null);
    } catch {
      /* unsupported */
    }
  }
}

function useSleep(sleepEnd: number | null, pause: () => void, done: () => void) {
  const p = useRef(pause);
  p.current = pause;
  useEffect(() => {
    if (!sleepEnd) return;
    const i = setInterval(() => {
      if (Date.now() >= sleepEnd) {
        p.current();
        done();
      }
    }, 1000);
    return () => clearInterval(i);
  }, [sleepEnd, done]);
}

function Header({ c, onOpen, expanded }: { c: Chapter; onOpen: () => void; expanded: boolean }) {
  return (
    <button onClick={onOpen} disabled={expanded} className="min-w-0 flex-1 text-left">
      <p className="truncate text-xs uppercase tracking-widest text-muted-foreground">
        {[c.series, c.episode != null ? `Ép. ${c.episode}` : "", c.lang.toUpperCase()].filter(Boolean).join(" · ")}
      </p>
      <p className={`truncate font-display ${expanded ? "text-3xl" : "text-lg"}`}>{c.title}</p>
    </button>
  );
}

function MiniBar(p: { c: Chapter; pct: number; playing: boolean; toggle: () => void; onOpen: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur">
      <div className="h-1 bg-muted">
        <div className="h-full bg-primary" style={{ width: `${p.pct * 100}%` }} />
      </div>
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <Header c={p.c} onOpen={p.onOpen} expanded={false} />
        <button onClick={p.toggle} className={btnMain} aria-label={p.playing ? "Pause" : "Lecture"}>
          {p.playing ? "❚❚" : "▶"}
        </button>
      </div>
    </div>
  );
}

function Transport(p: {
  playing: boolean;
  toggle: () => void;
  back: () => void;
  fwd: () => void;
  backLabel: string;
  fwdLabel: string;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <button onClick={p.back} className={btnSoft}>{p.backLabel}</button>
        <button onClick={p.toggle} className={`${btnMain} text-2xl`}>{p.playing ? "❚❚ Pause" : "▶ Lire"}</button>
        <button onClick={p.fwd} className={btnSoft}>{p.fwdLabel}</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={p.onPrev} disabled={!p.onPrev} className={`${btnSoft} disabled:opacity-40`}>⏮ Précédent</button>
        <button onClick={p.onNext} disabled={!p.onNext} className={`${btnSoft} disabled:opacity-40`}>Suivant ⏭</button>
      </div>
    </div>
  );
}

function AudioPlayer(p: EngineProps) {
  const c = p.chapter;
  const url = c.audioUrl!;
  const [t, setT] = useState(c.position);
  const [dur, setDur] = useState(c.duration ?? 0);
  // Durée connue : celle du fichier une fois chargé, sinon celle enregistrée (iPhone avant la 1re lecture).
  const total = dur > 0 && isFinite(dur) ? dur : c.duration ?? 0;
  const totalRef = useRef(total);
  totalRef.current = total;
  const [playing, setPlaying] = useState(false);
  const lastSave = useRef(0);
  const live = useRef(p);
  live.current = p;

  const mine = () => engine.loadedChapterId() === c.id;
  const save = () => {
    // engine.position() returns the requested start until iOS has loaded the metadata,
    // so leaving the page before playing never overwrites the saved position with 0.
    if (mine()) live.current.onUpdate(c.id, { position: engine.position(), updatedAt: Date.now() });
  };
  const play = () => {
    engine.loadChapter(c.id, url, c.position);
    engine.getAudio().play().catch((e) => console.error("[audio] play() refusé :", e));
  };
  const pause = () => engine.getAudio().pause();
  const toggle = () => (playing ? pause() : play());
  /** Aller à une position, même si l'iPhone n'a pas encore chargé le fichier (avant la 1re lecture). */
  const seekTo = (s: number) => {
    engine.loadChapter(c.id, url, c.position); // sans effet si l'épisode est déjà chargé
    const target = engine.seek(s, totalRef.current);
    setT(target);
    lastSave.current = Date.now();
    live.current.onUpdate(c.id, { position: target, updatedAt: Date.now() });
  };
  const seek = (d: number) => seekTo((mine() ? engine.position() : c.position) + d);

  useEffect(() => {
    engine.setRate(p.rate);
  }, [p.rate]);
  useEffect(() => {
    const a = engine.getAudio();
    engine.loadChapter(c.id, url, c.position);
    // Nouvel épisode dans le même lecteur : repartir de ses propres position et durée.
    setT(engine.position());
    setDur(c.duration ?? 0);
    setPlaying(!a.paused);
    if (isFinite(a.duration) && a.duration > 0) {
      setDur(a.duration);
      if (a.duration !== c.duration) live.current.onUpdate(c.id, { duration: a.duration });
    }
    const onMeta = () => {
      if (!mine() || !isFinite(a.duration) || a.duration <= 0) return;
      setDur(a.duration);
      if (isFinite(a.duration) && a.duration !== live.current.chapter.duration) live.current.onUpdate(c.id, { duration: a.duration });
    };
    const onTime = () => {
      if (!mine()) return;
      setT(a.currentTime);
      const se = live.current.sleepEnd;
      if (se && Date.now() >= se) {
        a.pause();
        live.current.onSleepDone();
      }
      if (Date.now() - lastSave.current > 3000) {
        lastSave.current = Date.now();
        save();
      }
    };
    const onPlay = () => {
      setPlaying(true);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    };
    const onPause = () => {
      setPlaying(false);
      save();
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    };
    const onHide = () => save();
    const onVis = () => { if (document.visibilityState === "hidden") save(); };
    const evs: [string, () => void][] = [
      ["loadedmetadata", onMeta], ["durationchange", onMeta], ["timeupdate", onTime], ["play", onPlay],
      ["pause", onPause],
    ];
    for (const [e, f] of evs) a.addEventListener(e, f);
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      for (const [e, f] of evs) a.removeEventListener(e, f);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
      if (mine()) {
        save();
        a.pause();
      }
    };
  }, [c.id]); // pas [url] : passer à la copie téléchargée ne doit pas couper la lecture en cours
  useSleep(p.sleepEnd, pause, p.onSleepDone);
  useEffect(() => {
    setupMediaSession(c, {
      // Écran verrouillé : iOS affiche des boutons « 10 », on saute donc de 10 s (ou de ce qu'il demande).
      play, pause, prev: p.onPrev, next: p.onNext,
      back: (o?: number) => seek(-(o ?? 10)), fwd: (o?: number) => seek(o ?? 10),
      seek: (s) => seekTo(s),
    });
  }, [c.id, c.title, c.series, c.episode, p.onPrev, p.onNext]);

  const pct = total ? t / total : 0;

  if (!p.expanded) return <MiniBar c={c} pct={pct} playing={playing} toggle={toggle} onOpen={p.onOpen} />;
  return (
    <div className="space-y-6">
      <Header c={c} onOpen={p.onOpen} expanded />
      <div>
        <input
          type="range"
          min={0}
          max={total || 0}
          step={1}
          value={Math.min(t, total || t)}
          onChange={(e) => seekTo(+e.target.value)}
          className="w-full accent-primary h-8"
          aria-label="Position"
        />
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>{fmtTime(t)}</span>
          <span>-{fmtTime(Math.max(0, total - t))}</span>
        </div>
      </div>
      <Transport playing={playing} toggle={toggle} back={() => seek(-15)} fwd={() => seek(15)}
        backLabel="↺ 15 s" fwdLabel="15 s ↻" onPrev={p.onPrev} onNext={p.onNext} />
      {p.extras}
      {c.text && <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{withoutTitleLine(c.text, c.title)}</p>}
    </div>
  );
}

function SpeechPlayer(p: EngineProps & { voice?: SpeechSynthesisVoice | undefined }) {
  const c = p.chapter;
  const sentences = useMemo(() => splitSentences(c.text), [c.text]);
  const n = sentences.length;
  const [idx, setIdx] = useState(() => (c.position >= n ? 0 : Math.floor(c.position)));
  const [playing, setPlaying] = useState(false);
  const idxRef = useRef(idx);
  const playingRef = useRef(false);
  const gen = useRef(0);
  const cfg = useRef({ voice: p.voice, rate: p.rate, sentences, onEnded: p.onEnded });
  cfg.current = { voice: p.voice, rate: p.rate, sentences, onEnded: p.onEnded };
  const curEl = useRef<HTMLSpanElement>(null);
  const boxEl = useRef<HTMLDivElement>(null);
  const userScrollAt = useRef(0);

  const setPos = (i: number) => {
    idxRef.current = i;
    setIdx(i);
    p.onUpdate(c.id, { position: i, updatedAt: Date.now() });
  };
  const speakFrom = (i: number) => {
    const synth = window.speechSynthesis;
    const g = ++gen.current;
    synth.cancel();
    const { sentences: ss, voice, rate } = cfg.current;
    if (i >= ss.length) {
      playingRef.current = false;
      setPlaying(false);
      setPos(ss.length);
      cfg.current.onEnded();
      return;
    }
    setPos(i);
    const u = new SpeechSynthesisUtterance(ss[i]);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else u.lang = c.lang === "fr" ? "fr-FR" : "en-US";
    u.rate = rate;
    u.onend = () => {
      if (g === gen.current && playingRef.current) speakFrom(i + 1);
    };
    u.onerror = (e) => {
      if (g !== gen.current || e.error === "interrupted" || e.error === "canceled") return;
      playingRef.current = false;
      setPlaying(false);
    };
    synth.speak(u);
  };
  const play = () => {
    if (!n) return;
    engine.stop();
    playingRef.current = true;
    setPlaying(true);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    speakFrom(idxRef.current >= n ? 0 : idxRef.current);
  };
  const pause = () => {
    playingRef.current = false;
    setPlaying(false);
    gen.current++;
    window.speechSynthesis.cancel();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  };
  const toggle = () => (playing ? pause() : play());
  const jump = (i: number) => {
    const t = Math.max(0, Math.min(n - 1, i));
    if (playingRef.current) speakFrom(t);
    else setPos(t);
  };

  useEffect(() => {
    if (p.token > 0) play();
  }, [p.token]);
  useEffect(() => {
    if (playingRef.current) speakFrom(idxRef.current);
  }, [p.rate, p.voice?.name]);
  useEffect(
    () => () => {
      gen.current++;
      playingRef.current = false;
      window.speechSynthesis.cancel();
    },
    [],
  );
  useSleep(p.sleepEnd, pause, p.onSleepDone);
  useEffect(() => {
    setupMediaSession(c, {
      play, pause, prev: p.onPrev, next: p.onNext,
      back: () => jump(idxRef.current - 1), fwd: () => jump(idxRef.current + 1),
    });
  }, [c.title, c.series, c.episode, p.onPrev, p.onNext, n]);
  // Fait défiler uniquement le cadre du texte (jamais toute la page, qui masquait les commandes),
  // et laisse la main 8 s quand l'utilisateur fait défiler lui-même.
  useEffect(() => {
    const box = boxEl.current;
    const el = curEl.current;
    if (!p.expanded || !box || !el || Date.now() - userScrollAt.current < 8000) return;
    box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2), behavior: "smooth" });
  }, [idx, p.expanded]);

  const pct = n ? idx / n : 0;
  if (!p.expanded) return <MiniBar c={c} pct={pct} playing={playing} toggle={toggle} onOpen={p.onOpen} />;
  const remainingWords = wordCount(sentences.slice(idx).join(" "));
  return (
    <div className="space-y-6">
      <Header c={c} onOpen={p.onOpen} expanded />
      <div>
        <div className="h-2 rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct * 100}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-sm text-muted-foreground">
          <span>Phrase {Math.min(idx + 1, n)} / {n}</span>
          <span>~{Math.max(1, Math.round(remainingWords / (160 * p.rate)))} min restantes</span>
        </div>
      </div>
      <Transport playing={playing} toggle={toggle} back={() => jump(idxRef.current - 1)} fwd={() => jump(idxRef.current + 1)}
        backLabel="↺ Phrase" fwdLabel="Phrase ↻" onPrev={p.onPrev} onNext={p.onNext} />
      {p.extras}
      <div ref={boxEl} onWheel={() => { userScrollAt.current = Date.now(); }} onTouchMove={() => { userScrollAt.current = Date.now(); }}
        className="relative max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-card p-4 text-lg leading-relaxed">
        {sentences.map((s, i) => (
          <span
            key={i}
            ref={i === idx ? curEl : undefined}
            onClick={() => jump(i)}
            className={`cursor-pointer rounded px-0.5 ${i === idx ? "bg-highlight text-foreground" : i < idx ? "text-muted-foreground" : ""}`}
          >
            {s}{" "}
          </span>
        ))}
      </div>
    </div>
  );
}
