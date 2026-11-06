// Atelier (espace auteur) : import texte + MP3, mise à jour, série vide, échec et nettoyage, compte non autorisé.
// Nécessite OWNER_EMAIL (adresse de l'auteur) dans l'environnement : elle n'est jamais écrite dans le dépôt.
import { APP, MP3, ROWS, begin, btn, check, makeDb, newPhone, noJsErrors, sleep, step } from "./harness.mjs";

const REF = "hoyhnxrcmjdbmsofniub";
const sessionInit = (email) => `localStorage.setItem("sb-${REF}-auth-token", JSON.stringify({
  access_token: "test-token", refresh_token: "test-refresh", token_type: "bearer",
  expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "00000000-0000-4000-8000-000000000001", email: ${JSON.stringify(email)}, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} }
}));`;

function backend(state) {
  state.rows = [...ROWS];
  state.calls = [];
  state.handler = async (route, req, url, json) => {
    const m = req.method();
    const p = url.pathname;
    if (p.startsWith("/auth/v1/")) {
      state.calls.push(`${m} ${p}`);
      return json(200, {}), true;
    }
    if (p === "/rest/v1/chapters" && m === "POST") {
      state.calls.push("INSERT");
      if (state.insertFail) return json(500, { message: "panne simulée" }), true;
      const body = JSON.parse(req.postData() || "{}");
      const row = { id: `99999999-9999-4999-8999-${String(state.rows.length).padStart(12, "0")}`, created_at: new Date().toISOString(), ...body };
      state.rows.push(row);
      state.lastInsert = body;
      return json(201, row), true;
    }
    if (p === "/rest/v1/chapters" && m === "PATCH") {
      state.calls.push("UPDATE");
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      const body = JSON.parse(req.postData() || "{}");
      const i = state.rows.findIndex((r) => r.id === id);
      if (i < 0) return json(404, { message: "absent" }), true;
      state.rows[i] = { ...state.rows[i], ...body };
      return json(200, state.rows[i]), true;
    }
    if (p.startsWith("/storage/v1/object/list/")) return json(200, []), true;
    if (p.startsWith("/storage/v1/object/audiobook/") && m === "POST") {
      state.calls.push(`UPLOAD ${p.split("/audiobook/")[1]}`);
      return json(200, { Key: p }), true;
    }
    if (p === "/storage/v1/object/audiobook" && m === "DELETE") {
      state.calls.push(`DELETE ${(JSON.parse(req.postData() || "{}").prefixes || []).join(",")}`);
      return json(200, []), true;
    }
    return false;
  };
  return state;
}

const files = (n, text) => [
  { name: `Episode ${String(n).padStart(2, "0")}.md`, mimeType: "text/markdown", buffer: Buffer.from(text) },
  { name: `Episode ${String(n).padStart(2, "0")}.mp3`, mimeType: "audio/mpeg", buffer: MP3["ep2.mp3"] },
];

export async function run(browser, { ios }) {
  begin(`Atelier (${ios ? "iPhone simulé" : "ordinateur"})`);
  const owner = process.env.OWNER_EMAIL;
  if (!owner) return check("Atelier testé (OWNER_EMAIL fourni)", false, "OWNER_EMAIL absent : suite ignorée");
  const pg = await makeDb();
  const { ctx, page, state } = await newPhone(browser, pg, backend({}), { ios, device: null, init: sessionInit(owner) });
  await page.goto(APP);

  await step("accès auteur", async () => {
    await btn(page, "Atelier").waitFor({ timeout: 20000 });
    check("onglet Atelier visible pour l'auteur", true);
    await btn(page, "Atelier").click();
    const series = await page.getByPlaceholder("Série / tome (ex. Tome 1)").inputValue();
    check("série pré-remplie avec « Tome 1 »", series === "Tome 1", series);
  });

  const input = page.locator('input[type=file][multiple]');
  await step("nouvel épisode (texte + MP3)", async () => {
    await input.setInputFiles(files(5, "Le nouveau venu\n\nPremier paragraphe.\n\nDeuxième paragraphe."));
    await page.getByText("✓ Ajouté").waitFor({ timeout: 20000 });
    const ins = state.lastInsert;
    check("enregistré dans « Tome 1 », épisode 5, titre de la 1re ligne", ins?.series === "Tome 1" && ins?.episode === 5 && ins?.title === "Le nouveau venu", JSON.stringify({ s: ins?.series, e: ins?.episode, t: ins?.title }));
    check("MP3 envoyé dans tome-1/fr/", state.calls.some((c) => c.startsWith("UPLOAD tome-1/fr/")), state.calls.filter((c) => c.startsWith("UPLOAD")).join(" "));
    check("durée du MP3 mesurée", Math.abs((ins?.duration ?? 0) - 20) < 1.5, ins?.duration);
    await btn(page, "Bibliothèque").click();
    check("l'épisode 5 apparaît dans la bibliothèque", (await page.locator("article").count()) === 5);
    await btn(page, "Atelier").click();
  });

  await step("réimporter le même épisode le met à jour", async () => {
    state.calls.length = 0;
    await input.setInputFiles([files(5, "Le nouveau venu\n\nTexte corrigé.")[0]]);
    await page.getByText("✓ Mis à jour").waitFor({ timeout: 20000 });
    check("mise à jour, pas de doublon", state.calls.includes("UPDATE") && !state.calls.includes("INSERT"), state.calls.join(" "));
    check("toujours 5 épisodes", state.rows.length === 5, state.rows.length);
  });

  await step("série vide", async () => {
    state.calls.length = 0;
    await page.getByPlaceholder("Série / tome (ex. Tome 1)").fill("");
    await input.setInputFiles(files(6, "Sans série\n\nTexte."));
    await sleep(1500);
    const body = await page.innerText("body");
    check("message clair, rien n'est envoyé", body.includes("Indique d’abord la série") && !state.calls.some((c) => /UPLOAD|INSERT/.test(c)), state.calls.join(" "));
    await page.getByPlaceholder("Série / tome (ex. Tome 1)").fill("Tome 1");
  });

  await step("échec d'enregistrement : pas de MP3 orphelin", async () => {
    state.calls.length = 0;
    state.insertFail = true;
    await input.setInputFiles(files(7, "Épisode raté\n\nTexte."));
    await page.getByText("Échec").first().waitFor({ timeout: 20000 });
    await sleep(800);
    const up = state.calls.find((c) => c.startsWith("UPLOAD"))?.slice(7);
    check("le MP3 envoyé est supprimé après l'échec", up && state.calls.includes(`DELETE ${up}`), state.calls.join(" "));
    state.insertFail = false;
  });

  noJsErrors(page);
  await ctx.close();

  await step("compte non autorisé", async () => {
    const o = await newPhone(browser, pg, backend({}), { ios, device: null, init: sessionInit("quelquun@example.com") });
    await o.page.goto(APP);
    await o.page.getByText("n’est pas autorisé").waitFor({ timeout: 20000 });
    check("message + déconnexion, pas d'onglet Atelier", (await o.page.getByRole("button", { name: "Atelier", exact: true }).count()) === 0);
    check("déconnexion demandée au serveur", o.state.calls.some((c) => c.includes("/auth/v1/logout")), o.state.calls.join(" "));
    await o.ctx.close();
  });
}
