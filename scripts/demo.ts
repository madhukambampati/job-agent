/**
 * `npm run demo`: fills a throwaway ledger with sample roles (using a fake
 * model and a local fake application form, no API key or real site needed),
 * then starts the UI on it so you can click around safely.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger } from "../src/agents/ledger.js";
import { launchBrowser } from "../src/browser.js";
import { runJob } from "../src/pipeline.js";
import { FakeLLM, FORM_HAPPY, profile, RESUME_MD, startFormServer } from "../tests/helpers.js";

const dir = resolve("data-demo");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const srv = await startFormServer({ "/apply": FORM_HAPPY });
const browser = await launchBrowser();
const ledger = new Ledger(join(dir, "ledger.json"));
const llm = new FakeLLM(
  {
    record_fit: {
      score: 8,
      summary: "Strong Playwright and LLM-evaluation match; Go is the main gap.",
      strengths: ["Playwright + TypeScript framework work", "LLM evaluation harness with golden datasets"],
      gaps: [
        { requirement: "Go", severity: "major", note: "Not on the resume" },
        { requirement: "Kubernetes operators", severity: "minor", note: "Only general Kubernetes use" },
      ],
    },
    record_edit: {
      roles: [{ roleId: "r1", bulletOrder: ["r1.b2", "r1.b1", "r1.b3"], rewrites: [{ bulletId: "r1.b3", text: "Wired tests into GitHub Actions and Jenkins.", keywordsUsed: ["Jenkins"] }] }],
      summary: "Senior SDET with 8 years of test automation.",
      coverNote: "I built an LLM evaluation harness with a golden dataset, which maps directly to your evaluation work.\n\nHappy to walk through how I handled non-deterministic outputs.",
      unsupportedRequirements: ["Go"],
    },
    record_questions: {
      questions: [
        "How would you test a non-deterministic LLM feature?",
        "Walk me through how you'd structure a Playwright framework for 10 teams.",
        "Tell me about a flaky test you tracked down.",
        "How do you decide what not to automate?",
        "Design a test strategy for an agent that calls external tools.",
        "How do you validate data consistency across microservices?",
        "Describe a time you pushed back on a release.",
        "How would you measure test-suite health?",
        "What would you test first in our product?",
        "How do you keep API contract tests from going stale?",
      ].map((question, i) => ({ question, category: i === 2 || i === 6 ? "behavioral" : i === 8 ? "company" : "technical", whyTheyAsk: "Core to the role" })),
    },
    fill_fields: (p: string) => ({
      answers: [...p.matchAll(/id=(f\d+).*?label="([^"]*)"/g)].map(([, id, l]) => ({ fieldId: id, value: /why/i.test(l) ? "Your evaluation tooling problem matches the LLM harness I built." : "UNKNOWN", basis: "cover note" })),
    }),
  },
  "## What they do\nSample company for the demo.\n\n## Last 90 days\n- 2026-10-20: Launched an AI agent product.\n\n## Who leads the team\nnot found",
);
const fetcher = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({ text: "Senior QA Engineer (sample)", categories: { location: "Canada", commitment: "Full-time" }, workplaceType: "remote", descriptionPlain: "Playwright, LLM evals.", lists: [], applyUrl: `${srv.url}/apply` }),
});

await runJob("https://jobs.lever.co/samplecorp/demo", { llm, profile, resumeMarkdown: RESUME_MD, ledger, browser }, { fetcher, outRoot: join(dir, "out"), dryRun: true });
ledger.upsert({ key: "demo:skipped", company: "Acme (sample)", title: "Staff Go Engineer", url: "https://example.com", status: "skipped", score: 4, notes: "Fit 4/10" });
ledger.upsert({ key: "demo:applied", company: "Northwind (sample)", title: "Senior SDET", url: "https://example.com", status: "applied", score: 9, appliedAt: "2026-10-20T10:00:00Z", nextStep: "Follow up with recruiter", nextStepDate: "2026-10-27" });
await browser.close();
srv.server.close();

process.env.JOB_AGENT_LEDGER = join(dir, "ledger.json");
console.log("Demo data ready (sample roles only, nothing real).");
await import("../src/ui/server.js");
