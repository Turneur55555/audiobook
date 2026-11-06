// Écoute hors ligne : téléchargements, arrêt, coupure, suppression, enchaînement sans réseau.
import { APP, ROWS, SW_NOT_SEEKABLE, audioState, begin, btn, check, makeDb, newPhone, noJsErrors, nowPlayingTitle, remote, seekSlider, sleep, step } from "./harness.mjs";

const panel = (page) => page.locator("section", { hasText: "Écouter sans réseau" }).last();
const panelText = async (page) => (await panel(page).innerText()).replace(/\n/g, " | ");
const cached = (page) => page.evaluate(async () => (await (await caches.open("audio-v1")).keys()).map((r) => r.url.split("/").pop()).sort());

export async function run(browser, { ios }) {
  begin(`Hors ligne (${ios ? "iPhone simulé" : "ordinateur"})`);
  const pg = await makeDb();
  const { ctx, page, state } = await newPhone(browser, pg, {}, { ios, init: SW_NOT_SEEKABLE });
  await page.goto(APP);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
  await page.getByText("Écouter sans réseau").waitFor();

  await step("arrêter un « Tout télécharger » puis reprendre", async () => {
    let slow = true;
    state.handler = async (route, req, url) => {
      if (slow && /ep[1-4]\.mp3$/.test(url.pathname) && !req.headers()["range"]) await sleep(1500);
      return false;
    };
    await panel(page).getByRole("button", { name: /Tout télécharger/ }).click();
    await page.waitForFunction(() => /Téléchargement 2 \//.test(document.body.innerText), null, { timeout: 20000 });
    await panel(page).getByRole("button", { name: "Arrêter" }).click();
    await sleep(2500);
    const c = await cached(page);
    check("après « Arrêter », seuls les épisodes finis sont gardés (aucun fichier à moitié)", c.length >= 1 && c.length <= 2, c.join(", "));
    check("le panneau indique le bon compte", (await panelText(page)).includes(`${c.length} / 4 épisodes téléchargés`), await panelText(page));
    slow = false;
    await panel(page).getByRole("button", { name: /Tout télécharger/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Les 4 épisodes sont sur cet appareil"), null, { timeout: 30000 });
    check("« Tout télécharger » complète les manquants", (await cached(page)).length === 4);
  });

  await step("coupure pendant un téléchargement", async () => {
    await page.locator("article").nth(1).getByRole("button", { name: "Retirer le téléchargement" }).click();
    await sleep(800);
    check("retirer un épisode (confirmation acceptée)", !(await cached(page)).includes("ep2.mp3"));
    state.audioFail = (f) => f === "ep2.mp3";
    await page.locator("article").nth(1).getByRole("button", { name: "Télécharger pour écouter hors ligne" }).click();
    await sleep(2500);
    const txt = await panelText(page);
    check("échec affiché clairement, en français", /Épisode 2 : connexion interrompue/.test(txt), txt.match(/Épisode 2 :[^|]*/)?.[0]);
    check("épisode non marqué téléchargé après l'échec", !(await cached(page)).includes("ep2.mp3"));
    state.audioFail = null;
    await page.locator("article").nth(1).getByRole("button", { name: "Télécharger pour écouter hors ligne" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Les 4 épisodes"), null, { timeout: 20000 });
    check("nouvel essai réussi", (await cached(page)).includes("ep2.mp3"));
  });

  await step("enchaînement hors ligne", async () => {
    await page.locator("article").nth(2).getByRole("button", { name: "Retirer le téléchargement" }).click(); // ep3 retiré
    await sleep(800);
    state.offline = true;
    await ctx.setOffline(true);
    await page.locator("article").nth(0).getByRole("button", { name: /Écouter|Reprendre/ }).click();
    await sleep(2000);
    const vis = await page.evaluate(() => { const r = document.querySelector("input[type=range]")?.getBoundingClientRect(); return r ? r.top >= 0 && r.bottom <= innerHeight : false; });
    check("après « Écouter », les commandes de lecture sont visibles à l'écran", vis);
    const s1 = await audioState(page);
    check("épisode 1 joue hors ligne depuis la copie locale", s1 && !s1.paused && s1.src === "local", JSON.stringify(s1));
    const b0 = (await audioState(page)).t;
    for (let i = 0; i < 3; i++) await btn(page, "15 s ↻").click();
    await sleep(800);
    const b1 = (await audioState(page)).t;
    check("±15 s agit vraiment sur le son d'un épisode téléchargé (pas seulement la barre)", Math.abs(b1 - b0 - 45) <= 3, `${b0.toFixed(1)} → ${b1.toFixed(1)}`);
    await btn(page, "↺ 15 s").click();
    await sleep(800);
    const b2 = (await audioState(page)).t;
    check("−15 s aussi", Math.abs(b1 - b2 - 15) <= 3, `${b1.toFixed(1)} → ${b2.toFixed(1)}`);
    await seekSlider(page, 294);
    await page.waitForFunction(() => navigator.mediaSession?.metadata?.title === "Brume-Aval", null, { timeout: 20000 }).catch(async (e) => {
      console.log("JOURNAL:\n" + (JSON.parse(await page.evaluate(() => localStorage.getItem("audio-diag")) || "[]")).slice(-12).map((x) => `  ${x.ev} t=${x.t} d=${x.d} src=${x.src} ${x.suivant ?? ""} ${x.err ?? ""}`).join("\n"));
      console.log("ÉTAT:", JSON.stringify(await audioState(page)), "| page:", (await page.innerText("body")).slice(0, 300).replace(/\n/g, " | "));
      throw e;
    });
    await sleep(1500);
    const s2 = await audioState(page);
    check("hors ligne : passe tout seul à l'épisode 2 téléchargé (copie locale)", s2 && !s2.paused && s2.src === "local", JSON.stringify(s2));
    await page.waitForFunction(() => window.__audio?.paused, null, { timeout: 40000 });
    await sleep(1500);
    const s3 = await audioState(page);
    const title = await nowPlayingTitle(page);
    check("épisode 3 non téléchargé : s'arrête proprement à la fin du 2", s3.paused && title === "Brume-Aval", `${title} ${JSON.stringify(s3)}`);
    const body = await page.innerText("body");
    check("message « pas téléchargé » affiché", body.includes("n’est pas téléchargé"), "");
    await btn(page, "Bibliothèque").click();
    const c3 = await page.locator("article").nth(2).innerText();
    check("épisode 3 grisé « Non téléchargé »", c3.includes("Non téléchargé"), c3.replace(/\n/g, " | "));
  });

  await step("retour du réseau", async () => {
    state.offline = false;
    await ctx.setOffline(false);
    await sleep(4000);
    const c3 = await page.locator("article").nth(2).innerText();
    check("épisode 3 de nouveau écoutable", /Écouter|Reprendre/.test(c3) && !c3.includes("Non téléchargé"), c3.replace(/\n/g, " | "));
    const rows = await remote(pg);
    check("positions hors ligne envoyées au retour du réseau", rows.some((r) => r.chapter_id === ROWS[1].id && r.done), JSON.stringify(rows.map((r) => [r.chapter_id.slice(0, 2), r.pos, r.done])));
  });

  await step("télécharger l'épisode en cours de lecture", async () => {
    await page.locator("article").nth(2).getByRole("button", { name: /Écouter|Reprendre/ }).click();
    await sleep(2000);
    const before = await audioState(page);
    await btn(page, "Bibliothèque").click();
    await page.locator("article").nth(2).getByRole("button", { name: "Télécharger pour écouter hors ligne" }).click();
    await sleep(2500);
    const after = await audioState(page);
    check("la lecture continue pendant et après le téléchargement", !after.paused && after.t > before.t, `${before.t.toFixed(1)} → ${after.t.toFixed(1)}`);
    await btn(page, "Lecture").click();
    await btn(page, /Pause/).click();
    await sleep(400);
    await btn(page, /▶ Lire/).click();
    await sleep(1500);
    const s = await audioState(page);
    check("à la reprise, la copie téléchargée est utilisée, à la même position", ["local", "sw"].includes(s.src) && Math.abs(s.t - after.t) < 4, JSON.stringify(s));
    await btn(page, /Pause/).click();
  });

  await step("libérer toute la place", async () => {
    await btn(page, "Bibliothèque").click();
    await panel(page).getByRole("button", { name: "Libérer la place" }).click();
    await sleep(1500);
    check("plus aucun épisode téléchargé", (await cached(page)).length === 0 && (await panelText(page)).includes("0 / 4"), await panelText(page));
  });

  noJsErrors(page);
  await ctx.close();
}
