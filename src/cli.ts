#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { scoreFit } from "./agents/filter.js";
import { Ledger } from "./agents/ledger.js";
import { hardRuleViolations } from "./agents/rules.js";
import { launchBrowser } from "./browser.js";
import { fetchJob } from "./jobs/fetch.js";
import { AnthropicLLM } from "./llm.js";
import { runJob, type RunOptions } from "./pipeline.js";
import { loadProfile } from "./profile.js";
import { parseResume, resumeForPrompt } from "./resume.js";
import { spar } from "./spar.js";
import { LedgerStatusSchema } from "./types.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env: rely on the real environment */
}

const program = new Command()
  .name("job-agent")
  .description("Five single-purpose job-search agents plus an auto-submitter.");

program
  .command("init")
  .description("Create config/profile.yaml, config/resume.md and .env from the examples")
  .action(() => {
    mkdirSync("config", { recursive: true });
    for (const [from, to] of [
      ["config/profile.example.yaml", "config/profile.yaml"],
      ["config/resume.example.md", "config/resume.md"],
      [".env.example", ".env"],
    ]) {
      if (existsSync(to)) console.log(`exists, left alone: ${to}`);
      else {
        copyFileSync(from, to);
        console.log(`created: ${to}`);
      }
    }
  });

async function runMany(urls: string[], opts: RunOptions) {
  const { profile, resumeMarkdown } = loadProfile();
  const llm = new AnthropicLLM();
  const ledger = new Ledger();
  const browser = await launchBrowser();
  try {
    for (const url of urls) {
      console.log(`\n▶ ${url}`);
      try {
        const r = await runJob(url, { llm, profile, resumeMarkdown, ledger, browser }, { ...opts, log: (m) => console.log(`  · ${m}`) });
        console.log(`  ${r.status.toUpperCase()}  ${r.job.company} – ${r.job.title}  fit ${r.score ?? "-"}/10\n  ${r.reason}${r.outDir ? `\n  files: ${r.outDir}` : ""}`);
      } catch (e) {
        console.error(`  ERROR ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }
}

program
  .command("run")
  .description("Filter → brief → edit → spar prep → apply → ledger, for one or more job URLs")
  .argument("<urls...>")
  .option("--no-submit", "prepare documents only; never open the application form")
  .option("--dry-run", "fill the form and screenshot it, but don't click submit")
  .option("--force", "re-run even if the ledger already has this job as applied")
  .action((urls: string[], o) => runMany(urls, { noSubmit: !o.submit, dryRun: !!o.dryRun, force: !!o.force }));

program
  .command("batch")
  .description("Same as run, reading one URL per line from a file (# comments allowed)")
  .argument("<file>")
  .option("--no-submit")
  .option("--dry-run")
  .action((file: string, o) => {
    const urls = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    return runMany(urls, { noSubmit: !o.submit, dryRun: !!o.dryRun });
  });

program
  .command("score")
  .description("Run only the filter: fit score + gaps, no files written")
  .argument("<url>")
  .action(async (url: string) => {
    const { profile, resumeMarkdown } = loadProfile();
    const job = await fetchJob(url);
    const hard = hardRuleViolations(job, profile);
    if (hard.length) console.log(`Hard-rule skip: ${hard.join("; ")}`);
    const fit = await scoreFit(new AnthropicLLM(), job, resumeForPrompt(parseResume(resumeMarkdown)));
    console.log(`${job.company} – ${job.title}: ${fit.score}/10\n${fit.summary}\n\nStrengths:\n${fit.strengths.map((s) => `  + ${s}`).join("\n")}\nGaps:\n${fit.gaps.map((g) => `  - [${g.severity}] ${g.requirement}: ${g.note}`).join("\n")}`);
  });

program
  .command("spar")
  .description("Get grilled on the likely questions for a prepared job (pass its out/ folder)")
  .argument("<dir>")
  .option("-n, --count <n>", "questions to answer before the drill", "5")
  .option("-r, --rounds <n>", "follow-up rounds on the weakest answer", "3")
  .action(async (dir: string, o) => {
    const { resumeMarkdown } = loadProfile();
    await spar(new AnthropicLLM(), dir, resumeForPrompt(parseResume(resumeMarkdown)), { count: +o.count, drillRounds: +o.rounds });
  });

const ledgerCmd = program.command("ledger").description("One row per role: applied, followed up, next step, date");

ledgerCmd.command("list").option("-s, --status <status>").action((o) => {
  const rows = new Ledger().all().filter((r) => !o.status || r.status === o.status);
  if (!rows.length) return console.log("Ledger is empty. Run `job-agent run <url>` to add roles.");
  console.table(rows.map((r, i) => ({ "#": i + 1, company: r.company, title: r.title.slice(0, 40), fit: r.score, status: r.status, applied: r.appliedAt?.slice(0, 10) ?? "", next: r.nextStep.slice(0, 40), due: r.nextStepDate ?? "" })));
});

ledgerCmd.command("due").description("Applications that need a follow-up or have a next step due").action(() => {
  const rows = new Ledger().due();
  if (!rows.length) return console.log("Nothing due.");
  for (const r of rows) console.log(`- ${r.company} – ${r.title} [${r.status}] → ${r.nextStep || "follow up"} (${r.nextStepDate ?? "overdue"})\n  ${r.url}`);
});

ledgerCmd
  .command("set")
  .description("Update a row by its list number or key")
  .argument("<row>")
  .argument("<status>", LedgerStatusSchema.options.join(" | "))
  .option("--next <text>", "next step")
  .option("--date <yyyy-mm-dd>", "next step date")
  .action((row: string, status: string, o) => {
    const ledger = new Ledger();
    const key = /^\d+$/.test(row) ? ledger.all()[+row - 1]?.key : row;
    if (!key) throw new Error(`No row ${row}`);
    const r = ledger.setStatus(key, LedgerStatusSchema.parse(status), o.next, o.date);
    console.log(`${r.company} – ${r.title}: ${r.status}${r.nextStep ? ` → ${r.nextStep}` : ""}`);
  });

ledgerCmd.command("csv").argument("[file]", "output path", "data/ledger.csv").action((file: string) => {
  writeFileSync(file, new Ledger().exportCsv());
  console.log(`wrote ${file}`);
});

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
