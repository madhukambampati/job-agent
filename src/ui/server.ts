import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { scoreFit } from "../agents/filter.js";
import { Ledger } from "../agents/ledger.js";
import { gradeAnswer } from "../agents/sparring.js";
import { BROWSER_SETUP_HELP, BrowserSetupError, launchBrowser } from "../browser.js";
import { fetchJob, type Fetcher } from "../jobs/fetch.js";
import type { LLM } from "../llm.js";
import { createLLM } from "../providers.js";
import { runJob } from "../pipeline.js";
import { loadProfile, type Profile } from "../profile.js";
import { parseResume, resumeForPrompt, type Resume } from "../resume.js";
import { createRetriever, type EvidenceRetriever } from "../rag/index.js";
import { BoardMemory, parseRequest, searchJobs } from "../search.js";
import { JobSchema, LedgerStatusSchema, type FitScore } from "../types.js";
import { applyEdits } from "../agents/editor.js";

/**
 * Local-only web UI. Everything still runs on this machine (agents, browser,
 * resume); the pages are just a face for the same pipeline the CLI uses.
 *   /           chat: ask for jobs, get cards, one-click Apply
 *   /dashboard  ledger + per-job detail + sparring
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface AppDeps {
  llm: () => LLM;
  load: () => { profile: Profile; resumeMarkdown: string };
  launch: () => Promise<Browser>;
  fetcher?: Fetcher;
  ledgerPath?: string;
  boards?: BoardMemory;
  outRoot?: string;
  fitConcurrency?: number;
  fitTimeoutMs?: number;
  /** Evidence retriever for RAG; defaults to createRetriever (Cohere if COHERE_API_KEY, else local). Return null to turn it off. */
  retriever?: (resume: Resume) => EvidenceRetriever | null;
  /** Set in sandbox mode: dummy jobs, local employer forms. */
  sandbox?: { inboxUrl: string; mode: string };
}

interface Active {
  id: string;
  url: string;
  mode: "submit" | "dry";
  step: string;
  startedAt: string;
  key?: string;
  company?: string;
  title?: string;
}

function fitPayload(id: string, f: FitScore, threshold: number) {
  return { id, score: f.score, summary: f.summary, strengths: f.strengths.slice(0, 4), gaps: f.gaps.map((g) => ({ requirement: g.requirement, severity: g.severity })), plan: f.closeTheGap, threshold };
}

function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolveP, rejectP) => {
      const run = () => {
        active++;
        fn().then(resolveP, rejectP).finally(() => {
          active--;
          queue.shift()?.();
        });
      };
      if (active < n) run();
      else queue.push(run);
    });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const t = setTimeout(() => rejectP(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => (clearTimeout(t), resolveP(v)), (e) => (clearTimeout(t), rejectP(e)));
  });
}

type Event = { type: string; data: unknown };
interface Stream {
  events: Event[];
  listeners: Set<ServerResponse>;
  done: boolean;
}

export function createApp(deps: AppDeps): Server {
  const streams = new Map<string, Stream>();
  const ledger = () => new Ledger(deps.ledgerPath);
  let applyChain: Promise<unknown> = Promise.resolve();
  let seq = 0;

  const open = (): [string, Stream] => {
    const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
    const s: Stream = { events: [], listeners: new Set(), done: false };
    streams.set(id, s);
    return [id, s];
  };
  const emit = (s: Stream, type: string, data: unknown, end = false) => {
    const ev = { type, data };
    s.events.push(ev);
    for (const l of s.listeners) l.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (end) {
      s.done = true;
      for (const l of s.listeners) l.end();
      s.listeners.clear();
    }
  };

  function startSearch(message: string, s: Stream) {
    (async () => {
      try {
        const llm = deps.llm();
        const { profile, resumeMarkdown } = deps.load();
        const q = await parseRequest(llm, message);
        emit(s, "query", q);
        if (q.intent === "ledger") {
          emit(s, "ledger", ledger().all().slice(0, 30), true);
          return;
        }
        if (q.intent === "help" || (!q.titles.length && !q.country)) {
          emit(s, "say", "Tell me the role and where, for example: “SDET or QA automation jobs, remote in Canada”. I'll find open postings on Greenhouse, Lever and Ashby, and each one gets an Apply button.", true);
          return;
        }
        const resumeText = resumeForPrompt(parseResume(resumeMarkdown));
        const l = ledger();
        // Every card gets a fit score: a few at a time, each with a deadline, and a
        // visible "fit_error" instead of a spinner that never stops.
        const fits: Promise<void>[] = [];
        const limit = limiter(deps.fitConcurrency ?? 4);
        const threshold = profile.automation.scoreThreshold;
        await searchJobs(llm, q, { profile, fetcher: deps.fetcher, boards: deps.boards, isKnown: (id) => l.alreadyApplied(id) }, {
          status: (m) => emit(s, "status", m),
          job: (job) => {
            emit(s, "job", { id: job.id, url: job.url, title: job.title, company: job.company, location: job.location, compensation: job.compensation, ats: job.ats });
            fits.push(
              limit(() => withTimeout(scoreFit(llm, job, resumeText), deps.fitTimeoutMs ?? 90_000))
                .then((f) => emit(s, "fit", fitPayload(job.id, f, threshold)))
                .catch((e: Error) => emit(s, "fit_error", { id: job.id, error: e.message })),
            );
          },
        });
        await Promise.all(fits);
        emit(s, "end", null, true);
      } catch (e) {
        emit(s, "error", (e as Error).message, true);
      }
    })();
  }

  /** Applications queued or running right now, so every view can show live progress. */
  const active = new Map<string, Active>();

  function startApply(url: string, mode: "submit" | "dry", s: Stream, userConfirmed = false) {
    const a: Active = { id: `${Date.now().toString(36)}${(seq++).toString(36)}`, url, mode, step: "Queued", startedAt: new Date().toISOString() };
    active.set(a.id, a);
    const step = (m: string) => {
      a.step = m;
      emit(s, "status", m);
    };
    step("Queued");
    applyChain = applyChain.then(async () => {
      try {
        await runOne();
      } finally {
        active.delete(a.id);
      }
    });
    const runOne = async () => {
      a.step = "Starting";
      // The browser starts only when PDFs or the form need it; if it can't start, the
      // pipeline records the role as Failed with a plain-language reason.
      const launch = () =>
        deps.launch().catch((e: Error) => {
          throw e instanceof BrowserSetupError ? e : new BrowserSetupError(BROWSER_SETUP_HELP);
        });
      try {
        const { profile, resumeMarkdown } = deps.load();
        const retriever = (deps.retriever ?? ((res: Resume) => createRetriever(res)))(parseResume(resumeMarkdown));
        const r = await runJob(url, { llm: deps.llm(), profile, resumeMarkdown, ledger: ledger(), browser: launch, retriever }, {
          dryRun: mode === "dry",
          userConfirmed,
          fetcher: deps.fetcher,
          outRoot: deps.outRoot,
          log: step,
          onJob: (job) => {
            a.key = job.id;
            a.company = job.company;
            a.title = job.title;
          },
        });
        active.delete(a.id); // before the final event, so nobody sees a finished application as still running
        emit(s, "result", { key: r.job.id, company: r.job.company, title: r.job.title, status: r.status, score: r.score, reason: r.reason, applyUrl: r.job.applyUrl }, true);
      } catch (e) {
        // Only reached before the role is known (e.g. the posting couldn't be read).
        active.delete(a.id);
        emit(s, "error", `Couldn't read this posting: ${(e as Error).message.split("\n")[0]}`, true);
      }
    };
  }

  /** Ledger rows plus what each one needs on the dashboard (documents, honesty count, where to finish by hand). */
  function applications() {
    return {
      rows: ledger().all().map((r) => {
        const d = r.outDir ?? "";
        const fs = files(r.outDir);
        const job = d ? readJson(d, "job.json") : null;
        const edit = d ? readJson(d, "edit.json") : null;
        const fit = d ? readJson(d, "fit.json") : null;
        return {
          ...r,
          applyUrl: job?.applyUrl ?? r.url,
          location: job?.location ?? "",
          resumePdf: fs.find((f) => /_Resume\.pdf$/.test(f)) ?? null,
          coverPdf: fs.find((f) => /_Cover_Letter\.pdf$/.test(f)) ?? null,
          claimsRemoved: edit?.rejected?.length ?? 0,
          unsupported: edit?.output?.unsupportedRequirements?.length ?? 0,
          gaps: (fit?.gaps ?? []).length,
        };
      }),
      active: [...active.values()],
    };
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const raw = (res: ServerResponse, body: string | Buffer, type: string) => {
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const body = async (req: IncomingMessage) => {
    let t = "";
    for await (const c of req) t += c;
    return t ? JSON.parse(t) : {};
  };
  const files = (dir: string | null) => (dir && existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()) : []);
  const readJson = (d: string, f: string) => (existsSync(join(d, f)) ? JSON.parse(readFileSync(join(d, f), "utf8")) : null);
  const readText = (d: string, f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : null);
  const MIME: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".md": "text/plain; charset=utf-8", ".json": "application/json" };

  return createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const GET = req.method === "GET", POST = req.method === "POST";

      if (GET && u.pathname === "/") return raw(res, readFileSync(join(ROOT, "ui", "app.html")), "text/html; charset=utf-8");
      if (GET && u.pathname === "/dashboard") {
        res.writeHead(302, { location: `/#applications` });
        return res.end();
      }

      if (GET && u.pathname === "/api/applications") return json(res, 200, applications());

      if (GET && u.pathname === "/api/profile") {
        const { profile, resumeMarkdown } = deps.load();
        const r = parseResume(resumeMarkdown);
        return json(res, 200, {
          profile,
          resume: { name: r.name, contact: r.contact, summary: r.summary, skills: r.skills, roles: r.roles.map((x) => ({ heading: x.heading, bullets: x.bullets.length })), other: r.otherSections.map((x) => x.heading) },
        });
      }

      // Original vs tailored resume, bullet by bullet.
      if (GET && parts[1] === "job" && parts[2] && parts[3] === "diff") {
        const row = ledger().get(parts[2]);
        const edit = row?.outDir ? readJson(row.outDir, "edit.json") : null;
        if (!edit) return json(res, 404, { error: "No tailored resume for this role (it was skipped before tailoring)." });
        const resume = parseResume(deps.load().resumeMarkdown);
        const tailored = applyEdits(resume, edit.output);
        return json(res, 200, {
          summary: { before: resume.summary, after: edit.output.summary },
          roles: resume.roles.map((orig, i) => ({
            heading: orig.heading,
            bullets: tailored[i].bullets.map((b, pos) => {
              const was = orig.bullets.findIndex((x) => x.id === b.id);
              return { id: b.id, text: b.text, original: orig.bullets[was].text, from: was, to: pos, rewritten: b.text !== orig.bullets[was].text };
            }),
          })),
          rejected: edit.rejected ?? [],
          unsupported: edit.output.unsupportedRequirements ?? [],
        });
      }

      if (GET && u.pathname === "/api/config") {
        let name = "", threshold = 7, autoSubmit = true, dailyCap = 15, problem = "";
        try {
          const { profile } = deps.load();
          ({ scoreThreshold: threshold, autoSubmit, dailyCap } = profile.automation);
          name = `${profile.firstName} ${profile.lastName}`;
        } catch (e) {
          problem = (e as Error).message;
        }
        let hasKey = true;
        try { deps.llm(); } catch { hasKey = false; }
        return json(res, 200, { name, threshold, autoSubmit, dailyCap, appliedToday: ledger().appliedToday(), hasKey, problem, sandbox: deps.sandbox ?? null });
      }

      if (POST && u.pathname === "/api/chat") {
        const { message } = await body(req);
        if (!String(message ?? "").trim()) return json(res, 400, { error: "Type what you're looking for" });
        const [id, s] = open();
        startSearch(String(message), s);
        return json(res, 200, { id });
      }

      // Re-score one card after a fit check failed or timed out.
      if (POST && u.pathname === "/api/fit") {
        const b = await body(req);
        const { profile, resumeMarkdown } = deps.load();
        const job = await fetchJob(String(b.url ?? ""), deps.fetcher);
        const f = await withTimeout(scoreFit(deps.llm(), job, resumeForPrompt(parseResume(resumeMarkdown))), deps.fitTimeoutMs ?? 90_000);
        return json(res, 200, fitPayload(job.id, f, profile.automation.scoreThreshold));
      }

      if (POST && u.pathname === "/api/apply") {
        const b = await body(req);
        const url = String(b.url ?? "");
        if (!/^https?:\/\//.test(url)) return json(res, 400, { error: "Bad job URL" });
        const [id, s] = open();
        startApply(url, b.mode === "dry" ? "dry" : "submit", s, b.manual === true);
        return json(res, 200, { id });
      }
      // Dashboard's run box uses the same queue.
      if (POST && u.pathname === "/api/run") {
        const b = await body(req);
        const [id, s] = open();
        startApply(String(b.url ?? ""), b.mode === "submit" ? "submit" : "dry", s, true);
        return json(res, 200, { id });
      }

      if (GET && (parts[1] === "stream" || parts[1] === "run") && parts[2] && parts[3] === "events") {
        const s = streams.get(parts[2]);
        if (!s) return json(res, 404, { error: "unknown stream" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        for (const ev of s.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (s.done) return res.end();
        s.listeners.add(res);
        req.on("close", () => s.listeners.delete(res));
        return;
      }

      if (GET && u.pathname === "/api/ledger") return json(res, 200, ledger().all());
      if (POST && parts[1] === "ledger" && parts[2]) {
        const b = await body(req);
        return json(res, 200, ledger().setStatus(parts[2], LedgerStatusSchema.parse(b.status), b.nextStep, b.nextStepDate || null));
      }

      if (GET && parts[1] === "job" && parts[2] && !parts[3]) {
        const row = ledger().get(parts[2]);
        if (!row) return json(res, 404, { error: "not in ledger" });
        const d = row.outDir ?? "";
        return json(res, 200, {
          row, files: files(row.outDir),
          report: d && readText(d, "report.md"), briefing: d && readText(d, "briefing.md"), coverNote: d && readText(d, "cover-note.md"),
          fit: d && readJson(d, "fit.json"),
          evidence: d && readJson(d, "evidence.json"), edit: d && readJson(d, "edit.json"), questions: d && readJson(d, "questions.json"), answers: d && readJson(d, "answers.json"),
        });
      }

      if (GET && parts[1] === "file" && parts[2] && parts[3]) {
        const row = ledger().get(parts[2]);
        const name = basename(parts[3]);
        if (!row?.outDir || !files(row.outDir).includes(name)) return json(res, 404, { error: "no such file" });
        return raw(res, readFileSync(join(row.outDir, name)), MIME[extname(name)] ?? "application/octet-stream");
      }

      if (POST && u.pathname === "/api/spar") {
        const b = await body(req);
        const row = ledger().get(String(b.key));
        if (!row?.outDir) return json(res, 404, { error: "job not prepared" });
        const job = JobSchema.parse(readJson(row.outDir, "job.json"));
        return json(res, 200, await gradeAnswer(deps.llm(), job, String(b.question), String(b.answer), String(b.history ?? "")));
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
}

/** Real app: Anthropic API, real job boards, your profile. */
export function startUi(port = Number(process.env.JOB_AGENT_UI_PORT ?? 3000), deps?: Partial<AppDeps>): Server {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    /* fine */
  }
  let llm: LLM | null = null;
  const app = createApp({
    llm: () => (llm ??= createLLM()),
    load: () => loadProfile(),
    launch: launchBrowser,
    ...deps,
  });
  app.listen(port, "127.0.0.1", () => console.log(`job-agent: http://localhost:${port}  (local only; Ctrl+C to stop)`));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startUi();
