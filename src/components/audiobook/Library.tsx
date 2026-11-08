import { useState } from "react";
import { SHELF_BOOK_KEY as SHELF_KEY, SHELF_TITLE_KEY, bookKey, fmtTime, groupBooks, joinSeries, planBookRename, progressOf, recall, remember, splitSeries, tomeLabel, wordCount, type Chapter, type Group, type Lang } from "@/lib/chapters";

const field = "h-14 w-full rounded-xl border border-input bg-card px-4 text-lg";
const big = "min-h-14 rounded-xl px-5 text-lg font-medium active:scale-95 transition";

export function Library(p: {
  chapters: Chapter[];
  currentId: string | null;
  isOwner: boolean;
  onPlay: (id: string) => void;
  onToggleDone: (id: string) => void;
  onEdit: (id: string, patch: { title: string; episode: number | null; series: string }) => Promise<void>;
  onDelete: (c: Chapter) => Promise<void>;
  /** Renomme (ou fusionne) un livre entier. Réservé à l'auteur. */
  onRenameBook?: (fromKey: string, series: string, lang: Lang) => Promise<void>;
  offline?: {
    online: boolean;
    isDownloaded: (c: Chapter) => boolean;
    progress: Map<string, number>;
    onDownload: (id: string) => void;
    onRemove: (id: string) => void;
    busy: boolean;
  };
}) {
  const [editing, setEditing] = useState<Chapter | null>(null);
  const [renaming, setRenaming] = useState<Group | null>(null);
  const [openTitle, setOpenTitleState] = useState<string | null>(() => recall(SHELF_TITLE_KEY));
  const [openKey, setOpenKeyState] = useState<string | null>(() => recall(SHELF_KEY));
  const setOpenTitle = (k: string | null) => { setOpenTitleState(k); remember(SHELF_TITLE_KEY, k); window.scrollTo(0, 0); };
  const setOpenKey = (k: string | null) => { setOpenKeyState(k); remember(SHELF_KEY, k); window.scrollTo(0, 0); };
  if (!p.chapters.length) return <p className="text-lg text-muted-foreground">Aucun chapitre pour l’instant.</p>;

  const books = groupBooks(p.chapters);
  const stats = (cs: Chapter[]) => ({
    done: cs.filter((c) => c.done).length,
    pct: cs.reduce((n, c) => n + progressOf(c), 0) / cs.length,
    cur: cs.some((c) => c.id === p.currentId),
  });
  const card = (key: string, title: React.ReactNode, sub: string, cs: Chapter[], onClick: () => void) => {
    const st = stats(cs);
    return (
      <button key={key} onClick={onClick}
        className={`w-full rounded-2xl border bg-card p-4 text-left active:scale-[0.98] transition ${st.cur ? "border-primary" : "border-border"}`}>
        <span className="flex items-center justify-between gap-2">
          <span className="block font-display text-xl">{title}</span>
          <span className="text-2xl text-muted-foreground" aria-hidden>›</span>
        </span>
        <span className="text-sm text-muted-foreground">{sub} · {st.done} écouté(s){st.cur ? " · en cours" : ""}</span>
        <span className="mt-3 block h-2 rounded-full bg-muted">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${st.pct * 100}%` }} />
        </span>
      </button>
    );
  };

  // Niveau 1 : les livres (par titre).
  const book = books.find((b) => b.key === openTitle);
  if (!book) {
    return (
      <div className="space-y-3">
        <h2 className="font-display text-2xl">Mes livres</h2>
        {books.map((b) => {
          const cs = b.tomes.flatMap((t) => t.chapters);
          return card(b.key, b.title, `${b.tomes.length} tome(s) · ${cs.length} épisode(s)`, cs, () => setOpenTitle(b.key));
        })}
      </div>
    );
  }

  // Niveau 2 : les tomes du livre.
  const opened = book.tomes.find((g) => g.key === openKey);
  if (!opened) {
    return (
      <div className="space-y-3">
        <button onClick={() => setOpenTitle(null)} className={`${big} w-full bg-secondary`}>← Mes livres</button>
        <h2 className="pt-3 font-display text-2xl">{book.title}</h2>
        {book.tomes.map((g) =>
          card(g.key, <>{tomeLabel(g)} <span className="text-base text-muted-foreground">· {g.lang.toUpperCase()}</span></>,
            `${g.chapters.length} épisode(s)`, g.chapters, () => setOpenKey(g.key)))}
      </div>
    );
  }
  const groups = [opened];

  // Niveau 3 : les épisodes du tome.
  return (
    <div className="space-y-10">
      <div className="flex gap-2">
        <button onClick={() => setOpenKey(null)} className={`${big} flex-1 bg-secondary`}>← {book.title}</button>
        {p.isOwner && p.onRenameBook && (
          <button onClick={() => setRenaming(opened)} className={`${big} bg-secondary`} aria-label="Renommer le tome">✎</button>
        )}
      </div>
      {groups.map((g) => (
        <section key={g.key} className="space-y-3">
          <h2 className="font-display text-2xl">
            {tomeLabel(g)} <span className="text-base text-muted-foreground">· {g.lang.toUpperCase()}</span>
          </h2>
          {g.chapters.map((c) => {
            const pct = progressOf(c);
            const meta = c.audioUrl
              ? `Audio · ${c.duration ? fmtTime(c.duration) : "durée inconnue"}`
              : `${wordCount(c.text)} mots · ~${Math.max(1, Math.round(wordCount(c.text) / 160))} min`;
            const cur = c.id === p.currentId;
            const off = p.offline;
            const saved = !!c.audioUrl && !!off?.isDownloaded(c);
            const dlPct = off?.progress.get(c.id);
            const unavailable = !!c.audioUrl && !!off && !off.online && !saved;
            return (
              <article key={c.id} className={`rounded-2xl border bg-card p-4 ${cur ? "border-primary" : "border-border"}`}>
                <p className="text-sm text-muted-foreground">
                  {c.episode != null ? `Épisode ${c.episode}` : "Sans numéro"} · {meta}{saved ? " · ✓ hors ligne" : ""}
                </p>
                <h3 className="mt-1 font-display text-xl leading-tight">{c.title}</h3>
                <div className="mt-3 h-2 rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct * 100}%` }} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{c.done ? "✓ Écouté" : `${Math.round(pct * 100)} %`}{cur ? " · en cours" : ""}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => p.onPlay(c.id)} disabled={unavailable}
                    className={`${big} flex-1 bg-primary text-primary-foreground disabled:opacity-40`}>
                    {unavailable ? "Non téléchargé" : pct > 0 && pct < 1 ? "▶ Reprendre" : pct >= 1 ? "↺ Réécouter" : "▶ Écouter"}
                  </button>
                  {c.audioUrl && off && (
                    <button
                      onClick={() => {
                        if (saved) {
                          if (confirm(`Retirer « ${c.title} » de l’appareil ? Il faudra du réseau pour l’écouter.`)) off.onRemove(c.id);
                        } else if (dlPct === undefined && off.online && !off.busy) off.onDownload(c.id);
                      }}
                      disabled={!saved && (dlPct !== undefined || !off.online || off.busy)}
                      className={`${big} min-w-14 bg-secondary px-3 disabled:opacity-50`}
                      aria-label={saved ? "Retirer le téléchargement" : "Télécharger pour écouter hors ligne"}
                      title={saved ? "Téléchargé — toucher pour retirer" : "Télécharger pour écouter hors ligne"}
                    >
                      {dlPct !== undefined ? `${Math.round(dlPct * 100)} %` : saved ? "📲" : "⬇"}
                    </button>
                  )}
                  <button onClick={() => p.onToggleDone(c.id)} className={`${big} bg-secondary`} aria-label={c.done ? "Marquer non écouté" : "Marquer écouté"}>
                    {c.done ? "✓" : "○"}
                  </button>
                  {p.isOwner && (
                    <>
                      <button onClick={() => setEditing(c)} className={`${big} bg-secondary`} aria-label="Modifier">✎</button>
                      <button
                        onClick={async () => {
                          if (!confirm(`Supprimer « ${c.title} »${c.audioPath ? " et son fichier audio" : ""} ? Cette action est définitive.`)) return;
                          await p.onDelete(c);
                        }}
                        className={`${big} bg-secondary text-destructive`} aria-label="Supprimer">🗑</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      ))}
      {renaming && p.onRenameBook && (
        <RenameBookDialog g={renaming} chapters={p.chapters} onClose={() => setRenaming(null)}
          onSave={async (series, lang) => { await p.onRenameBook!(renaming.key, series, lang); setRenaming(null); setOpenTitle(splitSeries(series).title.toLowerCase()); setOpenKey(bookKey(series, lang)); }} />
      )}
      {editing && <EditDialog c={editing} onClose={() => setEditing(null)} onSave={async (patch) => { await p.onEdit(editing.id, patch); setEditing(null); }} />}
    </div>
  );
}

function EditDialog({ c, onClose, onSave }: { c: Chapter; onClose: () => void; onSave: (p: { title: string; episode: number | null; series: string }) => Promise<void> }) {
  const [title, setTitle] = useState(c.title);
  const [episode, setEpisode] = useState(c.episode?.toString() ?? "");
  const [series, setSeries] = useState(c.series);
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-2xl space-y-3 rounded-t-2xl bg-background p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-2xl">Modifier le chapitre</h2>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre" className={field} />
        <input value={episode} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="N° d’épisode" className={field} />
        <input value={series} onChange={(e) => setSeries(e.target.value)} placeholder="Série / tome" className={field} />
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button onClick={onClose} className={`${big} bg-secondary`}>Annuler</button>
          <button disabled={busy} onClick={async () => { setBusy(true); try { await onSave({ title: title.trim() || c.title, episode: episode ? parseInt(episode, 10) : null, series: series.trim() }); } finally { setBusy(false); } }}
            className={`${big} bg-primary text-primary-foreground disabled:opacity-50`}>Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

function RenameBookDialog({ g, chapters, onClose, onSave }: { g: Group; chapters: Chapter[]; onClose: () => void; onSave: (series: string, lang: Lang) => Promise<void> }) {
  const [bookTitle, setBookTitle] = useState(splitSeries(g.series).title);
  const [tome, setTome] = useState(splitSeries(g.series).tome);
  const name = joinSeries(bookTitle, tome);
  const [lang, setLang] = useState<Lang>(g.lang);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const plan = planBookRename(chapters, g.key, name, lang);
  const blocked = !name.trim() || plan.same || plan.conflicts.length > 0;
  let info = "";
  if (!name.trim()) info = "Donne un titre au livre.";
  else if (plan.same) info = "Rien ne change.";
  else if (plan.conflicts.length)
    info = `Impossible de fusionner : les épisodes ${plan.conflicts.join(", ")} existent déjà dans « ${plan.series} · ${lang.toUpperCase()} ». Renumérote ou supprime-les d’abord (bouton ✎ ou 🗑 de l’épisode).`;
  else if (plan.merge) info = `Fusion : les ${plan.ids.length} épisode(s) rejoindront le livre existant « ${plan.series} · ${lang.toUpperCase()} ». Le livre « ${g.series} » disparaîtra.`;
  else info = `${plan.ids.length} épisode(s) seront déplacés vers « ${plan.series} · ${lang.toUpperCase()} ».`;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-2xl space-y-3 rounded-t-2xl bg-background p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-2xl">Renommer le tome</h2>
        <p className="text-sm text-muted-foreground">Mets le titre et le tome d’un tome existant pour les fusionner.</p>
        <label className="block"><span className="text-sm text-muted-foreground">Titre du livre</span>
          <input value={bookTitle} onChange={(e) => { setBookTitle(e.target.value); setErr(""); }} placeholder="ex. Le Seuil d’Astréon" className={field} /></label>
        <label className="block"><span className="text-sm text-muted-foreground">Tome</span>
          <input value={tome} onChange={(e) => { setTome(e.target.value); setErr(""); }} placeholder="ex. Tome 1" className={field} /></label>
        <div className="grid grid-cols-2 gap-2">
          {(["fr", "en"] as const).map((l) => (
            <button key={l} onClick={() => setLang(l)} className={`${big} ${lang === l ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
              {l === "fr" ? "Français" : "English"}
            </button>
          ))}
        </div>
        <p className={`rounded-xl p-3 ${plan.conflicts.length ? "border border-destructive text-destructive" : "bg-secondary"}`} role="status">{info}</p>
        {err && <p className="text-destructive" role="alert">{err}</p>}
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button onClick={onClose} className={`${big} bg-secondary`}>Annuler</button>
          <button disabled={busy || blocked}
            onClick={async () => {
              setBusy(true);
              try { await onSave(plan.series, lang); }
              catch (e) { setErr(`Échec : ${e instanceof Error ? e.message : String(e)}`); }
              finally { setBusy(false); }
            }}
            className={`${big} bg-primary text-primary-foreground disabled:opacity-50`}>{busy ? "…" : plan.merge ? "Fusionner" : "Renommer"}</button>
        </div>
      </div>
    </div>
  );
}
