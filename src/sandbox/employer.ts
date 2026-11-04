import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import type { Fetcher } from "../jobs/fetch.js";
import { POSTINGS, description, type DummyPosting } from "./postings.js";

/**
 * The fake employer side of sandbox mode:
 *  - `fetcher` answers the Greenhouse / Lever / Ashby public APIs for the dummy
 *    postings (same JSON shapes as the real ones), and 404s everything else,
 *    so sandbox runs never touch the network.
 *  - an HTTP server serves each posting's application form in that ATS's
 *    style, validates required fields like a real ATS, and records every
 *    submission (fields + uploaded files) in an inbox you can browse.
 */

interface Field {
  name: string;
  label: string;
  type: "text" | "email" | "tel" | "url" | "textarea" | "file" | "select" | "radio";
  required?: boolean;
  options?: string[];
}

export interface Submission {
  id: string;
  at: string;
  postingId: string;
  company: string;
  title: string;
  fields: { label: string; value: string }[];
  files: { label: string; name: string; bytes: number; stored: string }[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const YES_NO = ["Yes", "No"];
const EEO = (ats: string): Field[] =>
  ats === "greenhouse"
    ? [
        { name: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Non-binary", "Decline to self-identify"] },
        { name: "veteran", label: "Veteran status", type: "select", options: ["I am a veteran", "I am not a veteran", "I don't wish to answer"] },
        { name: "disability", label: "Disability status", type: "select", options: ["Yes", "No", "I don't wish to answer"] },
      ]
    : [];

function formFields(p: DummyPosting): Field[] {
  const why: Field = { name: "why", label: `Why do you want to work at ${p.company}?`, type: "textarea", required: true };
  const auth: Field = { name: "auth_ca", label: "Are you legally authorized to work in Canada?", type: p.ats === "greenhouse" ? "select" : "radio", required: true, options: YES_NO };
  const spons: Field = { name: "sponsorship", label: "Will you now or in the future require visa sponsorship?", type: p.ats === "ashby" ? "radio" : "select", required: true, options: YES_NO };
  const hear: Field = { name: "source", label: "How did you hear about this job?", type: "select", options: ["LinkedIn", "Company website", "Referral", "Other"] };
  const salary: Field = { name: "salary", label: "What are your salary expectations?", type: "text" };
  const extra: Field[] = [];
  if (p.board === "auroralabs") extra.push({ name: "notice", label: "What is your notice period?", type: "text" }, { name: "relocate", label: "Are you open to relocating?", type: "select", options: YES_NO });
  if (p.form === "clearance") extra.push({ name: "clearance", label: "Do you currently hold an active Canadian government security clearance? Please state the level.", type: "text", required: true });

  if (p.ats === "lever") {
    return [
      { name: "name", label: "Full name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "phone", label: "Phone", type: "tel" },
      { name: "org", label: "Current company", type: "text" },
      { name: "resume", label: "Resume/CV", type: "file", required: true },
      { name: "linkedin", label: "LinkedIn URL", type: "url" },
      { name: "github", label: "GitHub URL", type: "url" },
      auth, spons, why, hear, salary, ...extra,
      { name: "comments", label: "Additional information", type: "textarea" },
    ];
  }
  if (p.ats === "ashby") {
    return [
      { name: "name", label: "Name", type: "text", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "resume", label: "Resume", type: "file", required: true },
      { name: "linkedin", label: "LinkedIn Profile", type: "url" },
      auth, spons, why, ...extra,
    ];
  }
  return [
    { name: "first_name", label: "First Name", type: "text", required: true },
    { name: "last_name", label: "Last Name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "phone", label: "Phone", type: "tel", required: true },
    { name: "resume", label: "Resume/CV", type: "file", required: true },
    { name: "cover_letter", label: "Cover Letter", type: "file" },
    { name: "linkedin", label: "LinkedIn Profile", type: "url" },
    { name: "website", label: "Website", type: "url" },
    auth, spons, why, hear, salary, ...extra, ...EEO(p.ats),
  ];
}

const THEME = {
  greenhouse: { accent: "#24a47f", head: "#fff", headInk: "#14213d", button: "Submit Application" },
  lever: { accent: "#1d1d1f", head: "#1d1d1f", headInk: "#fff", button: "Submit application" },
  ashby: { accent: "#5b4bd5", head: "#f4f2ff", headInk: "#2b2563", button: "Submit Application" },
};

function renderForm(p: DummyPosting, error = ""): string {
  const t = THEME[p.ats];
  const inputs = formFields(p).map((f) => {
    const req = f.required ? " required" : "";
    const star = f.required ? " *" : "";
    const id = `f_${f.name}`;
    let control: string;
    if (f.type === "textarea") control = `<textarea id="${id}" name="${f.name}"${req}></textarea>`;
    else if (f.type === "select") control = `<select id="${id}" name="${f.name}"${req}><option value="">Select...</option>${f.options!.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    else if (f.type === "radio") {
      return `<fieldset><legend>${esc(f.label)}${star}</legend>${f.options!.map((o, i) => `<label class="radio"><input type="radio" name="${f.name}" value="${esc(o)}"${i === 0 ? req : ""}> ${esc(o)}</label>`).join("")}</fieldset>`;
    } else control = `<input id="${id}" name="${f.name}" type="${f.type}"${f.type === "file" ? ' accept=".pdf,.doc,.docx"' : ""}${req}>`;
    return `<div class="field"><label for="${id}">${esc(f.label)}${star}</label>${control}</div>`;
  });
  const captcha = p.form === "captcha" ? '<div class="field"><div class="h-captcha" style="width:304px;height:78px;border:1px solid #ccc;background:#f9f9f9;display:flex;align-items:center;padding:0 12px">☐ I am human</div></div>' : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)} · ${esc(p.company)}</title><style>
  body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f;background:#fafafa}
  header{background:${t.head};color:${t.headInk};padding:22px 28px;border-bottom:3px solid ${t.accent}}
  header small{opacity:.7;display:block} header h1{margin:4px 0 0;font-size:24px}
  .sandbox{background:#fff4ce;color:#5c4400;padding:6px 28px;font-size:13px}
  main{max-width:720px;margin:24px auto;background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:24px 28px}
  .field,fieldset{margin:0 0 16px;border:0;padding:0} label{display:block;font-weight:600;margin-bottom:4px}
  label.radio{display:inline-block;font-weight:400;margin-right:16px}
  input[type=text],input[type=email],input[type=tel],input[type=url],select,textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ccc;border-radius:6px;font:inherit}
  textarea{min-height:90px} legend{font-weight:600;margin-bottom:4px}
  button{background:${t.accent};color:#fff;border:0;border-radius:6px;padding:11px 20px;font:inherit;font-weight:600;cursor:pointer}
  .error{background:#fde8e8;color:#9b1c1c;padding:10px 12px;border-radius:6px;margin-bottom:16px}
  </style></head><body>
  <div class="sandbox">Sandbox employer · fictional company · submissions go to the local inbox only</div>
  <header><small>${esc(p.company)} · ${p.ats === "greenhouse" ? "Apply for this Job" : p.ats === "lever" ? "Submit your application" : "Application"}</small><h1>${esc(p.title)}</h1><small>${esc(p.location)}</small></header>
  <main>${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
  <form method="post" action="/apply/${p.id}" enctype="multipart/form-data">${inputs.join("")}${captcha}<button type="submit">${t.button}</button></form></main></body></html>`;
}

function thanks(p: DummyPosting): string {
  return `<!doctype html><html><body style="font:16px -apple-system,Arial;padding:40px;text-align:center"><h1>Thank you for applying!</h1><p>Your application to ${esc(p.company)} has been submitted.</p></body></html>`;
}

export interface Employer {
  server: Server;
  baseUrl: string;
  fetcher: Fetcher;
  submissions(): Submission[];
  close(): Promise<void>;
}

export async function startEmployer(dataDir: string, port = 0): Promise<Employer> {
  const inboxDir = join(dataDir, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  const indexPath = join(inboxDir, "submissions.json");
  const subs: Submission[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
  const save = () => writeFileSync(indexPath, JSON.stringify(subs, null, 2) + "\n");
  let base = "";
  const formUrl = (p: DummyPosting) => `${base}/apply/${p.id}`;

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const html = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const m = /^\/apply\/([^/]+)$/.exec(u.pathname);
    const p = m && POSTINGS.find((x) => x.id === m[1]);

    if (req.method === "GET" && p) return html(200, renderForm(p));

    if (req.method === "POST" && p) {
      // Parse multipart with the platform's own Request, like a real backend would.
      const request = new Request(`http://localhost${req.url}`, { method: "POST", headers: req.headers as HeadersInit, body: req as any, duplex: "half" } as RequestInit);
      const form = await request.formData();
      if (p.form === "captcha" && !form.get("h-captcha-response")) return html(422, renderForm(p, "Please complete the captcha."));
      const missing: string[] = [];
      const fields: Submission["fields"] = [];
      const files: Submission["files"] = [];
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      for (const f of formFields(p)) {
        const v = form.get(f.name);
        if (f.type === "file") {
          if (v && typeof v !== "string" && v.size > 0) {
            const name = basename(v.name);
            const stored = `${id}-${f.name}-${name}`;
            writeFileSync(join(inboxDir, stored), Buffer.from(await v.arrayBuffer()));
            files.push({ label: f.label, name, bytes: v.size, stored });
          } else if (f.required) missing.push(f.label);
        } else {
          const s = typeof v === "string" ? v.trim() : "";
          if (!s && f.required) missing.push(f.label);
          if (s) fields.push({ label: f.label, value: s });
        }
      }
      if (missing.length) return html(422, renderForm(p, `Please fill in: ${missing.join(", ")}`));
      subs.unshift({ id, at: new Date().toISOString(), postingId: p.id, company: p.company, title: p.title, fields, files });
      save();
      return html(200, thanks(p));
    }

    if (req.method === "GET" && u.pathname === "/inbox") return html(200, inboxPage(subs));
    const fm = /^\/inbox\/file\/([^/]+)$/.exec(u.pathname);
    if (req.method === "GET" && fm) {
      const name = basename(decodeURIComponent(fm[1]));
      const path = join(inboxDir, name);
      if (!subs.some((s) => s.files.some((f) => f.stored === name)) || !existsSync(path)) return html(404, "not found");
      res.writeHead(200, { "content-type": name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream" });
      return res.end(readFileSync(path));
    }
    html(404, "not found");
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // ---- the public ATS APIs, answered locally ----
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const notFound = { ok: false, status: 404, json: async () => ({ error: "not found" }), text: async () => "" };
  const of = (ats: string, board: string) => POSTINGS.filter((p) => p.ats === ats && p.board === board);
  const gh = (p: DummyPosting) => ({
    id: Number(p.id), title: p.title, company_name: p.company, absolute_url: formUrl(p), location: { name: p.location },
    content: esc(`<p>${description(p).split("\n").map(esc).join("<br>")}</p>`),
    pay_input_ranges: p.pay ? [{ currency_type: p.pay.currency, min_cents: p.pay.min * 100, max_cents: p.pay.max * 100 }] : [],
  });
  const lv = (p: DummyPosting) => ({
    id: p.id, text: p.title, hostedUrl: `https://jobs.lever.co/${p.board}/${p.id}`, applyUrl: formUrl(p),
    categories: { location: p.location, commitment: p.employment }, workplaceType: p.workplace,
    descriptionPlain: description(p), lists: [], additionalPlain: "",
    salaryRange: p.pay ? { currency: p.pay.currency, min: p.pay.min, max: p.pay.max, interval: "per-year-salary" } : undefined,
  });
  const ab = (p: DummyPosting) => ({
    id: p.id, title: p.title, location: p.location, isRemote: p.workplace === "remote" || p.board === "sunbeam-compute",
    workplaceType: p.workplace === "remote" ? "Remote" : p.workplace === "hybrid" ? "Hybrid" : "OnSite",
    employmentType: p.employment === "Contract" ? "Contract" : "FullTime", descriptionPlain: description(p),
    jobUrl: `https://jobs.ashbyhq.com/${p.board}/${p.id}`, applyUrl: formUrl(p),
    compensation: p.pay ? { compensationTierSummary: `${p.pay.currency} ${p.pay.min.toLocaleString("en-US")} – ${p.pay.max.toLocaleString("en-US")}` } : undefined,
  });

  const fetcher: Fetcher = async (url: string) => {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (u.host === "boards-api.greenhouse.io") {
      const [, , board, , id] = parts; // v1/boards/{board}/jobs/{id}
      if (!id) return of("greenhouse", board).length ? ok({ jobs: of("greenhouse", board).map(gh) }) : notFound;
      const p = of("greenhouse", board).find((x) => x.id === id);
      return p ? ok(gh(p)) : notFound;
    }
    if (u.host === "api.lever.co" || u.host === "api.eu.lever.co") {
      const [, , board, id] = parts; // v0/postings/{board}/{id}
      if (!id) return of("lever", board).length ? ok(of("lever", board).map(lv)) : notFound;
      const p = of("lever", board).find((x) => x.id === id);
      return p ? ok(lv(p)) : notFound;
    }
    if (u.host === "api.ashbyhq.com") {
      const board = parts[2]; // posting-api/job-board/{board}
      return of("ashby", board).length ? ok({ jobs: of("ashby", board).map(ab) }) : notFound;
    }
    return notFound; // sandbox never reaches the real internet
  };

  return {
    server,
    baseUrl: base,
    fetcher,
    submissions: () => subs,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function inboxPage(subs: Submission[]): string {
  const rows = subs.map((s) => `<section><h2>${esc(s.company)} · ${esc(s.title)}</h2><div class="when">${new Date(s.at).toLocaleString()}</div>
    <table>${s.fields.map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value).replace(/\n/g, "<br>")}</td></tr>`).join("")}
    ${s.files.map((f) => `<tr><th>${esc(f.label)}</th><td><a href="/inbox/file/${encodeURIComponent(f.stored)}" target="_blank">📄 ${esc(f.name)}</a> (${Math.round(f.bytes / 1024)} KB)</td></tr>`).join("")}</table></section>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Employer inbox (sandbox)</title><meta http-equiv="refresh" content="10"><style>
  body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;background:#f6f4ef;color:#14213d}
  header{background:#5c4400;color:#fff;padding:16px 24px} header h1{margin:0;font-size:18px} header p{margin:2px 0 0;opacity:.85;font-size:13px}
  main{max-width:860px;margin:20px auto;padding:0 16px} section{background:#fff;border:1px solid #e1e4ea;border-radius:10px;padding:16px 18px;margin-bottom:14px}
  h2{margin:0;font-size:16px} .when{color:#5b6475;font-size:13px;margin-bottom:8px} table{border-collapse:collapse;width:100%;font-size:14px}
  th{text-align:left;width:38%;color:#5b6475;font-weight:500;padding:5px 8px;vertical-align:top;border-top:1px solid #eef0f4} td{padding:5px 8px;border-top:1px solid #eef0f4}
  .empty{color:#5b6475;text-align:center;padding:40px}</style></head><body>
  <header><h1>Employer inbox · sandbox</h1><p>Every application the agent submitted to the dummy employers, exactly as they received it. Refreshes every 10s.</p></header>
  <main>${rows.join("") || '<div class="empty">No applications received yet. Click Apply on a card in the chat.</div>'}</main></body></html>`;
}
