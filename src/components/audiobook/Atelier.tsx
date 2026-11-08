import { useRef, useState } from "react";
import { audioDuration } from "@/lib/audiobook-db";
import { ATELIER_BOOK_KEY, baseName, bookKey, groupBooks, joinSeries, splitSeries, tomeLabel, cleanTitle, episodeFrom, findSameEpisode, groupChapters, recall, remember, splitEpisodeHeading, stripHeading, titleFromText, type Chapter, type Lang } from "@/lib/chapters";
import { frError, insertChapter, removeAudioQuietly, uniqueAudioPath, updateChapterContent, uploadAudio } from "@/lib/supabase";

const field = "h-14 w-full rounded-xl border border-input bg-card px-4 text-lg";
const big = "min-h-14 w-full rounded-xl px-5 text-lg font-medium active:scale-95 transition";
const isAudio = (f: File) => f.type.startsWith("audio/") || /\.(mp3|m4a)$/i.test(f.name);

interface Job { name: string; pct: number; status: "attente" | "envoi" | "ok" | "erreur"; updated?: boolean; error?: string }

const BOOK_KEY = ATELIER_BOOK_KEY;

/** Étape 1 de l'Atelier : choisir un tome existant ou en créer un (titre du livre + tome). */
function BookPicker(p: { chapters: Chapter[]; onPick: (series: string, lang: Lang) => void }) {
  const books = groupBooks(p.chapters);
  const [bookTitle, setBookTitle] = useState("");
  const [tome, setTome] = useState("");
  const [lang, setLang] = useState<Lang>("fr");
  const [err, setErr] = useState("");
  const create = () => {
    if (!bookTitle.trim()) return setErr("Donne le titre du livre (par exemple « Le Seuil d’Astréon »).");
    if (!tome.trim()) return setErr("Indique le tome (par exemple « Tome 3 »).");
    const n = joinSeries(bookTitle, tome);
    const same = groupChapters(p.chapters).find((g) => g.key === bookKey(n, lang));
    p.onPick(same?.series ?? n, lang);
  };
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="font-display text-2xl">Dans quel tome déposer ?</h2>
        {books.length === 0 && <p className="text-muted-foreground">Aucun livre pour l’instant : crée le premier ci-dessous.</p>}
        {books.map((b) => (
          <div key={b.key} className="space-y-2">
            <h3 className="font-display text-xl">{b.title}</h3>
            {b.tomes.map((g) => (
              <button key={g.key} onClick={() => p.onPick(g.series, g.lang)}
                className="w-full rounded-2xl border border-border bg-card p-4 text-left active:scale-[0.98] transition">
                <span className="block text-lg font-medium">{tomeLabel(g)} <span className="text-base text-muted-foreground">· {g.lang.toUpperCase()}</span></span>
                <span className="text-sm text-muted-foreground">{g.chapters.length} épisode(s) · {g.chapters.filter((c) => c.audioPath).length} avec audio</span>
              </button>
            ))}
            <button onClick={() => { setBookTitle(b.title); setTome(""); setErr(""); document.getElementById("nouveau-tome")?.scrollIntoView?.({ behavior: "smooth" }); }}
              className="w-full rounded-2xl border border-dashed border-border p-3 text-left text-muted-foreground">＋ Nouveau tome de « {b.title} »</button>
          </div>
        ))}
      </section>
      <section id="nouveau-tome" className="space-y-3">
        <h2 className="font-display text-2xl">Nouveau livre ou nouveau tome</h2>
        <input value={bookTitle} onChange={(e) => { setBookTitle(e.target.value); setErr(""); }} placeholder="Titre du livre (ex. Le Seuil d’Astréon)" className={field} list="titres-livres" />
        <datalist id="titres-livres">{books.map((b) => <option key={b.key} value={b.title} />)}</datalist>
        <input value={tome} onChange={(e) => { setTome(e.target.value); setErr(""); }} placeholder="Tome (ex. Tome 2)" className={field}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
        <div className="grid grid-cols-2 gap-2">
          {(["fr", "en"] as const).map((l) => (
            <button key={l} onClick={() => setLang(l)}
              className={`${big} ${lang === l ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
              {l === "fr" ? "Français" : "English"}
            </button>
          ))}
        </div>
        {err && <p className="text-destructive">{err}</p>}
        <button onClick={create} className={`${big} bg-primary text-primary-foreground`}>Créer et déposer dedans</button>
      </section>
    </div>
  );
}

export function Atelier(p: { chapters: Chapter[]; onSaved: (cs: Chapter[]) => void }) {
  const [book, setBook] = useState<{ series: string; lang: Lang } | null>(() => {
    const v = recall(BOOK_KEY);
    if (!v) return null;
    try { const b = JSON.parse(v) as { series: string; lang: Lang }; return b.series && (b.lang === "fr" || b.lang === "en") ? b : null; }
    catch { return null; }
  });
  const pick = (b: { series: string; lang: Lang } | null) => {
    setBook(b);
    remember(BOOK_KEY, b ? JSON.stringify(b) : null);
  };
  if (!book) return <BookPicker chapters={p.chapters} onPick={(series, lang) => pick({ series, lang })} />;
  return <BookUpload key={bookKey(book.series, book.lang)} {...p} series={book.series} lang={book.lang} onChangeBook={() => pick(null)} />;
}

function BookUpload(p: { chapters: Chapter[]; onSaved: (cs: Chapter[]) => void; series: string; lang: Lang; onChangeBook: () => void }) {
  const { series, lang } = p;
  const [title, setTitle] = useState("");
  const [episode, setEpisode] = useState("");
  const [text, setText] = useState("");
  const [audio, setAudio] = useState<File | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const audioInput = useRef<HTMLInputElement>(null);

  const setJob = (i: number, j: Partial<Job>) => setJobs((o) => o.map((x, k) => (k === i ? { ...x, ...j } : x)));

  /**
   * Dépose un épisode. S'il existe déjà (même tome, même langue, même numéro), il est mis à jour :
   * nouveau texte s'il y en a un, audio ajouté ou remplacé. Sinon, il est créé.
   */
  async function save(
    item: { text?: File | string; audio?: File; title?: string; episode?: number | null },
    reserved: Set<string>,
    onPct: (n: number) => void,
  ): Promise<{ chapter: Chapter; updated: boolean }> {
    const raw = typeof item.text === "string" ? item.text : item.text ? await item.text.text() : "";
    const fname = item.text instanceof File ? item.text.name : item.audio?.name;
    const heading = titleFromText(raw);
    const split = splitEpisodeHeading(heading);
    const body = /^\s*#/.test(raw) ? stripHeading(raw) : raw.trim();
    const t = item.title || split?.title || heading || (fname ? cleanTitle(fname) : "Sans titre");
    const ep = item.episode !== undefined && item.episode !== null ? item.episode : split?.episode ?? episodeFrom(heading, fname);
    const existing = findSameEpisode(p.chapters, series, lang, ep);
    let audio_path: string | null = null;
    let duration: number | null = null;
    if (item.audio) {
      if (item.audio.size > 100 * 1024 * 1024) throw new Error("fichier trop volumineux (100 Mo maximum).");
      duration = (await audioDuration(item.audio)) ?? null;
      audio_path = await uniqueAudioPath(series.trim(), lang, item.audio.name, reserved);
      await uploadAudio(audio_path, item.audio, onPct);
    }
    onPct(1);
    try {
      if (!existing) {
        const chapter = await insertChapter({ title: t, episode: ep, series: series.trim(), lang, body, audio_path, duration });
        return { chapter, updated: false };
      }
      const chapter = await updateChapterContent(existing.id, {
        title: item.text ? t : existing.title,
        episode: ep,
        body: body || existing.text,
        audio_path: audio_path ?? existing.audioPath ?? null,
        duration: audio_path ? duration : existing.duration ?? null,
      });
      if (audio_path && existing.audioPath) void removeAudioQuietly(existing.audioPath);
      return { chapter, updated: true };
    } catch (e) {
      // L'épisode n'a pas été enregistré : on ne laisse pas son MP3 orphelin dans le stockage.
      if (audio_path) void removeAudioQuietly(audio_path);
      throw e;
    }
  }

  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setMsg("");
    const byName = new Map<string, { text?: File; audio?: File }>();
    for (const f of Array.from(list)) {
      const k = baseName(f.name).toLowerCase();
      const e = byName.get(k) ?? {};
      if (isAudio(f)) e.audio = f;
      else e.text = f;
      byName.set(k, e);
    }
    const items = [...byName.values()];
    setJobs(items.map((it) => ({ name: [it.text?.name, it.audio?.name].filter(Boolean).join(" + "), pct: 0, status: "attente" })));
    const reserved = new Set<string>();
    const saved: Chapter[] = [];
    let created = 0;
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < items.length; i++) {
      setJob(i, { status: "envoi" });
      try {
        const r = await save(items[i]!, reserved, (pct) => setJob(i, { pct }));
        saved.push(r.chapter);
        if (r.updated) updated++;
        else created++;
        setJob(i, { status: "ok", pct: 1, updated: r.updated });
        p.onSaved([r.chapter]);
      } catch (e) {
        failed++;
        setJob(i, { status: "erreur", error: frError(e) });
      }
    }
    setMsg(`${created} épisode(s) ajouté(s), ${updated} mis à jour${failed ? `, ${failed} en échec (voir ci-dessous)` : ""}.`);
    setBusy(false);
  }

  async function addOne() {
    if (!text.trim() && !audio) return setMsg("Ajoutez un texte ou un fichier audio.");
    setBusy(true);
    setMsg("");
    setJobs(audio ? [{ name: audio.name, pct: 0, status: "envoi" }] : []);
    try {
      const ep = episode.trim() ? parseInt(episode, 10) : null;
      const r = await save({ text, ...(audio ? { audio } : {}), title: title.trim(), episode: ep }, new Set(), (pct) => setJob(0, { pct }));
      if (audio) setJob(0, { status: "ok", pct: 1, updated: r.updated });
      p.onSaved([r.chapter]);
      setTitle(""); setEpisode(""); setText(""); setAudio(null);
      if (audioInput.current) audioInput.current.value = "";
      setMsg(r.updated ? "Épisode existant mis à jour." : "Chapitre déposé dans la bibliothèque.");
    } catch (e) {
      if (audio) setJob(0, { status: "erreur", error: frError(e) });
      setMsg(`Dépôt impossible : ${frError(e)}`);
    }
    setBusy(false);
  }

  return (
    <div className="space-y-8">
      <section className="flex items-center justify-between gap-3 rounded-2xl border border-primary bg-card p-4">
        <div className="min-w-0">
          <p className="truncate text-sm text-muted-foreground">{splitSeries(series).title}</p>
          <p className="truncate font-display text-xl">{splitSeries(series).tome || "Tome unique"} <span className="text-base text-muted-foreground">· {lang.toUpperCase()}</span></p>
          <p className="text-sm text-muted-foreground">{p.chapters.filter((c) => bookKey(c.series, c.lang) === bookKey(series, lang)).length} épisode(s) déjà dedans</p>
        </div>
        <button onClick={p.onChangeBook} disabled={busy} className="min-h-12 shrink-0 rounded-xl bg-secondary px-4 font-medium disabled:opacity-50">Changer</button>
      </section>
      {msg && <p className="rounded-xl bg-secondary p-4" role="status">{msg}</p>}
      {jobs.length > 0 && (
        <ul className="space-y-2">
          {jobs.map((j, i) => (
            <li key={i} className="rounded-xl border border-border bg-card p-3">
              <div className="flex justify-between gap-2 text-sm">
                <span className="truncate">{j.name}</span>
                <span className={j.status === "erreur" ? "text-destructive" : "text-muted-foreground"}>
                  {j.status === "ok" ? (j.updated ? "✓ Mis à jour" : "✓ Ajouté") :j.status === "erreur" ? "Échec" : j.status === "envoi" ? `${Math.round(j.pct * 100)} %` : "En attente"}
                </span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-muted">
                <div className={`h-full rounded-full ${j.status === "erreur" ? "bg-destructive" : "bg-primary"}`} style={{ width: `${j.pct * 100}%` }} />
              </div>
              {j.error && <p className="mt-1 text-sm text-destructive">{j.error}</p>}
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-3">
        <h2 className="font-display text-2xl">Importer des fichiers</h2>
        <p className="text-muted-foreground">.txt, .md, .mp3 ou .m4a — plusieurs à la fois. Un audio portant le même nom qu’un texte y est rattaché. Le titre vient de la première ligne du texte. Un épisode déjà présent dans ce tome est mis à jour, pas dupliqué.</p>
        <label className={`${big} flex cursor-pointer items-center justify-center bg-primary text-primary-foreground ${busy ? "pointer-events-none opacity-50" : ""}`}>
          {busy ? "Envoi en cours…" : "Choisir des fichiers"}
          <input type="file" multiple hidden accept=".txt,.md,.mp3,.m4a,text/plain,text/markdown,audio/mpeg,audio/mp4,audio/x-m4a"
            onChange={(e) => { void importFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-2xl">Coller un chapitre</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre (sinon : première ligne du texte)" className={field} />
        <input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="N° d’épisode (sinon : « Épisode N »)" className={field} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10}
          placeholder="Collez ici le texte venant de Claude ou ChatGPT…"
          className="w-full rounded-xl border border-input bg-card p-4 text-lg leading-relaxed" />
        <label className="block">
          <span className="text-muted-foreground">Fichier audio (facultatif)</span>
          <input ref={audioInput} type="file" accept=".mp3,.m4a,audio/mpeg,audio/mp4,audio/x-m4a" onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-base file:mr-3 file:h-12 file:rounded-lg file:border-0 file:bg-secondary file:px-4" />
        </label>
        <button onClick={addOne} disabled={busy} className={`${big} bg-primary text-primary-foreground disabled:opacity-50`}>
          Déposer le chapitre
        </button>
      </section>
    </div>
  );
}
