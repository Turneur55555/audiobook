import { useEffect, useState } from "react";
import type { Chapter } from "@/lib/chapters";
import { canDownload, estimateBytes, fmtMo } from "@/lib/offline";

const big = "min-h-14 w-full rounded-xl px-5 text-lg font-medium active:scale-95 transition";

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export function OfflinePanel(p: {
  chapters: Chapter[];
  isDownloaded: (c: Chapter) => boolean;
  bytes: number;
  online: boolean;
  swOn: boolean;
  queue: number;
  done: number;
  error: string;
  progress: Map<string, number>;
  onDownloadAll: (ids: string[]) => void;
  onRemoveAll: (ids: string[]) => void;
  onCancel: () => void;
}) {
  const [env, setEnv] = useState({ ios: false, standalone: false, supported: true });
  useEffect(() => setEnv({ ios: isIOS(), standalone: isStandalone(), supported: canDownload() }), []);

  const audio = p.chapters.filter((c) => c.audioUrl);
  if (!audio.length) return null;
  const saved = audio.filter(p.isDownloaded);
  const missing = audio.filter((c) => !p.isDownloaded(c));
  const missingBytes = missing.reduce((n, c) => n + estimateBytes(c.duration), 0);
  const current = [...p.progress.values()][0] ?? 0;
  const busy = p.queue > 0;

  return (
    <section className="mt-12 space-y-4 rounded-2xl border border-border bg-card p-4">
      <h2 className="font-display text-xl">Écouter sans réseau</h2>
      {!env.supported ? (
        <p className="text-muted-foreground">Ce navigateur ne permet pas l’écoute hors ligne.</p>
      ) : (
        <>
          <p className="text-muted-foreground" role="status">
            {saved.length === audio.length
              ? `✓ Les ${audio.length} épisodes sont sur cet appareil (${fmtMo(p.bytes)}).`
              : `${saved.length} / ${audio.length} épisodes téléchargés${saved.length ? ` (${fmtMo(p.bytes)})` : ""}.`}
            {" "}Les positions d’écoute faites hors ligne se resynchronisent toutes seules au retour du réseau.
          </p>

          {busy ? (
            <div className="space-y-2">
              <p>
                Téléchargement {Math.min(p.done + 1, p.queue)} / {p.queue} — {Math.round(current * 100)} %
              </p>
              <div className="h-2 rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: `${((p.done + current) / p.queue) * 100}%` }} />
              </div>
              <p className="text-sm text-muted-foreground">Garde cette page ouverte et l’écran allumé jusqu’à la fin.</p>
              <button onClick={p.onCancel} className={`${big} bg-secondary`}>Arrêter</button>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {missing.length > 0 && (
                <button onClick={() => p.onDownloadAll(missing.map((c) => c.id))} disabled={!p.online}
                  className={`${big} bg-primary text-primary-foreground disabled:opacity-50`}>
                  ⬇ Tout télécharger ({missing.length} · ≈ {fmtMo(missingBytes)})
                </button>
              )}
              {saved.length > 0 && (
                <button
                  onClick={() => {
                    if (confirm(`Retirer les ${saved.length} épisodes téléchargés de cet appareil ?`)) p.onRemoveAll(saved.map((c) => c.id));
                  }}
                  className={`${big} bg-secondary`}>
                  Libérer la place
                </button>
              )}
            </div>
          )}
          {p.error && <p className="text-destructive" role="alert">{p.error}</p>}
          {!p.swOn && saved.length > 0 && (
            <p className="text-sm text-muted-foreground">Recharge la page une fois avec du réseau pour activer la lecture hors ligne.</p>
          )}
          {env.ios && !env.standalone && (
            <p className="rounded-xl bg-secondary p-3 text-sm">
              Sur iPhone, installe d’abord le site sur l’écran d’accueil (bouton <strong>Partager</strong> → <strong>Sur l’écran d’accueil</strong>),
              puis télécharge depuis l’icône. Dans Safari, les fichiers téléchargés peuvent être effacés si le site n’est pas ouvert pendant 7 jours.
            </p>
          )}
        </>
      )}
    </section>
  );
}
