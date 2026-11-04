/**
 * `npm run demo`: the chat UI on a fake job market (fake model, five sample
 * Lever postings, a local fake application form). Nothing real is searched or
 * submitted and no API key is needed: safe to click Apply and see what happens.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser } from "../src/browser.js";
import { BoardMemory } from "../src/search.js";
import { startUi } from "../src/ui/server.js";
import { fakeMarket } from "../tests/fake-market.js";
import { FORM_HAPPY, profile, RESUME_MD, startFormServer } from "../tests/helpers.js";

const dir = resolve("data-demo");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const form = await startFormServer({ "/apply": FORM_HAPPY });
const { llm, fetcher } = fakeMarket(`${form.url}/apply`);

startUi(Number(process.env.JOB_AGENT_UI_PORT ?? 3000), {
  llm: () => llm,
  load: () => ({ profile, resumeMarkdown: RESUME_MD }),
  launch: launchBrowser,
  fetcher,
  ledgerPath: join(dir, "ledger.json"),
  boards: new BoardMemory(join(dir, "boards.json")),
  outRoot: join(dir, "out"),
});
console.log("DEMO MODE: sample jobs and a fake form. Try: “SDET jobs remote in Canada”.");
