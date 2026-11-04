import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const ProfileSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  city: z.string(),
  region: z.string(),
  country: z.string(),
  postalCode: z.string().default(""),
  linkedin: z.string().default(""),
  github: z.string().default(""),
  website: z.string().default(""),
  currentCompany: z.string().default(""),
  currentTitle: z.string().default(""),
  yearsOfExperience: z.number(),

  workAuthorization: z.object({
    authorizedCountries: z.array(z.string()),
    requiresSponsorship: z.boolean(),
  }),

  salary: z.object({
    floor: z.number(),
    currency: z.string().default("CAD"),
    /** What to put in "expected salary" boxes. */
    expected: z.string(),
  }),

  search: z.object({
    remoteOnly: z.boolean().default(true),
    /** Places a non-remote role is still acceptable. */
    acceptableLocations: z.array(z.string()).default([]),
    excludeEmploymentTypes: z.array(z.string()).default(["contract", "temporary", "fixed-term", "freelance", "internship"]),
    excludeTitleKeywords: z.array(z.string()).default([]),
  }),

  automation: z.object({
    scoreThreshold: z.number().int().min(1).max(10).default(7),
    /** true = submit with no human review when every gate passes. */
    autoSubmit: z.boolean().default(true),
    dailyCap: z.number().int().positive().default(15),
    noticePeriod: z.string().default("2 weeks"),
    willingToRelocate: z.boolean().default(false),
  }),

  /** Pre-approved answers for recurring application questions. The submitter may only use these. */
  answers: z.record(z.string(), z.string()).default({}),

  /** Markdown base resume. Path is resolved relative to the profile file. */
  resumePath: z.string(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export function loadProfile(path = process.env.JOB_AGENT_PROFILE ?? "config/profile.yaml"): {
  profile: Profile;
  resumeMarkdown: string;
} {
  const abs = resolve(path);
  const profile = ProfileSchema.parse(parse(readFileSync(abs, "utf8")));
  const resumeMarkdown = readFileSync(resolve(dirname(abs), profile.resumePath), "utf8");
  return { profile, resumeMarkdown };
}

export function fullName(p: Profile): string {
  return `${p.firstName} ${p.lastName}`;
}
