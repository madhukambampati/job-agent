import { z } from "zod";

/** Applicant tracking systems the submitter knows how to drive. */
export const AtsSchema = z.enum(["greenhouse", "lever", "ashby", "unknown"]);
export type Ats = z.infer<typeof AtsSchema>;

export const JobQuestionSchema = z.object({
  label: z.string(),
  required: z.boolean(),
  type: z.string(),
  options: z.array(z.string()).default([]),
});
export type JobQuestion = z.infer<typeof JobQuestionSchema>;

export const JobSchema = z.object({
  id: z.string(),
  ats: AtsSchema,
  company: z.string(),
  title: z.string(),
  location: z.string(),
  description: z.string(),
  url: z.string(),
  applyUrl: z.string(),
  compensation: z.string().optional(),
  employmentType: z.string().optional(),
  /** Application questions when the ATS exposes them publicly (Greenhouse does). */
  questions: z.array(JobQuestionSchema).default([]),
});
export type Job = z.infer<typeof JobSchema>;

// ---- Agent 1: the filter ----------------------------------------------------
export const FitScoreSchema = z.object({
  score: z.number().int().min(1).max(10),
  summary: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(
    z.object({
      requirement: z.string(),
      severity: z.enum(["dealbreaker", "major", "minor"]),
      note: z.string(),
    }),
  ),
  /** Concrete, honest steps that would raise this score (learn, build, or surface real experience). */
  closeTheGap: z
    .array(
      z.object({
        gap: z.string(),
        action: z.string(),
        kind: z.enum(["surface-existing", "learn", "build-proof"]),
      }),
    )
    .default([]),
});
export type FitScore = z.infer<typeof FitScoreSchema>;

// ---- Agent 2: the briefing writer ------------------------------------------
export const BriefingSchema = z.object({
  markdown: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
});
export type Briefing = z.infer<typeof BriefingSchema>;

// ---- Agent 3: the editor ---------------------------------------------------
export const EditorOutputSchema = z.object({
  /** Bullet ids from the base resume, in the order they should appear for each role. */
  roles: z.array(
    z.object({
      roleId: z.string(),
      bulletOrder: z.array(z.string()),
      rewrites: z
        .array(
          z.object({
            bulletId: z.string(),
            text: z.string(),
            /** Every JD keyword this rewrite introduces. Each must already exist in the base resume. */
            keywordsUsed: z.array(z.string()),
          }),
        )
        .default([]),
    }),
  ),
  summary: z.string(),
  coverNote: z.string(),
  /** JD requirements the base resume genuinely does not support. Flagged, never papered over. */
  unsupportedRequirements: z.array(z.string()),
});
export type EditorOutput = z.infer<typeof EditorOutputSchema>;

// ---- Agent 4: the sparring partner -----------------------------------------
export const InterviewQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        category: z.enum(["technical", "behavioral", "system-design", "role-specific", "company"]),
        whyTheyAsk: z.string(),
      }),
    )
    .length(10),
});
export type InterviewQuestions = z.infer<typeof InterviewQuestionsSchema>;

export const AnswerGradeSchema = z.object({
  score: z.number().int().min(1).max(10),
  weakness: z.string(),
  followUp: z.string(),
});
export type AnswerGrade = z.infer<typeof AnswerGradeSchema>;

// ---- Agent 5: the ledger ---------------------------------------------------
export const LedgerStatusSchema = z.enum([
  "skipped",
  "ready",
  "applied",
  "needs_manual",
  "failed",
  "followed_up",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
]);
export type LedgerStatus = z.infer<typeof LedgerStatusSchema>;

export const LedgerRowSchema = z.object({
  key: z.string(),
  company: z.string(),
  title: z.string(),
  url: z.string(),
  score: z.number().nullable(),
  status: LedgerStatusSchema,
  appliedAt: z.string().nullable(),
  followedUpAt: z.string().nullable(),
  nextStep: z.string(),
  nextStepDate: z.string().nullable(),
  notes: z.string(),
  outDir: z.string().nullable(),
  updatedAt: z.string(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;
