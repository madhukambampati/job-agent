// Run under tsx (not vitest) by e2e.test.ts: tsx's keepNames injects __name() into
// functions passed to page.evaluate, which broke form scanning in real CLI runs.
import { launchBrowser } from "../src/browser.js";
import { scanForm } from "../src/submit/form.js";
import { FORM_HAPPY } from "./helpers.js";

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setContent(FORM_HAPPY);
  const fields = await scanForm(page);
  console.log(JSON.stringify({ count: fields.length }));
} finally {
  await browser.close();
}
