import type { Browser } from "playwright";
import type { Resume, Role } from "./resume.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

/** Navy-border two-page layout (Arial, all-caps underlined navy headers). */
export function resumeHtml(resume: Resume, roles: Role[], summary: string): string {
  const section = (title: string, body: string) => `<h2>${esc(title)}</h2>${body}`;
  const jobs = roles
    .map((r) => {
      const [title, company, location, dates] = r.heading.split("|").map((x) => x.trim());
      return `<div class="role"><div class="role-head"><span><b>${esc(title ?? "")}</b>${company ? ` | ${esc(company)}` : ""}${location ? ` | ${esc(location)}` : ""}</span><span>${esc(dates ?? "")}</span></div><ul>${r.bullets.map((b) => `<li>${md(b.text)}</li>`).join("")}</ul></div>`;
    })
    .join("");
  const others = resume.otherSections
    .map((s) => {
      const lines = s.body.trim().split("\n").filter(Boolean);
      const bullets = lines.filter((l) => l.trim().startsWith("-"));
      const body = bullets.length === lines.length
        ? `<ul>${bullets.map((l) => `<li>${md(l.replace(/^\s*-\s*/, ""))}</li>`).join("")}</ul>`
        : lines.map((l) => `<p>${md(l.replace(/^\s*-\s*/, ""))}</p>`).join("");
      return section(s.heading, body);
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0.45in; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; margin: 0; }
  .page { border: 2px solid #1F3864; padding: 0.3in 0.35in; min-height: calc(11in - 0.9in - 4px); box-sizing: border-box; }
  h1 { text-align: center; font-size: 18pt; margin: 0 0 2px; color: #1F3864; }
  .contact { text-align: center; font-size: 9.5pt; margin-bottom: 8px; }
  h2 { color: #1F3864; font-size: 10.5pt; text-transform: uppercase; text-decoration: underline; margin: 10px 0 4px; }
  p { margin: 2px 0; }
  ul { margin: 2px 0 6px 16px; padding: 0; }
  li { margin: 1px 0; }
  .role-head { display: flex; justify-content: space-between; margin-top: 6px; }
  .role { break-inside: auto; }
  </style></head><body><div class="page">
  <h1>${esc(resume.name)}</h1><div class="contact">${esc(resume.contact)}</div>
  ${section("Professional Summary", `<p>${md(summary)}</p>`)}
  ${section("Technical Skills", `<ul>${resume.skills.map((s) => `<li>${md(s)}</li>`).join("")}</ul>`)}
  ${section("Professional Experience", jobs)}
  ${others}
  </div></body></html>`;
}

export function coverLetterHtml(name: string, contact: string, company: string, body: string): string {
  const paras = body.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0.9in; } body { font-family: Arial, sans-serif; font-size: 11pt; line-height: 1.45; }
  h1 { color: #1F3864; font-size: 16pt; margin: 0; } .c { font-size: 9.5pt; margin-bottom: 24px; } p { margin: 0 0 12px; }
  </style></head><body><h1>${esc(name)}</h1><div class="c">${esc(contact)}</div><p>Dear ${esc(company)} hiring team,</p>${paras}<p>Best regards,<br>${esc(name)}</p></body></html>`;
}

export async function htmlToPdf(browser: Browser, html: string, path: string): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path, format: "Letter", printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}
