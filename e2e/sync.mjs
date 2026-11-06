// Synchronisation entre appareils : liaison, fusion, lecture simultanée, horloges décalées, pannes.
import { APP, ROWS, audioState, begin, btn, card, check, hide, makeDb, newPhone, noJsErrors, remote, seekSlider, show, sleep, step } from "./harness.mjs";

const codeOf = async (page) => (await page.locator("p.font-mono").innerText()).replace(/-/g, "");
const ready = (page) => page.getByText("Positions synchronisées").waitFor({ timeout: 20000 });
const pos1 = async (pg, code, n = 1) => (await remote(pg)).find((r) => r.sync_code === code && r.chapter_id === ROWS[n - 1].id);

async function listen(page, n, toSec) {
  await btn(page, "Bibliothèque").click();
  await page.locator("article").nth(n - 1).getByRole("button", { name: /Écouter|Reprendre|Réécouter/ }).click();
  await sleep(1500);
  await seekSlider(page, toSec);
  await sleep(1200);
  await btn(page, /Pause/).click();
  await sleep(500);
  await hide(page);
  await sleep(1200);
  await show(page);
}

export async function run(browser, { ios }) {
  begin(`Synchronisation (${ios ? "iPhone simulé" : "ordinateur"})`);
  const pg = await makeDb();

  // --- fusion à la liaison : chaque appareil a sa propre progression avant d'être relié ---
  const A = await newPhone(browser, pg, {}, { ios, device: null });
  const B = await newPhone(browser, pg, {}, { ios });
  await A.page.goto(APP); await ready(A.page);
  await B.page.goto(APP); await ready(B.page);
  const codeA = await codeOf(A.page);

  await step("fusion à la liaison", async () => {
    await listen(A.page, 1, 100); // A : épisode 1 à ≈1:40
    await listen(B.page, 1, 30); // B : épisode 1 à ≈0:30 (plus récent)…
    await listen(B.page, 2, 10); // …et épisode 2 à ≈0:10
    await sleep(1500);
    await B.page.goto(`${APP}/#sync=${codeA}`);
    await B.page.getByText("Cet appareil est relié").waitFor({ timeout: 20000 });
    await sleep(1500);
    await show(A.page); await sleep(6000); await hide(A.page); await show(A.page); await sleep(2000);
    const a1 = await pos1(pg, codeA, 1), a2 = await pos1(pg, codeA, 2);
    check("après liaison, le serveur garde la position la plus récente de l'épisode 1 (celle de B)", a1 && Math.abs(a1.pos - 30) <= 10, JSON.stringify(a1));
    check("l'épisode 2 écouté seulement sur B est partagé", a2 && Math.abs(a2.pos - 10) <= 8, JSON.stringify(a2));
    await btn(A.page, "Bibliothèque").click();
    const c2 = await A.page.locator("article").nth(1).innerText();
    check("A voit la progression de l'épisode 2 faite sur B", /Reprendre/.test(c2), c2.replace(/\n/g, " | "));
  });

  await step("lecture simultanée : l'autre appareil ne coupe pas la lecture en cours", async () => {
    await btn(A.page, "Bibliothèque").click();
    await A.page.locator("article").nth(0).getByRole("button", { name: /Écouter|Reprendre|Réécouter/ }).click();
    await sleep(2500);
    const t0 = (await audioState(A.page)).t;
    await listen(B.page, 1, 250); // B écrit une position bien plus loin pendant que A joue
    await sleep(6000);
    await A.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await sleep(2500);
    const s = await audioState(A.page);
    check("A continue de jouer, sans saut vers la position de B", s && !s.paused && s.t > t0 && s.t < t0 + 15, `${t0.toFixed(1)} → ${s?.t.toFixed(1)}`);
    await btn(A.page, /Pause/).click();
    await sleep(500);
    await hide(A.page); await sleep(1500); await show(A.page);
    const r = await pos1(pg, codeA, 1);
    check("quand A s'arrête après B, c'est la position de A qui gagne (la plus récente)", r && Math.abs(r.pos - s.t) <= 6, `${r?.pos} vs A ${s.t.toFixed(1)}`);
  });

  await step("épisode marqué écouté synchronisé", async () => {
    await btn(A.page, "Bibliothèque").click();
    await A.page.locator("article").nth(2).getByRole("button", { name: "Marquer écouté" }).click();
    await sleep(500);
    await hide(A.page); await sleep(1500); await show(A.page);
    await sleep(5500);
    await hide(B.page); await show(B.page); await sleep(2500);
    await btn(B.page, "Bibliothèque").click();
    const c3 = await B.page.locator("article").nth(2).innerText();
    check("B voit l'épisode 3 « Écouté »", c3.includes("Écouté"), c3.replace(/\n/g, " | "));
  });

  await step("serveur en panne puis rétabli", async () => {
    A.state.rpcFail = true;
    await listen(A.page, 4, 12);
    await btn(A.page, "Bibliothèque").click();
    const panel = await A.page.locator("section", { hasText: "Reprendre sur un autre appareil" }).last().innerText();
    check("panne : message clair, pas de plantage", /Synchronisation en pause/.test(panel), panel.split("\n")[1]);
    A.state.rpcFail = false;
    await sleep(5500);
    await A.page.evaluate(() => window.dispatchEvent(new Event("online")));
    await sleep(3000);
    const r = await pos1(pg, codeA, 4);
    check("rétabli : la position écrite pendant la panne arrive sur le serveur", r && Math.abs(r.pos - 12) <= 6, JSON.stringify(r));
  });

  await step("lien de liaison invalide", async () => {
    const before = await codeOf(B.page);
    await B.page.goto(`${APP}/#sync=PASUNCODE`);
    await ready(B.page);
    check("lien invalide ignoré, l'appareil garde son code", (await codeOf(B.page)) === before);
  });
  noJsErrors(A.page, B.page);
  await A.ctx.close(); await B.ctx.close();

  // --- horloges décalées : le téléphone retarde de 3 minutes ---
  await step("horloge du téléphone en retard de 3 min", async () => {
    const pg2 = await makeDb();
    const P = await newPhone(browser, pg2, {}, { ios, device: null });
    const late = () => { const real = Date.now.bind(Date); Date.now = () => real() - 180000; };
    const Q = await newPhone(browser, pg2, {}, { ios, init: late });
    await P.page.goto(APP); await ready(P.page);
    const code = await codeOf(P.page);
    await listen(P.page, 1, 60); // PC à 1:00
    await Q.page.goto(`${APP}/#sync=${code}`);
    await Q.page.getByText("Cet appareil est relié").waitFor({ timeout: 20000 });
    await sleep(1500);
    await listen(Q.page, 1, 200); // puis le téléphone (en retard) va à 3:20
    await sleep(6000);
    await hide(Q.page); await show(Q.page); await sleep(2500);
    const r = await pos1(pg2, code, 1);
    check("la position faite en dernier (téléphone, 3:20) est gardée malgré son horloge en retard", r && Math.abs(r.pos - 200) <= 10, JSON.stringify(r));
    await btn(Q.page, "Bibliothèque").click();
    const cq = await Q.page.locator("article").first().innerText();
    check("le téléphone ne revient pas en arrière à 1:00 (≈ 67 %)", /6[3-9] %/.test(cq), cq.replace(/\n/g, " | "));
    noJsErrors(P.page, Q.page);
    await P.ctx.close(); await Q.ctx.close();
  });
}
