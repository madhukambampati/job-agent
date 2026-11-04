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
  research(req: ResearchRequest): Promise<ResearchResult>;
}

export interface ResearchRequest {
  system: string;
  prompt: string;
  maxSearches?: number;
  /** Restrict web search to these domains (e.g. the ATS job boards). */
  allowedDomains?: string[];
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

type JsonSchema = Record<string, any>;

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern", "$schema"];

/**
 * Converts a zod schema to the subset the structured-output API accepts:
 * numeric/length limits move into the description (zod still enforces them),
 * every object gets additionalProperties:false, minItems only 0 or 1.
 */
export function toApiSchema(schema: z.ZodType): JsonSchema {
  const walk = (node: JsonSchema): JsonSchema => {
    if (Array.isArray(node)) return node.map(walk) as unknown as JsonSchema;
    if (!node || typeof node !== "object") return node;
    const out: JsonSchema = {};
    const notes: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED.includes(k)) {
        if (k !== "$schema" && Math.abs(Number(v)) < 1e12) notes.push(`${k}: ${v}`);
        continue;
      }
      if (k === "minItems" && Number(v) > 1) {
        notes.push(`minItems: ${v}`);
        continue;
      }
      out[k] = typeof v === "object" ? walk(v) : v;
    }
    if (out.type === "object") out.additionalProperties = false;
    if (notes.length) out.description = [out.description, `(${notes.join(", ")})`].filter(Boolean).join(" ");
    return out;
  };
  return walk(z.toJSONSchema(schema, { io: "output" }) as JsonSchema);
}

/** The API may change enum casing ("Technical" vs "technical"); map back to the schema's spelling. */
export function normalizeEnums(value: unknown, schema: JsonSchema): unknown {
  if (!schema || typeof schema !== "object") return value;
  if (Array.isArray(schema.enum) && typeof value === "string") {
    return schema.enum.find((e: unknown) => typeof e === "string" && e.toLowerCase() === value.toLowerCase()) ?? value;
  }
  if (Array.isArray(value) && schema.items) return value.map((v) => normalizeEnums(v, schema.items));
  if (value && typeof value === "object" && schema.properties) {
    const o = value as Record<string, unknown>;
    for (const k of Object.keys(o)) if (schema.properties[k]) o[k] = normalizeEnums(o[k], schema.properties[k]);
  }
  return value;
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
    // Bounded so a slow call surfaces as an error instead of a spinner that never ends.
    this.client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  }

  /**
   * Uses the API's native JSON-schema output mode (output_config.format), which
   * every current model supports, unlike forced tool_choice. The zod schema is
   * still the final word: the reply is validated against it after parsing.
   */
  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const schema = toApiSchema(req.schema);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: `${req.system}\n\nRespond with JSON only. Task: ${req.toolDescription}`,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { format: { type: "json_schema", schema } },
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);
    if (res.stop_reason === "max_tokens") throw new Error(`${req.toolName}: reply hit max_tokens (${req.maxTokens ?? 4096}); raise it`);
    if (res.stop_reason === "refusal") throw new Error(`${req.toolName}: model declined this request`);
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const raw = JSON.parse(text);
    return req.schema.parse(normalizeEnums(raw, z.toJSONSchema(req.schema, { io: "output" }) as JsonSchema));
  }

  async research(req: ResearchRequest): Promise<ResearchResult> {
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
          ...(req.allowedDomains ? { allowed_domains: req.allowedDomains } : {}),
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
