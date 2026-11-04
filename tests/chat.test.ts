import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser.js";
import { BoardMemory, placeMatches, searchJobs, titleMatches, type SearchQuery } from "../src/search.js";
import { createApp } from "../src/ui/server.js";
import { fakeMarket } from "./fake-market.js";
import { FORM_HAPPY, profile, RESUME_MD, startFormServer } from "./helpers.js";

const q: SearchQuery = { intent: "search", titles: ["SDET", "QA Automation", "QA Engineer", "Software Engineer in Test"], country: "Canada", places: [], workplace: "remote", exclude: [] };

describe("search filters", () => {
  it("matches titles by any synonym and honours excludes", () => {
    expect(titleMatches("Senior SDET", q)).toBe(true);
    expect(titleMatches("Staff Software Engineer in Test", q)).toBe(true);
    expect(titleMatches("Product Manager", q)).toBe(false);
    expect(titleMatches("SDET Manager", { ...q, exclude: ["manager"] })).toBe(false);
  });

  it("checks work mode and country from the posting", () => {
    expect(placeMatches("Remote - Canada", "", q).ok).toBe(true);
    expect(placeMatches("Toronto, Ontario · remote", "", q).ok).toBe(true);
    expect(placeMatches("Remote - US", "", q)).toMatchObject({ ok: false });
    expect(placeMatches("Remote", "We hire across Canada.", q).ok).toBe(true);
    expect(placeMatches("Remote", "US only.", q).ok).toBe(false);
    expect(placeMatches("Toronto, ON", "", q)).toMatchObject({ ok: false, reason: "not remote" });
    expect(placeMatches("Toronto, ON (Hybrid)", "", { ...q, workplace: "hybrid" }).ok).toBe(true);
  });
});

describe("searchJobs on a fake market", () => {
  it("finds the 3 Canada-remote roles, drops US-only and contract, remembers boards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-"));
    const { llm, fetcher } = fakeMarket("http://unused/apply");
    const boards = new BoardMemory(join(dir, "boards.json"));
    const status: string[] = [];
    const jobs = await searchJobs(llm, q, { profile, fetcher, boards }, { status: (m) => status.push(m), job: () => {} });
    expect(jobs.map((j) => j.company).sort()).toEqual(["Lakeside", "Maplesoft", "Northwind"]);
    expect(status.at(-1)).toMatch(/3 matching roles.*in another country.*contract/);
    expect(boards.list()).toContain("lever:northwind");
    expect(llm.calls.find((c) => c.tool === "research")!.prompt).toMatch(/jobs\.lever\.co/);
  });
});

describe("chat → cards → Apply over HTTP", () => {
  let base = "";
  let close: () => Promise<void>;
  let submissions: string[];

  beforeAll(async () => {
    const form = await startFormServer({ "/apply": FORM_HAPPY });
    submissions = form.submissions;
    const { llm, fetcher } = fakeMarket(`${form.url}/apply`);
    const dir = mkdtempSync(join(tmpdir(), "chat-"));
    const app = createApp({
      llm: () => llm,
      load: () => ({ profile, resumeMarkdown: RESUME_MD }),
      launch: launchBrowser,
      fetcher,
      ledgerPath: join(dir, "ledger.json"),
      boards: new BoardMemory(join(dir, "boards.json")),
      outRoot: join(dir, "out"),
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = async () => {
      app.close();
      form.server.close();
    };
  });
  afterAll(() => close());

  const events = async (id: string) => {
    const text = await (await fetch(`${base}/api/stream/${id}/events`)).text();
    return text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
  };
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  it("serves the chat page", async () => {
    expect(await (await fetch(base + "/")).text()).toContain("What are you looking for?");
  });

  it("turns a message into job cards with fit scores, then Apply submits the real form", async () => {
    const { id } = await post("/api/chat", { message: "I am looking for SDET QA jobs remote Canada" });
    const evs = await events(id);
    const jobs = evs.filter((e) => e.type === "job").map((e) => e.data);
    const fits = Object.fromEntries(evs.filter((e) => e.type === "fit").map((e) => [e.data.id, e.data.score]));
    expect(jobs).toHaveLength(3);
    expect(Object.values(fits).sort()).toEqual([6, 8, 8]);
    expect(evs.at(-1).type).toBe("end");

    const good = jobs.find((j) => j.company === "Northwind");
    const applied = await events((await post("/api/apply", { url: good.url })).id);
    expect(applied.at(-1)).toMatchObject({ type: "result", data: { status: "applied", score: 8 } });
    expect(submissions.at(-1)).toContain("alex@example.com");

    const low = jobs.find((j) => j.company === "Lakeside");
    const skipped = await events((await post("/api/apply", { url: low.url })).id);
    expect(skipped.at(-1).data.status).toBe("skipped");

    // Clicking Apply on the card yourself overrides the fit threshold.
    const manual = await events((await post("/api/apply", { url: low.url, manual: true })).id);
    expect(manual.at(-1)).toMatchObject({ type: "result", data: { status: "applied", score: 6 } });

    // Ledger intent from chat, and the applied job no longer shows in a fresh search.
    const led = await events((await post("/api/chat", { message: "show my applications status" })).id);
    expect(led.at(-1).type).toBe("ledger");
    expect(led.at(-1).data.map((r: any) => r.status).sort()).toEqual(["applied", "applied"]);
    const again = await events((await post("/api/chat", { message: "SDET remote Canada" })).id);
    expect(again.filter((e) => e.type === "job").map((e) => e.data.company)).not.toContain("Northwind");
  }, 120000);
});

describe("QA report regressions (Nov 4)", () => {
  it("#1 California is not Canada, hybrid is not remote, LATAM titles are out", () => {
    expect(placeMatches("Sunnyvale, CA · Remote · Hybrid", "", q)).toMatchObject({ ok: false, reason: "hybrid, not remote" });
    expect(placeMatches("Sunnyvale, CA · Remote", "", q)).toMatchObject({ ok: false, reason: "in another country" });
    expect(placeMatches("Remote", "Help Canadian homeowners with HELOC products.", q, "Senior QA Automation Engineer - HELOC (LATAM)")).toMatchObject({ ok: false });
    expect(placeMatches("Buenos Aires, Argentina · Remote", "", q).ok).toBe(false);
    expect(placeMatches("Remote", "Our customers include Canadian banks.", q).ok).toBe(false);
    expect(placeMatches("Remote", "This role is fully remote and open to candidates located in Canada.", q).ok).toBe(true);
    expect(placeMatches("Remote - US or Canada", "", q).ok).toBe(true);
    expect(placeMatches("Toronto, ON · Remote", "", q).ok).toBe(true);
    expect(placeMatches("Waterloo, Ontario, Canada · Remote", "", q).ok).toBe(true);
  });

  it("#1 Ashby: workplaceType Hybrid wins over isRemote", async () => {
    const { fetchJob } = await import("../src/jobs/fetch.js");
    const fetcher = async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ jobs: [{ id: "x1", title: "SDET", location: "Sunnyvale, CA", isRemote: true, workplaceType: "Hybrid", descriptionPlain: "d" }] }) });
    const j = await fetchJob("https://jobs.ashbyhq.com/cerebras/x1", fetcher);
    expect(j.location).toBe("Sunnyvale, CA · Hybrid");
  });

  it("#2 every card gets a fit score or a visible fit_error, nothing hangs", async () => {
    const form = await startFormServer({ "/apply": FORM_HAPPY });
    const { llm, fetcher } = fakeMarket(`${form.url}/apply`);
    const slow = {
      research: llm.research.bind(llm),
      structured: (req: any) => (req.toolName === "record_fit" && /Lakeside/i.test(req.prompt) ? new Promise(() => {}) : llm.structured(req)),
    } as any;
    const dir = mkdtempSync(join(tmpdir(), "fit-"));
    const app = createApp({ llm: () => slow, load: () => ({ profile, resumeMarkdown: RESUME_MD }), launch: launchBrowser, fetcher, ledgerPath: join(dir, "l.json"), boards: new BoardMemory(join(dir, "b.json")), fitTimeoutMs: 300, fitConcurrency: 2 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const { id } = await (await fetch(b + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "SDET remote Canada" }) })).json();
      const evs = (await (await fetch(`${b}/api/stream/${id}/events`)).text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6)));
      const jobIds = evs.filter((e) => e.type === "job").map((e) => e.data.id);
      const settled = evs.filter((e) => e.type === "fit" || e.type === "fit_error").map((e) => e.data.id);
      expect(settled.sort()).toEqual(jobIds.sort());
      expect(evs.find((e) => e.type === "fit_error").data.error).toMatch(/timed out/);
      expect(evs.at(-1).type).toBe("end");
    } finally {
      app.close();
      form.server.close();
    }
  }, 30000);

  it("#5 days are local, not UTC (9pm in Toronto is still today)", async () => {
    const prev = process.env.TZ;
    process.env.TZ = "America/Toronto";
    try {
      const { localDay } = await import("../src/dates.js");
      const { Ledger } = await import("../src/agents/ledger.js");
      expect(localDay(new Date("2026-11-04T02:00:00Z"))).toBe("2026-11-03");
      const l = new Ledger(join(mkdtempSync(join(tmpdir(), "tz-")), "l.json"));
      l.upsert({ key: "a", company: "A", title: "t", url: "u", status: "applied", appliedAt: "2026-11-04T02:00:00Z" });
      expect(l.appliedToday(new Date("2026-11-04T03:30:00Z"))).toBe(1);
      expect(l.appliedToday(new Date("2026-11-04T14:00:00Z"))).toBe(0);
    } finally {
      process.env.TZ = prev;
    }
  });
});
