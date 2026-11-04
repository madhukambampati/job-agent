import type { LLM } from "../llm.js";
import type { Briefing, Job } from "../types.js";

const SYSTEM = `You are THE BRIEFING WRITER. You prepare a one-page company briefing for a candidate
who is about to apply and may interview soon. Use web search. Today is ${new Date().toISOString().slice(0, 10)}.

Cover, in this order, as tight markdown (max ~450 words):
## What they do (2-3 lines)
## Last 90 days: news, launches, funding, layoffs, leadership changes (dated bullets, newest first)
## Who leads the team this role sits in (names + titles only if a source says so; otherwise say "not found")
## Engineering / quality signals (stack, eng blog posts, testing culture, incidents)
## 3 sharp questions to ask them

Rules:
- Every factual claim must come from a search result. If you could not find something, say "not found". Never guess names.
- Only include items from the last 90 days in that section; skip older items.
- No filler, no praise of the company.`;

export async function writeBriefing(llm: LLM, job: Job): Promise<Briefing> {
  const res = await llm.research({
    system: SYSTEM,
    maxSearches: 8,
    prompt: `Company: ${job.company}
Role: ${job.title} (${job.location})
Posting URL: ${job.url}
Posting excerpt (for team / product context):
${job.description.slice(0, 3000)}`,
  });
  const sources = res.sources.slice(0, 15);
  const md = `# ${job.company} briefing: ${job.title}\n\n${res.text}\n\n### Sources\n${sources.map((s) => `- [${s.title}](${s.url})`).join("\n") || "- none returned"}\n`;
  return { markdown: md, sources };
}
