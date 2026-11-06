import { useRef, useState } from "react";
import { audioDuration } from "@/lib/audiobook-db";
import { baseName, cleanTitle, episodeFrom, findSameEpisode, mostCommonSeries, splitEpisodeHeading, stripHeading, titleFromText, type Chapter, type Lang } from "@/lib/chapters";
import { frError, insertChapter, removeAudioQuietly, uniqueAudioPath, updateChapterContent, uploadAudio } from "@/lib/supabase";

const field = "h-14 w-full rounded-xl border border-input bg-card px-4 text-lg";
const big = "min-h-14 w-full rounded-xl px-5 text-lg font-medium active:scale-95 transition";
const isAudio = (f: File) => f.type.startsWith("audio/") || /\.(mp3|m4a)$/i.test(f.name);

interface Job { name: string; pct: number; status: "attente" | "envoi" | "ok" | "erreur"; updated?: boolean; error?: string }

export function Atelier(p: { chapters: Chapter[]; onSaved: (cs: Chapter[]) => void }) {
  const [series, setSeries] = useState(() => mostCommonSeries(p.chapters));
  const [lang, setLang] = useState<Lang>("fr");
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

  const noSeries = () => {
    if (series.trim()) return false;
    setMsg("Indique d’abord la série dans « Série et langue » (par exemple « Tome 1 »), puis relance l’import.");
    return true;
  };

  async function importFiles(list: FileList | null) {
    if (!list?.length || noSeries()) return;
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
    if (noSeries()) return;
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
        <h2 className="font-display text-2xl">Série et langue</h2>
        <input value={series} onChange={(e) => setSeries(e.target.value)} placeholder="Série / tome (ex. Tome 1)" className={field} />
        <div className="grid grid-cols-2 gap-2">
          {(["fr", "en"] as const).map((l) => (
            <button key={l} onClick={() => setLang(l)}
              className={`${big} ${lang === l ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
              {l === "fr" ? "Français" : "English"}
            </button>
          ))}
        </div>
      </section>

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
