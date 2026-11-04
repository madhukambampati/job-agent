import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser.js";
import { startEmployer, type Employer } from "../src/sandbox/employer.js";
import { OfflineLLM } from "../src/sandbox/llm.js";
import { BoardMemory } from "../src/search.js";
import { createApp } from "../src/ui/server.js";
import { profile, RESUME_MD } from "./helpers.js";

describe("sandbox: dummy market end to end", () => {
  let base = "";
  let employer: Employer;
  let close: () => void;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-"));
    employer = await startEmployer(dir);
    const llm = new OfflineLLM();
    const app = createApp({
      llm: () => llm,
      load: () => ({ profile, resumeMarkdown: RESUME_MD }),
      launch: launchBrowser,
      fetcher: employer.fetcher,
      ledgerPath: join(dir, "ledger.json"),
      boards: new BoardMemory(join(dir, "boards.json")),
      outRoot: join(dir, "out"),
      sandbox: { inboxUrl: `${employer.baseUrl}/inbox`, mode: "offline" },
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => app.close();
  });
  afterAll(async () => {
    close();
    await employer.close();
  });

  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const events = async (id: string) =>
    (await (await fetch(`${base}/api/stream/${id}/events`)).text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const search = async (message: string) => {
    const evs = await events((await post("/api/chat", { message })).id);
    return { jobs: evs.filter((e) => e.type === "job").map((e) => e.data), summary: evs.filter((e) => e.type === "status").at(-1)?.data as string, evs };
  };
  const apply = async (url: string) => (await events((await post("/api/apply", { url, manual: true })).id)).at(-1);

  it("config reports sandbox mode", async () => {
    expect((await (await fetch(base + "/api/config")).json()).sandbox.inboxUrl).toMatch(/\/inbox$/);
  });

  it("remote Canada search shows only remote-Canada full-time roles and explains the rest", async () => {
    const { jobs, summary } = await search("SDET or QA automation jobs, remote in Canada");
    const companies = jobs.map((j) => j.company).sort();
    expect(companies).toEqual(["Aurora Labs", "Cedarloop", "Frostbyte", "Lakeshore Analytics", "Maplewave", "Northpine", "Polaris Defence Systems", "Quillmind"]);
    for (const out of ["Sunbeam", "Pampa", "Globex", "Initrode", "Budget Books", "Harbour", "King West", "Ottawa"]) expect(companies.join()).not.toContain(out);
    expect(summary).toMatch(/1 closed/);
    expect(summary).toMatch(/in another country/);
    expect(summary).toMatch(/contract/);
    expect(summary).toMatch(/pay tops out/);
  }, 60000);

  it("Toronto hybrid search shows the two Toronto hybrid roles only", async () => {
    const { jobs } = await search("Senior QA engineer jobs in Toronto, hybrid");
    expect(jobs.map((j) => j.company).sort()).toEqual(["Harbour Financial", "King West Labs"]);
  }, 60000);

  it("AI evaluation search finds the evals roles", async () => {
    const { jobs } = await search("AI evaluation / LLM quality roles, remote Canada");
    expect(jobs.map((j) => j.company)).toEqual(expect.arrayContaining(["EvalForge", "Quillmind"]));
  }, 60000);

  it("Apply: Greenhouse and Lever submit; the employer inbox receives the fields and the resume PDF", async () => {
    const gh = await apply("https://job-boards.greenhouse.io/maplewave/jobs/4100001");
    expect(gh).toMatchObject({ type: "result", data: { status: "applied" } });
    const lv = await apply("https://jobs.lever.co/northpine/np-qa-201");
    expect(lv).toMatchObject({ type: "result", data: { status: "applied" } });

    const [lever, greenhouse] = employer.submissions();
    expect(greenhouse.company).toBe("Maplewave");
    const g = Object.fromEntries(greenhouse.fields.map((f) => [f.label, f.value]));
    expect(g).toMatchObject({ "First Name": "Alex", "Last Name": "Rivera", Email: "alex@example.com", "Are you legally authorized to work in Canada?": "Yes", "Will you now or in the future require visa sponsorship?": "No", Gender: "Decline to self-identify", "How did you hear about this job?": "LinkedIn" });
    expect(g["Why do you want to work at Maplewave?"]).toBeTruthy();
    expect(greenhouse.files.map((f) => f.name)).toEqual(["Alex_Rivera_Resume.pdf", "Alex_Rivera_Cover_Letter.pdf"]);
    expect(Object.fromEntries(lever.fields.map((f) => [f.label, f.value]))).toMatchObject({ "Full name": "Alex Rivera", "Current company": "Example Corp" });

    const inbox = await (await fetch(`${employer.baseUrl}/inbox`)).text();
    expect(inbox).toContain("Maplewave");
    const pdf = await fetch(`${employer.baseUrl}/inbox/file/${encodeURIComponent(greenhouse.files[0].stored)}`);
    expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(5000);
  }, 120000);

  it("Apply: captcha, unanswerable required question and Ashby each stop with a reason, nothing sent", async () => {
    const before = employer.submissions().length;
    const cap = await apply("https://jobs.lever.co/cedarloop/cl-qe-301");
    expect(cap.data).toMatchObject({ status: "needs_manual", reason: expect.stringMatching(/captcha/i) });
    const clr = await apply("https://job-boards.greenhouse.io/polarisdefence/jobs/4100003");
    expect(clr.data).toMatchObject({ status: "needs_manual", reason: expect.stringMatching(/clearance/i) });
    const ash = await apply("https://jobs.ashbyhq.com/frostbyte/6f1d2c3a-0000-4a11-9a00-000000000004");
    expect(ash.data).toMatchObject({ status: "needs_manual", reason: expect.stringMatching(/Ashby/) });
    expect(employer.submissions().length).toBe(before);
  }, 120000);

  it("the sandbox fetcher never reaches anything outside the dummy market", async () => {
    expect((await employer.fetcher("https://boards-api.greenhouse.io/v1/boards/anthropic/jobs")).status).toBe(404);
    expect((await employer.fetcher("https://example.com/")).status).toBe(404);
  });
});

describe("server survives a browser that won't start", () => {
  it("reports the error on that application and keeps serving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-"));
    const employer = await startEmployer(dir);
    const app = createApp({
      llm: () => new OfflineLLM(), load: () => ({ profile, resumeMarkdown: RESUME_MD }),
      launch: async () => { throw new Error("Executable doesn't exist\nmore detail"); },
      fetcher: employer.fetcher, ledgerPath: join(dir, "l.json"), boards: new BoardMemory(join(dir, "b.json")), outRoot: join(dir, "out"),
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const { id } = await (await fetch(b + "/api/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://jobs.lever.co/northpine/np-qa-201" }) })).json();
      const last = (await (await fetch(`${b}/api/stream/${id}/events`)).text()).split("\n\n").filter(Boolean).map((l) => JSON.parse(l.slice(6))).at(-1);
      expect(last).toMatchObject({ type: "error", data: expect.stringMatching(/Couldn't start the browser.*playwright install/) });
      expect((await fetch(b + "/api/config")).status).toBe(200);
    } finally {
      app.close();
      await employer.close();
    }
  });
});
