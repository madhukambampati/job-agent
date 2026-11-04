import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LLM, ResearchResult, StructuredRequest } from "../src/llm.js";
import { ProfileSchema, type Profile } from "../src/profile.js";

// Use installed Chrome when Playwright's own Chromium isn't downloaded.
if (!process.env.JOB_AGENT_CHROME_PATH && existsSync("/usr/bin/google-chrome")) {
  process.env.JOB_AGENT_CHROME_PATH = "/usr/bin/google-chrome";
}

/** Fake model: each tool name maps to a canned response (or a function of the prompt). */
export class FakeLLM implements LLM {
  calls: { tool: string; prompt: string }[] = [];
  constructor(
    private responses: Record<string, unknown | ((prompt: string) => unknown)>,
    private researchText: string | ((prompt: string) => string) = "## What they do\nTest co.",
  ) {}
  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    this.calls.push({ tool: req.toolName, prompt: req.prompt });
    const r = this.responses[req.toolName];
    if (r === undefined) throw new Error(`FakeLLM: no response for ${req.toolName}`);
    return req.schema.parse(typeof r === "function" ? (r as (p: string) => unknown)(req.prompt) : r);
  }
  async research(req: { prompt: string }): Promise<ResearchResult> {
    this.calls.push({ tool: "research", prompt: req.prompt });
    const text = typeof this.researchText === "function" ? this.researchText(req.prompt) : this.researchText;
    return { text, sources: [{ title: "Example news", url: "https://example.com/news" }] };
  }
}

export const profile: Profile = ProfileSchema.parse({
  firstName: "Alex",
  lastName: "Rivera",
  email: "alex@example.com",
  phone: "5550100000",
  city: "Toronto",
  region: "Ontario",
  country: "Canada",
  linkedin: "https://linkedin.com/in/example",
  github: "https://github.com/example",
  currentCompany: "Example Corp",
  currentTitle: "Senior SDET",
  yearsOfExperience: 8,
  workAuthorization: { authorizedCountries: ["Canada"], requiresSponsorship: false },
  salary: { floor: 90000, expected: "120,000 CAD" },
  search: { remoteOnly: true },
  automation: { scoreThreshold: 7, autoSubmit: true, dailyCap: 15 },
  answers: { "how did you hear": "LinkedIn" },
  resumePath: "resume.md",
});

export const RESUME_MD = `# Alex Rivera
Toronto, ON | alex@example.com

## Summary
Senior SDET with 8 years of test automation.

## Skills
- Automation: Playwright, Selenium
- Languages: TypeScript, Python

## Experience
### Senior SDET | Example Corp | Toronto | 2025 – Present
- Built a Playwright framework covering 400 tests.
- Built an LLM evaluation harness with a golden dataset.
- Wired tests into GitHub Actions.

### QA Engineer | Previous Co | Remote | 2020 – 2025
- Automated API tests in Python with pytest, catching 30 breaking changes.

## Education
- B.Tech, Example University
`;

/** Serves fixture application pages; POST /submit returns a thank-you page. */
export async function startFormServer(pages: Record<string, string>): Promise<{ url: string; server: Server; submissions: string[] }> {
  const submissions: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        submissions.push(body);
        res.writeHead(200, { "content-type": "text/html" }).end("<html><body><h1>Thank you for applying!</h1><p>Your application has been submitted.</p></body></html>");
      });
      return;
    }
    const page = pages[req.url?.split("?")[0] ?? ""];
    if (!page) return void res.writeHead(404).end("nope");
    res.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, submissions };
}

export const FORM_HAPPY = `<!doctype html><html><body>
<form method="post" action="/submit" enctype="multipart/form-data">
  <label for="first_name">First Name*</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last Name*</label><input id="last_name" name="last_name" required>
  <label for="email">Email*</label><input id="email" type="email" name="email" required>
  <label for="phone">Phone</label><input id="phone" type="tel" name="phone">
  <label for="resume">Resume/CV*</label><input id="resume" type="file" name="resume" required>
  <label for="li">LinkedIn Profile</label><input id="li" name="linkedin">
  <label for="spons">Will you now or in the future require visa sponsorship?*</label>
  <select id="spons" name="spons" required><option value="">Select...</option><option>Yes</option><option>No</option></select>
  <fieldset><legend>Are you legally authorized to work in Canada?</legend>
    <label><input type="radio" name="auth" value="y" required> Yes</label>
    <label><input type="radio" name="auth" value="n"> No</label>
  </fieldset>
  <label for="gender">Gender</label>
  <select id="gender" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select>
  <label for="hear">How did you hear about us?</label><input id="hear" name="hear">
  <label for="why">Why do you want to work at TestCo?*</label><textarea id="why" name="why" required></textarea>
  <button type="submit">Submit application</button>
</form></body></html>`;

export const FORM_UNANSWERABLE = FORM_HAPPY.replace(
  "<button",
  `<label for="clr">Do you hold an active government security clearance?*</label><input id="clr" name="clr" required><button`,
);

export const FORM_CAPTCHA = FORM_HAPPY.replace("<button", `<div class="h-captcha" style="width:300px;height:80px;background:#eee"></div><button`);
