import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { scoreFit } from "../agents/filter.js";
import { Ledger } from "../agents/ledger.js";
import { gradeAnswer } from "../agents/sparring.js";
import { launchBrowser } from "../browser.js";
import type { Fetcher } from "../jobs/fetch.js";
import { AnthropicLLM, type LLM } from "../llm.js";
import { runJob } from "../pipeline.js";
import { loadProfile, type Profile } from "../profile.js";
import { parseResume, resumeForPrompt } from "../resume.js";
import { BoardMemory, parseRequest, searchJobs } from "../search.js";
import { JobSchema, LedgerStatusSchema } from "../types.js";

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
        const fits: Promise<unknown>[] = [];
        let scoring = 0;
        await searchJobs(llm, q, { profile, fetcher: deps.fetcher, boards: deps.boards, isKnown: (id) => l.alreadyApplied(id) }, {
          status: (m) => emit(s, "status", m),
          job: (job) => {
            emit(s, "job", { id: job.id, url: job.url, title: job.title, company: job.company, location: job.location, compensation: job.compensation, ats: job.ats });
            // Fit score for the first 10 cards, so you can see what Apply will do before clicking.
            if (scoring++ < 10) {
              fits.push(
                scoreFit(llm, job, resumeText)
                  .then((f) => emit(s, "fit", { id: job.id, score: f.score, summary: f.summary, gaps: f.gaps.slice(0, 3).map((g) => g.requirement), threshold: profile.automation.scoreThreshold }))
                  .catch(() => {}),
              );
            }
          },
        });
        await Promise.all(fits);
        emit(s, "end", null, true);
      } catch (e) {
        emit(s, "error", (e as Error).message, true);
      }
    })();
  }

  function startApply(url: string, mode: "submit" | "dry", s: Stream) {
    emit(s, "status", "Queued");
    applyChain = applyChain.then(async () => {
      const browser = await deps.launch();
      try {
        const { profile, resumeMarkdown } = deps.load();
        const r = await runJob(url, { llm: deps.llm(), profile, resumeMarkdown, ledger: ledger(), browser }, {
          dryRun: mode === "dry",
          fetcher: deps.fetcher,
          outRoot: deps.outRoot,
          log: (m) => emit(s, "status", m),
        });
        emit(s, "result", { key: r.job.id, company: r.job.company, title: r.job.title, status: r.status, score: r.score, reason: r.reason, applyUrl: r.job.applyUrl }, true);
      } catch (e) {
        emit(s, "error", (e as Error).message, true);
      } finally {
        await browser.close().catch(() => {});
      }
    });
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

      if (GET && u.pathname === "/") return raw(res, readFileSync(join(ROOT, "ui", "chat.html")), "text/html; charset=utf-8");
      if (GET && u.pathname === "/dashboard") return raw(res, readFileSync(join(ROOT, "ui", "dashboard.html")), "text/html; charset=utf-8");

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
        return json(res, 200, { name, threshold, autoSubmit, dailyCap, appliedToday: ledger().appliedToday(), hasKey, problem });
      }

      if (POST && u.pathname === "/api/chat") {
        const { message } = await body(req);
        if (!String(message ?? "").trim()) return json(res, 400, { error: "Type what you're looking for" });
        const [id, s] = open();
        startSearch(String(message), s);
        return json(res, 200, { id });
      }

      if (POST && u.pathname === "/api/apply") {
        const b = await body(req);
        const url = String(b.url ?? "");
        if (!/^https?:\/\//.test(url)) return json(res, 400, { error: "Bad job URL" });
        const [id, s] = open();
        startApply(url, b.mode === "dry" ? "dry" : "submit", s);
        return json(res, 200, { id });
      }
      // Dashboard's run box uses the same queue.
      if (POST && u.pathname === "/api/run") {
        const b = await body(req);
        const [id, s] = open();
        startApply(String(b.url ?? ""), b.mode === "submit" ? "submit" : "dry", s);
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

      if (GET && parts[1] === "job" && parts[2]) {
        const row = ledger().get(parts[2]);
        if (!row) return json(res, 404, { error: "not in ledger" });
        const d = row.outDir ?? "";
        return json(res, 200, {
          row, files: files(row.outDir),
          report: d && readText(d, "report.md"), briefing: d && readText(d, "briefing.md"), coverNote: d && readText(d, "cover-note.md"),
          fit: d && readJson(d, "fit.json"), edit: d && readJson(d, "edit.json"), questions: d && readJson(d, "questions.json"), answers: d && readJson(d, "answers.json"),
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
    llm: () => (llm ??= new AnthropicLLM()),
    load: () => loadProfile(),
    launch: launchBrowser,
    ...deps,
  });
  app.listen(port, "127.0.0.1", () => console.log(`job-agent: http://localhost:${port}  (local only; Ctrl+C to stop)`));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startUi();
