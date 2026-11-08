import { useState } from "react";
import { fmtTime, groupChapters, progressOf, recall, remember, wordCount, type Chapter } from "@/lib/chapters";

const SHELF_KEY = "biblio-livre";

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
      {all.length > 1 && (
        <button onClick={() => setOpenKey(null)} className={`${big} bg-secondary`}>← Tous les livres</button>
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
