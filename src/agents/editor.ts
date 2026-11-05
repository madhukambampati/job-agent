import type { LLM } from "../llm.js";
import { resumeForPrompt, type Resume, type Role } from "../resume.js";
import { EditorOutputSchema, type EditorOutput, type FitScore, type Job } from "../types.js";

const SYSTEM = `You are THE EDITOR. You tailor an existing resume to one job. You are an editor, not a writer:
you may only reorder and lightly reword what is already true.

You must:
- For every role, return bulletOrder: ALL of that role's bullet ids, most relevant to this job first.
- Optionally rewrite up to 2 bullets per role to surface JD language, but only using facts, tools and numbers
  already present in the resume. List every JD keyword you worked in under keywordsUsed.
- Write a 2-3 sentence summary for the top of the resume, built only from resume facts.
- Draft a cover note: 120-170 words, plain and specific, no "I am thrilled", no restating the resume.
  Mention one concrete thing that maps the candidate's real experience to this team's problem.
- List requirements from the posting the resume does not support in unsupportedRequirements.

You must never:
- Add a tool, language, certification, metric, title, or year of experience that is not in the resume.
- Inflate scope ("led" when the resume says "contributed", new percentages, bigger team sizes).
Anything you add that is not in the resume will be detected and thrown away.`;

export interface EditResult {
  output: EditorOutput;
  /** Rewrites the honesty guard threw out, with the reason. Shown to the user. */
  rejected: { where: string; text: string; reason: string }[];
}

export async function tailor(llm: LLM, job: Job, resume: Resume, fit: FitScore, evidence = ""): Promise<EditResult> {
  const raw = await llm.structured({
    system: SYSTEM,
    toolName: "record_edit",
    toolDescription: "Record the re-ranked bullets, safe rewrites, summary, cover note and unsupported requirements.",
    schema: EditorOutputSchema,
    maxTokens: 6000,
    prompt: `JOB: ${job.title} at ${job.company}
POSTING:
${job.description.slice(0, 12000)}

FILTER NOTES (gaps to be honest about): ${fit.gaps.map((g) => `${g.requirement} (${g.severity})`).join("; ") || "none"}
${evidence ? `\nEVIDENCE MAP (which of the candidate's own bullets support each requirement; lead with these, and list every NO EVIDENCE requirement in unsupportedRequirements):\n${evidence}\n` : ""}
RESUME (bullet ids in brackets):
${resumeForPrompt(resume)}`,
  });
  return guardEdits(raw, resume);
}

/**
 * The honesty guard. Runs in code after the model, so a fabricated claim can
 * never reach the PDF no matter what the prompt or model does.
 */
export function guardEdits(raw: EditorOutput, resume: Resume): EditResult {
  const rejected: EditResult["rejected"] = [];
  const roles = raw.roles.filter((r) => resume.roles.some((x) => x.id === r.roleId));

  // Every role must be present, with every original bullet exactly once.
  const fixedRoles = resume.roles.map((orig) => {
    const proposed = roles.find((r) => r.roleId === orig.id);
    const valid = new Set(orig.bullets.map((b) => b.id));
    const seen = new Set<string>();
    const order = (proposed?.bulletOrder ?? []).filter((id) => valid.has(id) && !seen.has(id) && seen.add(id));
    for (const b of orig.bullets) if (!seen.has(b.id)) order.push(b.id);

    const rewrites = (proposed?.rewrites ?? []).filter((rw) => {
      const source = orig.bullets.find((b) => b.id === rw.bulletId);
      if (!source) {
        rejected.push({ where: rw.bulletId, text: rw.text, reason: "unknown bullet id" });
        return false;
      }
      const problem = honestyProblem(rw.text, source.text, resume.corpus, rw.keywordsUsed);
      if (problem) rejected.push({ where: rw.bulletId, text: rw.text, reason: problem });
      return !problem;
    });
    return { roleId: orig.id, bulletOrder: order, rewrites };
  });

  let summary = raw.summary;
  const summaryProblem = honestyProblem(summary, resume.summary, resume.corpus, []);
  if (summaryProblem) {
    rejected.push({ where: "summary", text: summary, reason: summaryProblem });
    summary = resume.summary;
  }

  // The cover note names the employer and its products, so only numbers and tech terms are checked.
  const coverProblem = honestyProblem(raw.coverNote, "", resume.corpus, [], { checkNumbersAgainstCorpus: true, allowNewProperNouns: true });
  if (coverProblem) rejected.push({ where: "coverNote", text: raw.coverNote, reason: `${coverProblem} (kept; review before sending)` });

  return { output: { ...raw, roles: fixedRoles, summary }, rejected };
}

/** Returns why `text` makes a claim the resume can't back, or null if it's clean. */
export function honestyProblem(
  text: string,
  sourceText: string,
  corpus: string,
  keywordsUsed: string[],
  opts: { checkNumbersAgainstCorpus?: boolean; allowNewProperNouns?: boolean } = {},
): string | null {
  for (const k of keywordsUsed) {
    if (!hasWord(corpus, k)) return `keyword "${k}" is not in the base resume`;
  }
  // Numbers (metrics, years, team sizes) must already exist in the source bullet (or anywhere, for summaries/notes).
  const numberSource = opts.checkNumbersAgainstCorpus || !sourceText ? corpus : sourceText.toLowerCase() + " " + corpus;
  for (const n of text.match(/\d+(?:[.,]\d+)?\s*%?/g) ?? []) {
    if (!hasWord(numberSource, n.trim())) return `number "${n.trim()}" is not in the base resume`;
  }
  // Tech-looking tokens (TypeScript, C#, Node.js, k8s, AWS...) must already appear in the resume.
  for (const tok of techTokens(text)) {
    if (!hasWord(corpus, tok)) return `term "${tok}" is not in the base resume`;
  }
  // Plain capitalised names mid-sentence (Kubernetes, Jenkins, Terraform) must already appear too.
  if (!opts.allowNewProperNouns) {
    for (const tok of properNouns(text)) {
      if (!hasWord(corpus, tok)) return `term "${tok}" is not in the base resume`;
    }
  }
  return null;
}

const ORDINARY_CAPS = new Set([
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "English",
]);

/** Capitalised words that don't start a sentence: almost always product, tool or company names. */
/** Capitalised two-letter words that are just English, not names (Go, R and C# are names). */
const SHORT_WORDS = new Set(["In", "At", "To", "Of", "On", "As", "By", "Or", "An", "If", "It", "Is", "We", "My", "So", "Up", "Do", "No", "Be", "He", "Me", "Us"]);

/**
 * Whole-word match. Substring matching let "Go" pass because the resume says
 * "golden", and "Java" pass because it says "JavaScript".
 */
export function hasWord(corpus: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return true;
  const e = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9+#])${e}($|[^a-z0-9+#])`).test(corpus.toLowerCase());
}

export function properNouns(text: string): string[] {
  const out = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n+/)) {
    const words = sentence.split(/\s+/).slice(1);
    for (const w of words) {
      const tok = w.replace(/^[^A-Za-z]+|[^A-Za-z0-9#+.]+$|\.$/g, "");
      if ((/^[A-Z][a-z]{2,}/.test(tok) || /^[A-Z][a-z]$/.test(tok)) && !ORDINARY_CAPS.has(tok) && !COMMON_CAPS.has(tok) && !SHORT_WORDS.has(tok)) out.add(tok);
    }
  }
  return [...out];
}

const COMMON_CAPS = new Set(["I", "A", "An", "The", "QA", "AI", "UI", "API", "APIs", "CI", "CD", "CI/CD", "SDET", "LLM", "LLMs"]);

export function techTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;:()"“”]+/)) {
    const tok = raw.replace(/^[^\w#+.]+|[.]+$|[^\w#+.]+$/g, "");
    if (tok.length < 2 || COMMON_CAPS.has(tok)) continue;
    const techy =
      /[#+]/.test(tok) || // C#, C++
      /\w\.\w/.test(tok) || // Node.js, ASP.NET
      /[a-z][A-Z]/.test(tok) || // TypeScript, GitHub, PyTest
      /^[A-Z]{2,}\d*$/.test(tok) || // AWS, GCP, SQL, K8S
      /[A-Za-z]\d|\d[A-Za-z]/.test(tok); // k8s, S3, EC2
    if (techy && !/^\d+(st|nd|rd|th|k|x|s)$/i.test(tok)) out.add(tok);
  }
  return [...out];
}

/** Applies the guarded edit to produce the role list in final order with rewrites swapped in. */
export function applyEdits(resume: Resume, edit: EditorOutput): Role[] {
  return resume.roles.map((role) => {
    const plan = edit.roles.find((r) => r.roleId === role.id);
    if (!plan) return role;
    return {
      ...role,
      bullets: plan.bulletOrder.map((id) => {
        const b = role.bullets.find((x) => x.id === id)!;
        const rw = plan.rewrites.find((r) => r.bulletId === id);
        return rw ? { id, text: rw.text } : b;
      }),
    };
  });
}
