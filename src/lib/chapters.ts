export type Lang = "fr" | "en";

export interface Chapter {
  id: string;
  title: string;
  episode: number | null;
  series: string;
  lang: Lang;
  text: string;
  /** Path in the Supabase "audiobook" bucket. */
  audioPath?: string | null | undefined;
  /** Address actually played: the Supabase URL, or the downloaded copy (/offline-audio?src=…). */
  audioUrl?: string | undefined;
  /** Public Supabase URL of the MP3 (key of the offline copy). */
  sourceUrl?: string | undefined;
  duration?: number | undefined;
  /** Local only: seconds for audio chapters, sentence index for text chapters. */
  position: number;
  /** Local only: marked as listened. */
  done?: boolean | undefined;
  createdAt: number;
  updatedAt: number;
}

export function baseName(file: string) {
  return file.replace(/\.[^.]+$/, "");
}

export function cleanTitle(file: string) {
  return baseName(file).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Finds the episode number in a filename or title. */
export function parseEpisode(name: string): number | null {
  const s = baseName(name);
  const kw = s.match(/(?:[ée]pisode|ep|chapitre|chapter|chap|ch)\s*[._#-]?\s*(\d+)/i);
  if (kw) return parseInt(kw[1]!, 10);
  const stripped = s.replace(/(?:tome|vol(?:ume)?|livre|saison|season|book|t)\s*[._-]?\s*\d+/gi, " ");
  const n = stripped.match(/\d+/);
  return n ? parseInt(n[0], 10) : null;
}

/** Title = the "# Titre" line if any, otherwise the first non-empty line. */
export function titleFromText(text: string): string | null {
  const h = text.match(/^\s*#+\s*(.+?)\s*#*\s*$/m)?.[1];
  const line = h ?? text.split(/\r?\n/).find((l) => l.trim());
  const t = line?.replace(/^[#*\s]+|[*\s]+$/g, "").trim();
  return t ? t.slice(0, 200) : null;
}

/** Episode from "Épisode N" in the title line, else from the filename. */
export function episodeFrom(title: string | null, filename?: string): number | null {
  const m = title?.match(/[ée]pisode\s*[._#-]?\s*(\d+)/i);
  if (m) return parseInt(m[1]!, 10);
  return filename ? parseEpisode(filename) : title ? parseEpisode(title) : null;
}

/** "Épisode 12 — Le titre" (ou "Épisode 12. Le titre.") → { episode: 12, title: "Le titre" }. */
export function splitEpisodeHeading(heading: string | null): { episode: number; title: string } | null {
  const m = heading?.match(/^\s*[ée]pisode\s*(\d+)\s*[.:—–-]+\s*(.+?)\.?\s*$/i);
  return m ? { episode: parseInt(m[1]!, 10), title: m[2]!.trim() } : null;
}

/** Retire la ligne de titre Markdown ("# …") du début du texte. */
export function stripHeading(text: string): string {
  return text.replace(/^\s*#+[^\n]*\n+/, "").trim();
}

/**
 * Retire la première ligne du texte si c'est le titre de l'épisode (« Dernier de 480 »,
 * « # Épisode 1 — Dernier de 480 »…), pour ne pas l'afficher deux fois.
 */
export function withoutTitleLine(text: string, title: string): string {
  const m = text.match(/^\s*([^\n]*)(\n|$)/);
  if (!m) return text;
  const norm = (s: string) =>
    s.replace(/^[#*\s]+|[*\s.]+$/g, "").replace(/^[ée]pisode\s*\d+\s*[.:—–-]+\s*/i, "").trim().toLowerCase();
  const first = norm(m[1]!);
  return first && first === norm(title) ? text.slice(m[0].length).trimStart() : text;
}

/** Série la plus fréquente (pour pré-remplir l'Atelier et éviter un import sans série). */
export function mostCommonSeries(cs: Chapter[]): string {
  const n = new Map<string, number>();
  for (const c of cs) if (c.series.trim()) n.set(c.series.trim(), (n.get(c.series.trim()) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** Même tome (sans tenir compte de la casse), même langue, même numéro d'épisode. */
export function findSameEpisode(cs: Chapter[], series: string, lang: Lang, episode: number | null): Chapter | undefined {
  if (episode === null) return undefined;
  const s = series.trim().toLowerCase();
  return cs.find((c) => c.series.trim().toLowerCase() === s && c.lang === lang && c.episode === episode);
}

/** ASCII, no accents, spaces → dashes, lowercase. */
export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Returns a name not in `taken`, adding -2, -3… before the extension. */
export function uniqueName(base: string, ext: string, taken: Set<string>): string {
  let name = `${base}${ext}`;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}${ext}`;
  return name;
}

export function compareChapters(a: Chapter, b: Chapter) {
  if (a.episode !== b.episode) {
    if (a.episode === null) return 1;
    if (b.episode === null) return -1;
    return a.episode - b.episode;
  }
  return a.title.localeCompare(b.title, "fr", { numeric: true });
}

export function sortChapters(cs: Chapter[]) {
  return [...cs].sort(compareChapters);
}

export interface Group {
  key: string;
  series: string;
  lang: Lang;
  chapters: Chapter[];
}

export function groupChapters(cs: Chapter[]): Group[] {
  const map = new Map<string, Group>();
  for (const c of cs) {
    const key = bookKey(c.series, c.lang);
    if (!map.has(key)) map.set(key, { key, series: c.series.trim(), lang: c.lang, chapters: [] });
    map.get(key)!.chapters.push(c);
  }
  return [...map.values()]
    .map((g) => ({ ...g, chapters: sortChapters(g.chapters) }))
    .sort((a, b) => {
      if (!a.series !== !b.series) return a.series ? -1 : 1;
      return a.series.localeCompare(b.series, "fr", { numeric: true }) || a.lang.localeCompare(b.lang);
    });
}

export function splitSentences(text: string): string[] {
  const parts = text.replace(/\r/g, "").match(/[^.!?…\n]+(?:[.!?…]+["»”’)\]]*)?|[.!?…]+/g) ?? [];
  return parts.map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

export function wordCount(text: string) {
  return (text.match(/[\p{L}\p{N}’'-]+/gu) ?? []).length;
}

export function progressOf(c: Chapter): number {
  if (c.done) return 1;
  if (c.audioUrl) return c.duration ? Math.min(1, c.position / c.duration) : 0;
  const n = splitSentences(c.text).length;
  return n ? Math.min(1, c.position / n) : 0;
}

export function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ss = s.toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Un livre = une série dans une langue. Clé stable, identique à celle de groupChapters. */
export function bookKey(series: string, lang: Lang): string {
  return `${series.trim().toLowerCase()}|${lang}`;
}

/** Mémorise une petite valeur sur l'appareil (choix du livre). Silencieux si le stockage est indisponible. */
export function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* stockage indisponible : on oublie simplement */ }
}

export function recall(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export interface RenamePlan {
  /** Épisodes à déplacer. */
  ids: string[];
  /** Le livre cible existe déjà : les épisodes y seront ajoutés. */
  merge: boolean;
  /** Nom exact du livre cible (celui de l'existant en cas de fusion). */
  series: string;
  /** Numéros présents dans les deux livres : la fusion créerait des doublons. */
  conflicts: number[];
  /** Rien à faire (même nom, même langue). */
  same: boolean;
}

/** Prépare le renommage (ou la fusion) d'un livre entier vers « newSeries · newLang ». */
export function planBookRename(cs: Chapter[], fromKey: string, newSeries: string, newLang: Lang): RenamePlan {
  const name = newSeries.trim().replace(/\s+/g, " ");
  const toKey = bookKey(name, newLang);
  const source = cs.filter((c) => bookKey(c.series, c.lang) === fromKey);
  const ids = source.map((c) => c.id);
  if (toKey === fromKey) return { ids, merge: false, series: name, conflicts: [], same: source.every((c) => c.series === name) };
  const target = cs.filter((c) => bookKey(c.series, c.lang) === toKey);
  const taken = new Set(target.map((c) => c.episode).filter((e): e is number => e !== null));
  const conflicts = [...new Set(source.map((c) => c.episode).filter((e): e is number => e !== null && taken.has(e)))].sort((a, b) => a - b);
  return { ids, merge: target.length > 0, series: target[0]?.series.trim() ?? name, conflicts, same: false };
}

export const ATELIER_BOOK_KEY = "atelier-livre";
export const SHELF_BOOK_KEY = "biblio-livre";

/** Après renommage d'un livre, les choix mémorisés sur l'appareil suivent le nouveau nom. */
export function followRenamedBook(fromKey: string, series: string, lang: Lang) {
  if (recall(SHELF_BOOK_KEY) === fromKey) remember(SHELF_BOOK_KEY, bookKey(series, lang));
  try {
    const a = JSON.parse(recall(ATELIER_BOOK_KEY) ?? "null") as { series: string; lang: Lang } | null;
    if (a && bookKey(a.series, a.lang) === fromKey) remember(ATELIER_BOOK_KEY, JSON.stringify({ series, lang }));
  } catch { /* valeur illisible : on la laisse */ }
}
