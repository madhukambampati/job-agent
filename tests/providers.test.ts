import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CohereLLM, createLLM } from "../src/providers.js";
import { FitScoreSchema } from "../src/types.js";

const fitReply = { score: 8, summary: "ok", strengths: ["Playwright"], gaps: [{ requirement: "Go", severity: "Minor", note: "n" }], closeTheGap: [] };
const chatResponse = (obj: unknown, extra: object = {}) => new Response(JSON.stringify({ finish_reason: "COMPLETE", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(obj) }] }, ...extra }));

describe("Cohere Command provider", () => {
  it("sends a v2 chat request with a JSON schema and validates the reply with zod", async () => {
    let sent: any;
    const fake = (async (url: string, init: any) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization }; return chatResponse(fitReply); }) as any;
    const out = await new CohereLLM("k", "command-a-03-2025", fake).structured({ system: "sys", prompt: "p", toolName: "record_fit", toolDescription: "Record fit", schema: FitScoreSchema });
    expect(sent.url).toBe("https://api.cohere.com/v2/chat");
    expect(sent.auth).toBe("Bearer k");
    expect(sent.body.model).toBe("command-a-03-2025");
    expect(sent.body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(sent.body.response_format.type).toBe("json_object");
    expect(sent.body.response_format.json_schema.properties.score.type).toBe("integer");
    expect(out.gaps[0].severity).toBe("minor"); // enum casing normalised
  });

  it("falls back to schema-in-prompt when the API rejects the schema", async () => {
    const bodies: any[] = [];
    const fake = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body); bodies.push(b);
      return b.response_format.json_schema ? new Response("unsupported schema keyword", { status: 400 }) : chatResponse({ a: 1 });
    }) as any;
    const out = await new CohereLLM("k", "m", fake).structured({ system: "s", prompt: "p", toolName: "t", toolDescription: "d", schema: z.object({ a: z.number() }) });
    expect(out).toEqual({ a: 1 });
    expect(bodies[1].messages[0].content).toMatch(/JSON Schema/);
  });

  it("rejects truncated or invalid replies instead of passing them on", async () => {
    const cut = (async () => chatResponse({}, { finish_reason: "MAX_TOKENS" })) as any;
    await expect(new CohereLLM("k", "m", cut).structured({ system: "s", prompt: "p", toolName: "t", toolDescription: "d", schema: z.object({ a: z.number() }) })).rejects.toThrow(/max_tokens/);
    const wrong = (async () => chatResponse({ a: "nope" })) as any;
    await expect(new CohereLLM("k", "m", wrong).structured({ system: "s", prompt: "p", toolName: "t", toolDescription: "d", schema: z.object({ a: z.number() }) })).rejects.toThrow();
  });

  it("createLLM picks the provider and explains a missing key", () => {
    const prev = { ...process.env };
    try {
      delete process.env.COHERE_API_KEY;
      expect(() => createLLM("cohere")).toThrow(/COHERE_API_KEY/);
      process.env.COHERE_API_KEY = "k";
      expect(createLLM("cohere")).toBeTruthy();
    } finally {
      process.env = prev;
    }
  });
});
