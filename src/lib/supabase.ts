import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { noteServerDate } from "./sync";
import { slugify, uniqueName, type Chapter, type Lang } from "./chapters";

// External Supabase project. The publishable key is meant to live in front-end code.
export const SUPABASE_URL = "https://hoyhnxrcmjdbmsofniub.supabase.co";
export const SUPABASE_KEY = "sb_publishable_Z-ee5l9Ut6_CX6NJ4pSIiA_N3AdPYGE";
/**
 * SHA-256 de l'adresse de l'auteur (minuscules) : l'adresse n'apparaît plus en clair dans le code public.
 * Ce contrôle ne sert qu'à l'affichage ; la vraie protection, ce sont les règles d'accès Supabase.
 */
const OWNER_EMAIL_SHA256 = "934f08d8b4cc65ff0ea1a3e2e2b1a1facd87a7b19362d2cf87b5f97145e4b3b0";
export const BUCKET = "audiobook";

let client: SupabaseClient | null = null;
/** Lazily created so nothing runs at module scope (SSR). */
export function sb() {
  return (client ??= createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
      // Mesure l'écart entre l'horloge de l'appareil et celle du serveur (voir sync.clockNow).
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const t0 = Date.now();
        const res = await fetch(input, init);
        noteServerDate(res.headers.get("Date"), t0, Date.now());
        return res;
      },
    },
  }));
}

export async function isOwnerEmail(e?: string | null): Promise<boolean> {
  if (!e?.trim()) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e.trim().toLowerCase()));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === OWNER_EMAIL_SHA256;
}

interface Row {
  id: string;
  series: string | null;
  lang: Lang;
  episode: number | null;
  title: string;
  body: string | null;
  audio_path: string | null;
  duration: number | null;
  created_at: string;
}

function toChapter(r: Row): Chapter {
  const t = new Date(r.created_at).getTime() || 0;
  const url = r.audio_path ? sb().storage.from(BUCKET).getPublicUrl(r.audio_path).data.publicUrl : undefined;
  return {
    id: r.id,
    title: r.title,
    episode: r.episode,
    series: r.series ?? "",
    lang: r.lang === "en" ? "en" : "fr",
    text: r.body ?? "",
    audioPath: r.audio_path,
    audioUrl: url,
    sourceUrl: url,
    duration: r.duration ?? undefined,
    position: 0,
    createdAt: t,
    updatedAt: t,
  };
}

export function frError(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if (/row-level security|permission|not authorized|unauthorized|403|401/i.test(m)) return "accès refusé — êtes-vous bien connecté avec le compte auteur ?";
  if (/exceeded|too large|413|payload/i.test(m)) return "fichier trop volumineux (100 Mo maximum).";
  if (/mime|content type|invalid_mime/i.test(m)) return "format refusé (mp3 ou m4a uniquement).";
  if (/fetch|network|failed to load/i.test(m)) return "problème de connexion réseau, réessayez.";
  if (/rate limit|too many/i.test(m)) return "trop de tentatives, patientez quelques minutes.";
  return m;
}

export async function fetchChapters(): Promise<Chapter[]> {
  const { data, error } = await sb().from("chapters").select("*");
  if (error) throw error;
  return (data as Row[]).map(toChapter);
}

export async function insertChapter(c: {
  title: string; episode: number | null; series: string; lang: Lang; body: string; audio_path?: string | null; duration?: number | null;
}): Promise<Chapter> {
  const { data, error } = await sb().from("chapters").insert({ ...c, series: c.series || null }).select("*").single();
  if (error) throw error;
  return toChapter(data as Row);
}

export async function updateChapter(id: string, patch: { title: string; episode: number | null; series: string }) {
  const { error } = await sb().from("chapters").update({ ...patch, series: patch.series || null }).eq("id", id);
  if (error) throw error;
}

/** Remplace le contenu d'un épisode existant (texte, titre, audio) et renvoie la ligne à jour. */
/** Change le livre (nom et langue) de plusieurs épisodes d'un coup. Vérifie que tous ont bien été modifiés. */
export async function moveChapters(ids: string[], series: string, lang: Lang) {
  if (!ids.length) return;
  const { data, error } = await sb().from("chapters").update({ series: series || null, lang }).in("id", ids).select("id");
  if (error) throw error;
  if ((data?.length ?? 0) !== ids.length)
    throw new Error(`seuls ${data?.length ?? 0} épisode(s) sur ${ids.length} ont été modifiés (droits insuffisants ?). Recharge la page pour voir l’état réel.`);
}

export async function updateChapterContent(id: string, patch: {
  title: string; episode: number | null; body: string; audio_path: string | null; duration: number | null;
}): Promise<Chapter> {
  const { data, error } = await sb().from("chapters").update(patch).eq("id", id).select("*").single();
  if (error) throw error;
  return toChapter(data as Row);
}

/** Supprime un fichier audio devenu inutile (sans bloquer si ça échoue). */
export async function removeAudioQuietly(path: string) {
  try { await sb().storage.from(BUCKET).remove([path]); } catch { /* fichier orphelin : sans gravité */ }
}

export async function deleteChapterRemote(c: Chapter) {
  if (c.audioPath) {
    const { error } = await sb().storage.from(BUCKET).remove([c.audioPath]);
    if (error) throw error;
  }
  const { error } = await sb().from("chapters").delete().eq("id", c.id);
  if (error) throw error;
}

/** <serie-slug>/<lang>/<ascii-name>.mp3 without collision with existing files. */
export async function uniqueAudioPath(series: string, lang: Lang, filename: string, reserved: Set<string>) {
  const folder = `${slugify(series) || "sans-serie"}/${lang}`;
  const ext = (filename.match(/\.(mp3|m4a)$/i)?.[0] ?? ".mp3").toLowerCase();
  const base = slugify(filename.replace(/\.[^.]+$/, "")) || "audio";
  const { data } = await sb().storage.from(BUCKET).list(folder, { limit: 1000 });
  const taken = new Set([...(data ?? []).map((f) => f.name), ...[...reserved].filter((p) => p.startsWith(folder + "/")).map((p) => p.slice(folder.length + 1))]);
  const path = `${folder}/${uniqueName(base, ext, taken)}`;
  reserved.add(path);
  return path;
}

/** Upload with progress (XHR, since supabase-js has no progress events). */
export async function uploadAudio(path: string, file: File, onProgress: (pct: number) => void) {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("session expirée, reconnectez-vous.");
  const type = file.type || (/\.m4a$/i.test(file.name) ? "audio/mp4" : "audio/mpeg");
  await new Promise<void>((res, rej) => {
    const x = new XMLHttpRequest();
    x.open("POST", `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`);
    x.setRequestHeader("Authorization", `Bearer ${token}`);
    x.setRequestHeader("apikey", SUPABASE_KEY);
    x.setRequestHeader("Content-Type", type);
    x.setRequestHeader("x-upsert", "false");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return res();
      let msg = `${x.status}`;
      try { msg = `${JSON.parse(x.responseText).message ?? msg} (${x.status})`; } catch { /* keep status */ }
      rej(new Error(msg));
    };
    x.onerror = () => rej(new Error("network"));
    x.send(file);
  });
}
