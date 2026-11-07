/**
 * npm run eval            deterministic suites (no API keys, no network)
 * npm run eval -- --llm   also the fit suite (needs ANTHROPIC_API_KEY, or COHERE_API_KEY with JOB_AGENT_PROVIDER=cohere)
 * npm run eval -- --ci    fail if any suite drops below its floor
 *
 * Writes evals/results.json and evals/RESULTS.md.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { guardEdits } from "../agents/editor.js";
import { scoreFit } from "../agents/filter.js";
import { launchBrowser } from "../browser.js";
import { fetchJob } from "../jobs/fetch.js";
import { ProfileSchema, type Profile } from "../profile.js";
import { createLLM } from "../providers.js";
import { CohereEmbedder, LocalEmbedder, type Embedder } from "../rag/embed.js";
import { EvidenceRetriever, extractRequirements, resumeChunks } from "../rag/evidence.js";
import { CohereReranker, type Reranker } from "../rag/rerank.js";
import { parseResume, resumeForPrompt, type Resume } from "../resume.js";
import { startEmployer } from "../sandbox/employer.js";
import { OfflineLLM } from "../sandbox/llm.js";
import { description, POSTINGS, publicUrl } from "../sandbox/postings.js";
import { submitApplication } from "../submit/submitter.js";
import type { EditorOutput } from "../types.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* fine */
}

interface SuiteResult {
  suite: string;
  setup: string;
  metrics: Record<string, number>;
  /** Minimum acceptable values for --ci. */
  floors: Record<string, number>;
  notes: string[];
}

const pct = (n: number) => Math.round(n * 1000) / 10;
const resume: Resume = parseResume(readFileSync("config/resume.example.md", "utf8"));
const profile: Profile = ProfileSchema.parse(parse(readFileSync("config/profile.example.yaml", "utf8")));

// ---- 1. honesty guard ----------------------------------------------------------
function honestySuite(): SuiteResult {
  const data = JSON.parse(readFileSync("evals/honesty.json", "utf8")) as { cases: { id: string; kind: string; where: string; text: string; keywordsUsed?: string[]; hard?: boolean; heldout?: boolean }[] };
  const outcomes = data.cases.map((c) => {
    const raw: EditorOutput = {
      roles: resume.roles.map((r) => ({ roleId: r.id, bulletOrder: r.bullets.map((b) => b.id), rewrites: c.where.startsWith(r.id + ".") ? [{ bulletId: c.where, text: c.text, keywordsUsed: c.keywordsUsed ?? [] }] : [] })),
      summary: c.where === "summary" ? c.text : resume.summary,
      coverNote: "",
      unsupportedRequirements: [],
    };
    const { rejected } = guardEdits(raw, resume);
    const r = rejected.find((x) => x.where === c.where);
    return { ...c, rejected: !!r, reason: r?.reason ?? "" };
  });
  const fab = outcomes.filter((o) => o.kind === "fabricated"), legit = outcomes.filter((o) => o.kind === "legit");
  const caught = fab.filter((o) => o.rejected), falseRejects = legit.filter((o) => o.rejected);
  const easy = fab.filter((o) => !o.hard);
  return {
    suite: "Honesty guard",
    setup: `${fab.length} fabricated + ${legit.length} legitimate edits to the example résumé`,
    metrics: {
      "fabrications caught %": pct(caught.length / fab.length),
      "term/number fabrications caught %": pct(easy.filter((o) => o.rejected).length / easy.length),
      "scope/scale inflation caught %": pct(fab.filter((o) => o.hard && o.rejected).length / fab.filter((o) => o.hard).length),
      "held-out hard cases caught %": pct(fab.filter((o) => o.heldout && o.rejected).length / fab.filter((o) => o.heldout).length),
      "legit edits wrongly rejected %": pct(falseRejects.length / legit.length),
    },
    floors: { "term/number fabrications caught %": 100, "fabrications caught %": 90, "legit edits wrongly rejected %": -0 },
    notes: [
      ...fab.filter((o) => !o.rejected).map((o) => `missed (${o.id}): "${o.text}"`),
      ...falseRejects.map((o) => `wrongly rejected (${o.id}): ${o.reason}`),
    ],
  };
}

// ---- 2. requirement extraction ------------------------------------------------
function extractionSuite(): SuiteResult {
  let tp = 0, fp = 0, fn = 0, kindRight = 0, matched = 0;
  const notes: string[] = [];
  for (const p of POSTINGS) {
    const got = extractRequirements(description(p));
    const want = [...p.must.map((t) => ({ text: t, mustHave: true })), ...p.nice.map((t) => ({ text: t, mustHave: false }))];
    for (const g of got) {
      const w = want.find((x) => x.text === g.text);
      if (w) { tp++; matched++; if (w.mustHave === g.mustHave) kindRight++; } else { fp++; notes.push(`${p.company}: extra "${g.text}"`); }
    }
    for (const w of want) if (!got.some((g) => g.text === w.text)) { fn++; notes.push(`${p.company}: missed "${w.text}"`); }
  }
  return {
    suite: "Requirement extraction",
    setup: `${POSTINGS.length} sandbox postings`,
    metrics: { "precision %": pct(tp / (tp + fp)), "recall %": pct(tp / (tp + fn)), "must/nice labelled right %": pct(kindRight / matched) },
    floors: { "precision %": 95, "recall %": 95, "must/nice labelled right %": 95 },
    notes,
  };
}

// ---- 3. retrieval ----------------------------------------------------------------
async function retrievalSuite(embedder: Embedder, reranker: Reranker | null, floors: Record<string, number>): Promise<SuiteResult> {
  const data = JSON.parse(readFileSync("evals/retrieval.json", "utf8")) as { cases: { query: string; relevant: string[]; none?: boolean; paraphrase?: boolean; heldout?: boolean }[] };
  const r = new EvidenceRetriever(resumeChunks(resume), embedder, reranker);
  let hit1 = 0, rec3 = 0, mrr = 0, para = 0, paraHit = 0, pos = 0, posSupported = 0, neg = 0, negUnsupported = 0;
  const notes: string[] = [];
  // Top score per case, kept so the "supported" threshold can be calibrated on both sides
  // (true evidence vs no evidence) instead of guessed.
  const posScores: number[] = [], negScores: number[] = [];
  let hoPos = 0, hoPosSupported = 0, hoNeg = 0, hoNegUnsupported = 0;
  for (const c of data.cases) {
    const [m] = await r.match([{ text: c.query, mustHave: true }]);
    const top = m.hits[0]?.score ?? 0;
    if (c.heldout) {
      if (c.none) { hoNeg++; if (!m.supported) hoNegUnsupported++; else notes.push(`held-out: claimed evidence for "${c.query}" (${top})`); }
      else { hoPos++; if (m.supported) hoPosSupported++; else notes.push(`held-out: below threshold for "${c.query}" (${top})`); }
      continue;
    }
    if (c.none) {
      negScores.push(top);
      neg++;
      if (!m.supported) negUnsupported++;
      else notes.push(`claimed evidence for "${c.query}": ${m.hits[0].chunkId} (${m.hits[0].score})`);
      continue;
    }
    pos++;
    if (m.supported) posSupported++;
    if (c.relevant.includes(m.hits[0]?.chunkId ?? "")) posScores.push(top);
    const ids = m.hits.map((h) => h.chunkId);
    const rank = ids.findIndex((id) => c.relevant.includes(id));
    if (rank === 0) hit1++;
    if (rank >= 0) { rec3++; mrr += 1 / (rank + 1); } else notes.push(`no relevant hit in top 3 for "${c.query}" (got ${ids.join(", ")})`);
    if (c.paraphrase) { para++; if (rank >= 0) paraHit++; }
    if (!m.supported) notes.push(`evidence found but below threshold for "${c.query}" (${m.hits[0]?.score})`);
  }
  return {
    suite: `Evidence retrieval (${r.description})`,
    setup: `${pos} requirements with evidence (${para} paraphrased) + ${neg} with none, plus ${hoPos + hoNeg} held-out, example résumé`,
    metrics: {
      "hit@1 %": pct(hit1 / pos),
      "recall@3 %": pct(rec3 / pos),
      MRR: Math.round((mrr / pos) * 1000) / 1000,
      "paraphrase recall@3 %": pct(paraHit / para),
      "supported when evidence exists %": pct(posSupported / pos),
      "'no evidence' correctly reported %": pct(negUnsupported / neg),
      "held-out: supported when evidence exists %": pct(hoPosSupported / hoPos),
      "held-out: 'no evidence' correctly reported %": pct(hoNegUnsupported / hoNeg),
    },
    floors,
    notes: [...notes, calibrationNote(posScores, negScores)],
  };
}

/** Where the threshold could sit: between the highest no-evidence score and the lowest correct #1 score. */
function calibrationNote(posScores: number[], negScores: number[]): string {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const minPos = Math.min(...posScores), maxNeg = Math.max(...negScores);
  const sorted = [...posScores].sort((a, b) => a - b).map(r);
  const verdict = minPos > maxNeg
    ? `separable: any threshold in (${r(maxNeg)}, ${r(minPos)}] keeps every no-evidence case unsupported and supports every correct #1 hit`
    : `overlap: ${posScores.filter((x) => x <= maxNeg).length} correct #1 hits score at or below the best no-evidence score`;
  return `calibration: correct #1 scores [${sorted.join(", ")}]; no-evidence max ${r(maxNeg)} (all: ${negScores.map(r).join(", ")}); ${verdict}`;
}

// ---- 4. form answers (sandbox employer, real browser) ---------------------------
async function formsSuite(): Promise<SuiteResult> {
  const dir = mkdtempSync(join(tmpdir(), "eval-forms-"));
  const employer = await startEmployer(dir);
  const browser = await launchBrowser();
  const docs = { resumePdf: join(dir, "Alex_Rivera_Resume.pdf"), coverLetterPdf: join(dir, "Alex_Rivera_Cover_Letter.pdf"), coverNote: "I build test automation teams trust." };
  writeFileSync(docs.resumePdf, "%PDF-1.4 eval");
  writeFileSync(docs.coverLetterPdf, "%PDF-1.4 eval");
  const expect: [RegExp, string | null][] = [
    [/^first name/i, profile.firstName], [/^last name/i, profile.lastName], [/^(full )?name$/i, `${profile.firstName} ${profile.lastName}`],
    [/^email/i, profile.email], [/^phone/i, profile.phone], [/linkedin/i, profile.linkedin], [/github/i, profile.github], [/^website/i, profile.website || profile.github],
    [/current company/i, profile.currentCompany], [/authorized to work in canada/i, "Yes"], [/sponsorship/i, "No"], [/how did you hear/i, "LinkedIn"],
    [/salary/i, profile.salary.expected], [/notice period/i, profile.automation.noticePeriod], [/relocat/i, "No"], [/gender/i, "Decline to self-identify"],
    [/veteran|disability/i, "I don't wish to answer"], [/security clearance/i, null], [/^resume|^cover letter$/i, "(file)"],
  ];
  let fields = 0, right = 0, abstainNeeded = 0, abstained = 0, stops = 0, stopsRight = 0;
  const notes: string[] = [];
  try {
    for (const p of POSTINGS.filter((x) => ["normal", "clearance", "captcha"].includes(x.form) && x.employment === "Full-time")) {
      const job = await fetchJob(publicUrl(p), employer.fetcher);
      const out = await submitApplication(browser, new OfflineLLM(), job, profile, docs, { dryRun: true, screenshotPath: join(dir, `${p.id}.png`), facts: resumeForPrompt(resume) });
      if (p.form === "captcha") { stops++; if (out.status === "needs_manual" && /captcha/i.test("reason" in out ? out.reason : "")) stopsRight++; else notes.push(`${p.company}: captcha not detected`); continue; }
      if (p.form === "clearance") { stops++; if (out.status === "needs_manual") stopsRight++; else notes.push(`${p.company}: unanswerable required question did not stop the run`); }
      for (const a of out.answers) {
        const rule = expect.find(([re]) => re.test(a.label));
        if (!rule) continue;
        const [, want] = rule;
        if (want === null) { abstainNeeded++; if (!a.filled) abstained++; else notes.push(`${p.company}: answered "${a.label}" with "${a.value}" instead of leaving it`); continue; }
        fields++;
        const ok = want === "(file)" ? a.filled && !!a.value : a.filled && a.value === want;
        if (ok) right++; else notes.push(`${p.company}: "${a.label}" = ${JSON.stringify(a.value)} (expected ${JSON.stringify(want)})`);
      }
    }
  } finally {
    await browser.close();
    await employer.close();
  }
  return {
    suite: "Form answers (sandbox employers, real browser)",
    setup: `Greenhouse/Lever/Ashby-style forms for ${POSTINGS.filter((x) => x.employment === "Full-time").length - 0} sandbox postings, example profile, dry run`,
    metrics: {
      "known fields answered correctly %": pct(right / fields),
      "unanswerable questions left blank %": pct(abstained / abstainNeeded),
      "runs stopped for a human when they should %": pct(stopsRight / stops),
    },
    floors: { "known fields answered correctly %": 98, "unanswerable questions left blank %": 100, "runs stopped for a human when they should %": 100 },
    notes,
  };
}

// ---- 5. fit scoring (needs a model) ------------------------------------------------
async function fitSuite(): Promise<SuiteResult> {
  const data = JSON.parse(readFileSync("evals/fit.json", "utf8")) as { cases: { board: string; band: "high" | "mid" | "low"; why: string }[] };
  const llm = createLLM();
  const employer = await startEmployer(mkdtempSync(join(tmpdir(), "eval-fit-")));
  const retriever = new EvidenceRetriever(resumeChunks(resume), new LocalEmbedder());
  const inBand = (s: number, b: string) => (b === "high" ? s >= 7 : b === "low" ? s <= 5 : s >= 5 && s <= 7);
  let ok = 0, order = 0, pairs = 0;
  const scores: { board: string; band: string; score: number }[] = [];
  const notes: string[] = [];
  try {
    for (const c of data.cases) {
      const p = POSTINGS.find((x) => x.board === c.board)!;
      const job = await fetchJob(publicUrl(p), employer.fetcher);
      const { evidenceForPrompt } = await import("../rag/evidence.js");
      const ev = evidenceForPrompt(await retriever.match(extractRequirements(job.description)));
      const f = await scoreFit(llm, job, resumeForPrompt(resume), ev);
      scores.push({ board: c.board, band: c.band, score: f.score });
      if (inBand(f.score, c.band)) ok++; else notes.push(`${p.company}: scored ${f.score}, expected ${c.band} (${c.why})`);
    }
  } finally {
    await employer.close();
  }
  const rank = { high: 2, mid: 1, low: 0 } as const;
  for (const a of scores) for (const b of scores) if (rank[a.band as keyof typeof rank] > rank[b.band as keyof typeof rank]) { pairs++; if (a.score > b.score) order++; }
  return {
    suite: `Fit scoring (${process.env.JOB_AGENT_PROVIDER === "cohere" ? "Cohere Command" : "Claude"})`,
    setup: `${data.cases.length} sandbox postings with maintainer-labelled bands, example résumé`,
    metrics: { "in expected band %": pct(ok / data.cases.length), "pairwise order correct %": pct(order / pairs) },
    floors: {},
    notes: [...notes, `scores: ${scores.map((s) => `${s.board}=${s.score}`).join(", ")}`],
  };
}

// ---- runner -------------------------------------------------------------------------
async function main() {
  const args = new Set(process.argv.slice(2));
  const results: SuiteResult[] = [honestySuite(), extractionSuite()];
  results.push(await retrievalSuite(new LocalEmbedder(), null, { "recall@3 %": 85, "'no evidence' correctly reported %": 80 }));
  if (process.env.COHERE_API_KEY) {
    try {
      results.push(await retrievalSuite(new CohereEmbedder(process.env.COHERE_API_KEY), new CohereReranker(process.env.COHERE_API_KEY), {}));
    } catch (e) {
      // A network or rate-limit error here shouldn't throw away every other suite's results.
      console.log(`· Cohere retrieval suite failed: ${(e as Error).message}`);
    }
  } else console.log("· Cohere retrieval suite skipped (no COHERE_API_KEY)");
  if (!args.has("--no-browser")) results.push(await formsSuite());
  if (args.has("--llm")) {
    try { results.push(await fitSuite()); } catch (e) { console.log(`· fit suite failed: ${(e as Error).message}`); }
  }
  else console.log("· fit suite skipped (add --llm; uses your API key)");

  const failures: string[] = [];
  for (const r of results) for (const [k, floor] of Object.entries(r.floors)) {
    const v = r.metrics[k];
    // a negative floor means "at most |floor|"
    if (floor < 0 || Object.is(floor, -0) ? v > Math.abs(floor) : v < floor) failures.push(`${r.suite}: ${k} = ${v} (floor ${Object.is(floor, -0) ? "0 max" : floor < 0 ? `${-floor} max` : floor})`);
  }

  const md = [
    `# Eval results`,
    ``,
    `Run: \`npm run eval${args.has("--llm") ? " -- --llm" : ""}\` · ${new Date().toISOString().slice(0, 10)}`,
    ``,
    ...results.flatMap((r) => [
      `## ${r.suite}`,
      `_${r.setup}_`,
      ``,
      `| Metric | Value |`,
      `|---|---|`,
      ...Object.entries(r.metrics).map(([k, v]) => `| ${k} | ${v} |`),
      ...(r.notes.length ? [``, `<details><summary>${r.notes.length} note(s)</summary>`, ``, ...r.notes.map((n) => `- ${n}`), ``, `</details>`] : []),
      ``,
    ]),
  ].join("\n");
  writeFileSync("evals/RESULTS.md", md);
  writeFileSync("evals/results.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + "\n");
  for (const r of results) {
    console.log(`\n${r.suite}  (${r.setup})`);
    for (const [k, v] of Object.entries(r.metrics)) console.log(`  ${k.padEnd(46)} ${v}`);
    for (const n of r.notes.slice(0, 8)) console.log(`    · ${n}`);
  }
  console.log(`\nwrote evals/RESULTS.md`);
  if (args.has("--ci") && failures.length) {
    console.error(`\nBelow floor:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
