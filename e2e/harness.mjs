// Harnais commun des tests de bout en bout (navigateur réel, Playwright + Chromium).
// - Faux Supabase : liste d'épisodes, MP3 avec requêtes partielles, et synchronisation exécutée
//   par un vrai Postgres local (PGlite) avec le SQL de production (supabase/sync.sql).
// - Mode « iPhone » : rien n'est chargé avant « Lire », comme Safari sur iOS.
// - Toute erreur JavaScript non interceptée fait échouer la suite.
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url);
export const { chromium, devices } = require("playwright");

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const APP = process.env.APP || "http://127.0.0.1:3123";
export const SB = "https://hoyhnxrcmjdbmsofniub.supabase.co";

// ---------- MP3 de test (générés une fois) ----------
const FIX = path.join(HERE, "fixtures");
const SPECS = { "ep1.mp3": [300, 330], "ep2.mp3": [20, 440], "ep3.mp3": [20, 550], "ep4.mp3": [20, 660] };
fs.mkdirSync(FIX, { recursive: true });
for (const [f, [d, hz]] of Object.entries(SPECS)) {
  const p = path.join(FIX, f);
  if (!fs.existsSync(p))
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=${d}:sample_rate=22050`,
      "-af", "volume=0.05", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k", p]);
}
export const MP3 = Object.fromEntries(Object.keys(SPECS).map((f) => [f, fs.readFileSync(path.join(FIX, f))]));

const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const row = (n, title, file, duration) => ({
  id: id(n), series: "Tome 1", lang: "fr", episode: n, title, body: `${title}\n\nTexte de l’épisode ${n}.`,
  audio_path: `tome-1/fr/${file}`, duration, created_at: "2026-11-06T10:00:00Z",
});
export const ROWS = [row(1, "Dernier de 480", "ep1.mp3", 300.07), row(2, "Brume-Aval", "ep2.mp3", 20.06), row(3, "La table de Bram", "ep3.mp3", 20.06), row(4, "Lecture des Fiches", "ep4.mp3", 20.06)];

// ---------- Postgres local avec le SQL de synchronisation ----------
export async function makeDb() {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated;");
  await pg.exec(fs.readFileSync(path.join(ROOT, "supabase/sync.sql"), "utf8"));
  return pg;
}

/**
 * Branche un contexte de navigateur sur le faux Supabase.
 * opts.state : { offline, rpcFail, audioFail, rows } modifiable pendant le test.
 */
export async function wire(ctx, pg, state = {}) {
  state.log ??= [];
  await ctx.route(`${SB}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
    if (state.offline) return route.abort("internetdisconnected");
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json", date: new Date().toUTCString() }, body: JSON.stringify(body) });
    if (url.pathname === "/rest/v1/chapters" && req.method() === "GET") return json(200, state.rows ?? ROWS);
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop();
      state.log.push(fn);
      if (state.rpcFail) return json(503, { message: "Service Unavailable" });
      const args = JSON.parse(req.postData() || "{}");
      try {
        const r = fn === "sync_pull"
          ? (await pg.query("select * from public.sync_pull($1)", [args.p_code])).rows
          : (await pg.query("select public.sync_push($1, $2::jsonb) as n", [args.p_code, JSON.stringify(args.p_items)])).rows[0].n;
        return json(200, r);
      } catch (e) {
        return json(400, { message: e.message });
      }
    }
    if (state.handler) {
      const handled = await state.handler(route, req, url, json);
      if (handled) return;
    }
    const f = url.pathname.split("/").pop();
    if (MP3[f]) {
      if (state.audioFail?.(f)) return route.abort("connectionreset");
      const buf = MP3[f];
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers()["range"] || "");
      if (!m) return route.fulfill({ status: 200, headers: { ...cors, "content-type": "audio/mpeg", "accept-ranges": "bytes", "content-length": String(buf.length) }, body: buf });
      const s = m[1] ? +m[1] : 0;
      const e = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
      return route.fulfill({ status: 206, headers: { ...cors, "content-type": "audio/mpeg", "accept-ranges": "bytes", "content-range": `bytes ${s}-${e}/${buf.length}`, "content-length": String(e - s + 1) }, body: buf.subarray(s, e + 1) });
    }
    return json(404, { message: "not mocked: " + url.pathname });
  });
  return state;
}

// ---------- Serveur local (build de production) ----------
let server = null;
export async function startServer() {
  if (process.env.APP) return;
  server = spawn("node", [".output/server/index.mjs"], { cwd: ROOT, env: { ...process.env, PORT: "3123", HOST: "127.0.0.1" }, stdio: "ignore" });
  await waitServer(true);
}
export function stopServer() {
  try { server?.kill("SIGKILL"); } catch { /* déjà arrêté */ }
  server = null;
}
export async function waitServer(up) {
  for (let i = 0; i < 60; i++) {
    try { await fetch(APP); if (up) return; } catch { if (!up) return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- Navigateur ----------
export const IOS_INIT = () => {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "preload");
  Object.defineProperty(HTMLMediaElement.prototype, "preload", { configurable: true, get() { return "none"; }, set() { d.set.call(this, "none"); } });
};
const SPY_INIT = () => {
  const P = HTMLMediaElement.prototype;
  const o = P.play;
  P.play = function () { window.__audio = this; return o.call(this); };
  window.__pos = []; window.__handlers = {};
  const ms = navigator.mediaSession;
  if (ms) {
    const sps = ms.setPositionState?.bind(ms);
    ms.setPositionState = (s) => { window.__pos.push({ at: Date.now(), ...s }); try { sps?.(s); } catch { /* */ } };
    const sah = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (a, f) => { window.__handlers[a] = f; try { sah(a, f); } catch { /* */ } };
  }
};

export async function newPhone(browser, pg, state = {}, { ios = true, device = "iPhone 13", init } = {}) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1100, height: 900 } });
  await wire(ctx, pg, state);
  if (ios) await ctx.addInitScript(IOS_INIT);
  await ctx.addInitScript(SPY_INIT);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  return { ctx, page, state };
}

// ---------- Aides ----------
export const timeShown = (page) => page.evaluate(() => document.body.innerText.match(/(\d+:\d\d)\s*\n?\s*-(\d+:\d\d)/)?.[1] ?? null);
export const toSec = (t) => { if (!t) return NaN; const [m, x] = t.split(":").map(Number); return m * 60 + x; };
export const near = (t, s, tol = 3) => Math.abs(toSec(t) - s) <= tol;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const audioState = (page) => page.evaluate(() => {
  const a = window.__audio;
  return a ? { t: a.currentTime, d: a.duration, paused: a.paused, ended: a.ended, src: a.currentSrc.includes("offline-audio") ? "offline" : a.currentSrc.split("/").pop(), rate: a.playbackRate } : null;
});
export const nowPlayingTitle = (page) => page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);
export const btn = (page, name) => page.getByRole("button", { name, exact: typeof name === "string" }).first();
export async function seekSlider(page, s) {
  const sl = page.locator("input[type=range]").first();
  const max = +(await sl.getAttribute("max"));
  const b = await sl.boundingBox();
  await page.mouse.click(b.x + b.width * (s / max), b.y + b.height / 2);
}
export const hide = (page) => page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
export const show = (page) => page.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
export const card = (page, n) => page.locator("article").nth(n - 1);
export const positions = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open("audiobook-perso");
  r.onsuccess = () => { const q = r.result.transaction("positions").objectStore("positions").getAll(); q.onsuccess = () => res(q.result); };
  r.onerror = () => res([]);
}));
export const remote = async (pg) => (await pg.query("select sync_code, chapter_id, round(position::numeric,1)::float as pos, done, updated_at from listening_sync order by updated_at")).rows;

// ---------- Résultats ----------
const results = [];
let suite = "";
export function begin(name) { suite = name; console.log(`\n=== ${name}`); }
export function check(label, ok, extra = "") {
  results.push({ suite, label, ok: !!ok, extra: String(extra ?? "") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" && extra != null ? "  — " + extra : ""}`);
}
export async function step(label, fn) {
  try { await fn(); } catch (e) { check(`${label} (exception)`, false, e.message.split("\n")[0]); }
}
export function noJsErrors(...pages) {
  const errs = pages.flatMap((p) => p.__errors);
  check("aucune erreur JavaScript", errs.length === 0, errs.slice(0, 3).join(" | "));
}
export function summary() {
  const fail = results.filter((r) => !r.ok);
  console.log(`\nTOTAL ${results.length - fail.length}/${results.length} PASS`);
  for (const f of fail) console.log(`  ✗ [${f.suite}] ${f.label} — ${f.extra}`);
  return { total: results.length, failed: fail };
}
