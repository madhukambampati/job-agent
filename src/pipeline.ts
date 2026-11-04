import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import { writeBriefing } from "./agents/briefing.js";
import { applyEdits, tailor } from "./agents/editor.js";
import { scoreFit } from "./agents/filter.js";
import { Ledger } from "./agents/ledger.js";
import { hardRuleViolations } from "./agents/rules.js";
import { generateQuestions, questionsMarkdown } from "./agents/sparring.js";
import { fetchJob, type Fetcher } from "./jobs/fetch.js";
import type { LLM } from "./llm.js";
import { fullName, type Profile } from "./profile.js";
import { coverLetterHtml, htmlToPdf, resumeHtml } from "./render.js";
import { parseResume, resumeForPrompt } from "./resume.js";
import { submitApplication, type SubmitOutcome } from "./submit/submitter.js";
import type { Job, LedgerStatus } from "./types.js";

export interface RunOptions {
  /** Prepare everything but never open the application form. */
  noSubmit?: boolean;
  /** Fill the form and screenshot it, but don't click submit. */
  dryRun?: boolean;
  /** Re-run even if the ledger says this job was already handled. */
  force?: boolean;
  outRoot?: string;
  fetcher?: Fetcher;
  log?: (msg: string) => void;
}

export interface RunResult {
  job: Job;
  status: LedgerStatus;
  score: number | null;
  reason: string;
  outDir: string | null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const plusDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

export async function runJob(
  url: string,
  deps: { llm: LLM; profile: Profile; resumeMarkdown: string; ledger: Ledger; browser: Browser },
  opts: RunOptions = {},
): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const { llm, profile, ledger, browser } = deps;
  const resume = parseResume(deps.resumeMarkdown);
  const resumeText = resumeForPrompt(resume);

  log("fetching posting");
  const job = await fetchJob(url, opts.fetcher);
  const base = { key: job.id, company: job.company, title: job.title, url: job.url };

  if (!opts.force && ledger.alreadyApplied(job.id)) {
    return { job, status: ledger.get(job.id)!.status, score: ledger.get(job.id)!.score, reason: "Already in ledger as applied; skipping", outDir: ledger.get(job.id)!.outDir };
  }

  // ---- 1. The filter: hard rules in code, then the model --------------------
  const violations = hardRuleViolations(job, profile);
  if (violations.length) {
    ledger.upsert({ ...base, status: "skipped", score: null, notes: violations.join("; "), nextStep: "" });
    return { job, status: "skipped", score: null, reason: violations.join("; "), outDir: null };
  }

  log("filter: scoring fit");
  const fit = await scoreFit(llm, job, resumeText);
  const outDir = resolve(opts.outRoot ?? "out", `${new Date().toISOString().slice(0, 10)}-${slug(job.company)}-${slug(job.title)}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "job.json"), JSON.stringify(job, null, 2));
  writeFileSync(join(outDir, "fit.json"), JSON.stringify(fit, null, 2));

  const threshold = profile.automation.scoreThreshold;
  if (fit.score < threshold) {
    const reason = `Fit ${fit.score}/10 < ${threshold}. Gaps: ${fit.gaps.map((g) => g.requirement).join("; ")}`;
    ledger.upsert({ ...base, status: "skipped", score: fit.score, notes: reason, outDir, nextStep: "" });
    writeFileSync(join(outDir, "report.md"), report(job, fit.score, "skipped", reason, null, []));
    return { job, status: "skipped", score: fit.score, reason, outDir };
  }

  // ---- 2-4. Briefing, editor, sparring run independently -------------------
  log(`fit ${fit.score}/10: briefing + editor + sparring in parallel`);
  const gaps = fit.gaps.map((g) => `${g.requirement} (${g.severity})`);
  const [briefing, edit, questions] = await Promise.all([
    writeBriefing(llm, job).catch((e: Error) => ({ markdown: `# Briefing failed\n\n${e.message}\n`, sources: [] })),
    tailor(llm, job, resume, fit),
    generateQuestions(llm, job, resumeText, gaps),
  ]);
  writeFileSync(join(outDir, "briefing.md"), briefing.markdown);
  writeFileSync(join(outDir, "questions.md"), questionsMarkdown(job, questions));
  writeFileSync(join(outDir, "questions.json"), JSON.stringify(questions, null, 2));
  writeFileSync(join(outDir, "cover-note.md"), edit.output.coverNote + "\n");
  writeFileSync(join(outDir, "edit.json"), JSON.stringify(edit, null, 2));

  const roles = applyEdits(resume, edit.output);
  const resumePdf = join(outDir, `${slug(fullName(profile))}-resume.pdf`);
  const coverLetterPdf = join(outDir, `${slug(fullName(profile))}-cover-letter.pdf`);
  await htmlToPdf(browser, resumeHtml(resume, roles, edit.output.summary), resumePdf);
  await htmlToPdf(browser, coverLetterHtml(resume.name, resume.contact, job.company, edit.output.coverNote), coverLetterPdf);

  // ---- The part the other four can't do: apply ------------------------------
  let outcome: SubmitOutcome | null = null;
  let status: LedgerStatus = "ready";
  let reason = "Documents ready";

  const capHit = ledger.appliedToday() >= profile.automation.dailyCap;
  if (opts.noSubmit) reason = "Prepared only (--no-submit)";
  else if (!profile.automation.autoSubmit && !opts.dryRun) reason = "autoSubmit is off in profile; documents ready for you";
  else if (capHit && !opts.dryRun) reason = `Daily cap of ${profile.automation.dailyCap} reached`;
  else {
    log(opts.dryRun ? "submitter: filling form (dry run)" : "submitter: applying");
    outcome = await submitApplication(browser, llm, job, profile, { resumePdf, coverLetterPdf, coverNote: edit.output.coverNote }, {
      dryRun: !!opts.dryRun,
      screenshotPath: join(outDir, "form.png"),
      facts: resumeText,
    });
    status = outcome.status;
    reason = "evidence" in outcome ? `Confirmed: ${outcome.evidence}` : outcome.reason;
    writeFileSync(join(outDir, "answers.json"), JSON.stringify(outcome.answers, null, 2));
  }

  // ---- 5. The ledger --------------------------------------------------------
  const nextStep =
    status === "applied" ? "Follow up with recruiter / hiring manager" :
    status === "needs_manual" ? `Finish by hand: ${reason}` :
    status === "failed" ? `Retry or apply by hand: ${reason}` :
    "Review documents and apply";
  ledger.upsert({
    ...base,
    status,
    score: fit.score,
    appliedAt: status === "applied" ? new Date().toISOString() : null,
    nextStep,
    nextStepDate: status === "applied" ? plusDays(7) : plusDays(1),
    notes: [reason, edit.rejected.length ? `${edit.rejected.length} editor claim(s) rejected by honesty guard` : ""].filter(Boolean).join(" | "),
    outDir,
  });

  writeFileSync(join(outDir, "report.md"), report(job, fit.score, status, reason, outcome, edit.rejected.map((r) => `${r.where}: ${r.reason}`), edit.output.unsupportedRequirements));
  return { job, status, score: fit.score, reason, outDir };
}

function report(job: Job, score: number | null, status: string, reason: string, outcome: SubmitOutcome | null, rejected: string[], unsupported: string[] = []): string {
  return [
    `# ${job.title} at ${job.company}`,
    `- URL: ${job.url}`,
    `- Fit: ${score ?? "n/a"}/10`,
    `- Status: **${status}**: ${reason}`,
    unsupported.length ? `\n## Requirements your resume doesn't cover (be ready to address)\n${unsupported.map((u) => `- ${u}`).join("\n")}` : "",
    rejected.length ? `\n## Editor claims thrown out by the honesty guard\n${rejected.map((r) => `- ${r}`).join("\n")}` : "",
    outcome?.answers.length
      ? `\n## What went into the form\n| Field | Req | Value | Source | Filled |\n|---|---|---|---|---|\n${outcome.answers
          .map((a) => `| ${a.label.replace(/\|/g, "/")} | ${a.required ? "yes" : ""} | ${(a.value ?? "").replace(/\n/g, " ").replace(/\|/g, "/").slice(0, 80)} | ${a.source} | ${a.filled ? "yes" : "no"} |`)
          .join("\n")}`
      : "",
    "",
  ].join("\n");
}
