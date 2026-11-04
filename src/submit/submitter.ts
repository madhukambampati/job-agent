import type { Browser, Page } from "playwright";
import type { LLM } from "../llm.js";
import type { Profile } from "../profile.js";
import type { Job } from "../types.js";
import { deterministicAnswer, modelAnswers, type Answer, type Documents, type FormField } from "./answers.js";
import { fillField, hasBlockingCaptcha, scanForm, submitAndConfirm } from "./form.js";

export interface SubmitOptions {
  /** Fill everything and screenshot, but don't click submit. */
  dryRun: boolean;
  screenshotPath: string;
  /** Extra facts the answerer may use (resume text, cover note). */
  facts: string;
}

export type SubmitOutcome =
  | { status: "applied"; evidence: string; answers: AnswerLog[] }
  | { status: "ready"; reason: string; answers: AnswerLog[] }
  | { status: "needs_manual"; reason: string; answers: AnswerLog[] }
  | { status: "failed"; reason: string; answers: AnswerLog[] };

export interface AnswerLog {
  label: string;
  required: boolean;
  value: string | null;
  source: Answer["source"];
  filled: boolean;
}

/**
 * Opens the employer's hosted application form, fills it from the profile,
 * the tailored documents and (only for leftovers) a constrained model call,
 * then submits. Any required field we can't answer from real facts stops the
 * submission and leaves it for a human, rather than guessing.
 */
export async function submitApplication(
  browser: Browser,
  llm: LLM,
  job: Job,
  profile: Profile,
  docs: Documents,
  opts: SubmitOptions,
): Promise<SubmitOutcome> {
  if (job.ats === "unknown") {
    return { status: "needs_manual", reason: "Not a Greenhouse/Lever/Ashby posting; apply by hand", answers: [] };
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 1800 } });
  const page = await context.newPage();
  const log: AnswerLog[] = [];
  try {
    await page.goto(job.applyUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await openFormIfNeeded(page);
    await page.waitForTimeout(1500);

    if (await hasBlockingCaptcha(page)) {
      await page.screenshot({ path: opts.screenshotPath, fullPage: true });
      return { status: "needs_manual", reason: "Captcha on the form; not attempting to bypass it", answers: log };
    }

    const fields = await scanForm(page);
    if (fields.length < 3) {
      await page.screenshot({ path: opts.screenshotPath, fullPage: true });
      return { status: "failed", reason: `Only found ${fields.length} form fields; page layout not recognised`, answers: log };
    }

    const answers = await answerAll(llm, fields, profile, docs, opts.facts);
    const missingRequired: string[] = [];

    for (const f of fields) {
      const a = answers.get(f.id)!;
      let filled = false;
      if (a.value !== null) {
        try {
          filled = await fillField(page, f, a.value);
        } catch {
          filled = false;
        }
      }
      log.push({ label: f.label, required: f.required, value: f.kind === "file" ? a.value?.split("/").pop() ?? null : a.value, source: a.source, filled });
      if (f.required && !filled) missingRequired.push(f.label || f.id);
    }

    await page.screenshot({ path: opts.screenshotPath, fullPage: true });

    if (missingRequired.length) {
      return { status: "needs_manual", reason: `Required fields not answerable from your facts: ${missingRequired.join("; ")}`, answers: log };
    }
    if (opts.dryRun) return { status: "ready", reason: "Dry run: form filled, not submitted", answers: log };
    if (job.ats === "ashby") {
      // Ashby's bot detection flagged an automated submission as spam in an earlier POC run.
      // Filling is fine; the final click stays human so the application isn't silently binned.
      return { status: "needs_manual", reason: "Ashby flags automated submits as spam: form is filled, open the link and click Submit yourself", answers: log };
    }

    const { confirmed, evidence } = await submitAndConfirm(page);
    await page.screenshot({ path: opts.screenshotPath.replace(/\.png$/, "-after.png"), fullPage: true });
    return confirmed
      ? { status: "applied", evidence, answers: log }
      : { status: "failed", reason: `Submitted but no confirmation seen: ${evidence}`, answers: log };
  } catch (err) {
    await page.screenshot({ path: opts.screenshotPath, fullPage: true }).catch(() => {});
    return { status: "failed", reason: (err as Error).message, answers: log };
  } finally {
    await context.close();
  }
}

async function openFormIfNeeded(page: Page): Promise<void> {
  const hasForm = await page.locator("input[type=file], input[type=email]").count();
  if (hasForm) return;
  const apply = page.getByRole("link", { name: /apply( for this job| now)?/i }).or(page.getByRole("button", { name: /apply/i })).first();
  if (await apply.count()) {
    await apply.click();
    await page.waitForLoadState("domcontentloaded");
  }
}

async function answerAll(llm: LLM, fields: FormField[], p: Profile, docs: Documents, facts: string): Promise<Map<string, Answer>> {
  const out = new Map<string, Answer>();
  const leftovers: FormField[] = [];
  for (const f of fields) {
    const a = deterministicAnswer(f, p, docs);
    if (a) out.set(f.id, a);
    else if (f.kind === "file") out.set(f.id, { fieldId: f.id, value: null, source: "unknown" });
    else leftovers.push(f);
  }
  const profileFacts = [
    `Name: ${p.firstName} ${p.lastName}; email ${p.email}; phone ${p.phone}`,
    `Location: ${p.city}, ${p.region}, ${p.country}`,
    `Work authorization: ${p.workAuthorization.authorizedCountries.join(", ")}; needs sponsorship: ${p.workAuthorization.requiresSponsorship}`,
    `Expected salary: ${p.salary.expected}; notice: ${p.automation.noticePeriod}; relocate: ${p.automation.willingToRelocate}`,
    `Years of experience: ${p.yearsOfExperience}; current: ${p.currentTitle} at ${p.currentCompany}`,
    ...Object.entries(p.answers).map(([k, v]) => `Q: ${k} -> A: ${v}`),
    `Cover note: ${docs.coverNote}`,
    facts,
  ].join("\n");
  for (const a of await modelAnswers(llm, leftovers, profileFacts)) out.set(a.fieldId, a);
  return out;
}
