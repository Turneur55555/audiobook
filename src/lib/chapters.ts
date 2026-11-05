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
  audioUrl?: string | undefined;
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
    const key = `${c.series.trim().toLowerCase()}|${c.lang}`;
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
