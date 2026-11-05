import { chromium, type Browser } from "playwright";

/** The browser can't start at all (not installed), as opposed to a page failing. */
export class BrowserSetupError extends Error {}

export const BROWSER_SETUP_HELP =
  "The browser the agent uses isn't installed on this computer. In the job-agent folder run: npx playwright install chromium (or install Google Chrome), then try again.";

/**
 * Tries, in order: JOB_AGENT_CHROME_PATH, Playwright's own Chromium, then the
 * Google Chrome / Microsoft Edge already installed on this computer. So a
 * missing `npx playwright install` doesn't block applying when Chrome exists.
 * JOB_AGENT_HEADFUL=1 shows the window.
 */
export async function launchBrowser(): Promise<Browser> {
  const headless = process.env.JOB_AGENT_HEADFUL !== "1";
  const attempts: Array<() => Promise<Browser>> = [];
  if (process.env.JOB_AGENT_CHROME_PATH) attempts.push(() => chromium.launch({ headless, executablePath: process.env.JOB_AGENT_CHROME_PATH }));
  attempts.push(() => chromium.launch({ headless }));
  attempts.push(() => chromium.launch({ headless, channel: "chrome" }));
  attempts.push(() => chromium.launch({ headless, channel: "msedge" }));
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      errors.push((e as Error).message.split("\n")[0]);
    }
  }
  const err = new BrowserSetupError(BROWSER_SETUP_HELP);
  (err as Error & { detail?: string[] }).detail = errors;
  throw err;
}
