import type { Resume } from "../resume.js";
import { CachedEmbedder, CohereEmbedder, LocalEmbedder, type Embedder } from "./embed.js";
import { EvidenceRetriever, noteChunks, resumeChunks } from "./evidence.js";
import { CohereReranker, type Reranker } from "./rerank.js";

export * from "./evidence.js";

/**
 * Cohere Embed + Rerank when COHERE_API_KEY is set (vectors cached on disk so
 * unchanged evidence isn't re-billed), otherwise the offline local embedder.
 */
export function createRetriever(
  resume: Resume,
  opts: { notesDir?: string; cachePath?: string; apiKey?: string } = {},
): EvidenceRetriever {
  const key = opts.apiKey ?? process.env.COHERE_API_KEY;
  const chunks = [...resumeChunks(resume), ...noteChunks(opts.notesDir ?? "config/evidence")];
  let embedder: Embedder = new LocalEmbedder();
  let reranker: Reranker | null = null;
  if (key) {
    embedder = new CachedEmbedder(new CohereEmbedder(key), opts.cachePath ?? "data/embeddings-cache.json");
    reranker = new CohereReranker(key);
  }
  return new EvidenceRetriever(chunks, embedder, reranker);
}
