import { z } from "zod";
import { AnthropicLLM, normalizeEnums, toApiSchema, type LLM, type ResearchRequest, type ResearchResult, type StructuredRequest } from "./llm.js";

/**
 * Cohere Command through the v2 Chat API with JSON-schema output. The zod
 * schema is still the final word: every reply is validated after parsing.
 */
export class CohereLLM implements LLM {
  constructor(
    private apiKey: string,
    private model = process.env.COHERE_CHAT_MODEL ?? "command-a-03-2025",
    private doFetch: typeof fetch = fetch,
  ) {}

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const schema = toApiSchema(req.schema);
    const system = `${req.system}\n\nRespond with a single JSON object only. Task: ${req.toolDescription}`;
    const call = (withSchema: boolean) =>
      this.doFetch("https://api.cohere.com/v2/chat", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-client-name": "job-agent" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 4096,
          messages: [
            { role: "system", content: withSchema ? system : `${system}\nThe JSON must match this JSON Schema:\n${JSON.stringify(schema)}` },
            { role: "user", content: req.prompt },
          ],
          response_format: withSchema ? { type: "json_object", json_schema: schema } : { type: "json_object" },
        }),
      });
    let res = await call(true);
    // Some schema keywords may be rejected; fall back to schema-in-prompt (zod still validates).
    if (res.status === 400) res = await call(false);
    if (!res.ok) throw new Error(`Cohere chat failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const d = (await res.json()) as { finish_reason?: string; message?: { content?: { type: string; text?: string }[] } };
    if (d.finish_reason === "MAX_TOKENS") throw new Error(`${req.toolName}: reply hit max_tokens (${req.maxTokens ?? 4096}); raise it`);
    const text = (d.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const raw = JSON.parse(text);
    return req.schema.parse(normalizeEnums(raw, z.toJSONSchema(req.schema, { io: "output" }) as Record<string, unknown>));
  }

  async research(): Promise<ResearchResult> {
    throw new Error("Web research uses Claude's web search tool; add ANTHROPIC_API_KEY to use briefings and job discovery with the Cohere provider");
  }
}

/** Judgments from one provider, web research from Claude when a key is there. */
class SplitLLM implements LLM {
  constructor(private judge: LLM, private researcher: LLM | null) {}
  structured<T>(req: StructuredRequest<T>): Promise<T> {
    return this.judge.structured(req);
  }
  research(req: ResearchRequest): Promise<ResearchResult> {
    return this.researcher ? this.researcher.research(req) : this.judge.research(req);
  }
}

/**
 * JOB_AGENT_PROVIDER=cohere uses Command for every agent decision (fit, editor,
 * answers, interview prep); anything else uses Claude. Web search always goes
 * through Claude when ANTHROPIC_API_KEY is set.
 */
export function createLLM(provider = process.env.JOB_AGENT_PROVIDER ?? "anthropic"): LLM {
  if (provider === "cohere") {
    const key = process.env.COHERE_API_KEY;
    if (!key) throw new Error("JOB_AGENT_PROVIDER=cohere needs COHERE_API_KEY in .env");
    return new SplitLLM(new CohereLLM(key), process.env.ANTHROPIC_API_KEY ? new AnthropicLLM() : null);
  }
  return new AnthropicLLM();
}
