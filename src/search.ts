import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { maxPostedSalary } from "./agents/rules.js";
import { fetchJob, parseJobUrl, type Fetcher } from "./jobs/fetch.js";
import type { LLM } from "./llm.js";
import type { Profile } from "./profile.js";
import type { Job } from "./types.js";

// ---- 1. Understand the request -----------------------------------------------

export const SearchQuerySchema = z.object({
  intent: z.enum(["search", "ledger", "help"]),
  /** Title phrases to match, already expanded with common synonyms. */
  titles: z.array(z.string()),
  /** Country name in English, or "" for anywhere. */
  country: z.string(),
  /** Cities/provinces/states the user named, if any. */
  places: z.array(z.string()),
  workplace: z.enum(["remote", "hybrid", "onsite", "any"]),
  /** Words that should rule a job out (e.g. "manager", "contract"). */
  exclude: z.array(z.string()),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

const PARSE_SYSTEM = `You turn a job seeker's chat message into a structured job search.
- intent: "search" for finding jobs; "ledger" if they ask about applications they already sent / status / follow-ups; "help" otherwise.
- titles: the roles they want plus the common synonyms recruiters use. For "SDET QA" include e.g.
  "SDET", "Software Development Engineer in Test", "Software Engineer in Test", "QA Automation", "QA Engineer",
  "Quality Assurance", "Quality Engineer", "Test Automation", "Automation Engineer". Keep each short (1-5 words).
- country: English country name if they named one (or implied via a city), else "".
- places: cities/provinces/states they named.
- workplace: remote / hybrid / onsite if they said so, else "any".
- exclude: words they said to avoid.`;

export async function parseRequest(llm: LLM, message: string): Promise<SearchQuery> {
  return llm.structured({
    system: PARSE_SYSTEM,
    toolName: "parse_search",
    toolDescription: "Return the structured search for this message.",
    schema: SearchQuerySchema,
    maxTokens: 800,
    prompt: message,
  });
}

// ---- 2. Find postings -------------------------------------------------------

export const ATS_DOMAINS = ["job-boards.greenhouse.io", "boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"];
const ATS_URL = /https?:\/\/(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com)\/[^\s)"'<>\]]+/g;

export interface Candidate {
  url: string;
  title: string;
  location: string;
}

/** Remembers company boards seen in past searches so later searches can scan them directly. */
export class BoardMemory {
  private boards: Set<string>;
  constructor(private path = process.env.JOB_AGENT_BOARDS ?? "data/boards.json") {
    this.boards = new Set(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as string[]) : []);
  }
  list(): string[] {
    return [...this.boards];
  }
  add(ats: string, board: string): void {
    const key = `${ats}:${board}`;
    if (this.boards.has(key)) return;
    this.boards.add(key);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.boards].sort(), null, 2) + "\n");
  }
}

/** Ask Claude's web search for live postings, restricted to the three ATS domains. */
export async function discoverUrls(llm: LLM, q: SearchQuery): Promise<string[]> {
  const where = [q.places.join(", "), q.country].filter(Boolean).join(", ") || "anywhere";
  const res = await llm.research({
    system: "You find currently open job postings. Search only the given job-board sites. Reply with a plain list of posting URLs, one per line, nothing else.",
    prompt: `Find open postings for: ${q.titles.slice(0, 6).join(" OR ")}.
Location: ${where}. Work mode: ${q.workplace}.
Search each of these sites: ${ATS_DOMAINS.join(", ")}. Try a few query variations. Return up to 25 posting URLs.`,
    maxSearches: 6,
    allowedDomains: ATS_DOMAINS,
  });
  const urls = new Set<string>();
  const one = new RegExp(ATS_URL.source);
  for (const s of res.sources) if (one.test(s.url)) urls.add(s.url);
  for (const m of res.text.match(ATS_URL) ?? []) urls.add(m);
  return [...urls].flatMap((u) => { try { return [cleanUrl(u)]; } catch { return []; } }).filter((u) => parseJobUrl(u).ats !== "unknown" && isPostingUrl(u));
}

function cleanUrl(u: string): string {
  const url = new URL(u.replace(/[.,;]+$/, ""));
  for (const k of [...url.searchParams.keys()]) if (k !== "gh_jid") url.searchParams.delete(k);
  url.pathname = url.pathname.replace(/\/(apply|application)\/?$/, "");
  return url.toString();
}

/** A posting, not a company's board index page. */
function isPostingUrl(u: string): boolean {
  const p = new URL(u).pathname.split("/").filter(Boolean);
  if (u.includes("greenhouse.io")) return p.includes("jobs") || new URL(u).searchParams.has("gh_jid");
  return p.length >= 2;
}

/** List every open job on a remembered board (cheap: one public API call per board). */
export async function listBoard(key: string, fetcher: Fetcher): Promise<Candidate[]> {
  const [ats, board] = key.split(":");
  const get = async (u: string) => {
    const r = await fetcher(u);
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  };
  if (ats === "greenhouse") {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`);
    return (d.jobs ?? []).map((j: any) => ({ url: `https://job-boards.greenhouse.io/${board}/jobs/${j.id}`, title: j.title, location: j.location?.name ?? "" }));
  }
  if (ats === "lever") {
    const d = await get(`https://api.lever.co/v0/postings/${board}?mode=json`);
    return (Array.isArray(d) ? d : []).map((j: any) => ({ url: j.hostedUrl ?? `https://jobs.lever.co/${board}/${j.id}`, title: j.text, location: [j.categories?.location, j.workplaceType].filter(Boolean).join(" · ") }));
  }
  if (ats === "ashby") {
    const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${board}`);
    return (d.jobs ?? []).map((j: any) => ({ url: j.jobUrl ?? `https://jobs.ashbyhq.com/${board}/${j.id}`, title: j.title, location: [j.location, j.isRemote ? "Remote" : ""].filter(Boolean).join(" · ") }));
  }
  return [];
}

// ---- 3. Filter ---------------------------------------------------------------

const COUNTRY_HINTS: Record<string, string[]> = {
  canada: ["canada", "canadian", ", ca", " ca ", "(ca)", "ontario", "toronto", "ottawa", "waterloo", "kitchener", "vancouver", "british columbia", "montreal", "montréal", "quebec", "québec", "calgary", "edmonton", "alberta", "winnipeg", "manitoba", "halifax", "nova scotia", "saskatchewan", "new brunswick", "mississauga"],
  "united states": ["united states", "usa", "u.s.", " us ", "(us)", "us-", "new york", "san francisco", "seattle", "austin", "boston", "chicago"],
  "united kingdom": ["united kingdom", " uk", "london", "england", "scotland", "manchester"],
  india: ["india", "bengaluru", "bangalore", "hyderabad", "pune", "chennai", "mumbai", "delhi", "gurgaon", "noida"],
};

export function titleMatches(title: string, q: SearchQuery): boolean {
  const t = ` ${title.toLowerCase()} `;
  if (q.exclude.some((x) => t.includes(x.toLowerCase()))) return false;
  return q.titles.some((x) => t.includes(x.toLowerCase())) || q.titles.length === 0;
}

/** Location check on what the posting itself says. `text` should include location + the start of the description. */
export function placeMatches(location: string, descHead: string, q: SearchQuery): { ok: boolean; reason: string } {
  const loc = ` ${location.toLowerCase()} `;
  const head = descHead.toLowerCase();
  const isRemote = /remote|anywhere|work from home|distributed/.test(loc);
  if (q.workplace === "remote" && !isRemote) return { ok: false, reason: "not remote" };
  if (q.workplace === "onsite" && isRemote) return { ok: false, reason: "remote, not onsite" };
  if (q.workplace === "hybrid" && !/hybrid/.test(loc + head)) return { ok: false, reason: "not hybrid" };

  const country = q.country.toLowerCase();
  if (country) {
    const hints = COUNTRY_HINTS[country] ?? [country];
    const inLoc = hints.some((h) => loc.includes(h));
    // "Remote" with no country: accept only if the posting says the country early on.
    const inDesc = hints.some((h) => head.includes(h.trim()));
    if (!inLoc && !(isRemote && inDesc)) return { ok: false, reason: `not in ${q.country}` };
    // "Remote - US" style postings that mention Canada only in passing.
    const otherCountry = Object.entries(COUNTRY_HINTS).some(([c, hs]) => c !== country && hs.slice(0, 3).some((h) => loc.includes(h)));
    if (otherCountry && !inLoc) return { ok: false, reason: "remote in another country" };
  }
  if (q.places.length && !isRemote && !q.places.some((p) => loc.includes(p.toLowerCase()))) return { ok: false, reason: "different city" };
  return { ok: true, reason: "" };
}

export function employmentOk(job: Job, profile: Profile): string | null {
  const hay = `${job.title} ${job.employmentType ?? ""}`.toLowerCase();
  for (const t of profile.search.excludeEmploymentTypes) if (hay.includes(t.toLowerCase())) return `${t} role`;
  const max = maxPostedSalary(job.compensation);
  if (max !== null && max < profile.salary.floor) return `pay tops out at ${max}`;
  return null;
}

// ---- Orchestration -----------------------------------------------------------

export interface SearchEvents {
  status(msg: string): void;
  job(job: Job): void;
}

export async function searchJobs(
  llm: LLM,
  q: SearchQuery,
  deps: { profile: Profile; fetcher?: Fetcher; boards?: BoardMemory; isKnown?: (jobId: string) => boolean; limit?: number },
  on: SearchEvents,
): Promise<Job[]> {
  const fetcher = deps.fetcher ?? (fetch as unknown as Fetcher);
  const boards = deps.boards ?? new BoardMemory();
  const limit = deps.limit ?? 20;
  const seen = new Set<string>();
  const found: Job[] = [];
  const skipped: Record<string, number> = {};
  const note = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);

  // a) remembered boards, filtered by title + location before any detail fetch
  const remembered = boards.list();
  const candidates: string[] = [];
  if (remembered.length) {
    on.status(`Checking ${remembered.length} company boards I've seen before…`);
    const lists = await pool(remembered.slice(0, 60), 8, (b) => listBoard(b, fetcher).catch(() => [] as Candidate[]));
    for (const c of lists.flat()) {
      if (!titleMatches(c.title, q)) continue;
      // Board listings only carry a short location; let vague "Remote" through to the detail check.
      const quick = placeMatches(c.location, "", q);
      if (!quick.ok && !/^\s*(remote)?\s*$/i.test(c.location) && !/remote/i.test(c.location)) continue;
      candidates.push(c.url);
    }
  }

  // b) live web search on the ATS domains
  on.status("Searching Greenhouse, Lever and Ashby job boards…");
  try {
    candidates.push(...(await discoverUrls(llm, q)));
  } catch (e) {
    on.status(`Web search failed (${(e as Error).message}); using remembered boards only.`);
  }

  const unique = [...new Set(candidates)];
  on.status(`Found ${unique.length} possible postings, checking each one…`);

  await pool(unique, 6, async (url) => {
    if (found.length >= limit) return;
    let job: Job;
    try {
      job = await fetchJob(url, fetcher);
    } catch {
      return note("closed or unreachable");
    }
    if (seen.has(job.id)) return;
    seen.add(job.id);
    const p = parseJobUrl(url);
    boards.add(p.ats, p.board);
    if (deps.isKnown?.(job.id)) return note("already applied");
    if (!titleMatches(job.title, q)) return note("different role");
    const place = placeMatches(`${job.location} ${job.employmentType ?? ""}`, job.description.slice(0, 2000), q);
    if (!place.ok) return note(place.reason);
    const emp = employmentOk(job, deps.profile);
    if (emp) return note(emp);
    if (found.length >= limit) return;
    found.push(job);
    on.job(job);
  });

  const why = Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(", ");
  on.status(`${found.length} matching role${found.length === 1 ? "" : "s"}${why ? ` (left out: ${why})` : ""}.`);
  return found;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
