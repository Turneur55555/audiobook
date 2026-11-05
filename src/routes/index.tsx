import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Atelier } from "@/components/audiobook/Atelier";
import { Library } from "@/components/audiobook/Library";
import { Player } from "@/components/audiobook/Player";
import * as db from "@/lib/audiobook-db";
import * as engine from "@/lib/audio-engine";
import { groupChapters, type Chapter } from "@/lib/chapters";
import { deleteChapterRemote, fetchChapters, frError, isOwnerEmail, sb, updateChapter } from "@/lib/supabase";

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
  const [tab, setTab] = useState<Tab>("biblio");
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
  const isOwner = isOwnerEmail(email);

  useEffect(() => {
    const check = (e?: string | null) => {
      if (e && !isOwnerEmail(e)) {
        setNotice("Ce compte n’est pas autorisé à déposer des chapitres. Vous avez été déconnecté.");
        void sb().auth.signOut();
        setEmail(null);
      } else setEmail(e ?? null);
    };
    void sb().auth.getSession().then(({ data }) => check(data.session?.user.email));
    const { data } = sb().auth.onAuthStateChange((ev, s) => {
      if (ev === "SIGNED_IN" || ev === "SIGNED_OUT" || ev === "USER_UPDATED") check(s?.user.email);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    void navigator.storage?.persist?.();
    (async () => {
      try {
        const [cs, pos, last] = await Promise.all([fetchChapters(), db.getAllPositions(), db.getMeta<string>("lastId")]);
        const pm = new Map(pos.map((p) => [p.id, p]));
        const merged = cs.map((c) => {
          const p = pm.get(c.id);
          return p ? { ...c, position: p.position, done: p.done, duration: c.duration ?? p.duration } : c;
        });
        setChapters(merged);
        if (last && merged.some((c) => c.id === last)) setCurrentId(last);
      } catch (e) {
        setError(`Impossible de charger la bibliothèque : ${frError(e)}`);
      }
      setLoaded(true);
    })();
  }, []);

  const update = useCallback((id: string, patch: Partial<Chapter>) => {
    const cur = ref.current.find((c) => c.id === id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    ref.current = ref.current.map((c) => (c.id === id ? next : c));
    setChapters(ref.current);
    if (LOCAL.some((k) => k in patch))
      void db.putPosition({ id, position: next.position, duration: next.duration, done: next.done, updatedAt: Date.now() });
  }, []);

  const play = useCallback((id: string) => {
    const c = ref.current.find((x) => x.id === id);
    if (c?.audioUrl) engine.playChapter(id, c.audioUrl, c.position);
    else engine.stop();
    setCurrentId(id);
    setToken((t) => t + 1);
    void db.setMeta("lastId", id);
  }, []);

  const current = chapters.find((c) => c.id === currentId) ?? null;
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
        return n ? { id: n.id, url: n.audioUrl, title: n.title, series: n.series, episode: n.episode } : null;
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
            <Library chapters={chapters} currentId={currentId} isOwner={isOwner}
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
            <section className="mt-12 space-y-3">
              <h2 className="font-display text-xl">Mes positions de lecture</h2>
              <p className="text-muted-foreground">Elles restent sur cet appareil. Exportez-les pour les transférer.</p>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={doExport} className={`${big} bg-secondary`}>Exporter</button>
                <label className={`${big} flex cursor-pointer items-center justify-center bg-secondary`}>
                  Importer
                  <input type="file" accept="application/json,.json" hidden onChange={(e) => { void doImport(e.target.files?.[0]); e.target.value = ""; }} />
                </label>
              </div>
            </section>
          </>
        ) : !current ? (
          <p className="text-lg text-muted-foreground">Choisissez un chapitre dans la bibliothèque.</p>
        ) : null}
        {current && (
          <div className={tab === "lecture" ? "" : "contents"}>
            <Player chapter={current} token={token} expanded={tab === "lecture"} onUpdate={update}
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
    if (!isOwnerEmail(v)) return setMsg("Cette adresse n’a pas accès à l’espace auteur.");
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
