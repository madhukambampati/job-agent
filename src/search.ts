import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { maxPostedSalary } from "./agents/rules.js";
import { fetchJob, parseJobUrl, PostingClosedError, type Fetcher } from "./jobs/fetch.js";
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
  For AI / LLM evaluation or quality work include e.g. "Evals", "Evaluation", "AI Quality", "LLM Quality",
  "Model Evaluation", "AI Evaluation", "AI Test", "Red Team", "AI Safety", "Trust and Safety", plus the QA titles above,
  because these roles are often titled "Member of Technical Staff, Evals" or "Software Engineer, Model Evaluation".
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
  /** Folder the memory lives in; the last search's per-URL log goes next to it. */
  dir(): string {
    return dirname(this.path);
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
    return (d.jobs ?? []).map((j: any) => ({ url: j.jobUrl ?? `https://jobs.ashbyhq.com/${board}/${j.id}`, title: j.title, location: [j.location, j.isRemote && !/hybrid|onsite/i.test(j.workplaceType ?? "") ? "Remote" : "", j.workplaceType].filter(Boolean).join(" · ") }));
  }
  return [];
}

// ---- 3. Filter ---------------------------------------------------------------

/**
 * Region markers matched as whole words against location + title. Two-letter
 * codes only count after a comma ("Sunnyvale, CA" is California, not Canada).
 */
const US_STATES = "al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc";
const REGIONS: Record<string, RegExp> = {
  canada: /\bcanada\b|\bcanadian\b|\bontario\b|\btoronto\b|\bottawa\b|\bwaterloo\b|\bkitchener\b|\bmississauga\b|\bvancouver\b|\bbritish columbia\b|\bmontr[eé]al\b|\bqu[eé]bec\b|\bcalgary\b|\bedmonton\b|\balberta\b|\bwinnipeg\b|\bmanitoba\b|\bhalifax\b|\bnova scotia\b|\bsaskatchewan\b|\bnew brunswick\b|\bnewfoundland\b|,\s*(on|bc|qc|ab|mb|ns|nb|sk|nl|pe)\b/,
  "united states": new RegExp(`\\bunited states\\b|\\busa\\b|\\bu\\.s\\.|\\bus\\b|\\bamericas?\\b|\\bnew york\\b|\\bsan francisco\\b|\\bsunnyvale\\b|\\bseattle\\b|\\baustin\\b|\\bboston\\b|\\bchicago\\b|\\bcalifornia\\b|\\btexas\\b|,\\s*(${US_STATES})\\b`),
  "united kingdom": /\bunited kingdom\b|\buk\b|\blondon\b|\bengland\b|\bscotland\b|\bmanchester\b/,
  india: /\bindia\b|\bbengaluru\b|\bbangalore\b|\bhyderabad\b|\bpune\b|\bchennai\b|\bmumbai\b|\bdelhi\b|\bgurgaon\b|\bnoida\b/,
  latam: /\blatam\b|\blatin america\b|\bargentina\b|\bbrazil\b|\bbrasil\b|\bmexico\b|\bcolombia\b|\bchile\b|\bperu\b|\buruguay\b|\bcosta rica\b|\bbuenos aires\b|\bs[aã]o paulo\b/,
  europe: /\bemea\b|\beurope\b|\beu\b|\bgermany\b|\bpoland\b|\bportugal\b|\bspain\b|\bfrance\b|\bnetherlands\b|\bireland\b|\bromania\b|\bukraine\b|\bberlin\b|\bamsterdam\b|\bdublin\b|\blisbon\b|\bwarsaw\b/,
  apac: /\bapac\b|\baustralia\b|\bsingapore\b|\bphilippines\b|\bjapan\b|\bvietnam\b|\bnew zealand\b/,
};

function regionKey(country: string): string {
  const c = country.toLowerCase().trim();
  if (/^(usa?|u\.s\.?|america)$/.test(c)) return "united states";
  if (/^(uk|great britain|britain)$/.test(c)) return "united kingdom";
  return c;
}

/** Explicit "you must be in X" lines near the top of a posting. */
const STATED_ELIGIBILITY = /(remote|work|based|located|reside|residing|live|living|anywhere|eligible|authori[sz]ed|hire|hiring|candidates)[^.\n]{0,50}\b(in|within|across|from)\b[^.\n]{0,15}/g;

export function titleMatches(title: string, q: SearchQuery): boolean {
  const t = ` ${title.toLowerCase()} `;
  if (q.exclude.some((x) => t.includes(x.toLowerCase()))) return false;
  return q.titles.some((x) => t.includes(x.toLowerCase())) || q.titles.length === 0;
}

/**
 * Location check on what the posting itself says.
 * `location` is the ATS location/workplace text, `title` catches "(LATAM)"-style
 * suffixes, `descHead` is the start of the description.
 */
export function placeMatches(location: string, descHead: string, q: SearchQuery, title = ""): { ok: boolean; reason: string } {
  const loc = ` ${location.toLowerCase()} `;
  const where = `${loc} ${title.toLowerCase()}`;
  const head = descHead.toLowerCase();
  const saysHybrid = /\bhybrid\b/.test(loc);
  const saysOnsite = /\bon-?site\b|\bin[- ]office\b/.test(loc);
  // "Remote · Hybrid" is not a remote job: the workplace type wins.
  const isRemote = /remote|anywhere|work from home|distributed/.test(loc) && !saysHybrid && !saysOnsite;
  if (q.workplace === "remote" && !isRemote) return { ok: false, reason: saysHybrid ? "hybrid, not remote" : saysOnsite ? "on-site, not remote" : "not remote" };
  if (q.workplace === "onsite" && !saysOnsite && /remote/.test(loc)) return { ok: false, reason: "remote, not onsite" };
  if (q.workplace === "hybrid" && !saysHybrid && !/\bhybrid\b/.test(head.slice(0, 600))) return { ok: false, reason: "not hybrid" };

  if (q.country) {
    const key = regionKey(q.country);
    const target = REGIONS[key] ?? new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const others = Object.entries(REGIONS).filter(([k]) => k !== key);
    const inLoc = target.test(where);
    const otherInLoc = others.find(([, re]) => re.test(where));
    if (otherInLoc && !inLoc) return { ok: false, reason: "in another country" };
    if (!inLoc) {
      // No place named at all: only accept a remote role whose posting says it hires in the country.
      if (!isRemote) return { ok: false, reason: `not in ${q.country}` };
      const statements = (head.slice(0, 2500).match(STATED_ELIGIBILITY) ?? []).join(" ");
      const tail = head.slice(0, 2500);
      const okHere = target.test(statements) || new RegExp(`(remote|based)[^.\\n]{0,20}\\(?(?:${target.source})`).test(tail);
      if (!okHere) return { ok: false, reason: `not stated as open in ${q.country}` };
      if (others.some(([, re]) => re.test(statements)) && !target.test(statements)) return { ok: false, reason: "in another country" };
    }
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
  const log: { url: string; outcome: string; title?: string; location?: string }[] = [];
  // One outcome per URL, from the same checks that decide what's shown, so the summary can't disagree with the cards.
  const note = (url: string, r: string, job?: Job) => {
    skipped[r] = (skipped[r] ?? 0) + 1;
    log.push({ url, outcome: r, title: job?.title, location: job?.location });
  };

  // a) live web search on the ATS domains: gives URLs, and more importantly, which companies are hiring for this
  on.status("Searching Greenhouse, Lever and Ashby job boards…");
  let discovered: string[] = [];
  try {
    discovered = await discoverUrls(llm, q);
  } catch (e) {
    on.status(`Web search failed (${(e as Error).message}); using remembered boards only.`);
  }

  // b) list every board we know about, old and newly found. Search results are often stale; the board itself is live.
  const fromSearch = discovered.map((u) => parseJobUrl(u)).map((p) => `${p.ats}:${p.board}`);
  const allBoards = [...new Set([...fromSearch, ...boards.list()])].slice(0, 80);
  on.status(`Checking current openings on ${allBoards.length} company boards…`);
  const listed = await pool(allBoards, 8, async (b) => {
    try {
      const jobs = await listBoard(b, fetcher);
      const [ats, board] = b.split(":");
      if (jobs.length) boards.add(ats, board);
      return jobs;
    } catch {
      return [] as Candidate[];
    }
  });
  const candidates = new Set<string>(discovered);
  for (const c of listed.flat()) {
    if (!titleMatches(c.title, q)) continue;
    // Board listings only carry a short location; a "Remote"-ish one goes on to the full check.
    const quick = placeMatches(c.location, "", q, c.title);
    if (quick.ok || /remote/i.test(c.location) || !c.location.trim()) candidates.add(c.url);
  }

  const unique = [...candidates];
  on.status(`Found ${unique.length} possible postings, checking each one…`);

  await pool(unique, 6, async (url) => {
    if (found.length >= limit) return;
    let job: Job;
    try {
      job = await fetchJob(url, fetcher);
    } catch (e) {
      return note(url, e instanceof PostingClosedError ? "closed" : "unreachable");
    }
    if (seen.has(job.id)) return;
    seen.add(job.id);
    const p = parseJobUrl(url);
    boards.add(p.ats, p.board);
    if (deps.isKnown?.(job.id)) return note(url, "already applied", job);
    if (!titleMatches(job.title, q)) return note(url, "different role", job);
    const place = placeMatches(`${job.location} ${job.employmentType ?? ""}`, job.description.slice(0, 2500), q, job.title);
    if (!place.ok) return note(url, place.reason, job);
    const emp = employmentOk(job, deps.profile);
    if (emp) return note(url, emp, job);
    if (found.length >= limit) return;
    found.push(job);
    log.push({ url, outcome: "shown", title: job.title, location: job.location });
    on.job(job);
  });

  try {
    mkdirSync(boards.dir(), { recursive: true });
    writeFileSync(join(boards.dir(), "last-search.json"), JSON.stringify({ at: new Date().toISOString(), query: q, results: log }, null, 2) + "\n");
  } catch {
    /* log is best-effort */
  }
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
