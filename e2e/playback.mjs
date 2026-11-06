// Lecture : enchaînement, fin de tome, minuteur, vitesse, navigation, sauts, reprises, écran verrouillé.
import { APP, ROWS, audioState, begin, btn, card, check, hide, makeDb, near, newPhone, noJsErrors, nowPlayingTitle, positions, seekSlider, show, sleep, step, timeShown, toSec } from "./harness.mjs";

export async function run(browser, { ios }) {
  begin(`Lecture (${ios ? "iPhone simulé" : "ordinateur"})`);
  const pg = await makeDb();
  const { ctx, page } = await newPhone(browser, pg, {}, { ios });
  const lecture = () => btn(page, "Lecture").click();
  const biblio = () => btn(page, "Bibliothèque").click();
  await page.goto(APP);
  await page.getByRole("button", { name: /Écouter/ }).first().waitFor({ timeout: 30000 });

  await step("démarrage", async () => {
    await card(page, 1).getByRole("button", { name: /Écouter/ }).click();
    await sleep(2000);
    const s = await audioState(page);
    check("épisode 1 démarre au début et joue", s && !s.paused && s.t > 0.5 && s.t < 4, JSON.stringify(s));
    check("écran verrouillé : bon titre", (await nowPlayingTitle(page)) === "Dernier de 480");
  });

  await step("sauts rapides", async () => {
    const t0 = (await audioState(page)).t;
    for (let i = 0; i < 5; i++) await btn(page, "15 s ↻").click();
    await sleep(600);
    const t1 = (await audioState(page)).t;
    check("5 × +15 s rapides = +75 s", Math.abs(t1 - t0 - 75) <= 3, `${t0.toFixed(1)} → ${t1.toFixed(1)}`);
    for (let i = 0; i < 8; i++) await btn(page, "↺ 15 s").click();
    await sleep(600);
    const t2 = (await audioState(page)).t;
    check("−15 s au début s'arrête à 0 (pas de valeur négative)", t2 >= 0 && t2 < 3, t2.toFixed(1));
  });

  await step("curseur pendant la lecture", async () => {
    await seekSlider(page, 150);
    await sleep(800);
    const s = await audioState(page);
    check("curseur à ≈2:30 pendant la lecture", Math.abs(s.t - 150) <= 8, s.t.toFixed(1));
  });

  await step("+15 s près de la fin → enchaînement", async () => {
    await seekSlider(page, 292);
    await sleep(500);
    await btn(page, "15 s ↻").click(); // dépasse la fin : doit s'arrêter juste avant puis enchaîner
    await page.waitForFunction(() => navigator.mediaSession?.metadata?.title === "Brume-Aval", null, { timeout: 15000 });
    await sleep(1500);
    const s = await audioState(page);
    check("épisode 2 démarre tout seul au début", s && !s.paused && s.t < 4 && s.src === "ep2.mp3", JSON.stringify(s));
    await biblio();
    const c1 = await card(page, 1).innerText();
    check("épisode 1 marqué écouté (✓ Écouté, Réécouter)", c1.includes("Écouté") && c1.includes("Réécouter"), c1.replace(/\n/g, " | "));
    await lecture();
  });

  await step("vitesse 1,5× conservée à l'enchaînement", async () => {
    await btn(page, "1,5×").click();
    await sleep(300);
    // laisser finir l'épisode 2 (20 s) à 1,5× : enchaînement réel (événement « fin »)
    await page.waitForFunction(() => navigator.mediaSession?.metadata?.title === "La table de Bram", null, { timeout: 30000 });
    await sleep(1200);
    const s = await audioState(page);
    check("fin naturelle de l'épisode 2 → épisode 3", s && !s.paused && s.src === "ep3.mp3", JSON.stringify(s));
    check("vitesse 1,5× toujours appliquée sur l'épisode suivant", s && Math.abs(s.rate - 1.5) < 0.01, s?.rate);
    const ps = await page.evaluate(() => window.__pos.at(-1));
    check("écran verrouillé informé de la vitesse", ps && Math.abs(ps.playbackRate - 1.5) < 0.01, JSON.stringify(ps));
    await btn(page, "1×").click();
  });

  await step("minuteur « Fin du chap. »", async () => {
    await btn(page, "Fin du chap.").click();
    await page.waitForFunction(() => window.__audio?.paused === true, null, { timeout: 35000 });
    await sleep(1500);
    const s = await audioState(page);
    const title = await nowPlayingTitle(page);
    check("s'arrête à la fin de l'épisode 3 sans lancer le 4", s.paused && title === "La table de Bram" && s.src === "ep3.mp3", `${title} ${JSON.stringify(s)}`);
    check("bouton affiche « Lire » (pas bloqué sur Pause)", await page.getByRole("button", { name: /▶ Lire/ }).count() > 0);
  });

  await step("précédent / suivant", async () => {
    await btn(page, "Suivant ⏭").click();
    await sleep(1500);
    check("Suivant → épisode 4", (await nowPlayingTitle(page)) === "Lecture des Fiches");
    await btn(page, "⏮ Précédent").click();
    await sleep(1500);
    check("Précédent → épisode 3", (await nowPlayingTitle(page)) === "La table de Bram");
    await page.evaluate(() => window.__handlers.nexttrack?.({ action: "nexttrack" }));
    await sleep(1500);
    check("écran verrouillé « suivant » → épisode 4", (await nowPlayingTitle(page)) === "Lecture des Fiches");
  });

  await step("fin du dernier épisode", async () => {
    await seekSlider(page, 17);
    await sleep(500);
    await page.waitForFunction(() => window.__audio?.ended || window.__audio?.paused, null, { timeout: 15000 });
    await sleep(1500);
    const s = await audioState(page);
    check("fin du tome : s'arrête proprement", s.paused && (await nowPlayingTitle(page)) === "Lecture des Fiches", JSON.stringify(s));
    const errs = await page.evaluate(() => [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent).join(" | "));
    check("pas de message d'erreur à la fin du tome", !errs, errs);
  });

  await step("réécouter un épisode fini", async () => {
    await biblio();
    await card(page, 1).getByRole("button", { name: /Réécouter/ }).click();
    await sleep(2500);
    const s = await audioState(page);
    check("Réécouter repart du début (pas restauré à la fin)", s && !s.paused && s.src === "ep1.mp3" && s.t < 5, JSON.stringify(s));
    await biblio();
    const c1 = await card(page, 1).innerText();
    check("un épisode relancé n'est plus marqué « Écouté »", !c1.includes("Écouté"), c1.replace(/\n/g, " | "));
    await lecture();
  });

  await step("retour volontaire à 0", async () => {
    await seekSlider(page, 100);
    await sleep(800);
    await btn(page, /Pause/).click();
    await sleep(400);
    await seekSlider(page, 0);
    await sleep(400);
    await btn(page, /▶ Lire/).click();
    await sleep(2000);
    const s = await audioState(page);
    check("curseur mis à 0 puis Lire : reste au début (la protection ne s'active pas à tort)", s.t < 5, s.t.toFixed(1));
  });

  await step("changer d'épisode pendant la lecture puis recharger", async () => {
    await seekSlider(page, 120);
    await sleep(1000);
    const before = (await audioState(page)).t;
    await biblio();
    await card(page, 2).getByRole("button", { name: /Écouter|Reprendre|Réécouter/ }).click();
    await sleep(1500);
    await btn(page, /Pause/).click();
    await sleep(600);
    await hide(page);
    await page.reload();
    await page.getByRole("button", { name: /Écouter|Reprendre|Réécouter/ }).first().waitFor({ timeout: 20000 });
    const ps = await positions(page);
    const p1 = ps.find((p) => p.id === ROWS[0].id);
    check("position de l'épisode quitté gardée après rechargement", p1 && Math.abs(p1.position - before) <= 3, `${p1?.position?.toFixed(1)} vs ${before.toFixed(1)}`);
    check("épisode fini (4) toujours marqué écouté après rechargement", ps.find((p) => p.id === ROWS[3].id)?.done === true, JSON.stringify(ps.map((p) => p.done)));
    const mini = await page.innerText("body");
    check("dernier épisode écouté remis dans le mini-lecteur", mini.includes("ÉP. 2"));
    await card(page, 1).getByRole("button", { name: /Reprendre/ }).click();
    await sleep(2500);
    const s = await audioState(page);
    check("Reprendre l'épisode 1 → bonne position", Math.abs(s.t - before - 2) <= 4, `${s.t.toFixed(1)} (attendu ≈${(before + 2).toFixed(0)})`);
  });

  await step("écran verrouillé : glisser la barre (seekto)", async () => {
    await page.evaluate(() => window.__handlers.seekto?.({ action: "seekto", seekTime: 200 }));
    await sleep(800);
    const s = await audioState(page);
    check("seekto 200 s", Math.abs(s.t - 200) <= 2, s.t.toFixed(1));
    await btn(page, /Pause/).click();
  });

  noJsErrors(page);
  await ctx.close();
}
