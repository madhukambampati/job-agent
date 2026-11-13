import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import type { Fetcher } from "../jobs/fetch.js";
import type { LLM } from "../llm.js";
import { launchBrowser } from "../browser.js";
import { createLLM } from "../providers.js";
import { ProfileSchema } from "../profile.js";
import { createRetriever } from "../rag/index.js";
import { parseResume, type Resume } from "../resume.js";
import { BoardMemory } from "../search.js";
import { createApp } from "../ui/server.js";
import { AttemptLimiter, hashPassword, hashToken, newSessionToken, normalizeEmail, readCookie, SESSION_COOKIE, SESSION_TTL_MS, sessionCookie, validEmail, verifyPassword } from "./auth.js";
import { Store } from "./store.js";

/**
 * Hosted gateway: accounts + onboarding in front of the existing app.
 *
 * Each signed-in user gets their OWN `createApp` instance (own ledger file, own
 * output folder, own evidence notes, own live-progress streams), so nothing the
 * app keeps in memory or on disk is shared between people. The gateway's only
 * job is to decide who is calling and hand the request to that user's instance.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAX_BODY = 512 * 1024;
const MAX_RESUME = 200 * 1024;
/** Hosted users can't raise their own daily application cap above this. */
export const HOSTED_MAX_DAILY_CAP = 25;

export interface HostedDeps {
  store: Store;
  llm: () => LLM;
  launch: () => Promise<Browser>;
  /** Folder holding data/users/<id>/ for every account. */
  dataRoot?: string;
  fetcher?: Fetcher;
  boards?: BoardMemory;
  fitConcurrency?: number;
  fitTimeoutMs?: number;
  retriever?: (resume: Resume, userDir: string) => ReturnType<typeof createRetriever> | null;
  /** Set true behind HTTPS so the session cookie is marked Secure. */
  secureCookies?: boolean;
  /** false = existing accounts only. */
  signupOpen?: boolean;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createHostedApp(deps: HostedDeps): Server {
  const { store } = deps;
  const dataRoot = resolve(deps.dataRoot ?? "data/users");
  const authLimiter = new AttemptLimiter();
  const apps = new Map<string, RequestListener>();
  const boards = deps.boards ?? new BoardMemory();

  const userDir = (id: string) => {
    const d = join(dataRoot, id);
    mkdirSync(d, { recursive: true });
    return d;
  };

  /** One isolated app per user, created on first use. */
  function appFor(userId: string): RequestListener {
    let h = apps.get(userId);
    if (h) return h;
    const dir = userDir(userId);
    const app = createApp({
      llm: deps.llm,
      load: () => {
        const d = store.loadComplete(userId);
        if (!d) throw new Error("Finish setting up your profile and résumé first.");
        return d;
      },
      launch: deps.launch,
      fetcher: deps.fetcher,
      ledgerPath: join(dir, "ledger.json"),
      outRoot: join(dir, "out"),
      boards,
      fitConcurrency: deps.fitConcurrency,
      fitTimeoutMs: deps.fitTimeoutMs,
      retriever: (resume) =>
        deps.retriever
          ? deps.retriever(resume, dir)
          : createRetriever(resume, { notesDir: join(dir, "evidence"), cachePath: join(dir, "embeddings-cache.json") }),
    });
    h = app.listeners("request")[0] as RequestListener;
    apps.set(userId, h);
    return h;
  }

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const page = (res: ServerResponse, file: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(join(ROOT, "ui", file)));
  };
  const redirect = (res: ServerResponse, to: string) => {
    res.writeHead(302, { location: to });
    res.end();
  };

  async function readBody(req: IncomingMessage): Promise<any> {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "Send JSON");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "Request too large");
      chunks.push(c as Buffer);
    }
    const t = Buffer.concat(chunks).toString("utf8");
    try {
      return t ? JSON.parse(t) : {};
    } catch {
      throw new HttpError(400, "Bad JSON");
    }
  }

  function userFromRequest(req: IncomingMessage): { id: string; email: string } | null {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return null;
    const id = store.sessionUser(hashToken(token));
    const u = id ? store.userById(id) : undefined;
    return u ? { id: u.id, email: u.email } : null;
  }

  async function startSession(res: ServerResponse, userId: string, status: number, body: unknown) {
    const { token, hash } = newSessionToken();
    store.addSession(hash, userId, Date.now() + SESSION_TTL_MS);
    json(res, status, body, { "set-cookie": sessionCookie(token, deps.secureCookies ?? false) });
  }

  const ipOf = (req: IncomingMessage) => req.socket.remoteAddress ?? "?";

  return createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      const path = u.pathname;
      const GET = req.method === "GET" || req.method === "HEAD";
      const write = req.method === "POST" || req.method === "PUT";

      // ---- Public: sign in / sign up ------------------------------------------
      if (GET && (path === "/login" || path === "/signup")) return page(res, "auth.html");

      if (req.method === "POST" && (path === "/api/auth/signup" || path === "/api/auth/login")) {
        const b = await readBody(req);
        const email = normalizeEmail(String(b.email ?? ""));
        const password = String(b.password ?? "");
        if (!authLimiter.allow(`${ipOf(req)}:${path}`) || !authLimiter.allow(`${email}:${path}`)) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
        if (path === "/api/auth/signup") {
          if (deps.signupOpen === false) throw new HttpError(403, "Sign-ups are closed.");
          if (!validEmail(email)) throw new HttpError(400, "Enter a valid email address.");
          if (password.length < 10 || password.length > 200) throw new HttpError(400, "Use a password of at least 10 characters.");
          if (store.userByEmail(email)) throw new HttpError(409, "An account with this email already exists.");
          const user = store.createUser(randomUUID(), email, await hashPassword(password));
          return startSession(res, user.id, 201, { email: user.email });
        }
        const user = store.userByEmail(email);
        // Same work and same message whether or not the account exists.
        const ok = await verifyPassword(password, user?.passwordHash ?? "00:00");
        if (!user || !ok) throw new HttpError(401, "Wrong email or password.");
        return startSession(res, user.id, 200, { email: user.email });
      }

      if (req.method === "POST" && path === "/api/auth/logout") {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (token) store.deleteSession(hashToken(token));
        return json(res, 200, { ok: true }, { "set-cookie": sessionCookie("", deps.secureCookies ?? false, 0) });
      }

      // ---- Everything below needs a signed-in user ----------------------------
      const user = userFromRequest(req);
      if (!user) {
        if (GET && !path.startsWith("/api/")) return redirect(res, "/login");
        return json(res, 401, { error: "Sign in required" });
      }

      if (GET && path === "/api/auth/me") return json(res, 200, { email: user.email, onboarded: !!store.loadComplete(user.id) });

      // ---- Onboarding: profile + résumé ---------------------------------------
      if (GET && path === "/onboarding") return page(res, "auth.html");

      if (GET && path === "/api/onboarding") {
        const d = store.getData(user.id);
        return json(res, 200, { email: user.email, profile: d.profile, resumeMarkdown: d.resumeMarkdown, complete: !!store.loadComplete(user.id), maxDailyCap: HOSTED_MAX_DAILY_CAP });
      }

      if (req.method === "PUT" && path === "/api/onboarding/profile") {
        const b = await readBody(req);
        const parsed = ProfileSchema.safeParse({ ...b, resumePath: "resume.md" });
        if (!parsed.success) throw new HttpError(400, `Profile problem: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        const p = parsed.data;
        p.automation.dailyCap = Math.min(p.automation.dailyCap, HOSTED_MAX_DAILY_CAP);
        store.saveProfile(user.id, p);
        return json(res, 200, { ok: true, complete: !!store.loadComplete(user.id) });
      }

      if (req.method === "PUT" && path === "/api/onboarding/resume") {
        const b = await readBody(req);
        const md = String(b.markdown ?? "");
        if (!md.trim()) throw new HttpError(400, "Paste your résumé in the markdown format shown.");
        if (md.length > MAX_RESUME) throw new HttpError(413, "Résumé is too long.");
        let r: Resume;
        try {
          r = parseResume(md);
        } catch (e) {
          throw new HttpError(400, `Résumé format problem: ${(e as Error).message}`);
        }
        if (!r.name || !r.roles.length) throw new HttpError(400, "Résumé needs a “# Your Name” heading and at least one role under “## Experience”.");
        store.saveResume(user.id, md);
        return json(res, 200, { ok: true, complete: !!store.loadComplete(user.id) });
      }

      // ---- The app itself, scoped to this user --------------------------------
      if (!store.loadComplete(user.id)) {
        if (GET && !path.startsWith("/api/")) return redirect(res, "/onboarding");
        return json(res, 409, { error: "Finish onboarding first", onboarding: true });
      }
      if (write && !/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "Send JSON");
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) throw new HttpError(413, "Request too large");
      return appFor(user.id)(req, res);
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      json(res, 500, { error: "Something went wrong" });
    }
  });
}

/** Real hosted app: Anthropic API, real job boards, accounts in SQLite. */
export function startHosted(port = Number(process.env.PORT ?? process.env.JOB_AGENT_UI_PORT ?? 3000), deps?: Partial<HostedDeps>): Server {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    /* fine */
  }
  let llm: LLM | null = null;
  const app = createHostedApp({
    store: new Store(),
    llm: () => (llm ??= createLLM()),
    launch: launchBrowser,
    secureCookies: process.env.JOB_AGENT_SECURE_COOKIES === "1",
    signupOpen: process.env.JOB_AGENT_SIGNUPS !== "closed",
    ...deps,
  });
  const host = process.env.JOB_AGENT_HOST ?? "127.0.0.1";
  app.listen(port, host, () => console.log(`job-agent hosted: http://${host}:${port}`));
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startHosted();
