import { createHash } from "node:crypto";
import type { Ats, Job, JobQuestion } from "../types.js";

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export interface ParsedJobUrl {
  ats: Ats;
  board: string;
  jobId: string;
}

/** Recognises public job-post URLs from the three ATSs we can apply through. */
export function parseJobUrl(input: string): ParsedJobUrl {
  const u = new URL(input);
  const parts = u.pathname.split("/").filter(Boolean);
  const host = u.hostname.toLowerCase();

  if (host.endsWith("greenhouse.io")) {
    // boards.greenhouse.io/{board}/jobs/{id}  or  job-boards.greenhouse.io/{board}/jobs/{id}
    const i = parts.indexOf("jobs");
    const ghJid = u.searchParams.get("gh_jid");
    if (i > 0 && parts[i + 1]) return { ats: "greenhouse", board: parts[i - 1], jobId: parts[i + 1] };
    if (ghJid && parts[0]) return { ats: "greenhouse", board: parts[0], jobId: ghJid };
  }
  if (host === "jobs.lever.co" && parts.length >= 2) {
    return { ats: "lever", board: parts[0], jobId: parts[1] };
  }
  if (host === "jobs.ashbyhq.com" && parts.length >= 2) {
    return { ats: "ashby", board: parts[0], jobId: parts[1] };
  }
  return { ats: "unknown", board: host, jobId: createHash("sha1").update(input).digest("hex").slice(0, 12) };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Greenhouse returns HTML-escaped HTML, so entities are decoded both before and after stripping tags. */
export function htmlToText(html: string): string {
  return decodeEntities(
    decodeEntities(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function fetchJob(url: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<Job> {
  const p = parseJobUrl(url);
  const get = async (apiUrl: string) => {
    const res = await fetcher(apiUrl).catch((e: Error) => {
      throw new Error(`Could not reach ${new URL(apiUrl).host} (${e.message}). Check your network.`);
    });
    if (!res.ok) throw new Error(`Job fetch failed (${res.status}) for ${apiUrl}`);
    return res.json();
  };

  if (p.ats === "greenhouse") {
    const d = await get(`https://boards-api.greenhouse.io/v1/boards/${p.board}/jobs/${p.jobId}?questions=true`);
    const questions: JobQuestion[] = (d.questions ?? []).map((q: any) => ({
      label: q.label,
      required: !!q.required,
      type: q.fields?.[0]?.type ?? "input_text",
      options: (q.fields?.[0]?.values ?? []).map((v: any) => String(v.label)),
    }));
    const pay = (d.pay_input_ranges ?? [])
      .map((r: any) => `${r.currency_type ?? ""} ${(r.min_cents ?? 0) / 100}-${(r.max_cents ?? 0) / 100}`)
      .join("; ");
    return {
      id: `greenhouse:${p.board}:${p.jobId}`,
      ats: "greenhouse",
      company: d.company_name ?? titleCase(p.board),
      title: d.title,
      location: d.location?.name ?? "",
      description: htmlToText(d.content ?? ""),
      url,
      // Company career pages often iframe the form; the hosted board page is the reliable form.
      applyUrl: `https://job-boards.greenhouse.io/${p.board}/jobs/${p.jobId}`,
      compensation: pay || undefined,
      questions,
    };
  }

  if (p.ats === "lever") {
    const d = await get(`https://api.lever.co/v0/postings/${p.board}/${p.jobId}`);
    const lists = (d.lists ?? []).map((l: any) => `${l.text}\n${htmlToText(l.content ?? "")}`).join("\n\n");
    const sr = d.salaryRange;
    return {
      id: `lever:${p.board}:${p.jobId}`,
      ats: "lever",
      company: titleCase(p.board),
      title: d.text,
      location: [d.categories?.location, d.workplaceType].filter(Boolean).join(" · "),
      description: [d.descriptionPlain ?? htmlToText(d.description ?? ""), lists, d.additionalPlain ?? ""].join("\n\n").trim(),
      url,
      applyUrl: d.applyUrl ?? `${d.hostedUrl ?? url}/apply`,
      compensation: sr ? `${sr.currency} ${sr.min}-${sr.max} ${sr.interval ?? ""}`.trim() : undefined,
      employmentType: d.categories?.commitment,
      questions: [],
    };
  }

  if (p.ats === "ashby") {
    const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${p.board}?includeCompensation=true`);
    const j = (d.jobs ?? []).find((x: any) => x.id === p.jobId);
    if (!j) throw new Error(`Ashby job ${p.jobId} is not on ${p.board}'s public board (closed?)`);
    return {
      id: `ashby:${p.board}:${p.jobId}`,
      ats: "ashby",
      company: titleCase(p.board),
      title: j.title,
      location: [j.location, j.isRemote ? "Remote" : "", j.workplaceType].filter(Boolean).join(" · "),
      description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ""),
      url,
      applyUrl: j.applyUrl ?? `${j.jobUrl ?? url}/application`,
      compensation: j.compensation?.compensationTierSummary ?? undefined,
      employmentType: j.employmentType,
      questions: [],
    };
  }

  // Unknown site: we can still score / brief / edit / spar, just never auto-submit.
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Job fetch failed (${res.status}) for ${url}`);
  const html = await res.text();
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "Unknown role";
  return {
    id: `unknown:${p.jobId}`,
    ats: "unknown",
    company: p.board,
    title,
    location: "",
    description: htmlToText(html).slice(0, 20000),
    url,
    applyUrl: url,
    questions: [],
  };
}
