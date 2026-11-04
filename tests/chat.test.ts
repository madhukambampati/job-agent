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
    expect(status.at(-1)).toMatch(/3 matching roles.*not in Canada.*contract/);
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

    // Ledger intent from chat, and the applied job no longer shows in a fresh search.
    const led = await events((await post("/api/chat", { message: "show my applications status" })).id);
    expect(led.at(-1).type).toBe("ledger");
    expect(led.at(-1).data.map((r: any) => r.status).sort()).toEqual(["applied", "skipped"]);
    const again = await events((await post("/api/chat", { message: "SDET remote Canada" })).id);
    expect(again.filter((e) => e.type === "job").map((e) => e.data.company)).not.toContain("Northwind");
  }, 120000);
});
