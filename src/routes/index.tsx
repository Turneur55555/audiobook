import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Atelier } from "@/components/audiobook/Atelier";
import { Library } from "@/components/audiobook/Library";
import { Player } from "@/components/audiobook/Player";
import { OfflinePanel } from "@/components/audiobook/OfflinePanel";
import { SyncPanel } from "@/components/audiobook/SyncPanel";
import * as db from "@/lib/audiobook-db";
import * as engine from "@/lib/audio-engine";
import { groupChapters, type Chapter } from "@/lib/chapters";
import { deleteChapterRemote, fetchChapters, frError, isOwnerEmail, sb, updateChapter } from "@/lib/supabase";
import * as sync from "@/lib/sync";
import * as offline from "@/lib/offline";

const PUSH_DELAY = 10_000;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Mon Audiobook — Bibliothèque d’écoute" },
      { name: "description", content: "Écoutez les chapitres et reprenez à la seconde près." },
      { property: "og:title", content: "Mon Audiobook — Bibliothèque d’écoute" },
      { property: "og:description", content: "Écoutez les chapitres et reprenez à la seconde près." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Tab = "atelier" | "biblio" | "lecture" | "auteur";
const big = "min-h-14 w-full rounded-xl px-5 text-lg font-medium active:scale-95 transition";
const LOCAL: (keyof Chapter)[] = ["position", "duration", "done", "updatedAt"];

function Index() {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTabState] = useState<Tab>("biblio");
  // Chaque onglet garde son défilement ; « Lecture » s'ouvre toujours en haut (commandes visibles),
  // même si l'on a touché « Écouter » tout en bas de la bibliothèque.
  const scrollByTab = useRef<Partial<Record<Tab, number>>>({});
  const tabRef = useRef(tab);
  const setTab = (k: Tab) => {
    if (k === tabRef.current) return;
    scrollByTab.current[tabRef.current] = window.scrollY;
    tabRef.current = k;
    setTabState(k);
  };
  useEffect(() => {
    window.scrollTo(0, tab === "lecture" ? 0 : scrollByTab.current[tab] ?? 0);
  }, [tab]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const [email, setEmail] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [sleepAtEnd, setSleepAtEnd] = useState(false);
  const sleepAtEndRef = useRef(false);
  sleepAtEndRef.current = sleepAtEnd;
  const stoppedAtEnd = useRef(false);
  const ref = useRef(chapters);
  ref.current = chapters;
  const [isOwner, setIsOwner] = useState(false);
  const [syncState, setSyncState] = useState<{ code: string | null; at: number | null; error: string }>({ code: null, at: null, error: "" });
  const syncCode = useRef<string | null>(null);
  const pending = useRef(new Map<string, db.LocalPos>());
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPull = useRef(0);
  /** Bumped to remount a text (speech) player whose position was changed by another device. */
  const [playerRev, setPlayerRev] = useState(0);

  // ---------- Écoute hors ligne ----------
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [swOn, setSwOn] = useState(false);
  const [online, setOnline] = useState(true);
  const [dl, setDl] = useState<{ progress: Map<string, number>; queue: number; done: number; error: string }>({ progress: new Map(), queue: 0, done: 0, error: "" });
  const [bytes, setBytes] = useState(0);
  const dlAbort = useRef<AbortController | null>(null);
  const fromCache = useRef(false);
  const offRef = useRef({ downloaded, swOn });
  offRef.current = { downloaded, swOn };
  /** Adresse à lire : la copie téléchargée si elle existe (et que le service worker est actif), sinon l'original. */
  const playUrl = (c: Chapter): string | undefined => {
    const src = c.sourceUrl ?? c.audioUrl;
    if (!src) return undefined;
    const { downloaded: d, swOn: on } = offRef.current;
    return on && d.has(offline.norm(src)) ? offline.offlineUrl(src) : src;
  };
  const isDownloaded = (c: Chapter) => !!(c.sourceUrl ?? c.audioUrl) && downloaded.has(offline.norm((c.sourceUrl ?? c.audioUrl)!));

  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    void offline.registerServiceWorker();
    setSwOn(offline.swControls());
    const onCtl = () => setSwOn(offline.swControls());
    navigator.serviceWorker?.addEventListener("controllerchange", onCtl);
    void offline.listDownloaded().then(setDownloaded).catch(() => undefined);
    void offline.downloadedBytes().then(setBytes).catch(() => undefined);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      navigator.serviceWorker?.removeEventListener("controllerchange", onCtl);
    };
  }, []);

  async function downloadMany(ids: string[]) {
    const todo = ids
      .map((id) => ref.current.find((c) => c.id === id))
      .filter((c): c is Chapter => !!c && !!(c.sourceUrl ?? c.audioUrl) && !isDownloaded(c));
    if (!todo.length) return;
    void navigator.storage?.persist?.();
    const ctl = new AbortController();
    dlAbort.current = ctl;
    setDl({ progress: new Map(), queue: todo.length, done: 0, error: "" });
    let failed = "";
    for (let i = 0; i < todo.length; i++) {
      if (ctl.signal.aborted) break;
      const c = todo[i]!;
      const src = (c.sourceUrl ?? c.audioUrl)!;
      try {
        await offline.downloadAudio(src, (pct) => setDl((d) => ({ ...d, progress: new Map(d.progress).set(c.id, pct) })), ctl.signal);
        setDownloaded((o) => new Set(o).add(offline.norm(src)));
      } catch (e) {
        if (ctl.signal.aborted) break;
        failed = `Épisode ${c.episode ?? "?"} : ${(e as Error).message}`;
      }
      setDl((d) => {
        const progress = new Map(d.progress);
        progress.delete(c.id);
        return { ...d, progress, done: i + 1, error: failed };
      });
    }
    dlAbort.current = null;
    setDl((d) => ({ ...d, queue: 0, progress: new Map() }));
    setBytes(await offline.downloadedBytes().catch(() => 0));
  }
  async function removeMany(ids: string[]) {
    for (const id of ids) {
      const c = ref.current.find((x) => x.id === id);
      const src = c && (c.sourceUrl ?? c.audioUrl);
      if (!src) continue;
      await offline.removeDownload(src);
      setDownloaded((o) => {
        const n = new Set(o);
        n.delete(offline.norm(src));
        return n;
      });
    }
    setBytes(await offline.downloadedBytes().catch(() => 0));
  }

  /** Recharge la liste des épisodes depuis le serveur, en gardant les positions locales. */
  async function refreshChapters() {
    try {
      const cs = await fetchChapters();
      void db.setMeta("chaptersCache", cs);
      const old = new Map(ref.current.map((c) => [c.id, c]));
      ref.current = cs.map((c) => {
        const o = old.get(c.id);
        return o ? { ...c, position: o.position, done: o.done, duration: c.duration ?? o.duration } : c;
      });
      setChapters(ref.current);
      fromCache.current = false;
      setNotice((n) => (n.startsWith("Hors ligne") ? "" : n));
    } catch {
      /* toujours hors ligne */
    }
  }

  useEffect(() => {
    const check = async (e?: string | null) => {
      const ok = await isOwnerEmail(e);
      if (e && !ok) {
        setNotice("Ce compte n’est pas autorisé à déposer des chapitres. Vous avez été déconnecté.");
        void sb().auth.signOut();
        setEmail(null);
        setIsOwner(false);
      } else {
        setEmail(e ?? null);
        setIsOwner(ok);
      }
    };
    void sb().auth.getSession().then(({ data }) => check(data.session?.user.email));
    const { data } = sb().auth.onAuthStateChange((ev, s) => {
      if (ev === "SIGNED_IN" || ev === "SIGNED_OUT" || ev === "USER_UPDATED") void check(s?.user.email);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    void navigator.storage?.persist?.();
    (async () => {
      try {
        const [cs, pos, last] = await Promise.all([
          fetchChapters()
            .then((list) => {
              void db.setMeta("chaptersCache", list);
              return list;
            })
            .catch(async (e) => {
              // Pas de réseau : on reprend la dernière bibliothèque enregistrée sur l'appareil.
              const cached = await db.getMeta<Chapter[]>("chaptersCache");
              if (!cached?.length) throw e;
              fromCache.current = true;
              setNotice("Hors ligne : bibliothèque enregistrée sur cet appareil. Tes positions se resynchroniseront dès le retour du réseau.");
              return cached;
            }),
          db.getAllPositions(),
          db.getMeta<string>("lastId"),
        ]);
        const pm = new Map(pos.map((p) => [p.id, p]));
        const merged = cs.map((c) => {
          const p = pm.get(c.id);
          return p ? { ...c, position: p.position, done: p.done, duration: c.duration ?? p.duration } : c;
        });
        ref.current = merged;
        setChapters(merged);
        if (last && merged.some((c) => c.id === last)) setCurrentId(last);
      } catch (e) {
        setError(`Impossible de charger la bibliothèque : ${frError(e)}`);
      }
      setLoaded(true);
      await initSync();
    })();
  }, []);

  const update = useCallback((id: string, patch: Partial<Chapter>) => {
    const cur = ref.current.find((c) => c.id === id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    ref.current = ref.current.map((c) => (c.id === id ? next : c));
    setChapters(ref.current);
    // Ne date la position « maintenant » que si elle a vraiment changé : sinon, une simple mise en
    // arrière-plan (qui ré-enregistre la même position) écraserait l'écoute faite sur un autre appareil.
    const changed =
      ("position" in patch && Math.abs((patch.position ?? 0) - cur.position) >= 0.5) ||
      ("done" in patch && !!patch.done !== !!cur.done) ||
      ("duration" in patch && patch.duration !== cur.duration);
    if (LOCAL.some((k) => k in patch) && changed) {
      const pos: db.LocalPos = { id, position: next.position, duration: next.duration, done: next.done, updatedAt: sync.clockNow() };
      void db.putPosition(pos);
      pending.current.set(id, pos);
      schedulePush();
    }
  }, []);

  // ---------- Synchronisation entre appareils ----------
  async function flushPush() {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = null;
    const code = syncCode.current;
    if (!code || !pending.current.size) return;
    const items = [...pending.current.values()];
    pending.current.clear();
    try {
      await sync.push(sb(), code, items);
      setSyncState((s) => ({ ...s, at: Date.now(), error: "" }));
    } catch (e) {
      // On remet en attente ce qui n'a pas été remplacé entre-temps.
      for (const p of items) if (!pending.current.has(p.id)) pending.current.set(p.id, p);
      setSyncState((s) => ({ ...s, error: sync.syncErrorText(e) }));
      if (!pushTimer.current) pushTimer.current = setTimeout(() => void flushPush(), 60_000);
    }
  }
  function schedulePush() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return void flushPush();
    if (!pushTimer.current) pushTimer.current = setTimeout(() => void flushPush(), PUSH_DELAY);
  }

  /** Applique les positions plus récentes reçues d'un autre appareil, sans couper une lecture en cours. */
  function applyRemote(list: db.LocalPos[]) {
    const known = new Map(ref.current.map((c) => [c.id, c]));
    const speaking = typeof window !== "undefined" && !!window.speechSynthesis?.speaking;
    const applied: db.LocalPos[] = [];
    for (const r of list) {
      const c = known.get(r.id);
      if (!c) continue;
      const playingThis = (engine.loadedChapterId() === r.id && engine.isPlaying()) || (speaking && r.id === currentIdRef.current);
      if (playingThis) continue;
      known.set(r.id, { ...c, position: r.position, done: r.done, duration: c.duration ?? r.duration });
      void db.putPosition(r);
      pending.current.delete(r.id);
      if (engine.loadedChapterId() === r.id) engine.seekLoaded(r.id, r.position);
      else if (r.id === currentIdRef.current && !c.audioUrl) setPlayerRev((n) => n + 1);
      applied.push(r);
    }
    if (!applied.length) return applied;
    ref.current = ref.current.map((c) => known.get(c.id) ?? c);
    setChapters(ref.current);
    return applied;
  }

  async function syncNow() {
    const code = syncCode.current;
    if (!code) return;
    lastPull.current = Date.now();
    try {
      const [remote, local] = await Promise.all([sync.pull(sb(), code), db.getAllPositions()]);
      const { toApply, toPush } = sync.mergePositions(local, remote);
      const applied = applyRemote(toApply);
      // Reprendre là où on s'est arrêté sur l'autre appareil, si rien n'est en lecture ici.
      // On ne suit que les écoutes en cours (pas un simple « marqué écouté » fait ailleurs).
      const newest = sync.latest(applied.filter((p) => !p.done && p.position > 0));
      const localNewest = sync.latest(local);
      if (newest && (!localNewest || newest.updatedAt > localNewest.updatedAt) && !engine.isPlaying()
        && !(typeof window !== "undefined" && window.speechSynthesis?.speaking)) {
        setCurrentId(newest.id);
        void db.setMeta("lastId", newest.id);
      }
      for (const p of toPush) if (!pending.current.has(p.id)) pending.current.set(p.id, p);
      await flushPush();
      setSyncState((s) => ({ ...s, at: Date.now(), error: "" }));
    } catch (e) {
      setSyncState((s) => ({ ...s, error: sync.syncErrorText(e) }));
    }
  }

  async function initSync() {
    const fromLink = sync.normalizeCode(window.location.hash);
    let code = fromLink ?? sync.normalizeCode(await db.getMeta<string>("syncCode"));
    if (!code) code = sync.newSyncCode();
    await db.setMeta("syncCode", code);
    if (fromLink) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setNotice("Cet appareil est relié : tes positions d’écoute se synchronisent maintenant avec ton autre appareil.");
    }
    syncCode.current = code;
    setSyncState((s) => ({ ...s, code }));
    await syncNow();
  }

  async function linkTo(code: string) {
    await flushPush();
    syncCode.current = code;
    await db.setMeta("syncCode", code);
    setSyncState({ code, at: null, error: "" });
    await syncNow();
  }

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") void flushPush();
      else if (Date.now() - lastPull.current > 5000) void syncNow();
    };
    const onFocus = () => { if (Date.now() - lastPull.current > 5000) void syncNow(); };
    const onOnline = () => {
      if (fromCache.current) void refreshChapters();
      void syncNow();
    };
    const onHide = () => void flushPush();
    const onHash = () => {
      const c = sync.normalizeCode(window.location.hash);
      if (!c) return;
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (c !== syncCode.current) {
        void linkTo(c);
        setNotice("Cet appareil est relié : tes positions d’écoute se synchronisent maintenant avec ton autre appareil.");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const play = useCallback((id: string) => {
    const c = ref.current.find((x) => x.id === id);
    const url = c && playUrl(c);
    if (url && !offline.isOfflineUrl(url) && !navigator.onLine) {
      setNotice("Cet épisode n’est pas téléchargé : il faut du réseau pour l’écouter.");
      return;
    }
    // « Réécouter » un épisode fini : il repart du début et n'est plus marqué écouté.
    const start = c?.done ? 0 : c?.position ?? 0;
    if (c?.done) update(id, { done: false, position: 0 });
    if (url) engine.playChapter(id, url, start);
    else engine.stop();
    setCurrentId(id);
    setToken((t) => t + 1);
    void db.setMeta("lastId", id);
  }, []);

  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const view = useMemo(() => chapters.map((c) => (c.audioUrl ? { ...c, audioUrl: playUrl(c) } : c)), [chapters, downloaded, swOn]);
  const current = view.find((c) => c.id === currentId) ?? null;
  const siblings = useMemo(() => {
    if (!current) return { prev: undefined, next: undefined };
    const g = groupChapters(chapters).find((g) => g.chapters.some((c) => c.id === current.id))!;
    const i = g.chapters.findIndex((c) => c.id === current.id);
    return { prev: g.chapters[i - 1]?.id, next: g.chapters[i + 1]?.id };
  }, [chapters, current]);
  const onPrev = useMemo(() => (siblings.prev ? () => play(siblings.prev!) : undefined), [siblings.prev, play]);
  const onNext = useMemo(() => (siblings.next ? () => play(siblings.next!) : undefined), [siblings.next, play]);
  const onEnded = useCallback(() => {
    if (siblings.next) {
      update(siblings.next, { position: 0 });
      play(siblings.next);
    }
  }, [siblings.next, play, update]);

  const nextRef = useRef<string | undefined>(undefined);
  nextRef.current = siblings.next;
  useEffect(() => {
    engine.setHooks({
      getNext: () => {
        const n = ref.current.find((c) => c.id === nextRef.current);
        if (!n) return null;
        const url = playUrl(n);
        // Hors ligne, on ne passe pas à un épisode qui n'est pas téléchargé.
        if (url && !offline.isOfflineUrl(url) && !navigator.onLine) return null;
        return { id: n.id, url, title: n.title, series: n.series, episode: n.episode };
      },
      onLeave: (id, seconds) => {
        update(id, { position: seconds, updatedAt: Date.now() });
      },
      shouldStopAtEnd: () => {
        const s = sleepAtEndRef.current;
        stoppedAtEnd.current = s;
        if (s) {
          sleepAtEndRef.current = false;
          setSleepAtEnd(false);
        }
        return s;
      },
      onChapterEnded: (endedId, duration, nextId) => {
        const ended = ref.current.find((c) => c.id === endedId);
        update(endedId, { done: true, position: duration || ended?.duration || 0 });
        if (nextId) {
          update(nextId, { position: 0 });
          setCurrentId(nextId);
          void db.setMeta("lastId", nextId);
        } else if (!stoppedAtEnd.current && nextRef.current) {
          update(nextRef.current, { position: 0 });
          play(nextRef.current);
        }
      },
    });
  }, [update, play]);

  async function doExport() {
    const b = await db.exportPositions();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `audiobook-positions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function doImport(f?: File) {
    if (!f) return;
    try {
      const ps = await db.importPositions(f);
      for (const p of ps) pending.current.set(p.id, p);
      void flushPush();
      const pm = new Map(ps.map((p) => [p.id, p]));
      setChapters((o) => o.map((c) => (pm.has(c.id) ? { ...c, position: pm.get(c.id)!.position, done: pm.get(c.id)!.done } : c)));
      setNotice(`${ps.length} position(s) de lecture restaurée(s).`);
    } catch (e) {
      setNotice(`Import impossible : ${(e as Error).message}`);
    }
  }

  const tabs: [Tab, string][] = [
    ...(isOwner ? ([["atelier", "Atelier"]] as [Tab, string][]) : []),
    ["biblio", "Bibliothèque"],
    ["lecture", "Lecture"],
  ];

  return (
    <main className="min-h-screen bg-background pb-32 text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 pt-4">
          <h1 className="font-display text-3xl">Mon Audiobook</h1>
          <nav className={`mt-3 grid ${isOwner ? "grid-cols-3" : "grid-cols-2"}`}>
            {tabs.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`h-14 border-b-2 text-lg ${tab === k ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground"}`}>
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-3xl px-4 py-6">
        {!online && (
          <p className="mb-4 rounded-xl border border-border bg-card p-3 text-sm" role="status">
            📴 Hors ligne : seuls les épisodes téléchargés peuvent être écoutés. Tes positions seront envoyées au retour du réseau.
          </p>
        )}
        {notice && <p className="mb-6 rounded-xl bg-secondary p-4" role="status">{notice}</p>}
        {error && <p className="mb-6 rounded-xl border border-destructive bg-card p-4 text-destructive" role="alert">{error}</p>}
        {!loaded ? (
          <p className="text-muted-foreground">Chargement…</p>
        ) : tab === "atelier" && isOwner ? (
          <Atelier chapters={chapters} onSaved={(cs) => setChapters((o) => {
            const byId = new Map(cs.map((c) => [c.id, c]));
            // Garde la position d'écoute locale des épisodes mis à jour ; ajoute les nouveaux.
            const merged = o.map((c) => (byId.has(c.id) ? { ...byId.get(c.id)!, position: c.position, done: c.done } : c));
            return [...merged, ...cs.filter((c) => !o.some((x) => x.id === c.id))];
          })} />
        ) : tab === "auteur" ? (
          <AuthorLogin email={email} onDone={() => setTab(isOwner ? "atelier" : "biblio")} />
        ) : tab === "biblio" || tab === "atelier" ? (
          <>
            <Library chapters={view} currentId={currentId} isOwner={isOwner}
              offline={{
                online,
                isDownloaded,
                progress: dl.progress,
                onDownload: (id) => void downloadMany([id]),
                onRemove: (id) => void removeMany([id]),
                busy: dl.queue > 0,
              }}
              onPlay={(id) => { play(id); setTab("lecture"); }}
              onToggleDone={(id) => { const c = ref.current.find((x) => x.id === id); update(id, { done: !c?.done }); }}
              onEdit={async (id, patch) => {
                try { await updateChapter(id, patch); update(id, patch); }
                catch (e) { alert(`Modification impossible : ${frError(e)}`); throw e; }
              }}
              onDelete={async (c) => {
                try {
                  await deleteChapterRemote(c);
                  if (currentId === c.id) { engine.stop(); setCurrentId(null); }
                  setChapters((o) => o.filter((x) => x.id !== c.id));
                } catch (e) { alert(`Suppression impossible : ${frError(e)}`); }
              }} />
            <OfflinePanel chapters={view} isDownloaded={isDownloaded} bytes={bytes} online={online} swOn={swOn}
              queue={dl.queue} done={dl.done} error={dl.error} progress={dl.progress}
              onDownloadAll={(ids) => void downloadMany(ids)} onRemoveAll={(ids) => void removeMany(ids)}
              onCancel={() => dlAbort.current?.abort()} />
            <SyncPanel code={syncState.code} lastSync={syncState.at} error={syncState.error}
              onLink={linkTo} onExport={() => void doExport()} onImport={(f) => void doImport(f)} />
          </>
        ) : !current ? (
          <p className="text-lg text-muted-foreground">Choisissez un chapitre dans la bibliothèque.</p>
        ) : null}
        {current && (
          <div className={tab === "lecture" ? "" : "contents"}>
            <Player key={playerRev} chapter={current} token={token} expanded={tab === "lecture"} onUpdate={update}
              sleepAtEnd={sleepAtEnd} setSleepAtEnd={setSleepAtEnd}
              onEnded={onEnded} onPrev={onPrev} onNext={onNext} onOpen={() => setTab("lecture")} />
          </div>
        )}
        <footer className="mt-16 text-center text-sm text-muted-foreground">
          {isOwner ? (
            <button className="underline" onClick={() => { void sb().auth.signOut(); setTab("biblio"); }}>Déconnexion ({email})</button>
          ) : (
            <button className="underline" onClick={() => setTab("auteur")}>Espace auteur</button>
          )}
        </footer>
      </section>
    </main>
  );
}

function AuthorLogin({ email, onDone }: { email: string | null; onDone: () => void }) {
  const [v, setV] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (email) return <button onClick={onDone} className={`${big} bg-primary text-primary-foreground`}>Ouvrir l’Atelier</button>;
  async function send() {
    if (!(await isOwnerEmail(v))) return setMsg("Cette adresse n’a pas accès à l’espace auteur.");
    setBusy(true);
    const { error } = await sb().auth.signInWithOtp({ email: v.trim(), options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    setMsg(error ? `Envoi impossible : ${frError(error)}` : "Lien envoyé ! Ouvrez votre boîte mail et cliquez sur le lien.");
  }
  return (
    <div className="space-y-3">
      <h2 className="font-display text-2xl">Espace auteur</h2>
      <p className="text-muted-foreground">Recevez un lien de connexion par e-mail.</p>
      <input type="email" value={v} onChange={(e) => setV(e.target.value)} placeholder="Votre e-mail"
        className="h-14 w-full rounded-xl border border-input bg-card px-4 text-lg" />
      <button onClick={send} disabled={busy} className={`${big} bg-primary text-primary-foreground disabled:opacity-50`}>
        {busy ? "Envoi…" : "Recevoir le lien magique"}
      </button>
      {msg && <p className="rounded-xl bg-secondary p-4" role="status">{msg}</p>}
    </div>
  );
}
