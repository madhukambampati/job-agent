import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import { writeBriefing } from "./agents/briefing.js";
import { applyEdits, tailor } from "./agents/editor.js";
import { scoreFit } from "./agents/filter.js";
import { Ledger } from "./agents/ledger.js";
import { hardRuleViolations } from "./agents/rules.js";
import { generateQuestions, questionsMarkdown } from "./agents/sparring.js";
import { BrowserSetupError } from "./browser.js";
import { evidenceForPrompt, extractRequirements, type EvidenceMatch, type EvidenceRetriever } from "./rag/index.js";
import { addDays, localDay } from "./dates.js";
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
  /** Called once the posting is known (company/title for live progress). */
  onJob?: (job: Job) => void;
  /** Re-run even if the ledger says this job was already handled. */
  force?: boolean;
  /**
   * The user picked this exact job and clicked Apply. Their location/work-mode
   * preference and the fit threshold stop being blockers (fit is still scored
   * and recorded). Safety stops (captcha, unanswerable required questions,
   * Ashby, duplicates, daily cap) still apply.
   */
  userConfirmed?: boolean;
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
const plusDays = (d: number) => addDays(d);

export async function runJob(
  url: string,
  /** `browser` may be a launcher: it's only started when PDFs or the form need it. */
  deps: { llm: LLM; profile: Profile; resumeMarkdown: string; ledger: Ledger; browser: Browser | (() => Promise<Browser>); retriever?: EvidenceRetriever | null },
  opts: RunOptions = {},
): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const { llm, profile, ledger } = deps;
  let launched: Promise<Browser> | null = null;
  const getBrowser = () => (launched ??= typeof deps.browser === "function" ? deps.browser() : Promise.resolve(deps.browser));
  const resume = parseResume(deps.resumeMarkdown);
  const resumeText = resumeForPrompt(resume);

  log("Reading the posting");
  const job = await fetchJob(url, opts.fetcher);
  opts.onJob?.(job);
  const base = { key: job.id, company: job.company, title: job.title, url: job.url };
  let fitScore: number | null = null;
  let outDirSoFar: string | null = null;

  // From here on the role is known, so any failure is recorded in the ledger instead of vanishing.
  try {

  if (!opts.force && ledger.alreadyApplied(job.id)) {
    return { job, status: ledger.get(job.id)!.status, score: ledger.get(job.id)!.score, reason: "Already in ledger as applied; skipping", outDir: ledger.get(job.id)!.outDir };
  }

  // ---- 1. The filter: hard rules in code, then the model --------------------
  const violations = hardRuleViolations(job, profile, { ignoreLocation: opts.userConfirmed });
  if (violations.length) {
    ledger.upsert({ ...base, status: "skipped", score: null, notes: violations.join("; "), nextStep: "" });
    return { job, status: "skipped", score: null, reason: violations.join("; "), outDir: null };
  }

  // ---- Evidence (RAG): which of your own bullets support each requirement ---------
  let matches: EvidenceMatch[] | null = null;
  if (deps.retriever) {
    log("Finding evidence for each requirement");
    try {
      matches = await deps.retriever.match(extractRequirements(job.description));
    } catch (e) {
      log(`Evidence search unavailable (${(e as Error).message.split("\n")[0]}); continuing without it`);
    }
  }
  const evidence = matches ? evidenceForPrompt(matches) : "";

  log("Scoring fit against your resume");
  const fit = await scoreFit(llm, job, resumeText, evidence);
  fitScore = fit.score;
  const outDir = resolve(opts.outRoot ?? "out", `${localDay()}-${slug(job.company)}-${slug(job.title)}`);
  mkdirSync(outDir, { recursive: true });
  outDirSoFar = outDir;
  writeFileSync(join(outDir, "job.json"), JSON.stringify(job, null, 2));
  writeFileSync(join(outDir, "fit.json"), JSON.stringify(fit, null, 2));
  if (matches) writeFileSync(join(outDir, "evidence.json"), JSON.stringify({ retriever: deps.retriever!.description, matches }, null, 2));

  const threshold = profile.automation.scoreThreshold;
  if (fit.score < threshold && !opts.userConfirmed) {
    const reason = `Fit ${fit.score}/10 < ${threshold}. Gaps: ${fit.gaps.map((g) => g.requirement).join("; ")}`;
    ledger.upsert({ ...base, status: "skipped", score: fit.score, notes: reason, outDir, nextStep: "" });
    writeFileSync(join(outDir, "report.md"), report(job, fit.score, "skipped", reason, null, []));
    return { job, status: "skipped", score: fit.score, reason, outDir };
  }

  // ---- 2-4. Briefing, editor, sparring run independently -------------------
  log(`Fit ${fit.score}/10. Tailoring résumé, writing cover note, briefing and interview questions`);
  const gaps = fit.gaps.map((g) => `${g.requirement} (${g.severity})`);
  const [briefing, edit, questions] = await Promise.all([
    writeBriefing(llm, job).catch((e: Error) => ({ markdown: `# Briefing failed\n\n${e.message}\n`, sources: [] })),
    tailor(llm, job, resume, fit, evidence),
    generateQuestions(llm, job, resumeText, gaps),
  ]);
  writeFileSync(join(outDir, "briefing.md"), briefing.markdown);
  writeFileSync(join(outDir, "questions.md"), questionsMarkdown(job, questions));
  writeFileSync(join(outDir, "questions.json"), JSON.stringify(questions, null, 2));
  writeFileSync(join(outDir, "cover-note.md"), edit.output.coverNote + "\n");
  writeFileSync(join(outDir, "edit.json"), JSON.stringify(edit, null, 2));

  log("Rendering tailored résumé and cover letter PDFs");
  const roles = applyEdits(resume, edit.output);
  // Recruiters see the uploaded file name, so it reads like a person sent it.
  const fileStem = fullName(profile).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const resumePdf = join(outDir, `${fileStem}_Resume.pdf`);
  const coverLetterPdf = join(outDir, `${fileStem}_Cover_Letter.pdf`);
  const browser = await getBrowser();
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
    log(opts.dryRun ? "Opening the application form (dry run)" : "Opening the application form");
    outcome = await submitApplication(browser, llm, job, profile, { resumePdf, coverLetterPdf, coverNote: edit.output.coverNote }, {
      dryRun: !!opts.dryRun,
      screenshotPath: join(outDir, "form.png"),
      facts: resumeText,
      log,
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
    // Applied: follow up in a week. Anything else needs you now, so it is due today.
    nextStepDate: status === "applied" ? plusDays(7) : plusDays(0),
    notes: [reason, edit.rejected.length ? `${edit.rejected.length} editor claim(s) rejected by honesty guard` : ""].filter(Boolean).join(" | "),
    outDir,
  });

  writeFileSync(join(outDir, "report.md"), report(job, fit.score, status, reason, outcome, edit.rejected.map((r) => `${r.where}: ${r.reason}`), edit.output.unsupportedRequirements, matches));
  return { job, status, score: fit.score, reason, outDir };
  } catch (e) {
    const reason = e instanceof BrowserSetupError ? e.message : `Something went wrong: ${(e as Error).message.split("\n")[0]}`;
    ledger.upsert({ ...base, status: "failed", score: fitScore, nextStep: "Retry, or apply by hand", nextStepDate: plusDays(0), notes: reason, outDir: outDirSoFar });
    return { job, status: "failed", score: fitScore, reason, outDir: outDirSoFar };
  } finally {
    // Only close a browser this run started; a Browser passed in belongs to the caller.
    const started = launched as Promise<Browser> | null;
    if (started && typeof deps.browser === "function") await started.then((b) => b.close()).catch(() => {});
  }
}

function report(job: Job, score: number | null, status: string, reason: string, outcome: SubmitOutcome | null, rejected: string[], unsupported: string[] = [], matches: EvidenceMatch[] | null = null): string {
  return [
    `# ${job.title} at ${job.company}`,
    `- URL: ${job.url}`,
    `- Fit: ${score ?? "n/a"}/10`,
    `- Status: **${status}**: ${reason}`,
    unsupported.length ? `\n## Requirements your resume doesn't cover (be ready to address)\n${unsupported.map((u) => `- ${u}`).join("\n")}` : "",
    matches?.length
      ? `\n## Evidence map\n| Requirement | Must | Best evidence | Score |\n|---|---|---|---|\n${matches
          .map((m) => `| ${m.requirement.replace(/\|/g, "/")} | ${m.mustHave ? "yes" : ""} | ${m.supported ? `${m.hits[0].chunkId}: ${m.hits[0].text.replace(/\|/g, "/").slice(0, 90)}` : "**no evidence**"} | ${m.hits[0]?.score ?? ""} |`)
          .join("\n")}`
      : "",
    rejected.length ? `\n## Editor claims thrown out by the honesty guard\n${rejected.map((r) => `- ${r}`).join("\n")}` : "",
    outcome?.answers.length
      ? `\n## What went into the form\n| Field | Req | Value | Source | Filled |\n|---|---|---|---|---|\n${outcome.answers
          .map((a) => `| ${a.label.replace(/\|/g, "/")} | ${a.required ? "yes" : ""} | ${(a.value ?? "").replace(/\n/g, " ").replace(/\|/g, "/").slice(0, 80)} | ${a.source} | ${a.filled ? "yes" : "no"} |`)
          .join("\n")}`
      : "",
    "",
  ].join("\n");
}
