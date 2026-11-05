import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardEdits, honestyProblem, techTokens } from "../src/agents/editor.js";
import { Ledger } from "../src/agents/ledger.js";
import { hardRuleViolations, maxPostedSalary } from "../src/agents/rules.js";
import { fetchJob, parseJobUrl } from "../src/jobs/fetch.js";
import { parseResume } from "../src/resume.js";
import { deterministicAnswer, type Documents, type FormField } from "../src/submit/answers.js";
import type { Job } from "../src/types.js";
import { profile, RESUME_MD } from "./helpers.js";

const job = (over: Partial<Job> = {}): Job => ({
  id: "greenhouse:co:1", ats: "greenhouse", company: "Co", title: "Senior SDET", location: "Remote - Canada",
  description: "We test things.", url: "u", applyUrl: "u", questions: [], ...over,
});

describe("parseJobUrl", () => {
  it("recognises the three ATSs", () => {
    expect(parseJobUrl("https://job-boards.greenhouse.io/acme/jobs/123")).toMatchObject({ ats: "greenhouse", board: "acme", jobId: "123" });
    expect(parseJobUrl("https://boards.greenhouse.io/acme/jobs/9?gh_src=x")).toMatchObject({ ats: "greenhouse", jobId: "9" });
    expect(parseJobUrl("https://jobs.lever.co/acme/abc-def")).toMatchObject({ ats: "lever", board: "acme", jobId: "abc-def" });
    expect(parseJobUrl("https://jobs.ashbyhq.com/acme/uuid-1/application")).toMatchObject({ ats: "ashby", jobId: "uuid-1" });
    expect(parseJobUrl("https://careers.example.com/x").ats).toBe("unknown");
  });
});

describe("fetchJob", () => {
  it("maps a Greenhouse posting with questions and pay", async () => {
    const fetcher = async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => ({
        title: "SDET", company_name: "Acme", location: { name: "Remote" }, content: "&lt;p&gt;Build &amp;amp; test&lt;/p&gt;",
        pay_input_ranges: [{ currency_type: "CAD", min_cents: 12000000, max_cents: 15000000 }],
        questions: [{ label: "First Name", required: true, fields: [{ type: "input_text" }] }],
      }),
    });
    const j = await fetchJob("https://job-boards.greenhouse.io/acme/jobs/1", fetcher);
    expect(j.company).toBe("Acme");
    expect(j.description).toBe("Build & test");
    expect(j.compensation).toBe("CAD 120000-150000");
    expect(j.questions[0]).toMatchObject({ label: "First Name", required: true });
    expect(j.applyUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/1");
  });
});

describe("hard rules", () => {
  it("skips contract, on-site, and underpaid roles", () => {
    expect(hardRuleViolations(job({ title: "QA Engineer (Contract)" }), profile)[0]).toMatch(/contract/);
    expect(hardRuleViolations(job({ location: "San Francisco, CA" }), profile)[0]).toMatch(/Not remote/);
    expect(hardRuleViolations(job({ compensation: "CAD 60,000 - 75,000" }), profile)[0]).toMatch(/below/);
    expect(hardRuleViolations(job(), profile)).toEqual([]);
    // A card you chose yourself: your remote-only preference no longer blocks it, contract still does.
    expect(hardRuleViolations(job({ location: "Toronto, ON | Hybrid" }), profile, { ignoreLocation: true })).toEqual([]);
    expect(hardRuleViolations(job({ title: "SDET (Contract)", location: "Toronto" }), profile, { ignoreLocation: true })[0]).toMatch(/contract/);
  });
  it("reads salary strings", () => {
    expect(maxPostedSalary("$120k - $150k")).toBe(150000);
    expect(maxPostedSalary("$40 - $60 per hour")).toBeNull();
  });
});

describe("editor honesty guard", () => {
  const resume = parseResume(RESUME_MD);

  it("parses bullets with stable ids", () => {
    expect(resume.roles.map((r) => r.bullets.length)).toEqual([3, 1]);
    expect(resume.roles[0].bullets[1].id).toBe("r1.b2");
  });

  it("rejects invented tools, numbers and keywords, keeps every bullet", () => {
    const { output, rejected } = guardEdits(
      {
        roles: [{
          roleId: "r1",
          bulletOrder: ["r1.b2", "r1.b2", "r9.b1"],
          rewrites: [
            { bulletId: "r1.b1", text: "Built a Playwright framework in TypeScript covering 400 tests.", keywordsUsed: ["Playwright"] },
            { bulletId: "r1.b3", text: "Wired tests into GitHub Actions and Kubernetes.", keywordsUsed: [] },
            { bulletId: "r1.b2", text: "Built an LLM evaluation harness improving accuracy 45%.", keywordsUsed: [] },
            { bulletId: "r1.b2", text: "Built an LLM harness with C# tooling.", keywordsUsed: ["C#"] },
          ],
        }],
        summary: "Senior SDET with 12 years of AWS experience.",
        coverNote: "Hi",
        unsupportedRequirements: ["C#"],
      },
      resume,
    );
    expect(output.roles[0].bulletOrder).toEqual(["r1.b2", "r1.b1", "r1.b3"]);
    expect(output.roles[1].bulletOrder).toEqual(["r2.b1"]);
    expect(output.roles[0].rewrites.map((r) => r.bulletId)).toEqual(["r1.b1"]);
    expect(rejected.map((r) => r.reason).join(" | ")).toMatch(/Kubernetes.*45%.*C#.*12/s);
    expect(output.summary).toBe(resume.summary);
  });

  it("detects tech-looking tokens", () => {
    expect(techTokens("Used Node.js, C#, AWS and k8s with TypeScript in 2024")).toEqual(expect.arrayContaining(["Node.js", "C#", "AWS", "k8s", "TypeScript"]));
    expect(honestyProblem("Built a Playwright framework", "", resume.corpus, [])).toBeNull();
  });
});

describe("ledger", () => {
  it("tracks status, dedupes, and surfaces follow-ups", () => {
    const l = new Ledger(join(mkdtempSync(join(tmpdir(), "ledger-")), "l.json"));
    l.upsert({ key: "a", company: "A", title: "SDET", url: "u", status: "applied", appliedAt: "2026-10-01T10:00:00Z" });
    l.upsert({ key: "b", company: "B", title: "QA", url: "u", status: "skipped" });
    expect(l.alreadyApplied("a")).toBe(true);
    expect(l.alreadyApplied("b")).toBe(false);
    expect(l.due(new Date("2026-10-20")).map((r) => r.key)).toEqual(["a"]);
    l.setStatus("a", "followed_up", "Wait for reply", "2026-10-27");
    expect(l.get("a")!.followedUpAt).not.toBeNull();
    expect(l.exportCsv().split("\n")[0]).toContain("company,title,score,status");
  });
});

describe("deterministic answers", () => {
  const docs: Documents = { resumePdf: "/tmp/r.pdf", coverLetterPdf: "/tmp/c.pdf", coverNote: "note" };
  const f = (label: string, kind: FormField["kind"] = "text", options: string[] = [], required = true): FormField => ({ id: "x", label, kind, required, options });

  it("maps common fields", () => {
    expect(deterministicAnswer(f("First Name"), profile, docs)?.value).toBe("Alex");
    expect(deterministicAnswer(f("Resume/CV", "file"), profile, docs)?.value).toBe("/tmp/r.pdf");
    expect(deterministicAnswer(f("Cover Letter", "textarea"), profile, docs)?.value).toBe("note");
    expect(deterministicAnswer(f("Will you require visa sponsorship?", "select", ["Yes", "No"]), profile, docs)?.value).toBe("No");
    expect(deterministicAnswer(f("Are you authorized to work in Canada?", "radio", ["Yes", "No"]), profile, docs)?.value).toBe("Yes");
    expect(deterministicAnswer(f("Are you authorized to work in the United States?", "radio", ["Yes", "No"]), profile, docs)?.value).toBe("No");
    expect(deterministicAnswer(f("How did you hear about us?"), profile, docs)).toMatchObject({ value: "LinkedIn", source: "answer-bank" });
  });

  it("declines demographic questions and never guesses unknowns", () => {
    expect(deterministicAnswer(f("Gender", "select", ["Male", "Female", "Decline to self-identify"], false), profile, docs)?.value).toBe("Decline to self-identify");
    expect(deterministicAnswer(f("Do you hold a security clearance?"), profile, docs)).toBeNull();
  });
});

describe("structured-output schema conversion", async () => {
  const { toApiSchema, normalizeEnums } = await import("../src/llm.js");
  const T = await import("../src/types.js");
  const bad = ["minimum", "maximum", "minLength", "maxLength", "maxItems", "exclusiveMinimum", "exclusiveMaximum", "pattern"];
  const check = (n: any, path = "$"): string[] => {
    if (!n || typeof n !== "object") return [];
    const errs: string[] = [];
    for (const k of bad) if (k in n) errs.push(`${path}.${k}`);
    if (n.type === "object" && n.additionalProperties !== false) errs.push(`${path} additionalProperties`);
    if ("minItems" in n && n.minItems > 1) errs.push(`${path}.minItems`);
    for (const [k, v] of Object.entries(n)) errs.push(...check(v, `${path}.${k}`));
    return errs;
  };
  it.each(["FitScoreSchema", "EditorOutputSchema", "InterviewQuestionsSchema", "AnswerGradeSchema"])("%s only uses supported keywords", (name) => {
    expect(check(toApiSchema((T as any)[name]))).toEqual([]);
  });
  it("maps enum casing back", () => {
    expect(normalizeEnums({ severity: "Major" }, { properties: { severity: { enum: ["major", "minor"] } } })).toEqual({ severity: "major" });
  });
});

describe("answer rules don't misfire on long questions (found by the sandbox)", async () => {
  const { deterministicAnswer } = await import("../src/submit/answers.js");
  const docs = { resumePdf: "/r.pdf", coverLetterPdf: "/c.pdf", coverNote: "note" };
  const f = (label: string, kind: any = "text", options: string[] = []) => ({ id: "x", label, kind, required: true, options });
  it("a clearance question containing 'state' is not answered with the province", () => {
    expect(deterministicAnswer(f("Do you currently hold an active Canadian government security clearance? Please state the level."), profile, docs)).toBeNull();
  });
  it("short field names still work", () => {
    expect(deterministicAnswer(f("State/Province"), profile, docs)?.value).toBe("Ontario");
    expect(deterministicAnswer(f("City"), profile, docs)?.value).toBe("Toronto");
  });
  it("'status' doesn't count as 'US' in work-authorization questions", () => {
    expect(deterministicAnswer(f("Are you legally authorized to work in Canada? (citizenship status)", "select", ["Yes", "No"]), profile, docs)?.value).toBe("Yes");
  });
  it("long upload labels still get the resume", () => {
    expect(deterministicAnswer(f("Please upload your most recent resume or CV (PDF preferred, max 5MB)", "file"), profile, docs)?.value).toBe("/r.pdf");
  });
});

describe("honesty guard uses whole words (found by the sandbox)", async () => {
  const { honestyProblem, hasWord } = await import("../src/agents/editor.js");
  const corpus = "built an llm evaluation harness with a golden dataset in javascript, cut runs from 6 to 3 hours.";
  it("'Go' is not hidden inside 'golden', 'Java' not inside 'JavaScript'", () => {
    expect(hasWord(corpus, "Go")).toBe(false);
    expect(hasWord(corpus, "Java")).toBe(false);
    expect(hasWord(corpus, "JavaScript")).toBe(true);
    expect(honestyProblem("Built the harness in Go.", "", corpus, [])).toMatch(/Go/);
    expect(honestyProblem("Built it.", "", corpus, ["Java"])).toMatch(/Java/);
  });
  it("numbers must match whole: 60 is not inside 6", () => {
    expect(honestyProblem("Cut runs from 60 to 3 hours.", "", corpus, [])).toMatch(/60/);
    expect(honestyProblem("Cut runs from 6 to 3 hours.", "", corpus, [])).toBeNull();
  });
  it("ordinary two-letter words are not treated as tools", () => {
    expect(honestyProblem("Built a harness. In practice it cut runs from 6 to 3 hours.", "", corpus, [])).toBeNull();
  });
});
