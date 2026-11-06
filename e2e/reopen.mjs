// Fermer l'app puis la rouvrir (iPhone) : la lecture doit reprendre où elle en était, jamais à 0:00.
// On simule le pire cas Safari : un saut demandé avant que le fichier soit prêt est ignoré,
// et le repère « #t= » de l'adresse aussi.
import { APP, ROWS, SW_NOT_SEEKABLE, audioState, begin, btn, check, makeDb, newPhone, noJsErrors, positions, remote, seekSlider, sleep, step, timeShown, toSec, hide } from "./harness.mjs";

const SAFARI_DROPS_EARLY_SEEKS = () => {
  const P = HTMLMediaElement.prototype;
  const ct = Object.getOwnPropertyDescriptor(P, "currentTime");
  Object.defineProperty(P, "currentTime", {
    configurable: true,
    get() { return ct.get.call(this); },
    set(v) { if (this.readyState < 3) { window.__dropped = (window.__dropped || 0) + 1; return; } ct.set.call(this, v); },
  });
  const src = Object.getOwnPropertyDescriptor(P, "src");
  Object.defineProperty(P, "src", { configurable: true, get() { return src.get.call(this); }, set(v) { src.set.call(this, String(v).replace(/#t=[\d.]+$/, "")); } });
};

export async function run(browser, { ios }) {
  begin(`Fermer puis rouvrir l'app (${ios ? "iPhone simulé" : "ordinateur"}, Safari qui ignore les sauts précoces)`);
  const pg = await makeDb();
  const { ctx, page } = await newPhone(browser, pg, {}, { ios, init: SAFARI_DROPS_EARLY_SEEKS });
  await ctx.addInitScript(SW_NOT_SEEKABLE);
  await page.goto(APP);
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 20000 });
  await page.locator("section", { hasText: "Écouter sans réseau" }).last().getByRole("button", { name: /Tout télécharger/ }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Les 4 épisodes"), null, { timeout: 30000 });

  let saved = 0;
  await step("écoute puis pause", async () => {
    await page.locator("article").first().getByRole("button", { name: /Écouter/ }).click();
    await sleep(2500);
    await seekSlider(page, 200);
    await sleep(2000);
    await btn(page, /Pause/).click();
    await sleep(800);
    saved = toSec(await timeShown(page));
    check("en pause vers 3:20, depuis la copie téléchargée", Math.abs(saved - 202) < 10 && ["local", "sw"].includes((await audioState(page)).src), `${saved} s`);
  });

  let p2 = page;
  for (const [label, playing] of [["après une pause", false], ["en pleine lecture", true]]) {
    await step(`fermer l'app ${label} puis la rouvrir`, async () => {
      if (playing) {
        await btn(p2, /▶ Lire/).click();
        await sleep(4000);
        saved = (await audioState(p2)).t;
      }
      await hide(p2);
      await sleep(800);
      await p2.close({ runBeforeUnload: false }); // l'app est tuée
      p2 = await ctx.newPage();
      p2.__errors = [];
      p2.on("pageerror", (e) => p2.__errors.push(e.message));
      await p2.goto(APP);
      await p2.getByRole("button", { name: "Lecture", exact: true }).first().click();
      await sleep(1500);
      const shown = toSec(await timeShown(p2));
      check(`${label} : la bonne position est affichée à la réouverture`, Math.abs(shown - saved) <= 4, `${shown} s (attendu ≈${Math.round(saved)})`);
      await btn(p2, /▶ Lire/).click();
      await sleep(3500);
      const s = await audioState(p2);
      check(`${label} : « Lire » reprend là, pas à 0:00`, s && s.t > saved - 4 && s.t < saved + 8, `${s?.t.toFixed(1)} s (attendu ≈${Math.round(saved + 3)})`);
      const pos = (await positions(p2)).find((p) => p.id === ROWS[0].id);
      check(`${label} : la position enregistrée n'a pas été écrasée par 0`, pos && pos.position > saved - 5, pos?.position?.toFixed(1));
      await btn(p2, /Pause/).click();
      await sleep(600);
      saved = (await audioState(p2)).t;
    });
  }
  const r = (await remote(pg)).filter((x) => x.chapter_id === ROWS[0].id).at(-1);
  check("aucun 0:00 envoyé aux autres appareils", r && r.pos > 150, JSON.stringify(r));
  console.log("  sauts ignorés par le faux Safari :", await p2.evaluate(() => window.__dropped || 0));
  noJsErrors(page, p2);
  await ctx.close();
}
