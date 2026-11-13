import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedApp, HOSTED_MAX_DAILY_CAP } from "../src/hosted/server.js";
import { Store } from "../src/hosted/store.js";
import { BoardMemory } from "../src/search.js";
import { FakeLLM, profile, RESUME_MD } from "./helpers.js";

const PW = "correct horse battery";

describe("hosted: accounts, onboarding, isolation", () => {
  let base = "";
  let dir = "";
  let store: Store;
  let close: () => void;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "hosted-"));
    store = new Store(":memory:");
    const app = createHostedApp({
      store,
      llm: () => new FakeLLM({}),
      launch: async () => {
        throw new Error("no browser in this test");
      },
      dataRoot: join(dir, "users"),
      boards: new BoardMemory(join(dir, "boards.json")),
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => app.close();
  });
  afterAll(() => close());

  /** Tiny cookie-jar client. */
  function client() {
    let cookie = "";
    return {
      async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
        const r = await fetch(base + path, {
          method,
          redirect: "manual",
          headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const set = r.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
        const text = await r.text();
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* html or empty */
        }
        return { status: r.status, json, text, location: r.headers.get("location"), setCookie: set };
      },
    };
  }

  async function onboard(c: ReturnType<typeof client>, email: string) {
    expect((await c.call("POST", "/api/auth/signup", { email, password: PW })).status).toBe(201);
    expect((await c.call("PUT", "/api/onboarding/profile", { ...profile, email })).status).toBe(200);
    const r = await c.call("PUT", "/api/onboarding/resume", { markdown: RESUME_MD });
    expect(r.status).toBe(200);
    expect(r.json.complete).toBe(true);
  }

  it("redirects pages and rejects API calls when signed out", async () => {
    const c = client();
    const home = await c.call("GET", "/");
    expect(home.status).toBe(302);
    expect(home.location).toBe("/login");
    expect((await c.call("GET", "/api/ledger")).status).toBe(401);
    expect((await c.call("GET", "/api/applications")).status).toBe(401);
    expect((await c.call("GET", "/login")).text).toContain("job-agent");
  });

  it("validates signup, stores a hashed password, and blocks duplicates", async () => {
    const c = client();
    expect((await c.call("POST", "/api/auth/signup", { email: "nope", password: PW })).status).toBe(400);
    expect((await c.call("POST", "/api/auth/signup", { email: "a@example.com", password: "short" })).status).toBe(400);
    const ok = await c.call("POST", "/api/auth/signup", { email: "A@Example.com", password: PW });
    expect(ok.status).toBe(201);
    expect(ok.setCookie).toMatch(/HttpOnly/);
    expect(ok.setCookie).toMatch(/SameSite=Lax/);
    const u = store.userByEmail("a@example.com")!;
    expect(u.passwordHash).not.toContain(PW);
    expect((await client().call("POST", "/api/auth/signup", { email: "a@example.com", password: PW })).status).toBe(409);
  });

  it("logs in with the right password only, and logout ends the session", async () => {
    const c = client();
    await c.call("POST", "/api/auth/signup", { email: "login@example.com", password: PW });
    await c.call("POST", "/api/auth/logout", {});
    expect((await c.call("GET", "/api/auth/me")).status).toBe(401);

    const bad = client();
    expect((await bad.call("POST", "/api/auth/login", { email: "login@example.com", password: "wrong password!!" })).status).toBe(401);
    expect((await bad.call("POST", "/api/auth/login", { email: "ghost@example.com", password: PW })).status).toBe(401);

    const good = client();
    const r = await good.call("POST", "/api/auth/login", { email: "login@example.com", password: PW });
    expect(r.status).toBe(200);
    expect((await good.call("GET", "/api/auth/me")).json.email).toBe("login@example.com");
    await good.call("POST", "/api/auth/logout", {});
    expect((await good.call("GET", "/api/auth/me")).status).toBe(401);
  });

  it("requires onboarding before the app, and checks the résumé shape", async () => {
    const c = client();
    await c.call("POST", "/api/auth/signup", { email: "new@example.com", password: PW });
    expect((await c.call("GET", "/")).location).toBe("/onboarding");
    expect((await c.call("GET", "/api/ledger")).status).toBe(409);
    expect((await c.call("PUT", "/api/onboarding/profile", { firstName: "x" })).status).toBe(400);
    expect((await c.call("PUT", "/api/onboarding/resume", { markdown: "just some text" })).status).toBe(400);
    await c.call("PUT", "/api/onboarding/profile", { ...profile, email: "new@example.com" });
    expect((await c.call("GET", "/api/ledger")).status).toBe(409); // résumé still missing
    await c.call("PUT", "/api/onboarding/resume", { markdown: RESUME_MD });
    expect((await c.call("GET", "/api/ledger")).status).toBe(200);
    expect((await c.call("GET", "/")).text).toContain("job-agent");
  });

  it("caps the daily application limit that a user can set", async () => {
    const c = client();
    await c.call("POST", "/api/auth/signup", { email: "cap@example.com", password: PW });
    await c.call("PUT", "/api/onboarding/profile", { ...profile, automation: { ...profile.automation, dailyCap: 500 } });
    const saved = (await c.call("GET", "/api/onboarding")).json.profile;
    expect(saved.automation.dailyCap).toBe(HOSTED_MAX_DAILY_CAP);
  });

  it("keeps two users' ledgers and profiles completely separate", async () => {
    const a = client(), b = client();
    await onboard(a, "alice@example.com");
    await onboard(b, "bob@example.com");

    const aliceId = store.userByEmail("alice@example.com")!.id;
    const row = { key: "gh-1", company: "Acme", title: "SDET", url: "https://example.com/1", score: 8, status: "applied", appliedAt: new Date().toISOString(), followedUpAt: null, nextStep: "", nextStepDate: null, notes: "alice only", outDir: null, updatedAt: new Date().toISOString() };
    mkdirSync(join(dir, "users", aliceId), { recursive: true });
    writeFileSync(join(dir, "users", aliceId, "ledger.json"), JSON.stringify([row]));

    const aliceView = (await a.call("GET", "/api/ledger")).json;
    const bobView = (await b.call("GET", "/api/ledger")).json;
    expect(aliceView.map((r: any) => r.company)).toEqual(["Acme"]);
    expect(bobView).toEqual([]);
    expect((await b.call("GET", "/api/job/gh-1")).status).toBe(404);

    // Different people, different data.
    const pa = (await a.call("GET", "/api/profile")).json.profile;
    const pb = (await b.call("GET", "/api/profile")).json.profile;
    expect(pa.email).toBe("alice@example.com");
    expect(pb.email).toBe("bob@example.com");
  });

  it("refuses non-JSON writes (cross-site form posts) and oversized bodies", async () => {
    const c = client();
    await onboard(c, "csrf@example.com");
    const r = await fetch(base + "/api/ledger/gh-1", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(401); // no cookie: never reaches the app
    const cookieOnly = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: (await c.call("POST", "/api/auth/login", { email: "csrf@example.com", password: PW })).setCookie!.split(";")[0] },
      body: "message=hi",
    });
    expect(cookieOnly.status).toBe(415);
    expect((await c.call("PUT", "/api/onboarding/resume", { markdown: "x".repeat(300_000) })).status).toBe(413);
  });
});
