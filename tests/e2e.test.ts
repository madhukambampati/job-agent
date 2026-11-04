import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ledger } from "../src/agents/ledger.js";
import { launchBrowser } from "../src/browser.js";
import { runJob } from "../src/pipeline.js";
import { submitApplication } from "../src/submit/submitter.js";
import type { Job } from "../src/types.js";
import { FakeLLM, FORM_CAPTCHA, FORM_HAPPY, FORM_UNANSWERABLE, profile, RESUME_MD, startFormServer } from "./helpers.js";

/** Answers "why" questions, refuses everything else, like the real answerer prompt demands. */
const fillFields = (prompt: string) => ({
  answers: [...prompt.matchAll(/id=(f\d+).*?label="([^"]*)"/g)].map(([, id, label]) => ({
    fieldId: id,
    value: /why do you want/i.test(label) ? "Your eval tooling problem matches the LLM harness I built." : "UNKNOWN",
    basis: "cover note",
  })),
});

const fake = (score: number) =>
  new FakeLLM({
    record_fit: { score, summary: "Good fit", strengths: ["Playwright"], gaps: [{ requirement: "Go", severity: "minor", note: "not on resume" }] },
    record_edit: {
      roles: [{ roleId: "r1", bulletOrder: ["r1.b2", "r1.b1", "r1.b3"], rewrites: [{ bulletId: "r1.b3", text: "Wired tests into GitHub Actions and Jenkins.", keywordsUsed: ["Jenkins"] }] }],
      summary: "Senior SDET with 8 years of test automation, now testing LLM features.",
      coverNote: "I built an LLM evaluation harness with a golden dataset, which maps to your eval work.",
      unsupportedRequirements: ["Go"],
    },
    record_questions: { questions: Array.from({ length: 10 }, (_, i) => ({ question: `Q${i}?`, category: "technical", whyTheyAsk: "x" })) },
    fill_fields: fillFields,
  });

const job = (applyUrl: string): Job => ({
  id: `lever:testco:${applyUrl}`, ats: "lever", company: "TestCo", title: "Senior SDET", location: "Remote",
  description: "Playwright, LLM evals.", url: applyUrl, applyUrl, questions: [],
});

const docsDir = mkdtempSync(join(tmpdir(), "docs-"));
const docs = { resumePdf: join(docsDir, "r.pdf"), coverLetterPdf: join(docsDir, "c.pdf"), coverNote: "note" };

describe("submitter against local application forms", () => {
  let browser: Browser;
  let srv: Awaited<ReturnType<typeof startFormServer>>;

  beforeAll(async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(docs.resumePdf, "%PDF-1.4 fake");
    writeFileSync(docs.coverLetterPdf, "%PDF-1.4 fake");
    browser = await launchBrowser();
    srv = await startFormServer({ "/happy": FORM_HAPPY, "/unanswerable": FORM_UNANSWERABLE, "/captcha": FORM_CAPTCHA });
  });
  afterAll(async () => {
    await browser?.close();
    srv?.server.close();
  });

  const opts = () => ({ dryRun: false, screenshotPath: join(mkdtempSync(join(tmpdir(), "shot-")), "form.png"), facts: "" });

  it("fills every field and submits when all required fields are answerable", async () => {
    const out = await submitApplication(browser, fake(8), job(`${srv.url}/happy`), profile, docs, opts());
    expect(out.status).toBe("applied");
    const body = srv.submissions.at(-1)!;
    for (const v of ["Alex", "Rivera", "alex@example.com", "LinkedIn", "Decline to self-identify", "golden", "r.pdf"]) {
      expect(body).toContain(v === "golden" ? "LLM harness" : v);
    }
    expect(body).toMatch(/name="spons"\r\n\r\nNo/);
    expect(body).toMatch(/name="auth"\r\n\r\ny/);
  });

  it("refuses to submit when a required question can't be answered from real facts", async () => {
    const before = srv.submissions.length;
    const out = await submitApplication(browser, fake(8), job(`${srv.url}/unanswerable`), profile, docs, opts());
    expect(out.status).toBe("needs_manual");
    expect(out.status === "needs_manual" && out.reason).toMatch(/security clearance/);
    expect(srv.submissions.length).toBe(before);
  });

  it("stops at a captcha instead of trying to bypass it", async () => {
    const before = srv.submissions.length;
    const out = await submitApplication(browser, fake(8), job(`${srv.url}/captcha`), profile, docs, opts());
    expect(out.status).toBe("needs_manual");
    expect(srv.submissions.length).toBe(before);
  });

  it("dry run fills but never clicks submit", async () => {
    const before = srv.submissions.length;
    const o = opts();
    const out = await submitApplication(browser, fake(8), job(`${srv.url}/happy`), profile, docs, { ...o, dryRun: true });
    expect(out.status).toBe("ready");
    expect(existsSync(o.screenshotPath)).toBe(true);
    expect(srv.submissions.length).toBe(before);
  });

  it("full pipeline: filter → brief → edit → spar → apply → ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-"));
    const ledger = new Ledger(join(dir, "ledger.json"));
    const leverPosting = { text: "Senior SDET", categories: { location: "Remote", commitment: "Full-time" }, descriptionPlain: "Playwright and LLM evals.", lists: [], hostedUrl: `${srv.url}/happy`, applyUrl: `${srv.url}/happy` };
    const fetcher = async () => ({ ok: true, status: 200, json: async () => leverPosting, text: async () => "" });
    const llm = fake(8);
    const deps = { llm, profile, resumeMarkdown: RESUME_MD, ledger, browser };

    const r = await runJob("https://jobs.lever.co/testco/abc", deps, { fetcher, outRoot: dir });
    expect(r.status).toBe("applied");
    expect(ledger.get("lever:testco:abc")).toMatchObject({ status: "applied", score: 8, nextStep: expect.stringMatching(/Follow up/) });
    for (const f of ["briefing.md", "questions.md", "cover-note.md", "report.md", "form.png", "alex-rivera-resume.pdf"]) {
      expect(existsSync(join(r.outDir!, f))).toBe(true);
    }
    // Editor's "Jenkins" rewrite is not in the resume, so the guard must drop it.
    expect(readFileSync(join(r.outDir!, "report.md"), "utf8")).toMatch(/honesty guard[\s\S]*Jenkins/);
    // The filter, editor and sparring partner are separate calls with separate prompts.
    expect(llm.calls.map((c) => c.tool)).toEqual(expect.arrayContaining(["record_fit", "research", "record_edit", "record_questions"]));

    // Second run: ledger dedupes, nothing is submitted twice.
    const n = srv.submissions.length;
    const again = await runJob("https://jobs.lever.co/testco/abc", deps, { fetcher, outRoot: dir });
    expect(again.reason).toMatch(/Already/);
    expect(srv.submissions.length).toBe(n);
  });

  it("skips low-fit roles without generating documents or applying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "run-"));
    const ledger = new Ledger(join(dir, "ledger.json"));
    const fetcher = async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ text: "Staff Go Engineer", categories: { location: "Remote" }, descriptionPlain: "Go", lists: [], applyUrl: `${srv.url}/happy` }) });
    const llm = fake(5);
    const r = await runJob("https://jobs.lever.co/testco/low", { llm, profile, resumeMarkdown: RESUME_MD, ledger, browser }, { fetcher, outRoot: dir });
    expect(r.status).toBe("skipped");
    expect(llm.calls.map((c) => c.tool)).toEqual(["record_fit"]);
  });
});
