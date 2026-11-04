import type { LLM } from "../llm.js";
import {
  AnswerGradeSchema,
  InterviewQuestionsSchema,
  type AnswerGrade,
  type InterviewQuestions,
  type Job,
} from "../types.js";

const QUESTION_SYSTEM = `You are THE SPARRING PARTNER, a hiring manager for this exact role.
Turn the posting into the 10 questions this team is most likely to ask in interviews.
Mix: at least 4 technical/role-specific, 2 behavioral, 1 system-design or test-strategy, 1 about the company.
Make them specific to the posting's stack and problems, not generic ("tell me about yourself" is banned).
Bias toward the candidate's gaps listed below: those are where real interviewers will probe.`;

const GRADER_SYSTEM = `You are THE SPARRING PARTNER grading one interview answer like a tough but fair hiring manager.
Score 1-10. Name the single biggest weakness (vague, no example, no outcome, wrong depth, rambling, factual error).
Then ask ONE follow-up question that pushes on exactly that weakness. Do not coach; probe.`;

export async function generateQuestions(llm: LLM, job: Job, resumeText: string, gaps: string[]): Promise<InterviewQuestions> {
  return llm.structured({
    system: QUESTION_SYSTEM,
    toolName: "record_questions",
    toolDescription: "Record exactly 10 likely interview questions.",
    schema: InterviewQuestionsSchema,
    maxTokens: 3000,
    prompt: `ROLE: ${job.title} at ${job.company}
POSTING:
${job.description.slice(0, 10000)}

CANDIDATE GAPS: ${gaps.join("; ") || "none flagged"}

CANDIDATE RESUME:
${resumeText.slice(0, 8000)}`,
  });
}

export async function gradeAnswer(llm: LLM, job: Job, question: string, answer: string, history = ""): Promise<AnswerGrade> {
  return llm.structured({
    system: GRADER_SYSTEM,
    toolName: "grade_answer",
    toolDescription: "Grade the answer and ask one follow-up on its weakest point.",
    schema: AnswerGradeSchema,
    maxTokens: 800,
    prompt: `ROLE: ${job.title} at ${job.company}
${history ? `EARLIER IN THIS DRILL:\n${history}\n` : ""}QUESTION: ${question}
ANSWER: ${answer}`,
  });
}

export function questionsMarkdown(job: Job, q: InterviewQuestions): string {
  return [
    `# Likely interview questions: ${job.title} at ${job.company}`,
    "",
    ...q.questions.map((x, i) => `${i + 1}. **${x.question}**  \n   _${x.category}_ · ${x.whyTheyAsk}`),
    "",
    "Run `job-agent spar <this folder>` to get grilled on them.",
    "",
  ].join("\n");
}
