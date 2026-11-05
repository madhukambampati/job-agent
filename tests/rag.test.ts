import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachedEmbedder, CohereEmbedder, LocalEmbedder } from "../src/rag/embed.js";
import { EvidenceRetriever, extractRequirements, noteChunks, resumeChunks } from "../src/rag/evidence.js";
import { CohereReranker } from "../src/rag/rerank.js";
import { parseResume } from "../src/resume.js";
import { description, POSTINGS } from "../src/sandbox/postings.js";
import { RESUME_MD } from "./helpers.js";

describe("requirement extraction", () => {
  it("pulls must-haves and nice-to-haves from headed bullet lists, skipping duties", () => {
    const p = POSTINGS.find((x) => x.board === "auroralabs")!;
    const reqs = extractRequirements(description(p));
    expect(reqs.filter((r) => r.mustHave).map((r) => r.text)).toEqual(p.must);
    expect(reqs.filter((r) => !r.mustHave).map((r) => r.text)).toEqual(p.nice);
    expect(reqs.map((r) => r.text).join()).not.toMatch(/Own test automation/); // "What you'll do" is not a requirement
  });
  it("falls back to requirement-like sentences when there are no bullets", () => {
    const reqs = extractRequirements("We need someone great. You have 5+ years experience with Playwright. Lunch is free.");
    expect(reqs.map((r) => r.text)).toEqual(["You have 5+ years experience with Playwright."]);
  });
});

describe("evidence chunks", () => {
  it("every résumé bullet, summary and skill line is evidence, plus notes files", () => {
    const r = parseResume(RESUME_MD);
    const chunks = resumeChunks(r);
    expect(chunks.find((c) => c.id === "r1.b2")!.text).toMatch(/LLM evaluation harness/);
    const dir = mkdtempSync(join(tmpdir(), "ev-"));
    writeFileSync(join(dir, "jdpower.md"), "# Work notes\n\n- Built a golden dataset of 300 prompts for the pricing assistant.\n- short\n");
    expect(noteChunks(dir)).toEqual([{ id: "jdpower#1", text: "Built a golden dataset of 300 prompts for the pricing assistant.", source: "jdpower.md", kind: "note" }]);
  });
});

describe("local retrieval (offline)", () => {
  it("finds the right bullet for a requirement and flags requirements with no evidence", async () => {
    const r = new EvidenceRetriever(resumeChunks(parseResume(RESUME_MD)), new LocalEmbedder());
    const [llm, py, go] = await r.match([
      { text: "Experience building evaluation harnesses for LLM features", mustHave: true },
      { text: "API test automation in Python with pytest", mustHave: true },
      { text: "Kubernetes operators written in Golang", mustHave: false },
    ]);
    expect(llm.hits[0].chunkId).toBe("r1.b2");
    expect(llm.supported).toBe(true);
    expect(py.hits[0].chunkId).toBe("r2.b1");
    expect(go.supported).toBe(false);
  });
});

describe("Cohere clients", () => {
  it("embed sends the v2 request shape, batches at 96, and normalises vectors", async () => {
    const calls: any[] = [];
    const fake = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, auth: init.headers.authorization });
      return new Response(JSON.stringify({ embeddings: { float: body.texts.map(() => [3, 4]) } }));
    }) as any;
    const e = new CohereEmbedder("k", "embed-v4.0", fake);
    const out = await e.embed(Array.from({ length: 100 }, (_, i) => `t${i}`), "query");
    expect(calls.map((c) => c.body.texts.length)).toEqual([96, 4]);
    expect(calls[0]).toMatchObject({ url: "https://api.cohere.com/v2/embed", auth: "Bearer k", body: { model: "embed-v4.0", input_type: "search_query", embedding_types: ["float"] } });
    expect(out[0]).toEqual([0.6, 0.8]);
  });

  it("rerank sends query + documents and maps results back", async () => {
    let sent: any;
    const fake = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.91 }, { index: 0, relevance_score: 0.12 }] }));
    }) as any;
    const r = await new CohereReranker("k", "rerank-v3.5", fake).rerank("q", ["a", "b"], 5);
    expect(sent).toEqual({ model: "rerank-v3.5", query: "q", documents: ["a", "b"], top_n: 2 });
    expect(r).toEqual([{ index: 1, score: 0.91 }, { index: 0, score: 0.12 }]);
  });

  it("errors carry the status and body", async () => {
    const fake = (async () => new Response("bad key", { status: 401 })) as any;
    await expect(new CohereEmbedder("k", "m", fake).embed(["x"], "document")).rejects.toThrow(/401.*bad key/);
  });

  it("the cache stops re-embedding (and re-billing) unchanged evidence", async () => {
    let n = 0;
    const inner = { name: "fake", embed: async (t: string[]) => { n += t.length; return t.map(() => [1, 0]); } };
    const path = join(mkdtempSync(join(tmpdir(), "c-")), "sub", "cache.json");
    await new CachedEmbedder(inner, path).embed(["a", "b"], "document");
    await new CachedEmbedder(inner, path).embed(["a", "b", "c"], "document");
    expect(n).toBe(3);
  });

  it("with a reranker, the reranker's order and scores win", async () => {
    const { readFileSync } = await import("node:fs");
    const chunks = resumeChunks(parseResume(readFileSync("config/resume.example.md", "utf8")));
    const reranker = { name: "fake", rerank: async (_q: string, docs: string[]) => [{ index: docs.findIndex((d) => /Appium/.test(d)), score: 0.9 }] };
    const r = new EvidenceRetriever(chunks, new LocalEmbedder(), reranker, { candidates: chunks.length, topK: 1 });
    const [m] = await r.match([{ text: "mobile testing", mustHave: true }]);
    expect(m.hits[0]).toMatchObject({ chunkId: "r2.b2", score: 0.9 });
    expect(m.supported).toBe(true);
  });
});
