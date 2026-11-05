import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Turns text into vectors. `kind` matters for asymmetric models like Cohere Embed. */
export interface Embedder {
  readonly name: string;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

type Fetch = typeof fetch;

/** Cohere Embed v2 API. Batches of 96 (the API limit). */
export class CohereEmbedder implements Embedder {
  readonly name: string;
  constructor(
    private apiKey: string,
    private model = process.env.COHERE_EMBED_MODEL ?? "embed-v4.0",
    private doFetch: Fetch = fetch,
  ) {
    this.name = `cohere:${model}`;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96);
      const res = await this.doFetch("https://api.cohere.com/v2/embed", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-client-name": "job-agent" },
        body: JSON.stringify({ model: this.model, input_type: kind === "query" ? "search_query" : "search_document", texts: batch, embedding_types: ["float"] }),
      });
      if (!res.ok) throw new Error(`Cohere embed failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const d = (await res.json()) as { embeddings: { float: number[][] } };
      out.push(...d.embeddings.float);
    }
    return out.map(normalize);
  }
}

/**
 * Offline fallback: TF-IDF over words and word pairs, hashed into a fixed-size
 * vector. IDF is learned from the documents embedded (the evidence index), so
 * common words like "built" or "tests" count for little. No network and
 * deterministic; the eval suite reports how far behind Cohere it is.
 */
export class LocalEmbedder implements Embedder {
  readonly name = "local:tfidf";
  private df = new Map<string, number>();
  private docs = 0;
  constructor(private dim = 4096) {}

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const grams = texts.map(gramsOf);
    if (kind === "document") {
      for (const g of grams) for (const t of new Set(g)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs += texts.length;
    }
    return grams.map((g) => {
      const v = new Array(this.dim).fill(0);
      const tf = new Map<string, number>();
      for (const t of g) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        const idf = Math.log((1 + this.docs) / (1 + (this.df.get(t) ?? 0))) + 1;
        const h = createHash("md5").update(t).digest();
        v[h.readUInt32LE(0) % this.dim] += (h[4] & 1 ? 1 : -1) * (1 + Math.log(n)) * idf;
      }
      return normalize(v);
    });
  }
}

function gramsOf(text: string): string[] {
  const t = tokens(text);
  return [...t, ...t.slice(1).map((w, i) => `${t[i]}_${w}`)];
}

const STOP = new Set("a an the and or of to in on for with by at from as is are be was were this that it its your you we our their they who what will can using use used via into across over per".split(" "));

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/\.$/, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Tiny suffix stripper so "harnesses"/"harness" and "testing"/"tests" meet. */
export function stem(w: string): string {
  if (w.length <= 3 || /[0-9+#]/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ss")) return w;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Remembers document vectors by model + text hash, so unchanged evidence isn't re-embedded (or re-billed). */
export class CachedEmbedder implements Embedder {
  readonly name: string;
  private cache: Record<string, number[]>;
  constructor(private inner: Embedder, private path: string) {
    this.name = inner.name;
    this.cache = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const key = (t: string) => `${this.inner.name}:${kind}:${createHash("sha1").update(t).digest("hex")}`;
    const missing = [...new Set(texts.filter((t) => !this.cache[key(t)]))];
    if (missing.length) {
      const vecs = await this.inner.embed(missing, kind);
      missing.forEach((t, i) => (this.cache[key(t)] = vecs[i]));
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.cache));
    }
    return texts.map((t) => this.cache[key(t)]);
  }
}
