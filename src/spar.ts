import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { generateQuestions, gradeAnswer } from "./agents/sparring.js";
import type { LLM } from "./llm.js";
import { InterviewQuestionsSchema, JobSchema, type InterviewQuestions, type Job } from "./types.js";

/**
 * Interactive drill: answer the questions, get scored, then get grilled on
 * whichever answer scored lowest until it improves or you run out of rounds.
 */
export async function spar(llm: LLM, dir: string, resumeText: string, opts: { count: number; drillRounds: number }): Promise<void> {
  const job: Job = JobSchema.parse(JSON.parse(readFileSync(join(dir, "job.json"), "utf8")));
  const qPath = join(dir, "questions.json");
  const qs: InterviewQuestions = existsSync(qPath)
    ? InterviewQuestionsSchema.parse(JSON.parse(readFileSync(qPath, "utf8")))
    : await generateQuestions(llm, job, resumeText, []);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const transcript: string[] = [`# Sparring: ${job.title} at ${job.company} (${new Date().toISOString().slice(0, 16)})`];
  const scored: { q: string; a: string; score: number; followUp: string; weakness: string }[] = [];

  try {
    for (const [i, q] of qs.questions.slice(0, opts.count).entries()) {
      console.log(`\nQ${i + 1} [${q.category}] ${q.question}`);
      const a = (await rl.question("> ")).trim();
      if (!a) continue;
      const g = await gradeAnswer(llm, job, q.question, a);
      console.log(`  score ${g.score}/10 · ${g.weakness}`);
      scored.push({ q: q.question, a, ...g });
      transcript.push(`\n## Q${i + 1}: ${q.question}\n**You:** ${a}\n\n**Score:** ${g.score}/10. ${g.weakness}`);
    }
    if (!scored.length) return;

    const weakest = scored.reduce((m, x) => (x.score < m.score ? x : m));
    console.log(`\n=== Grilling your weakest answer (${weakest.score}/10) ===\n${weakest.q}`);
    transcript.push(`\n# Drill on weakest answer (${weakest.score}/10)\n${weakest.q}`);

    let history = `Q: ${weakest.q}\nA: ${weakest.a}\nWeakness: ${weakest.weakness}`;
    let followUp = weakest.followUp;
    for (let r = 1; r <= opts.drillRounds; r++) {
      console.log(`\nFollow-up ${r}: ${followUp}`);
      const a = (await rl.question("> ")).trim();
      if (!a) break;
      const g = await gradeAnswer(llm, job, followUp, a, history);
      console.log(`  score ${g.score}/10 · ${g.weakness}`);
      transcript.push(`\n**Follow-up ${r}:** ${followUp}\n**You:** ${a}\n**Score:** ${g.score}/10. ${g.weakness}`);
      history += `\nQ: ${followUp}\nA: ${a}\nWeakness: ${g.weakness}`;
      if (g.score >= 8) {
        console.log("  Solid. That one's fixed.");
        break;
      }
      followUp = g.followUp;
    }
  } finally {
    rl.close();
    const file = join(dir, `spar-${Date.now()}.md`);
    writeFileSync(file, transcript.join("\n") + "\n");
    console.log(`\nTranscript saved: ${file}`);
  }
}
