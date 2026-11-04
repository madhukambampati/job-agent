/**
 * `npm run sandbox`: the full app on dummy jobs and dummy employer forms.
 *   - Search returns only the sandbox postings (fictional companies).
 *   - Apply really fills and submits the forms, but they're served from this
 *     machine; nothing reaches a real employer.
 *   - Uses your profile + resume and real Claude when .env has a key
 *     (so fit, tailoring and answers are real); `--offline` uses rough
 *     heuristics and needs no key.
 *   - Separate ledger and files in data-sandbox/, so your real ledger stays clean.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { parse } from "yaml";
import { join, resolve } from "node:path";
import { launchBrowser } from "../browser.js";
import { AnthropicLLM, type LLM } from "../llm.js";
import { loadProfile, ProfileSchema } from "../profile.js";
import { BoardMemory } from "../search.js";
import { startUi } from "../ui/server.js";
import { startEmployer } from "./employer.js";
import { OfflineLLM, SandboxLLM } from "./llm.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* fine */
}

const args = new Set(process.argv.slice(2));
const dir = resolve("data-sandbox");
if (args.has("--reset")) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// Profile: yours if set up, else the example profile + example resume.
const mine = existsSync("config/profile.yaml") && existsSync("config/resume.md");
const profilePath = mine ? "config/profile.yaml" : "config/profile.example.yaml";
const loaded = mine
  ? loadProfile(profilePath)
  : { profile: ProfileSchema.parse(parse(readFileSync(profilePath, "utf8"))), resumeMarkdown: readFileSync("config/resume.example.md", "utf8") };

let llm: LLM;
let mode: string;
if (!args.has("--offline") && process.env.ANTHROPIC_API_KEY) {
  llm = new SandboxLLM(new AnthropicLLM());
  mode = "real Claude, fake web search";
} else {
  llm = new OfflineLLM();
  mode = args.has("--offline") ? "offline (no API calls)" : "offline (no ANTHROPIC_API_KEY in .env)";
}

const employer = await startEmployer(dir);
const port = Number(process.env.JOB_AGENT_UI_PORT ?? 3000);
startUi(port, {
  llm: () => llm,
  load: () => loaded,
  launch: launchBrowser,
  fetcher: employer.fetcher,
  ledgerPath: join(dir, "ledger.json"),
  boards: new BoardMemory(join(dir, "boards.json")),
  outRoot: join(dir, "out"),
  sandbox: { inboxUrl: `${employer.baseUrl}/inbox`, mode },
});

console.log(`
SANDBOX MODE: dummy jobs, local employer forms, nothing reaches a real employer.
  brain:          ${mode}
  profile:        ${profilePath}
  employer inbox: ${employer.baseUrl}/inbox
  data:           ${dir}   (npm run sandbox -- --reset to start fresh)
Try: "SDET or QA automation jobs, remote in Canada"
`);
