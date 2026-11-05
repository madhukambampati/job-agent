# job-agent

Five small AI agents for a tech job search, each with one job and one way of thinking, plus the part they can't do alone: **actually applying**.

```
job URL ─► 1. FILTER ──(score < 7)──► skip, logged
               │ ≥ 7
               ├─► 2. BRIEFING WRITER   one-page company brief (last 90 days, team leads, eng signals)
               ├─► 3. EDITOR            re-ranked bullets + cover note, behind an honesty guard
               └─► 4. SPARRING PARTNER  10 likely questions; `spar` grills you on your weakest answer
                         │
                         ▼
                    SUBMITTER  opens the employer's Greenhouse / Lever / Ashby form,
                               fills it, uploads the tailored PDFs, submits, confirms
                         │
                         ▼
               5. LEDGER   one row per role: applied, followed up, next step, date
```

## Why separate agents

Each agent gets its own system prompt, its own inputs, and returns a typed object (zod-validated, via forced tool calls). The filter never sees the cover note; the editor never sees the briefing. A screener that's also trying to sell you on the job scores generously; a writer that also judges fit writes defensively. Keeping them apart keeps each one honest at its own task.

## Guardrails (the part that matters when it submits for you)

Rules that must never be broken live **in code**, not in prompts:

| Guard | Where | What it does |
|---|---|---|
| Hard rules | `agents/rules.ts` | Skips contract/temp/fixed-term, non-remote, and postings whose pay tops out under your floor *before* any model call |
| Honesty guard | `agents/editor.ts` | Every rewritten bullet is checked against your base resume: new tools, tech terms, or numbers that aren't already there get thrown out and listed in `report.md` |
| No guessing | `submit/answers.ts` | Form answers come from your profile and answer bank first. Leftovers go to a model that may only use your facts or say `UNKNOWN` |
| Required-field gate | `submit/submitter.ts` | If any required field can't be answered truthfully, it doesn't submit; status becomes `needs_manual` with the exact question |
| Captchas | `submit/form.ts` | Detected and stopped at. Never solved or bypassed |
| Dedupe + daily cap | `agents/ledger.ts` | Never applies to the same posting twice; stops at `dailyCap` per day |
| Demographic questions | `submit/answers.ts` | Always "decline to self-identify" when that option exists |

Every run writes `report.md` with the full table of what went into the form, where each value came from, and what the honesty guard rejected.

## Setup

```bash
npm install
npx playwright install chromium        # or set JOB_AGENT_CHROME_PATH to an installed Chrome
npx tsx src/cli.ts init                 # creates config/profile.yaml, config/resume.md, .env (all gitignored)
```

Fill in `.env` (`ANTHROPIC_API_KEY`), `config/profile.yaml`, and `config/resume.md` (format shown in `config/resume.example.md`).

## Use

### Chat (main way to use it)

```bash
npm run ui      # http://localhost:3000
```

Type what you want, e.g. *"SDET or QA automation jobs, remote in Canada"*. The bot:

1. turns the message into roles + synonyms, country/cities and work mode,
2. finds open postings with web search restricted to Greenhouse, Lever and Ashby, plus every company board it has seen before (`data/boards.json`, grows with each search),
3. drops wrong location / work mode / contract / under-floor pay / already-applied roles,
4. shows a card per role with a fit score from the filter agent,
5. **Apply** on a card runs the whole pipeline and submits; **Apply to all with fit ≥ 7** queues every good card.

The app has four views:

- **Find**: search box, live “8 found · 5 of 8 scored” progress, match cards with a fit ring, *Why this score* (strengths, gaps, and an honest **To reach 8** plan), Apply / Dry run, and Apply-to-all.
- **Applications**: every role with its tailored résumé and cover letter, live status pills (Queued → Scoring fit → Tailoring résumé → Filling form 8/16 → Submitted), filter tabs (All, In flight, Needs you, Submitted, Failed, Skipped) and **Submit all ready**. Click a row for the drawer: Overview, **Honesty** (claims removed and why), **Résumé changes** (before/after, bullet by bullet), **Interview prep** (graded mock interview), Briefing, Cover note, and the exact Form answers with a screenshot.
- **Needs you**: everything the agent stopped on instead of guessing, with Finish by hand, Retry and Mark as applied.
- **Profile**: what the agent knows about you and the rules it follows.

### Sandbox (try everything on dummy jobs first)

```bash
npm run sandbox             # your profile + resume, real Claude, dummy jobs and employer forms
npm run sandbox -- --offline  # no API key needed; rough keyword scoring
npm run sandbox -- --reset    # start with an empty sandbox ledger and inbox
```

Search returns only fictional sandbox companies; **Apply really fills and submits** their forms, but the
forms are served from your machine. The yellow bar links to the **employer inbox**, which shows every
application exactly as the "employer" received it, with the uploaded resume and cover letter. The dummy
market is built so each case shows up at least once:

| Case | Sandbox posting |
|---|---|
| Submits (Greenhouse / Lever style forms) | Maplewave, Northpine, Aurora Labs, EvalForge, Quillmind |
| Ashby: filled, you click Submit | Frostbyte |
| Captcha: stops and asks you | Cedarloop |
| Required question you can't answer from your facts | Polaris Defence Systems |
| Low fit: skipped by Apply-to-all | Lakeshore Analytics |
| Filtered out of "remote in Canada" | Sunbeam (California, hybrid), Pampa Tech (LATAM), Globex (US), Initrode (contract), Budget Books (pay), Ottawa Tech / Harbour / King West (hybrid) |
| Closed search hit | one Maplewave URL |

Sandbox data lives in `data-sandbox/`, separate from your real ledger. Web search is never called in sandbox.

The UI only listens on localhost. Agents, the browser and your resume all stay on your machine.

### CLI

```bash
# score only: fit 1-10 + gaps
npx tsx src/cli.ts score https://job-boards.greenhouse.io/acme/jobs/123

# safest first run: everything, fills the form, screenshots it, does NOT click submit
npx tsx src/cli.ts run --dry-run https://jobs.lever.co/acme/abc

# the real thing (applies automatically when fit ≥ scoreThreshold and every gate passes)
npx tsx src/cli.ts run https://jobs.ashbyhq.com/acme/uuid
npx tsx src/cli.ts batch jobs.txt       # one URL per line

# interview drill on a prepared role
npx tsx src/cli.ts spar out/2026-11-03-acme-senior-sdet

# the ledger
npx tsx src/cli.ts ledger list
npx tsx src/cli.ts ledger due           # follow-ups owed (7+ days since applying) or next steps due
npx tsx src/cli.ts ledger set 3 interviewing --next "Tech screen" --date 2026-11-10
npx tsx src/cli.ts ledger csv
```

Each job gets a folder in `out/` with `fit.json`, `briefing.md`, tailored resume + cover letter PDFs, `questions.md`, `form.png` (what was submitted), and `report.md`.

## Supported application forms

| ATS | Posting data | Auto-apply |
|---|---|---|
| Greenhouse | public Job Board API (incl. application questions) | yes |
| Lever | public Postings API | yes |
| Ashby | public Posting API | fills only: Ashby flagged an automated submit as spam in testing, so you click Submit |
| Anything else | page text | no: documents prepared, status `needs_manual` |

LinkedIn Easy Apply and Workday are deliberately not automated: both actively block bots and an account ban costs more than a few applications.

## Tests

```bash
npm test
```

Unit tests cover URL parsing, ATS mapping, hard rules, the honesty guard, the ledger, and field answering. The end-to-end tests spin up local application forms and drive a real browser through them with a fake model: the happy path submits, an unanswerable required question blocks submission, a captcha blocks submission, dry run never clicks submit, and the full pipeline applies once and dedupes on the second run.

## Limits, honestly

- ATS forms change. Field discovery reads labels the way a screen reader would rather than relying on per-site selectors, but custom dropdown widgets can still fail. Those end as `failed` or `needs_manual` with a screenshot, never as a silent bad submission.
- Greenhouse uses invisible reCAPTCHA on some boards; if it rejects an automated submission you'll see `failed: no confirmation` and should apply by hand.
- The briefing is only as good as what web search finds; it says "not found" rather than guessing names.
