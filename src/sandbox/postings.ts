/**
 * Dummy job market for sandbox mode. Fictional companies only. The set is
 * built so every search filter and every apply outcome shows up at least once.
 */

export type Ats = "greenhouse" | "lever" | "ashby";
/** How the employer's application form behaves. */
export type FormVariant = "normal" | "captcha" | "clearance";

export interface DummyPosting {
  ats: Ats;
  board: string;
  id: string;
  company: string;
  title: string;
  location: string;
  workplace: "remote" | "hybrid" | "onsite";
  employment: "Full-time" | "Contract";
  pay?: { currency: string; min: number; max: number };
  about: string;
  must: string[];
  nice: string[];
  form: FormVariant;
  /** What this posting is here to demonstrate. Shown in the employer inbox. */
  purpose: string;
}

const QA_MUST = ["5+ years building UI and API test automation", "Playwright or Cypress with TypeScript", "REST API testing and contract validation", "CI/CD pipelines (GitHub Actions or Jenkins)", "SQL for data validation"];

export const POSTINGS: DummyPosting[] = [
  {
    ats: "greenhouse", board: "maplewave", id: "4100001", company: "Maplewave", title: "Senior SDET",
    location: "Remote - Canada", workplace: "remote", employment: "Full-time", pay: { currency: "CAD", min: 130000, max: 155000 },
    about: "Maplewave builds scheduling software for Canadian clinics.", must: QA_MUST, nice: ["Kafka or RabbitMQ", "Kubernetes"],
    form: "normal", purpose: "Happy path: Greenhouse form, should submit",
  },
  {
    ats: "lever", board: "northpine", id: "np-qa-201", company: "Northpine", title: "QA Automation Engineer",
    location: "Toronto, Ontario", workplace: "remote", employment: "Full-time", pay: { currency: "CAD", min: 105000, max: 125000 },
    about: "Northpine runs the payments layer for Canadian credit unions.", must: ["4+ years of QA automation", "Selenium or Playwright", "API testing with Postman or REST Assured", "SQL Server or PostgreSQL"], nice: ["PCI DSS testing", "JMeter"],
    form: "normal", purpose: "Happy path: Lever form (single 'Full name' field), should submit",
  },
  {
    ats: "greenhouse", board: "auroralabs", id: "4100002", company: "Aurora Labs", title: "Senior Software Engineer in Test, Platform",
    location: "Remote, Canada", workplace: "remote", employment: "Full-time",
    about: "Aurora Labs makes developer tooling for large monorepos.", must: [...QA_MUST, "Mentoring other engineers"], nice: ["Go", "Bazel"],
    form: "normal", purpose: "Happy path with extra custom questions",
  },
  {
    ats: "ashby", board: "frostbyte", id: "6f1d2c3a-0000-4a11-9a00-000000000004", company: "Frostbyte", title: "SDET II",
    location: "Vancouver, BC", workplace: "remote", employment: "Full-time", pay: { currency: "CAD", min: 115000, max: 140000 },
    about: "Frostbyte builds real-time inventory software for grocers.", must: QA_MUST, nice: ["Mobile testing with Appium"],
    form: "normal", purpose: "Ashby: form is filled but the final Submit is left to you",
  },
  {
    ats: "lever", board: "cedarloop", id: "cl-qe-301", company: "Cedarloop", title: "Quality Engineer, Payments",
    location: "Remote - Canada", workplace: "remote", employment: "Full-time",
    about: "Cedarloop processes card payments for small businesses.", must: ["Payments or e-commerce testing", "API automation", "SQL"], nice: ["PCI DSS"],
    form: "captcha", purpose: "Form has a captcha: stops and asks you",
  },
  {
    ats: "greenhouse", board: "polarisdefence", id: "4100003", company: "Polaris Defence Systems", title: "Senior QA Engineer",
    location: "Remote - Canada", workplace: "remote", employment: "Full-time",
    about: "Polaris builds mission software for public-sector clients.", must: [...QA_MUST, "Eligible for Canadian security clearance"], nice: [],
    form: "clearance", purpose: "Required question your profile can't answer: stops and asks you",
  },
  {
    ats: "lever", board: "lakeshore-analytics", id: "lk-lead-401", company: "Lakeshore Analytics", title: "Lead Software Engineer in Test",
    location: "Remote, Canada", workplace: "remote", employment: "Full-time",
    about: "Lakeshore AI sells forecasting models to retailers.", must: ["Managing a team of 6+ QA engineers", "Hiring and performance reviews", "Owning the QA budget", "Test automation strategy"], nice: [],
    form: "normal", purpose: "Low fit (people-management role): skipped by Apply-to-all, still appliable by hand",
  },
  {
    ats: "greenhouse", board: "evalforge", id: "4100004", company: "EvalForge", title: "Member of Technical Staff, Evals",
    location: "Remote (Canada)", workplace: "remote", employment: "Full-time", pay: { currency: "CAD", min: 150000, max: 190000 },
    about: "EvalForge builds evaluation suites for teams shipping LLM products.", must: ["Building evaluation harnesses for LLM features", "Golden datasets and LLM-as-judge", "Python or TypeScript", "Test automation background"], nice: ["Agentic / tool-calling systems"],
    form: "normal", purpose: "AI-evaluation role for the LLM search",
  },
  {
    ats: "lever", board: "quillmind", id: "qm-aiq-501", company: "Quillmind", title: "AI Quality Engineer (LLM Evaluation)",
    location: "Remote - Canada", workplace: "remote", employment: "Full-time",
    about: "Quillmind makes a writing assistant for legal teams.", must: ["Testing non-deterministic LLM output", "Playwright", "API testing", "Writing test strategy"], nice: ["Red-teaming", "Prompt injection testing"],
    form: "normal", purpose: "AI-evaluation role for the LLM search",
  },
  {
    ats: "greenhouse", board: "harbourfin", id: "4100005", company: "Harbour Financial", title: "Senior QA Engineer",
    location: "Toronto, ON · Hybrid", workplace: "hybrid", employment: "Full-time", pay: { currency: "CAD", min: 115000, max: 135000 },
    about: "Harbour Financial runs digital banking for Ontario credit unions.", must: QA_MUST, nice: ["Banking domain"],
    form: "normal", purpose: "Toronto hybrid: shows for the Toronto search, not for remote",
  },
  {
    ats: "lever", board: "king-west-labs", id: "kw-sdet-601", company: "King West Labs", title: "SDET",
    location: "Toronto, Ontario", workplace: "hybrid", employment: "Full-time",
    about: "King West Labs builds ticketing software for live events.", must: QA_MUST, nice: ["Load testing"],
    form: "normal", purpose: "Toronto hybrid: shows for the Toronto search, not for remote",
  },
  // ---- these should be filtered out of a "remote in Canada" search ----
  {
    ats: "ashby", board: "sunbeam-compute", id: "6f1d2c3a-0000-4a11-9a00-000000000012", company: "Sunbeam Compute", title: "Senior SDET",
    location: "Sunnyvale, CA", workplace: "hybrid", employment: "Full-time",
    about: "Sunbeam builds AI chips.", must: QA_MUST, nice: [],
    form: "normal", purpose: "Filter test: California + hybrid (Ashby also tags it remote)",
  },
  {
    ats: "greenhouse", board: "pampatech", id: "4100006", company: "Pampa Tech", title: "Senior QA Automation Engineer - HELOC (LATAM)",
    location: "Remote", workplace: "remote", employment: "Full-time",
    about: "Pampa Tech builds HELOC software used by Canadian lenders.", must: QA_MUST, nice: [],
    form: "normal", purpose: "Filter test: LATAM role that mentions Canadian customers",
  },
  {
    ats: "lever", board: "globex-logistics", id: "gx-sdet-701", company: "Globex Logistics", title: "SDET",
    location: "Remote - US", workplace: "remote", employment: "Full-time",
    about: "Globex US builds logistics software.", must: QA_MUST, nice: [],
    form: "normal", purpose: "Filter test: remote in the US only",
  },
  {
    ats: "greenhouse", board: "initrode", id: "4100007", company: "Initrode", title: "QA Engineer (Contract)",
    location: "Remote - Canada", workplace: "remote", employment: "Contract",
    about: "Initrode needs a 6-month contractor.", must: QA_MUST, nice: [],
    form: "normal", purpose: "Filter test: contract role",
  },
  {
    ats: "lever", board: "budget-books", id: "bc-qa-801", company: "Budget Books", title: "QA Automation Analyst",
    location: "Remote - Canada", workplace: "remote", employment: "Full-time", pay: { currency: "CAD", min: 55000, max: 65000 },
    about: "BudgetCo makes expense software.", must: QA_MUST, nice: [],
    form: "normal", purpose: "Filter test: pay below your floor",
  },
  {
    ats: "greenhouse", board: "ottawatech", id: "4100008", company: "Ottawa Tech", title: "QA Automation Engineer",
    location: "Ottawa, ON · Hybrid", workplace: "hybrid", employment: "Full-time",
    about: "Ottawa Tech builds network monitoring tools.", must: QA_MUST, nice: [],
    form: "normal", purpose: "Filter test: hybrid in a different city than Toronto",
  },
];

/** A search hit for a posting that has since closed. */
export const CLOSED_URL = "https://job-boards.greenhouse.io/maplewave/jobs/4199999";

export function publicUrl(p: DummyPosting): string {
  if (p.ats === "greenhouse") return `https://job-boards.greenhouse.io/${p.board}/jobs/${p.id}`;
  if (p.ats === "lever") return `https://jobs.lever.co/${p.board}/${p.id}`;
  return `https://jobs.ashbyhq.com/${p.board}/${p.id}`;
}

export function description(p: DummyPosting): string {
  return [
    `${p.about} This is a ${p.employment.toLowerCase()} ${p.workplace} role (${p.location}).`,
    p.workplace === "remote" && /canada|ontario|bc\b/i.test(p.location) ? "This role is fully remote and open to candidates located in Canada." : "",
    "",
    "What you'll do",
    "- Own test automation for a product area end to end",
    "- Work with developers on testability and release quality",
    "- Investigate failures across UI, API and data layers",
    "",
    "What we're looking for",
    ...p.must.map((m) => `- ${m}`),
    ...(p.nice.length ? ["", "Nice to have", ...p.nice.map((n) => `- ${n}`)] : []),
    "",
    "(Sandbox posting: fictional company, used to test job-agent.)",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}
