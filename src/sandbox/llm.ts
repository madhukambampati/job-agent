import type { LLM, ResearchRequest, ResearchResult, StructuredRequest } from "../llm.js";
import { CLOSED_URL, POSTINGS, publicUrl } from "./postings.js";

/**
 * Web search is always faked in sandbox mode: "find postings" returns the
 * dummy postings (plus one closed one), and company briefings say plainly
 * that the company is fictional. Nothing is searched for real.
 */
export function sandboxResearch(req: ResearchRequest): ResearchResult {
  if (/posting URLs/i.test(req.prompt)) {
    return { text: [...POSTINGS.map(publicUrl), CLOSED_URL].join("\n"), sources: [] };
  }
  const company = /Company:\s*(.+)/.exec(req.prompt)?.[1]?.trim() ?? "This company";
  return {
    text: `## What they do\n${company} is a fictional sandbox company.\n\n## Last 90 days\nnot found (sandbox)\n\n## Who leads the team\nnot found (sandbox)\n\n## Engineering / quality signals\nnot found (sandbox)\n\n## 3 sharp questions to ask them\n- How is quality owned across teams?\n- What does your release process look like?\n- What would success look like in the first 90 days?`,
    sources: [],
  };
}

/** Real Claude for every judgment (fit, tailoring, answers), fake web search. */
export class SandboxLLM implements LLM {
  constructor(private real: LLM) {}
  structured<T>(req: StructuredRequest<T>): Promise<T> {
    return this.real.structured(req);
  }
  async research(req: ResearchRequest): Promise<ResearchResult> {
    return sandboxResearch(req);
  }
}

/**
 * No API key needed: rough keyword heuristics so the whole flow can be
 * clicked through offline. Scores are not meaningful; use real mode for that.
 */
export class OfflineLLM implements LLM {
  async research(req: ResearchRequest): Promise<ResearchResult> {
    return sandboxResearch(req);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const p = req.prompt;
    const out = ((): unknown => {
      switch (req.toolName) {
        case "parse_search": {
          const m = p.toLowerCase();
          if (/application|applied|status|ledger/.test(m)) return { intent: "ledger", titles: [], country: "", places: [], workplace: "any", exclude: [] };
          const ai = /\bai\b|llm|eval/.test(m);
          const titles = ai
            ? ["Evals", "Evaluation", "AI Quality", "LLM", "Quality Engineer", "Software Engineer in Test"]
            : ["SDET", "Software Engineer in Test", "Software Development Engineer in Test", "QA Automation", "QA Engineer", "Quality Assurance", "Quality Engineer", "Test Automation"];
          const places = ["toronto", "ottawa", "vancouver", "kitchener", "waterloo", "montreal"].filter((c) => m.includes(c)).map((c) => c[0].toUpperCase() + c.slice(1));
          const country = /canada|ontario|toronto|ottawa|vancouver|kitchener|waterloo|montreal/.test(m) ? "Canada" : /\bus\b|usa|united states/.test(m) ? "United States" : "";
          const workplace = /remote/.test(m) ? "remote" : /hybrid/.test(m) ? "hybrid" : /on-?site|office/.test(m) ? "onsite" : "any";
          return { intent: titles.length ? "search" : "help", titles, country, places, workplace, exclude: [] };
        }
        case "record_fit": {
          const posting = (/POSTING:\n([\s\S]*?)\n\nRESUME:/.exec(p)?.[1] ?? "").toLowerCase();
          const resume = (/RESUME:\n([\s\S]*)$/.exec(p)?.[1] ?? "").toLowerCase();
          const skills = ["playwright", "cypress", "selenium", "typescript", "python", "api", "sql", "ci/cd", "github actions", "jenkins", "llm", "evaluation", "golden dataset", "appium", "jmeter", "postman", "rest assured", "kafka", "kubernetes"];
          const asked = skills.filter((s) => posting.includes(s));
          const have = asked.filter((s) => resume.includes(s));
          const gaps = ["go", "bazel", "managing a team", "hiring and performance", "budget", "security clearance", "red-teaming", "pci dss"].filter((g) => posting.includes(g) && !resume.includes(g));
          let score = 4 + Math.min(5, have.length) - Math.min(3, gaps.length);
          if (/managing a team|hiring and performance/.test(posting)) score = Math.min(score, 5);
          score = Math.max(1, Math.min(10, score));
          return {
            score,
            summary: `Offline estimate: matches ${have.length} of ${asked.length || 0} listed skills${gaps.length ? `; missing ${gaps.join(", ")}` : ""}. Run sandbox with your API key for a real assessment.`,
            strengths: have.slice(0, 4),
            gaps: gaps.map((g) => ({ requirement: g, severity: /managing|hiring|clearance/.test(g) ? "major" : "minor", note: "Not on the resume" })),
          };
        }
        case "record_edit": {
          const roles = [...p.matchAll(/^\[(r\d+)\][^\n]*\n((?:\s+\[r\d+\.b\d+\][^\n]*\n?)*)/gm)].map(([, roleId, block]) => ({
            roleId,
            bulletOrder: [...block.matchAll(/\[(r\d+\.b\d+)\]/g)].map((x) => x[1]),
            rewrites: [],
          }));
          const company = /^JOB: .+ at (.+)$/m.exec(p)?.[1] ?? "your team";
          const summary = /SUMMARY: (.+)/.exec(p)?.[1] ?? "";
          return {
            roles,
            summary,
            coverNote: `I'm applying for this role at ${company}. My background is in building UI and API test automation and wiring it into CI so teams get fast, trustworthy feedback. (Offline sandbox note: run with your API key for a tailored cover note.)`,
            unsupportedRequirements: [],
          };
        }
        case "record_questions": {
          const role = /ROLE: (.+)/.exec(p)?.[1] ?? "this role";
          const qs = [
            "Walk me through a test automation framework you designed. What would you change now?",
            "How do you decide what to automate and what to leave manual?",
            "Tell me about a flaky test you tracked down to its root cause.",
            "How would you test a feature whose output isn't deterministic, like an LLM response?",
            "Describe a time you disagreed with a developer about a bug's severity.",
            "How do you validate data consistency across services?",
            "What does a healthy CI pipeline look like to you?",
            "How would you build a test strategy for a brand-new service?",
            "Tell me about a release you pushed back on.",
            `What would you test first in your first month in ${role}?`,
          ];
          return { questions: qs.map((question, i) => ({ question, category: [4, 8].includes(i) ? "behavioral" : i === 9 ? "company" : "technical", whyTheyAsk: "Common for this kind of role" })) };
        }
        case "fill_fields": {
          const company = /Cover note: .*? at (.+?)\./.exec(p)?.[1] ?? "your company";
          return {
            answers: [...p.matchAll(/id=(f\d+).*?label="([^"]*)"/g)].map(([, id, label]) => ({
              fieldId: id,
              value: /why do you want/i.test(label) ? `I build test automation that teams trust, and ${company}'s product is the kind of system where that matters.` : "UNKNOWN",
              basis: "cover note",
            })),
          };
        }
        case "grade_answer": {
          const a = /ANSWER: ([\s\S]*)$/.exec(p)?.[1] ?? "";
          const concrete = /\d|for example|for instance|we |i built|i found|result/i.test(a);
          const score = a.length < 80 ? 4 : concrete ? 8 : 6;
          return {
            score,
            weakness: score >= 8 ? "Solid: concrete and specific." : a.length < 80 ? "Too short: no example or outcome." : "No concrete example or measurable result.",
            followUp: "Give me one specific example, what you did, and what changed because of it.",
          };
        }
      }
      throw new Error(`Offline sandbox has no answer for ${req.toolName}`);
    })();
    return req.schema.parse(out);
  }
}
