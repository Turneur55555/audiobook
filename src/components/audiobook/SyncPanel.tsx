import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { formatCode, normalizeCode, syncLink } from "@/lib/sync";
import { diagClear, diagText } from "@/lib/diag";

const big = "min-h-14 w-full rounded-xl px-5 text-lg font-medium active:scale-95 transition";
const field = "h-14 rounded-xl border border-input bg-card px-3 text-base tracking-wider uppercase placeholder:normal-case placeholder:tracking-normal";

function Qr({ text }: { text: string }) {
  const cells = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`} className="h-48 w-48 rounded-xl bg-white" role="img" aria-label="QR code du lien de synchronisation">
      <path d={cells.d} fill="#000" />
    </svg>
  );
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "à l’instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`;
};

export function SyncPanel(p: {
  code: string | null;
  lastSync: number | null;
  error: string;
  onLink: (code: string) => Promise<void>;
  onExport: () => void;
  onImport: (f?: File) => void;
}) {
  const [, tick] = useState(0);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(i);
  }, []);
  if (!p.code) return null;
  const link = syncLink(typeof window === "undefined" ? "" : window.location.origin, p.code);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setMsg("Lien copié. Ouvre-le sur ton autre appareil.");
    } catch {
      setMsg(`Copie impossible : sélectionne le lien à la main → ${link}`);
    }
  }
  async function share() {
    try {
      await navigator.share({ title: "Mon Audiobook — reprendre l’écoute", url: link });
    } catch {
      /* partage annulé */
    }
  }
  async function link2() {
    const c = normalizeCode(input);
    if (!c) return setMsg("Code invalide : il fait 16 caractères (lettres et chiffres 2 à 7).");
    if (c === p.code) return setMsg("Cet appareil utilise déjà ce code.");
    setBusy(true);
    try {
      await p.onLink(c);
      setInput("");
      setMsg("Appareil relié : tes positions sont maintenant partagées.");
    } catch (e) {
      setMsg(`Liaison impossible : ${(e as Error).message}`);
    }
    setBusy(false);
  }

  return (
    <section className="mt-12 space-y-4 rounded-2xl border border-border bg-card p-4">
      <h2 className="font-display text-xl">Reprendre sur un autre appareil</h2>
      <p className={p.error ? "text-destructive" : "text-muted-foreground"} role="status">
        {p.error
          ? `Synchronisation en pause : ${p.error} Tes positions restent enregistrées sur cet appareil.`
          : p.lastSync
            ? `✓ Positions synchronisées ${ago(p.lastSync)}.`
            : "Synchronisation en cours…"}
      </p>
      <p>
        Sur ton iPhone (ou ton PC), <strong>scanne ce QR code avec l’appareil photo</strong> ou ouvre ce lien. Les deux appareils
        partageront ensuite la même position d’écoute, automatiquement.
      </p>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <Qr text={link} />
        <div className="w-full space-y-2">
          <p className="text-sm text-muted-foreground">Code de cet appareil</p>
          <p className="select-all font-mono text-xl tracking-wider">{formatCode(p.code)}</p>
          <div className="flex gap-2">
            <button onClick={copy} className={`${big} flex-1 bg-secondary`}>Copier le lien</button>
            {typeof navigator !== "undefined" && "share" in navigator && (
              <button onClick={share} className={`${big} flex-1 bg-secondary`}>Partager…</button>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Le site est ouvert depuis l’écran d’accueil de l’iPhone ? Le QR code ouvre Safari, pas l’icône : tape plutôt ici le code affiché sur ton autre appareil.
        </p>
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Code de l’autre appareil" className={`${field} min-w-0 flex-1`}
            autoCapitalize="characters" autoCorrect="off" spellCheck={false} aria-label="Code de synchronisation" />
          <button onClick={link2} disabled={busy || !input.trim()}
            className="min-h-14 shrink-0 rounded-xl bg-primary px-5 text-lg font-medium text-primary-foreground transition active:scale-95 disabled:opacity-50">
            {busy ? "…" : "Relier"}
          </button>
        </div>
      </div>
      {msg && <p className="rounded-xl bg-secondary p-3" role="status">{msg}</p>}
      <DiagLog />
      <details className="text-muted-foreground">
        <summary className="cursor-pointer py-2">Sauvegarde manuelle (fichier)</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={p.onExport} className={`${big} bg-secondary text-foreground`}>Exporter</button>
          <label className={`${big} flex cursor-pointer items-center justify-center bg-secondary text-foreground`}>
            Importer
            <input type="file" accept="application/json,.json" hidden onChange={(e) => { p.onImport(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
        </div>
      </details>
    </section>
  );
}

/** Journal de lecture à copier pour signaler un problème (iPhone : pas de console). */
function DiagLog() {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  return (
    <details className="text-muted-foreground" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setText(diagText()); }}>
      <summary className="cursor-pointer py-2">Journal de lecture (en cas de problème)</summary>
      <p className="text-sm">Si la lecture se coupe ou n’enchaîne pas, copie ce journal et envoie-le.</p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-secondary p-3 text-xs text-foreground">{text || "Vide."}</pre>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button className={`${big} bg-secondary text-foreground`} onClick={async () => {
          try { await navigator.clipboard.writeText(diagText()); setMsg("Journal copié."); } catch { setMsg("Copie impossible : sélectionne le texte à la main."); }
        }}>Copier le journal</button>
        <button className={`${big} bg-secondary text-foreground`} onClick={() => { diagClear(); setText(""); setMsg("Journal vidé."); }}>Vider</button>
      </div>
      {msg && <p className="mt-2 text-sm" role="status">{msg}</p>}
    </details>
  );
}
