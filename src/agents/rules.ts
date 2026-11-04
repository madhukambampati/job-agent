import type { Profile } from "../profile.js";
import type { Job } from "../types.js";

/**
 * Deterministic pre-screen that runs before any model call. These are the
 * user's hard rules, so they live in code, not in a prompt the model could
 * talk itself out of.
 *
 * `ignoreLocation`: the user explicitly chose this job (clicked Apply on its card),
 * so their own remote/location preference no longer blocks it.
 */
export function hardRuleViolations(job: Job, profile: Profile, opts: { ignoreLocation?: boolean } = {}): string[] {
  const reasons: string[] = [];
  const haystack = `${job.title}\n${job.employmentType ?? ""}\n${job.location}`.toLowerCase();
  const descHead = job.description.slice(0, 1500).toLowerCase();

  for (const t of profile.search.excludeEmploymentTypes) {
    const needle = t.toLowerCase();
    if (haystack.includes(needle) || new RegExp(`\\b${escape(needle)}\\s+(role|position|contract|basis)`).test(descHead)) {
      reasons.push(`Employment type looks like "${t}"`);
    }
  }

  for (const k of profile.search.excludeTitleKeywords) {
    if (job.title.toLowerCase().includes(k.toLowerCase())) reasons.push(`Title contains excluded keyword "${k}"`);
  }

  if (profile.search.remoteOnly && !opts.ignoreLocation) {
    const loc = job.location.toLowerCase();
    const remote = /remote/.test(loc) || /\bfully remote\b|\bremote[- ]first\b/.test(descHead);
    const okPlace = profile.search.acceptableLocations.some((l) => loc.includes(l.toLowerCase()));
    if (!remote && !okPlace && loc) reasons.push(`Not remote ("${job.location}") and not in an acceptable location`);
  }

  const max = maxPostedSalary(job.compensation);
  if (max !== null && max < profile.salary.floor) {
    reasons.push(`Posted pay tops out at ${max}, below the ${profile.salary.floor} floor`);
  }
  return reasons;
}

/** Highest annual number in a compensation string, or null if none / hourly. */
export function maxPostedSalary(comp?: string): number | null {
  if (!comp) return null;
  if (/hour|\/hr|per hr/i.test(comp)) return null;
  const nums = [...comp.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k)?/gi)]
    .map((m) => parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1))
    .filter((n) => n >= 10000);
  return nums.length ? Math.max(...nums) : null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
