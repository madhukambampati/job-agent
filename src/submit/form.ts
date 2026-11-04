import type { Page } from "playwright";
import type { FormField } from "./answers.js";

/**
 * Walks the live DOM and returns every fillable control with a human label.
 * Each control gets a data-ja-id stamp so the filler can find it again even
 * if the ATS re-renders. Works across Greenhouse, Lever and Ashby because it
 * reads labels the way a screen reader would, not ATS-specific selectors.
 */
/**
 * tsx/esbuild (keepNames) wraps named functions in a `__name(...)` helper that
 * only exists in Node. Functions shipped into the page via evaluate() then
 * throw "ReferenceError: __name is not defined", so define a no-op in the page.
 */
async function ensureNameShim(page: Page): Promise<void> {
  await page.evaluate("window.__name = window.__name || function (f) { return f; }");
}

export async function scanForm(page: Page): Promise<FormField[]> {
  await ensureNameShim(page);
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/\*$/, "").trim();
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const st = getComputedStyle(el as HTMLElement);
      return (r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none") || (el as HTMLInputElement).type === "file";
    };
    const labelOf = (el: HTMLElement): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return clean(aria);
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        if (clean(t)) return clean(t);
      }
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(l.textContent)) return clean(l.textContent);
      }
      const wrap = el.closest("label");
      if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
      const legend = el.closest("fieldset")?.querySelector("legend");
      if (legend && clean(legend.textContent)) return clean(legend.textContent);
      // Nearest preceding label-ish text inside the same field container.
      let node: HTMLElement | null = el.parentElement;
      for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
        const l = node.querySelector("label, .label, [class*='label'], [class*='question']");
        if (l && l !== el && clean(l.textContent)) return clean(l.textContent);
      }
      return clean(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    };
    const isRequired = (el: HTMLElement, label: string) =>
      (el as HTMLInputElement).required ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$/.test((document.querySelector(`label[for="${CSS.escape(el.id || "_")}"]`)?.textContent ?? "").trim()) ||
      /\(required\)/i.test(label);

    const fields: any[] = [];
    let n = 0;
    const stamp = (el: Element) => {
      const id = `f${++n}`;
      el.setAttribute("data-ja-id", id);
      return id;
    };
    const seenRadioGroups = new Set<string>();

    const controls = document.querySelectorAll<HTMLElement>("input, textarea, select");
    for (const el of controls) {
      if (!visible(el)) continue;
      const input = el as HTMLInputElement;
      const type = (input.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
      if (input.disabled || input.readOnly) continue;

      if (type === "radio") {
        const group = input.name;
        if (!group || seenRadioGroups.has(group)) continue;
        seenRadioGroups.add(group);
        const radios = [...document.querySelectorAll<HTMLInputElement>(`input[type=radio][name="${CSS.escape(group)}"]`)];
        const legend = clean(input.closest("fieldset")?.querySelector("legend")?.textContent) || (() => {
          let node = input.parentElement;
          for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
            const all = node.querySelectorAll("input[type=radio]");
            if (all.length >= radios.length && node.parentElement) {
              const q = node.parentElement.querySelector("label, legend, [class*='label'], [class*='question']");
              if (q && !q.contains(input)) return clean(q.textContent);
            }
          }
          return group;
        })();
        const id = stamp(input);
        radios.forEach((r) => r.setAttribute("data-ja-group", id));
        fields.push({
          id,
          label: legend,
          kind: "radio",
          required: radios.some((r) => r.required),
          options: radios.map((r) => labelOf(r)),
        });
        continue;
      }

      const label = labelOf(el);
      const id = stamp(el);
      let kind: string;
      let options: string[] = [];
      if (el.tagName === "SELECT") {
        kind = "select";
        options = [...(el as HTMLSelectElement).options].filter((o) => o.value !== "").map((o) => clean(o.textContent));
      } else if (el.tagName === "TEXTAREA") kind = "textarea";
      else if (el.getAttribute("role") === "combobox") kind = "combobox";
      else if (["email", "tel", "url", "number", "checkbox", "file", "date"].includes(type)) kind = type;
      else kind = "text";
      fields.push({ id, label, kind, required: isRequired(el, label), options });
    }
    return fields;
  });
}

/** Fills one field. Returns false if the value didn't stick. */
export async function fillField(page: Page, field: FormField, value: string): Promise<boolean> {
  const sel = `[data-ja-id="${field.id}"]`;
  const el = page.locator(sel).first();
  switch (field.kind) {
    case "file":
      await el.setInputFiles(value);
      return (await el.evaluate((i: HTMLInputElement) => i.files?.length ?? 0)) > 0;
    case "select":
      await el.selectOption({ label: value });
      return true;
    case "radio": {
      const radios = page.locator(`[data-ja-group="${field.id}"]`);
      const count = await radios.count();
      for (let i = 0; i < count; i++) {
        const r = radios.nth(i);
        const lbl = await r.evaluate((node: HTMLInputElement) => {
          const l = node.id ? document.querySelector(`label[for="${CSS.escape(node.id)}"]`) : node.closest("label");
          return (l?.textContent ?? node.value).replace(/\s+/g, " ").trim();
        });
        if (lbl.toLowerCase() === value.toLowerCase()) {
          await r.check({ force: true });
          return r.isChecked();
        }
      }
      return false;
    }
    case "checkbox": {
      const want = /^(yes|true|checked|1)$/i.test(value);
      await el.setChecked(want, { force: true });
      return (await el.isChecked()) === want;
    }
    case "combobox":
      await el.click();
      await el.fill(value);
      await page.waitForTimeout(400);
      await el.press("ArrowDown");
      await el.press("Enter");
      return true;
    default:
      await el.fill(value);
      return (await el.inputValue()) === value;
  }
}

/** A captcha the user would have to solve by hand. We never try to solve these. */
export async function hasBlockingCaptcha(page: Page): Promise<boolean> {
  const frames = page.frames().map((f) => f.url());
  const challenge = frames.some((u) => /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/.test(u));
  const checkbox = await page.locator("iframe[src*='recaptcha'][src*='anchor']:visible, .h-captcha:visible, .cf-turnstile:visible").count();
  return challenge || checkbox > 0;
}

const CONFIRMATION = /thank(s| you)[^.]{0,40}(appl|interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (submitted|applied)/i;

export async function submitAndConfirm(page: Page, timeoutMs = 20000): Promise<{ confirmed: boolean; evidence: string }> {
  const button = page
    .locator("button[type=submit], input[type=submit], button")
    .filter({ hasText: /submit( application)?|send application|apply( now)?$/i })
    .first();
  const fallback = page.locator("button[type=submit], input[type=submit]").first();
  const target = (await button.count()) ? button : fallback;
  if (!(await target.count())) return { confirmed: false, evidence: "No submit button found" };

  const before = page.url();
  await target.click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText().catch(() => "");
    const m = CONFIRMATION.exec(text);
    if (m) return { confirmed: true, evidence: m[0] };
    if (page.url() !== before && /confirm|thank|success/i.test(page.url())) return { confirmed: true, evidence: page.url() };
    await page.waitForTimeout(500);
  }
  const errors = await page
    .locator("[class*='error' i]:visible, [role=alert]:visible")
    .allInnerTexts()
    .catch(() => []);
  return { confirmed: false, evidence: errors.filter(Boolean).slice(0, 5).join(" | ") || "No confirmation message within timeout" };
}
