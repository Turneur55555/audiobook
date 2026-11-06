import { describe, expect, it } from "vitest";
import { formatCode, latest, mergePositions, newSyncCode, normalizeCode, pull, push, syncErrorText, syncLink, type RpcClient } from "@/lib/sync";
import { mostCommonSeries, withoutTitleLine, type Chapter } from "@/lib/chapters";
import { isOwnerEmail } from "@/lib/supabase";
import type { LocalPos } from "@/lib/audiobook-db";

const pos = (id: string, position: number, updatedAt: number, done = false): LocalPos => ({ id, position, updatedAt, done });

describe("sync codes", () => {
  it("generates 16 base32 characters", () => {
    for (let i = 0; i < 50; i++) expect(newSyncCode()).toMatch(/^[A-Z2-7]{16}$/);
    expect(newSyncCode(() => new Uint8Array(10))).toBe("AAAAAAAAAAAAAAAA");
    expect(newSyncCode(() => new Uint8Array(10).fill(255))).toBe("7777777777777777");
  });
  it("accepts typed codes with dashes, lowercase and look-alike digits", () => {
    expect(normalizeCode("abcd-efgh-ijkl-mnop")).toBe("ABCDEFGHIJKLMNOP");
    expect(normalizeCode(" ABCD EFGH 1JKL MN0P ")).toBe("ABCDEFGHIJKLMNOP");
    expect(normalizeCode("https://mon-audiobook.vercel.app/#sync=ABCDEFGHIJKLMNOP")).toBe("ABCDEFGHIJKLMNOP");
  });
  it("rejects anything else", () => {
    for (const bad of ["", null, undefined, "ABC", "ABCDEFGHIJKLMNOPQ", "#sync=", "ABCDEFGHIJKLMNO9"]) expect(normalizeCode(bad)).toBeNull();
  });
  it("formats codes and links", () => {
    expect(formatCode("ABCDEFGHIJKLMNOP")).toBe("ABCD-EFGH-IJKL-MNOP");
    expect(syncLink("https://x.app", "ABCDEFGHIJKLMNOP")).toBe("https://x.app/#sync=ABCDEFGHIJKLMNOP");
  });
});

describe("mergePositions", () => {
  it("keeps the most recent position of each chapter, in both directions", () => {
    const local = [pos("a", 10, 100), pos("b", 50, 300), pos("c", 5, 100)];
    const remote = [pos("a", 90, 200), pos("b", 20, 250), pos("d", 7, 50)];
    const { toApply, toPush } = mergePositions(local, remote);
    expect(toApply.map((p) => [p.id, p.position])).toEqual([["a", 90], ["d", 7]]);
    expect(toPush.map((p) => [p.id, p.position])).toEqual([["b", 50], ["c", 5]]);
  });
  it("does nothing when both sides are equal", () => {
    const same = [pos("a", 10, 100)];
    expect(mergePositions(same, [...same])).toEqual({ toApply: [], toPush: [] });
  });
  it("finds the latest change", () => {
    expect(latest([pos("a", 1, 5), pos("b", 1, 9), pos("c", 1, 7)])?.id).toBe("b");
    expect(latest([])).toBeUndefined();
  });
});

describe("pull / push", () => {
  it("maps the server rows and sends clean items", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const client: RpcClient = {
      rpc: async (fn, args) => {
        calls.push([fn, args]);
        if (fn === "sync_pull")
          return { data: [{ cid: "a", pos: 12.5, dur: null, is_done: true, changed_at: "2026-11-06T10:00:00.000Z" }], error: null };
        return { data: 1, error: null };
      },
    };
    expect(await pull(client, "ABCDEFGHIJKLMNOP")).toEqual([
      { id: "a", position: 12.5, duration: undefined, done: true, updatedAt: Date.parse("2026-11-06T10:00:00.000Z") },
    ]);
    await push(client, "ABCDEFGHIJKLMNOP", [{ id: "a", position: NaN, duration: 600, done: undefined, updatedAt: 5 }]);
    expect(calls[1]).toEqual(["sync_push", { p_code: "ABCDEFGHIJKLMNOP", p_items: [{ id: "a", position: 0, duration: 600, done: false, updatedAt: 5 }] }]);
    await push(client, "ABCDEFGHIJKLMNOP", []);
    expect(calls).toHaveLength(2);
  });
  it("reports a missing server function as 'not activated'", async () => {
    const client: RpcClient = { rpc: async () => ({ data: null, error: { message: "Could not find the function public.sync_pull(p_code) in the schema cache" } }) };
    await expect(pull(client, "ABCDEFGHIJKLMNOP")).rejects.toThrow();
    expect(syncErrorText(new Error("Could not find the function public.sync_pull(p_code) in the schema cache"))).toMatch(/pas encore activée/);
  });
});

describe("display helpers", () => {
  it("removes a first line that repeats the title", () => {
    expect(withoutTitleLine("Dernier de 480\n\nLe Tableau occupait…", "Dernier de 480")).toBe("Le Tableau occupait…");
    expect(withoutTitleLine("# Épisode 1 — Dernier de 480\n\nTexte", "Dernier de 480")).toBe("Texte");
    expect(withoutTitleLine("Le Tableau occupait tout un mur.\nSuite", "Dernier de 480")).toBe("Le Tableau occupait tout un mur.\nSuite");
  });
  it("picks the most common series", () => {
    const c = (series: string) => ({ series } as Chapter);
    expect(mostCommonSeries([c("Tome 1"), c("Tome 2"), c("Tome 1"), c("")])).toBe("Tome 1");
    expect(mostCommonSeries([])).toBe("");
  });
});

describe("owner check", () => {
  it("rejects other addresses (the author's address is only stored as a hash)", async () => {
    expect(await isOwnerEmail("someone@example.com")).toBe(false);
    expect(await isOwnerEmail("")).toBe(false);
    expect(await isOwnerEmail(null)).toBe(false);
  });
});

describe("server clock", () => {
  it("corrects a device clock that is 3 minutes late, and stays monotonic", async () => {
    const { noteServerDate, clockNow, clockOffsetMs } = await import("@/lib/sync");
    const now = Date.now();
    noteServerDate(new Date(now + 180_000).toUTCString(), now - 50, now + 50);
    expect(Math.abs(clockOffsetMs() - 180_000)).toBeLessThan(1600);
    const a = clockNow();
    const b = clockNow();
    expect(b).toBeGreaterThan(a);
    expect(Math.abs(a - (Date.now() + 180_000))).toBeLessThan(1600);
  });
  it("ignores slow responses and sub-second noise", async () => {
    const { noteServerDate, clockOffsetMs } = await import("@/lib/sync");
    const before = clockOffsetMs();
    const now = Date.now();
    noteServerDate(new Date(now - 3_600_000).toUTCString(), now - 20_000, now); // 20 s de trajet : ignoré
    noteServerDate(new Date(now + before + 400).toUTCString(), now, now); // < 1,5 s d'écart : ignoré
    noteServerDate(null, now, now);
    expect(clockOffsetMs()).toBe(before);
  });
});
