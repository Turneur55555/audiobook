// Affichage : aucune largeur qui déborde (320 → 1280 px), libellés accessibles, 60 épisodes, titres très longs.
import { APP, ROWS, begin, btn, check, makeDb, newPhone, noJsErrors, sleep, step } from "./harness.mjs";

const many = () => {
  const rows = [];
  for (let n = 1; n <= 60; n++) {
    const base = ROWS[(n - 1) % 4];
    rows.push({ ...base, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`, episode: n, audio_path: n === 1 ? ROWS[0].audio_path : "tome-1/fr/ep2.mp3", duration: n === 1 ? 300.07 : 20.06,
      title: n === 7 ? "Un titre d’épisode extrêmement long qui ne devrait jamais faire déborder la carte ni la page sur un petit téléphone" : `Épisode numéro ${n}` });
  }
  return rows;
};

const overflow = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [...document.querySelectorAll("body *")]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > w + 1 && getComputedStyle(e).position !== "fixed"; })
    .slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ").slice(0, 2).join(".")} → ${Math.round(e.getBoundingClientRect().right)}px`);
  return { scroll: document.documentElement.scrollWidth, w, bad };
});

export async function run(browser, { ios }) {
  begin(`Affichage (${ios ? "iPhone simulé" : "ordinateur"})`);
  const pg = await makeDb();

  await step("60 épisodes", async () => {
    const { ctx, page } = await newPhone(browser, pg, { rows: many() }, { ios });
    const t0 = Date.now();
    await page.goto(APP);
    await page.locator("article").nth(59).waitFor({ timeout: 20000 });
    const ms = Date.now() - t0;
    check("bibliothèque de 60 épisodes affichée en moins de 4 s", ms < 4000, `${ms} ms`);
    await page.locator("article").nth(59).getByRole("button", { name: /Écouter/ }).click();
    await sleep(1500);
    const vis = await page.evaluate(() => { const r = document.querySelector("input[type=range]")?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= innerHeight; });
    check("« Écouter » sur le 60e épisode : commandes visibles en haut de l'écran", vis);
    await btn(page, "Bibliothèque").click();
    await sleep(500);
    const y = await page.evaluate(() => scrollY);
    check("retour à la bibliothèque : on retrouve sa place dans la liste", y > 2000, `${y}px`);
    await btn(page, "Lecture").click();
    await btn(page, /Pause/).click().catch(() => {});
    noJsErrors(page);
    await ctx.close();
  });

  for (const width of [320, 375, 414, 768, 1280]) {
    await step(`largeur ${width}px`, async () => {
      const { ctx, page } = await newPhone(browser, pg, { rows: many() }, { ios, device: null });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(APP);
      await page.locator("article").first().waitFor({ timeout: 20000 });
      await sleep(500);
      const lib = await overflow(page);
      check(`${width}px · Bibliothèque sans débordement horizontal`, lib.scroll <= lib.w + 1 && lib.bad.length === 0, `${lib.scroll}/${lib.w} ${lib.bad.join(" | ")}`);
      await page.locator("article").first().getByRole("button", { name: /Écouter/ }).click();
      await sleep(800);
      const lec = await overflow(page);
      check(`${width}px · Lecture sans débordement horizontal`, lec.scroll <= lec.w + 1 && lec.bad.length === 0, `${lec.scroll}/${lec.w} ${lec.bad.join(" | ")}`);
      await btn(page, /Pause/).click().catch(() => {});
      if (width === 375) {
        const unnamed = await page.evaluate(() => [...document.querySelectorAll("button, input, select, textarea")]
          .filter((e) => e.offsetParent !== null || e.type === "file")
          .filter((e) => !(e.getAttribute("aria-label") || e.textContent.trim() || e.getAttribute("placeholder") || e.closest("label")?.textContent.trim() || e.getAttribute("title")))
          .map((e) => e.outerHTML.slice(0, 80)));
        check("tous les boutons et champs ont un libellé (lecteurs d'écran)", unnamed.length === 0, unnamed.slice(0, 3).join(" | "));
      }
      noJsErrors(page);
      await ctx.close();
    });
  }
}
