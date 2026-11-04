import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Every agent talks to the model through this one seam. Structured output is
 * forced via tool_choice and validated with zod, so callers get typed data,
 * never prose they have to regex. Tests swap in a fake implementation.
 */
export interface LLM {
  structured<T>(req: StructuredRequest<T>): Promise<T>;
  /** Free-form answer with Claude's server-side web search enabled. */
  research(req: { system: string; prompt: string; maxSearches?: number }): Promise<ResearchResult>;
}

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface ResearchResult {
  text: string;
  sources: { title: string; url: string }[];
}

export const DEFAULT_MODEL = process.env.JOB_AGENT_MODEL ?? "claude-sonnet-5-5";
export const WEB_SEARCH_TOOL = process.env.JOB_AGENT_WEB_SEARCH_TOOL ?? "web_search_20260318";

export class AnthropicLLM implements LLM {
  private client: Anthropic;

  constructor(
    private model: string = DEFAULT_MODEL,
    apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
    this.client = new Anthropic({ apiKey });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const inputSchema = z.toJSONSchema(req.schema, { target: "draft-7" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      tools: [
        {
          name: req.toolName,
          description: req.toolDescription,
          input_schema: inputSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: req.toolName },
      messages: [{ role: "user", content: req.prompt }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error(`Model did not call ${req.toolName}`);
    return req.schema.parse(block.input);
  }

  async research(req: { system: string; prompt: string; maxSearches?: number }): Promise<ResearchResult> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      // Server-side web search; "direct" keeps it usable without the code-execution tool.
      tools: [
        {
          type: WEB_SEARCH_TOOL,
          name: "web_search",
          max_uses: req.maxSearches ?? 6,
          allowed_callers: ["direct"],
        } as unknown as Anthropic.ToolUnion,
      ],
      messages: [{ role: "user", content: req.prompt }],
    });

    const text: string[] = [];
    const sources = new Map<string, string>();
    for (const block of res.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "text") {
        text.push(String(block.text));
        for (const c of (block.citations as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof c.url === "string") sources.set(c.url, String(c.title ?? c.url));
        }
      }
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content as Array<Record<string, unknown>>) {
          if (typeof r.url === "string" && !sources.has(r.url)) sources.set(r.url, String(r.title ?? r.url));
        }
      }
    }
    return {
      text: text.join("").trim(),
      sources: [...sources].map(([url, title]) => ({ url, title })),
    };
  }
}
