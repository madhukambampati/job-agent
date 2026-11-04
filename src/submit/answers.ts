import { z } from "zod";
import type { LLM } from "../llm.js";
import { fullName, type Profile } from "../profile.js";

export interface FormField {
  /** data-ja-id we stamped on the element so we can find it again. */
  id: string;
  label: string;
  kind: "text" | "textarea" | "email" | "tel" | "url" | "number" | "select" | "combobox" | "radio" | "checkbox" | "file" | "date";
  required: boolean;
  options: string[];
}

export interface Answer {
  fieldId: string;
  value: string | null;
  /** Where the answer came from. "unknown" means we refuse to guess. */
  source: "profile" | "answer-bank" | "documents" | "model" | "unknown";
}

export interface Documents {
  resumePdf: string;
  coverNote: string;
  coverLetterPdf: string;
}

const yesNo = (b: boolean) => (b ? "Yes" : "No");

/** Deterministic mapping for the questions every ATS asks. Ordered: first match wins. */
function ruleFor(p: Profile, d: Documents): Array<[RegExp, string | ((f: FormField) => string | null)]> {
  return [
    [/resume|cv\b|curriculum/i, (f) => (f.kind === "file" ? d.resumePdf : null)],
    [/cover\s*letter/i, (f) => (f.kind === "file" ? d.coverLetterPdf : d.coverNote)],
    [/^first\s*name|given name|legal first/i, p.firstName],
    [/^last\s*name|surname|family name|legal last/i, p.lastName],
    [/preferred\s*(first\s*)?name/i, p.firstName],
    [/^(full\s*)?name\b/i, fullName(p)],
    [/e-?mail/i, p.email],
    [/phone|mobile|telephone/i, p.phone],
    [/linkedin/i, p.linkedin],
    [/github/i, p.github],
    [/website|portfolio|personal (site|url)|other (website|link)/i, p.website || p.github],
    [/current (company|employer)|company name|^organization/i, p.currentCompany],
    [/current (title|role|position)/i, p.currentTitle],
    [/postal|zip/i, p.postalCode],
    [/^city\b|city of residence/i, p.city],
    [/province|state\b|region/i, p.region],
    [/^country\b|country of residence/i, p.country],
    [/^location|where are you (located|based)|current location/i, `${p.city}, ${p.region}, ${p.country}`],
    [/(require|need).*(sponsor|visa)|sponsorship/i, yesNo(p.workAuthorization.requiresSponsorship)],
    [
      /(legally )?(authori[sz]ed|eligible|permitted).*work/i,
      (f) => {
        const countries = p.workAuthorization.authorizedCountries.map((c) => c.toLowerCase());
        const mentioned = countries.some((c) => f.label.toLowerCase().includes(c));
        const anyCountry = /(us|united states|canada|uk|u\.s\.)/i.test(f.label);
        if (anyCountry && !mentioned) return "No";
        return "Yes";
      },
    ],
    [/(salary|compensation|pay).*(expect|requirement|desired)|expected (salary|compensation)|desired (salary|pay)/i, p.salary.expected],
    [/years of (relevant |professional )?experience|how many years/i, String(p.yearsOfExperience)],
    [/notice period|start date|when can you start|earliest.*start/i, p.automation.noticePeriod],
    [/relocat/i, yesNo(p.automation.willingToRelocate)],
  ];
}

const DEMOGRAPHIC = /gender|race|ethnic|veteran|disability|hispanic|latino|sexual orientation|pronoun|transgender|indigenous|aboriginal|visible minority/i;
const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (answer|disclose|self)|choose not/i;

export function deterministicAnswer(field: FormField, p: Profile, d: Documents): Answer | null {
  const label = field.label.trim();

  if (DEMOGRAPHIC.test(label)) {
    const opt = field.options.find((o) => DECLINE.test(o));
    if (opt) return { fieldId: field.id, value: opt, source: "profile" };
    if (!field.required) return { fieldId: field.id, value: null, source: "profile" };
  }

  for (const [re, val] of ruleFor(p, d)) {
    if (!re.test(label)) continue;
    const v = typeof val === "function" ? val(field) : val;
    if (v === null || v === "") continue;
    const fitted = fitToOptions(v, field);
    if (fitted !== undefined) return { fieldId: field.id, value: fitted, source: field.kind === "file" || /cover/i.test(label) ? "documents" : "profile" };
  }

  // User's own answer bank: key matched as a case-insensitive substring of the label.
  for (const [k, v] of Object.entries(p.answers)) {
    if (label.toLowerCase().includes(k.toLowerCase())) {
      const fitted = fitToOptions(v, field);
      if (fitted !== undefined) return { fieldId: field.id, value: fitted, source: "answer-bank" };
    }
  }
  return null;
}

/** For choice fields, map a value onto an actual option; undefined if impossible. */
export function fitToOptions(value: string, field: FormField): string | undefined {
  if (!["select", "radio", "combobox"].includes(field.kind) || field.options.length === 0) return value;
  const v = value.toLowerCase().trim();
  return (
    field.options.find((o) => o.toLowerCase().trim() === v) ??
    field.options.find((o) => o.toLowerCase().startsWith(v)) ??
    field.options.find((o) => v.length > 2 && o.toLowerCase().includes(v)) ??
    (field.kind === "combobox" ? value : undefined)
  );
}

const ModelAnswersSchema = z.object({
  answers: z.array(
    z.object({
      fieldId: z.string(),
      value: z.string(),
      basis: z.string(),
    }),
  ),
});

const ANSWERER_SYSTEM = `You fill in job application questions for a candidate, using ONLY the facts provided.
For each field return a value, or exactly "UNKNOWN" when the facts do not answer it.
- Never invent experience, numbers, licences, clearances, references, or opinions the candidate didn't give.
- For choice fields, value must be copied exactly from the options list.
- Free-text "why this company / why you" questions: answer in 2-4 sentences using the cover note and resume facts only.
- Legal attestations, background-check consent, non-compete, and "agree to terms" questions: "UNKNOWN" (a human must decide).
- basis: quote the fact you used.`;

export async function modelAnswers(llm: LLM, fields: FormField[], facts: string): Promise<Answer[]> {
  if (fields.length === 0) return [];
  const res = await llm.structured({
    system: ANSWERER_SYSTEM,
    toolName: "fill_fields",
    toolDescription: "Return one answer per field id, or UNKNOWN.",
    schema: ModelAnswersSchema,
    maxTokens: 3000,
    prompt: `FACTS:\n${facts}\n\nFIELDS:\n${fields
      .map((f) => `- id=${f.id} kind=${f.kind} required=${f.required} label=${JSON.stringify(f.label)}${f.options.length ? ` options=${JSON.stringify(f.options)}` : ""}`)
      .join("\n")}`,
  });
  return fields.map((f) => {
    const a = res.answers.find((x) => x.fieldId === f.id);
    if (!a || a.value.trim().toUpperCase() === "UNKNOWN" || !a.value.trim()) return { fieldId: f.id, value: null, source: "unknown" };
    const fitted = fitToOptions(a.value, f);
    return fitted === undefined ? { fieldId: f.id, value: null, source: "unknown" } : { fieldId: f.id, value: fitted, source: "model" };
  });
}
