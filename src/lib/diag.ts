/**
 * Journal de lecture : les 200 derniers événements audio, gardés sur l'appareil.
 * Sur iPhone on ne peut pas ouvrir la console : ce journal permet de comprendre un problème
 * (coupure, enchaînement raté, chargement bloqué) en le copiant depuis la Bibliothèque.
 */
const KEY = "audio-diag";
const MAX = 200;

type Entry = { at: string; ev: string } & Record<string, unknown>;

function load(): Entry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as Entry[];
  } catch {
    return [];
  }
}

export function diag(ev: string, extra: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  try {
    const list = load();
    const d = new Date();
    const at = `${d.toLocaleDateString("fr-FR")} ${d.toLocaleTimeString("fr-FR")}`;
    list.push({ at, ev, ...extra, vis: document.visibilityState === "hidden" ? "verrouillé/fond" : "écran" });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* stockage indisponible : sans gravité */
  }
}

export function diagText(): string {
  const head = typeof navigator === "undefined" ? "" : `${navigator.userAgent}\n`;
  return (
    head +
    load()
      .map(({ at, ev, ...r }) => `${at}  ${ev}  ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" ")}`)
      .join("\n")
  );
}

export function diagClear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
