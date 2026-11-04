import { chromium, type Browser } from "playwright";

/**
 * Uses Playwright's bundled Chromium by default. Set JOB_AGENT_CHROME_PATH to
 * use an installed Chrome instead (handy on machines where browser downloads
 * are blocked), or JOB_AGENT_HEADFUL=1 to watch it work.
 */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: process.env.JOB_AGENT_HEADFUL !== "1",
    executablePath: process.env.JOB_AGENT_CHROME_PATH || undefined,
  });
}
