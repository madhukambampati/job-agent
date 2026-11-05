import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Resume } from "../resume.js";
import { cosine, type Embedder } from "./embed.js";
import type { Reranker } from "./rerank.js";

/**
 * Evidence = things you have actually done, in your own words: every résumé
 * bullet, plus optional notes in config/evidence/*.md (project READMEs, work
 * notes). The editor may only lean on these; requirements with no evidence are
 * reported, never papered over.
 */
export interface Chunk {
  id: string;
  text: string;
  source: string;
  kind: "bullet" | "summary" | "skills" | "note";
}

export function resumeChunks(r: Resume): Chunk[] {
  const out: Chunk[] = [];
  if (r.summary) out.push({ id: "summary", text: r.summary, source: "Résumé summary", kind: "summary" });
  r.skills.forEach((s, i) => out.push({ id: `skills.${i + 1}`, text: s.replace(/\*\*/g, ""), source: "Skills", kind: "skills" }));
  for (const role of r.roles) for (const b of role.bullets) out.push({ id: b.id, text: b.text.replace(/\*\*/g, ""), source: role.heading, kind: "bullet" });
  for (const s of r.otherSections) {
    s.body.split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").replace(/\*\*/g, "").trim()).filter((l) => l.length > 20)
      .forEach((l, i) => out.push({ id: `${s.heading.toLowerCase().replace(/\W+/g, "-")}.${i + 1}`, text: l, source: s.heading, kind: "note" }));
  }
  return out;
}

/** config/evidence/*.md: each bullet line or paragraph becomes a chunk. */
export function noteChunks(dir: string): Chunk[] {
  if (!existsSync(dir)) return [];
  const out: Chunk[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md") && x.toLowerCase() !== "readme.md").sort()) {
    const lines = readFileSync(join(dir, f), "utf8").split(/\n\s*\n|\n(?=\s*[-*] )/);
    let n = 0;
    for (const block of lines) {
      const text = block.replace(/^#+.*$/gm, "").replace(/^\s*[-*]\s*/gm, "").replace(/\s+/g, " ").trim();
      if (text.length < 25) continue;
      for (const piece of text.match(/.{1,600}(?:\s|$)/g) ?? [text]) out.push({ id: `${f.replace(/\.md$/, "")}#${++n}`, text: piece.trim(), source: f, kind: "note" });
    }
  }
  return out;
}

// ---- requirements from a job description ---------------------------------------

export interface Requirement {
  text: string;
  mustHave: boolean;
}

const MUST = /requirement|qualification|what you('|’)ll need|what we('|’)re looking for|you have|you bring|must|about you|skills|experience/i;
const NICE = /nice to have|bonus|preferred|plus|good to have|extra credit|asset/i;
const NOT_REQ = /what you('|’)ll do|responsibilit|benefit|perks|about us|we offer|why join|compensation|salary/i;

/** Bullet lines under requirement-like headings. No model call, so it's fast, free and testable. */
export function extractRequirements(description: string): Requirement[] {
  const out: Requirement[] = [];
  let mode: "must" | "nice" | "skip" | "unknown" = "unknown";
  for (const raw of description.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^([-*•·]|\d+[.)])\s+/.test(line);
    if (!bullet) {
      if (line.length < 80) {
        if (NICE.test(line)) mode = "nice";
        else if (NOT_REQ.test(line)) mode = "skip";
        else if (MUST.test(line)) mode = "must";
      }
      continue;
    }
    if (mode === "skip") continue;
    const text = line.replace(/^([-*•·]|\d+[.)])\s+/, "").trim();
    if (text.length < 2) continue;
    out.push({ text, mustHave: mode !== "nice" });
  }
  // No headed bullets at all: fall back to sentences that read like requirements.
  if (!out.length) {
    for (const s of description.split(/(?<=[.;])\s+/)) {
      if (/\b(\d\+?\s*years|experience (with|in)|proficien|knowledge of|familiar(ity)? with|strong .* skills)\b/i.test(s)) out.push({ text: s.trim().slice(0, 200), mustHave: true });
    }
  }
  return out.slice(0, 25);
}

// ---- retrieval -------------------------------------------------------------------

export interface EvidenceHit {
  chunkId: string;
  text: string;
  source: string;
  score: number;
}

export interface EvidenceMatch {
  requirement: string;
  mustHave: boolean;
  supported: boolean;
  hits: EvidenceHit[];
}

export interface RetrieverConfig {
  /** Candidates taken from vector search before reranking. */
  candidates?: number;
  topK?: number;
  /** Minimum best score to call a requirement "supported". Depends on the scorer (rerank vs cosine). */
  threshold?: number;
}

export class EvidenceRetriever {
  private vectors: number[][] | null = null;
  constructor(
    private chunks: Chunk[],
    private embedder: Embedder,
    private reranker: Reranker | null = null,
    private cfg: RetrieverConfig = {},
  ) {}

  get description(): string {
    return `${this.embedder.name}${this.reranker ? ` + ${this.reranker.name}` : ""}`;
  }

  private async index(): Promise<number[][]> {
    return (this.vectors ??= await this.embedder.embed(this.chunks.map((c) => `${c.source}: ${c.text}`), "document"));
  }

  async search(query: string): Promise<EvidenceHit[]> {
    const vecs = await this.index();
    const [q] = await this.embedder.embed([query], "query");
    const ranked = vecs.map((v, i) => ({ i, s: cosine(q, v) })).sort((a, b) => b.s - a.s).slice(0, this.cfg.candidates ?? 12);
    const topK = this.cfg.topK ?? 3;
    if (!this.reranker) return ranked.slice(0, topK).map(({ i, s }) => this.hit(i, s));
    const rr = await this.reranker.rerank(query, ranked.map(({ i }) => this.chunks[i].text), topK);
    return rr.map((r) => this.hit(ranked[r.index].i, r.score));
  }

  async match(reqs: Requirement[]): Promise<EvidenceMatch[]> {
    const threshold = this.cfg.threshold ?? (this.reranker ? 0.35 : 0.12);
    const out: EvidenceMatch[] = [];
    for (const r of reqs) {
      const hits = await this.search(r.text);
      out.push({ requirement: r.text, mustHave: r.mustHave, supported: (hits[0]?.score ?? 0) >= threshold, hits });
    }
    return out;
  }

  private hit(i: number, score: number): EvidenceHit {
    const c = this.chunks[i];
    return { chunkId: c.id, text: c.text, source: c.source, score: Math.round(score * 1000) / 1000 };
  }
}

/** The evidence map as the fit agent and the editor see it. */
export function evidenceForPrompt(matches: EvidenceMatch[]): string {
  return matches
    .map((m) => `- ${m.mustHave ? "[must]" : "[nice]"} ${m.requirement}\n  ${m.supported ? m.hits.slice(0, 2).map((h) => `[${h.chunkId}] ${h.text}`).join("\n  ") : "NO EVIDENCE FOUND"}`)
    .join("\n");
}
