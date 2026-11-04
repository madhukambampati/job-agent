import type { Fetcher } from "../src/jobs/fetch.js";
import { FakeLLM } from "./helpers.js";

/**
 * A tiny fake job market used by tests and `npm run demo`: five Lever postings
 * (three that should match "SDET / QA remote Canada", one US-only, one contract),
 * a fake model that understands the request, and a fetcher that serves them.
 */
export const FAKE_POSTINGS = [
  { site: "northwind", id: "nw-1", text: "Senior SDET", loc: "Remote - Canada", pay: { currency: "CAD", min: 120000, max: 150000, interval: "per-year-salary" } },
  { site: "maplesoft", id: "ms-2", text: "QA Automation Engineer", loc: "Toronto, Ontario", workplace: "remote" },
  { site: "lakeside", id: "ls-3", text: "Lead Software Engineer in Test", loc: "Remote, Canada" },
  { site: "globex", id: "gx-4", text: "SDET II", loc: "Remote - US" },
  { site: "initech", id: "it-5", text: "QA Engineer (Contract)", loc: "Remote - Canada" },
];

export function fakeMarket(applyUrl: string): { llm: FakeLLM; fetcher: Fetcher } {
  const llm = new FakeLLM(
    {
      parse_search: (p: string) =>
        /application|status|applied/i.test(p)
          ? { intent: "ledger", titles: [], country: "", places: [], workplace: "any", exclude: [] }
          : { intent: "search", titles: ["SDET", "Software Engineer in Test", "QA Automation", "QA Engineer"], country: "Canada", places: [], workplace: "remote", exclude: [] },
      record_fit: (p: string) =>
        /Lead Software Engineer in Test/.test(p)
          ? { score: 6, summary: "Lead role wants people management you haven't shown.", strengths: ["Automation depth"], gaps: [{ requirement: "Managing a team of 6", severity: "major", note: "Not on resume" }] }
          : { score: 8, summary: "Strong Playwright and API automation match.", strengths: ["Playwright + TypeScript", "API testing"], gaps: [{ requirement: "Go", severity: "minor", note: "Not on resume" }] },
      record_edit: {
        roles: [{ roleId: "r1", bulletOrder: ["r1.b2", "r1.b1", "r1.b3"], rewrites: [] }],
        summary: "Senior SDET with 8 years of test automation.",
        coverNote: "I built a Playwright framework and an LLM evaluation harness, which maps to your automation work.",
        unsupportedRequirements: ["Go"],
      },
      record_questions: {
        questions: Array.from({ length: 10 }, (_, i) => ({ question: `Sample question ${i + 1}: how would you test our checkout flow?`, category: "technical", whyTheyAsk: "Core to the role" })),
      },
      fill_fields: (p: string) => ({
        answers: [...p.matchAll(/id=(f\d+).*?label="([^"]*)"/g)].map(([, id, l]) => ({ fieldId: id, value: /why/i.test(l) ? "Your automation work matches the Playwright framework I built." : "UNKNOWN", basis: "cover note" })),
      }),
      grade_answer: { score: 5, weakness: "No concrete example or outcome.", followUp: "Give me one specific bug that framework caught, and what happened next?" },
    },
    (prompt) =>
      /Return up to 25 posting URLs/.test(prompt)
        ? FAKE_POSTINGS.map((p) => `https://jobs.lever.co/${p.site}/${p.id}`).join("\n")
        : "## What they do\nSample company.\n\n## Last 90 days\n- 2026-10-20: Shipped a new product.\n\n## Who leads the team\nnot found",
  );

  const fetcher: Fetcher = async (url: string) => {
    const m = /api\.lever\.co\/v0\/postings\/([^/?]+)\/([^/?]+)/.exec(url);
    const p = m && FAKE_POSTINGS.find((x) => x.site === m[1] && x.id === m[2]);
    const body = p
      ? {
          id: p.id, text: p.text, hostedUrl: `https://jobs.lever.co/${p.site}/${p.id}`, applyUrl,
          categories: { location: p.loc, commitment: "Full-time" }, workplaceType: p.workplace ?? "",
          descriptionPlain: `${p.text} at ${p.site}. Playwright, TypeScript, API testing.`, lists: [], salaryRange: p.pay,
        }
      : null;
    // Board listings (remembered boards) return nothing in the fake market.
    if (/api\.lever\.co\/v0\/postings\/[^/]+\?mode=json/.test(url)) return { ok: true, status: 200, json: async () => [], text: async () => "" };
    return { ok: !!body, status: body ? 200 : 404, json: async () => body, text: async () => "" };
  };
  return { llm, fetcher };
}
