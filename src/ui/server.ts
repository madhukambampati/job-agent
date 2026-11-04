import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../agents/ledger.js";
import { gradeAnswer } from "../agents/sparring.js";
import { launchBrowser } from "../browser.js";
import { AnthropicLLM, type LLM } from "../llm.js";
import { runJob } from "../pipeline.js";
import { loadProfile } from "../profile.js";
import { JobSchema, LedgerStatusSchema } from "../types.js";

/**
 * Local-only web UI. Everything still runs on this machine (agents, browser,
 * resume); the page is just a face for the same pipeline the CLI uses.
 */

try {
  process.loadEnvFile?.(".env");
} catch {
  /* fine */
}

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PAGE = join(ROOT, "ui", "index.html");
const PORT = Number(process.env.JOB_AGENT_UI_PORT ?? 3000);

type Mode = "dry" | "submit" | "prepare";
interface RunState {
  id: string;
  url: string;
  mode: Mode;
  events: { type: "log" | "done" | "error"; data: unknown }[];
  listeners: Set<ServerResponse>;
  done: boolean;
}
const runs = new Map<string, RunState>();
let busy = false;
let llm: LLM | null = null;
const getLLM = () => (llm ??= new AnthropicLLM());

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as string | Buffer));
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function emit(run: RunState, type: "log" | "done" | "error", data: unknown) {
  const ev = { type, data };
  run.events.push(ev);
  for (const l of run.listeners) l.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (type !== "log") {
    run.done = true;
    for (const l of run.listeners) l.end();
    run.listeners.clear();
  }
}

async function startRun(url: string, mode: Mode): Promise<RunState> {
  const run: RunState = { id: Date.now().toString(36), url, mode, events: [], listeners: new Set(), done: false };
  runs.set(run.id, run);
  busy = true;
  (async () => {
    const browser = await launchBrowser();
    try {
      const { profile, resumeMarkdown } = loadProfile();
      const r = await runJob(url, { llm: getLLM(), profile, resumeMarkdown, ledger: new Ledger(), browser }, {
        dryRun: mode === "dry",
        noSubmit: mode === "prepare",
        log: (m) => emit(run, "log", m),
      });
      emit(run, "done", { key: r.job.id, status: r.status, score: r.score, reason: r.reason, company: r.job.company, title: r.job.title });
    } catch (e) {
      emit(run, "error", (e as Error).message);
    } finally {
      await browser.close().catch(() => {});
      busy = false;
    }
  })();
  return run;
}

function jobFiles(outDir: string | null) {
  if (!outDir || !existsSync(outDir)) return [];
  return readdirSync(outDir).filter((f) => statSync(join(outDir, f)).isFile());
}

const readJson = (dir: string, f: string) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : null);
const readText = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".md": "text/plain; charset=utf-8", ".json": "application/json" };

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "GET" && u.pathname === "/") return send(res, 200, readFileSync(PAGE), "text/html; charset=utf-8");

    if (req.method === "GET" && u.pathname === "/api/config") {
      const { profile } = loadProfile();
      return send(res, 200, {
        name: `${profile.firstName} ${profile.lastName}`,
        threshold: profile.automation.scoreThreshold,
        autoSubmit: profile.automation.autoSubmit,
        dailyCap: profile.automation.dailyCap,
        appliedToday: new Ledger().appliedToday(),
        hasKey: !!process.env.ANTHROPIC_API_KEY,
        busy,
      });
    }

    if (req.method === "GET" && u.pathname === "/api/ledger") return send(res, 200, new Ledger().all());

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "ledger" && parts[2]) {
      const b = await body(req);
      const row = new Ledger().setStatus(parts[2], LedgerStatusSchema.parse(b.status), b.nextStep, b.nextStepDate || null);
      return send(res, 200, row);
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "job" && parts[2]) {
      const row = new Ledger().get(parts[2]);
      if (!row) return send(res, 404, { error: "not in ledger" });
      const d = row.outDir ?? "";
      return send(res, 200, {
        row,
        files: jobFiles(row.outDir),
        report: d && readText(d, "report.md"),
        briefing: d && readText(d, "briefing.md"),
        coverNote: d && readText(d, "cover-note.md"),
        fit: d && readJson(d, "fit.json"),
        edit: d && readJson(d, "edit.json"),
        questions: d && readJson(d, "questions.json"),
        answers: d && readJson(d, "answers.json"),
      });
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "file" && parts[2] && parts[3]) {
      const row = new Ledger().get(parts[2]);
      const name = basename(parts[3]);
      if (!row?.outDir || !jobFiles(row.outDir).includes(name)) return send(res, 404, { error: "no such file" });
      return send(res, 200, readFileSync(join(row.outDir, name)), MIME[extname(name)] ?? "application/octet-stream");
    }

    if (req.method === "POST" && u.pathname === "/api/run") {
      if (busy) return send(res, 409, { error: "A run is already in progress" });
      const b = await body(req);
      const url = String(b.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) return send(res, 400, { error: "Paste a full job URL starting with https://" });
      const mode: Mode = ["dry", "submit", "prepare"].includes(b.mode) ? b.mode : "dry";
      const run = await startRun(url, mode);
      return send(res, 200, { id: run.id });
    }

    if (req.method === "GET" && parts[0] === "api" && parts[1] === "run" && parts[2] && parts[3] === "events") {
      const run = runs.get(parts[2]);
      if (!run) return send(res, 404, { error: "unknown run" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (run.done) return res.end();
      run.listeners.add(res);
      req.on("close", () => run.listeners.delete(res));
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/spar") {
      const b = await body(req);
      const row = new Ledger().get(String(b.key));
      if (!row?.outDir) return send(res, 404, { error: "job not prepared" });
      const job = JobSchema.parse(readJson(row.outDir, "job.json"));
      const g = await gradeAnswer(getLLM(), job, String(b.question), String(b.answer), String(b.history ?? ""));
      return send(res, 200, g);
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`job-agent UI: http://localhost:${PORT}  (local only; Ctrl+C to stop)`);
});
