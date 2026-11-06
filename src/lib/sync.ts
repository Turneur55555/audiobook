/**
 * Synchronisation des positions d'écoute entre appareils, sans compte.
 * Les appareils qui partagent le même « code de synchronisation » partagent leurs positions
 * (table Supabase `listening_sync`, voir supabase/sync.sql). La plus récente gagne.
 */
import type { LocalPos } from "./audiobook-db";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const CODE_RE = /^[A-Z2-7]{16}$/;

/** 16 caractères base32 (80 bits aléatoires) : impossible à deviner, mais tapable à la main. */
export function newSyncCode(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = rand(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Accepte un code tapé (avec tirets, espaces, minuscules, 0/1/8 confondus) ou un lien complet « …#sync=CODE ». */
export function normalizeCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const fromLink = input.match(/[#&?]sync=([A-Za-z0-9-]+)/)?.[1];
  const c = (fromLink ?? input)
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B");
  return CODE_RE.test(c) ? c : null;
}

export const formatCode = (c: string) => c.match(/.{1,4}/g)?.join("-") ?? c;
export const syncLink = (origin: string, code: string) => `${origin}/#sync=${code}`;

/**
 * Compare les positions locales et distantes, chapitre par chapitre.
 * - toApply : positions distantes plus récentes, à appliquer sur cet appareil ;
 * - toPush : positions locales plus récentes (ou absentes en ligne), à envoyer.
 */
export function mergePositions(local: LocalPos[], remote: LocalPos[]): { toApply: LocalPos[]; toPush: LocalPos[] } {
  const lm = new Map(local.map((p) => [p.id, p]));
  const rm = new Map(remote.map((p) => [p.id, p]));
  const toApply: LocalPos[] = [];
  const toPush: LocalPos[] = [];
  for (const r of remote) {
    const l = lm.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) toApply.push(r);
  }
  for (const l of local) {
    const r = rm.get(l.id);
    if (!r || l.updatedAt > r.updatedAt) toPush.push(l);
  }
  return { toApply, toPush };
}

/** Position la plus récemment modifiée (pour proposer de reprendre là où on s'est arrêté ailleurs). */
export function latest(ps: LocalPos[]): LocalPos | undefined {
  return ps.reduce<LocalPos | undefined>((a, p) => (!a || p.updatedAt > a.updatedAt ? p : a), undefined);
}

interface PullRow { cid: string; pos: number; dur: number | null; is_done: boolean; changed_at: string }

/** Client minimal : on n'importe pas Supabase ici pour garder ce module testable. */
export interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function pull(client: RpcClient, code: string): Promise<LocalPos[]> {
  const { data, error } = await client.rpc("sync_pull", { p_code: code });
  if (error) throw new Error(error.message);
  return ((data as PullRow[] | null) ?? []).map((r) => ({
    id: r.cid,
    position: r.pos,
    duration: r.dur ?? undefined,
    done: r.is_done,
    updatedAt: Date.parse(r.changed_at) || 0,
  }));
}

export async function push(client: RpcClient, code: string, items: LocalPos[]): Promise<void> {
  if (!items.length) return;
  for (let i = 0; i < items.length; i += 400) {
    const batch = items.slice(i, i + 400).map((p) => ({
      id: p.id,
      position: Number.isFinite(p.position) ? p.position : 0,
      ...(p.duration !== undefined && Number.isFinite(p.duration) ? { duration: p.duration } : {}),
      done: !!p.done,
      updatedAt: p.updatedAt,
    }));
    const { error } = await client.rpc("sync_push", { p_code: code, p_items: batch });
    if (error) throw new Error(error.message);
  }
}

/** Message d'erreur lisible ; « pas encore activée » si la fonction n'existe pas encore côté Supabase. */
export function syncErrorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if (/sync_(pull|push)|function .* does not exist|schema cache|PGRST202|404/i.test(m))
    return "la synchronisation n’est pas encore activée sur le serveur.";
  if (/fetch|network|failed|load/i.test(m)) return "pas de connexion pour l’instant, nouvel essai automatique.";
  return m;
}
