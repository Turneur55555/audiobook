import { useState } from "react";
import { SHELF_BOOK_KEY as SHELF_KEY, bookKey, fmtTime, groupChapters, planBookRename, progressOf, recall, remember, wordCount, type Chapter, type Group, type Lang } from "@/lib/chapters";

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
  const [openKey, setOpenKeyState] = useState<string | null>(() => recall(SHELF_KEY));
  const setOpenKey = (k: string | null) => { setOpenKeyState(k); remember(SHELF_KEY, k); window.scrollTo(0, 0); };
  const all = groupChapters(p.chapters);
  if (!p.chapters.length) return <p className="text-lg text-muted-foreground">Aucun chapitre pour l’instant.</p>;

  // Un seul livre : on l'ouvre directement. Plusieurs : on montre d'abord l'étagère.
  const opened = all.length === 1 ? all[0] : all.find((g) => g.key === openKey);
  if (!opened) {
    return (
      <div className="space-y-3">
        <h2 className="font-display text-2xl">Mes livres</h2>
        {all.map((g) => {
          const done = g.chapters.filter((c) => c.done).length;
          const pct = g.chapters.reduce((n, c) => n + progressOf(c), 0) / g.chapters.length;
          const cur = g.chapters.some((c) => c.id === p.currentId);
          return (
            <button key={g.key} onClick={() => setOpenKey(g.key)}
              className={`w-full rounded-2xl border bg-card p-4 text-left active:scale-[0.98] transition ${cur ? "border-primary" : "border-border"}`}>
              <span className="block font-display text-xl">{g.series || "Sans série"} <span className="text-base text-muted-foreground">· {g.lang.toUpperCase()}</span></span>
              <span className="text-sm text-muted-foreground">{g.chapters.length} épisode(s) · {done} écouté(s){cur ? " · en cours" : ""}</span>
              <span className="mt-3 block h-2 rounded-full bg-muted">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${pct * 100}%` }} />
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  const groups = [opened];

  return (
    <div className="space-y-10">
      {(all.length > 1 || (p.isOwner && p.onRenameBook)) && (
        <div className="flex gap-2">
          {all.length > 1 && <button onClick={() => setOpenKey(null)} className={`${big} flex-1 bg-secondary`}>← Tous les livres</button>}
          {p.isOwner && p.onRenameBook && (
            <button onClick={() => setRenaming(opened)} className={`${big} ${all.length > 1 ? "" : "flex-1"} bg-secondary`}>✎ Renommer le livre</button>
          )}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.key} className="space-y-3">
          <h2 className="font-display text-2xl">
            {g.series || "Sans série"} <span className="text-base text-muted-foreground">· {g.lang.toUpperCase()}</span>
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
          onSave={async (series, lang) => { await p.onRenameBook!(renaming.key, series, lang); setRenaming(null); setOpenKey(bookKey(series, lang)); }} />
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
  const [name, setName] = useState(g.series);
  const [lang, setLang] = useState<Lang>(g.lang);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const plan = planBookRename(chapters, g.key, name, lang);
  const blocked = !name.trim() || plan.same || plan.conflicts.length > 0;
  let info = "";
  if (!name.trim()) info = "Donne un nom au livre.";
  else if (plan.same) info = "Rien ne change.";
  else if (plan.conflicts.length)
    info = `Impossible de fusionner : les épisodes ${plan.conflicts.join(", ")} existent déjà dans « ${plan.series} · ${lang.toUpperCase()} ». Renumérote ou supprime-les d’abord (bouton ✎ ou 🗑 de l’épisode).`;
  else if (plan.merge) info = `Fusion : les ${plan.ids.length} épisode(s) rejoindront le livre existant « ${plan.series} · ${lang.toUpperCase()} ». Le livre « ${g.series} » disparaîtra.`;
  else info = `${plan.ids.length} épisode(s) seront déplacés vers « ${plan.series} · ${lang.toUpperCase()} ».`;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-foreground/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-2xl space-y-3 rounded-t-2xl bg-background p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-2xl">Renommer le livre</h2>
        <p className="text-sm text-muted-foreground">Mets le nom d’un autre livre pour les fusionner.</p>
        <input value={name} onChange={(e) => { setName(e.target.value); setErr(""); }} placeholder="Nom du livre" className={field} />
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
