// Lance toutes les suites, en mode iPhone simulé puis ordinateur.
//   node run-all.mjs               → build local requis (./build-local.sh)
//   APP=https://… node run-all.mjs → contre un site déjà en ligne (données Supabase simulées)
import { chromium, startServer, stopServer, summary } from "./harness.mjs";

const SUITES = (process.env.SUITES || "playback,sync,offline,reopen,ui,atelier").split(",");
const MODES = (process.env.MODES || "ios,desktop").split(",");

await startServer();
const browser = await chromium.launch();
const t0 = Date.now();
for (const mode of MODES) {
  for (const name of SUITES) {
    const mod = await import(`./${name}.mjs`);
    try {
      await mod.run(browser, { ios: mode === "ios" });
    } catch (e) {
      console.log(`CRASH ${name}/${mode}: ${e.message.split("\n")[0]}`);
    }
  }
}
await browser.close();
stopServer();
const { failed } = summary();
console.log(`Durée : ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(failed.length ? 1 : 0);
