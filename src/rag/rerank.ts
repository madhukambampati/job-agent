/** Re-orders candidate passages for one query; returns indexes into `docs` with a 0..1 relevance. */
export interface Reranker {
  readonly name: string;
  rerank(query: string, docs: string[], topN: number): Promise<{ index: number; score: number }[]>;
}

/** Cohere Rerank v2 API. */
export class CohereReranker implements Reranker {
  readonly name: string;
  constructor(
    private apiKey: string,
    private model = process.env.COHERE_RERANK_MODEL ?? "rerank-v3.5",
    private doFetch: typeof fetch = fetch,
  ) {
    this.name = `cohere:${model}`;
  }
  async rerank(query: string, docs: string[], topN: number) {
    if (!docs.length) return [];
    const res = await this.doFetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-client-name": "job-agent" },
      body: JSON.stringify({ model: this.model, query, documents: docs, top_n: Math.min(topN, docs.length) }),
    });
    if (!res.ok) throw new Error(`Cohere rerank failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const d = (await res.json()) as { results: { index: number; relevance_score: number }[] };
    return d.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }
}
