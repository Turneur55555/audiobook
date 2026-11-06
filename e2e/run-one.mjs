// node run-one.mjs <suite> [desktop|ios]
import { chromium, startServer, stopServer, summary } from "./harness.mjs";
const [, , name, mode = "ios"] = process.argv;
const mod = await import(`./${name}.mjs`);
await startServer();
const browser = await chromium.launch();
try { await mod.run(browser, { ios: mode === "ios" }); }
catch (e) { console.log("CRASH", e.message.split("\n")[0]); }
finally { await browser.close(); stopServer(); }
summary();
