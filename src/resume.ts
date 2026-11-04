/**
 * The base resume is plain markdown in a fixed shape:
 *
 *   # Full Name
 *   contact line
 *   ## Summary
 *   paragraph
 *   ## Skills
 *   - Category: a, b, c
 *   ## Experience
 *   ### Title | Company | Location | Dates
 *   - bullet
 *   ## <any other section>
 *
 * Parsing it gives every bullet a stable id, which is what lets the editor
 * re-rank bullets without being able to invent new ones.
 */

export interface Bullet {
  id: string;
  text: string;
}
export interface Role {
  id: string;
  heading: string;
  bullets: Bullet[];
}
export interface Resume {
  name: string;
  contact: string;
  summary: string;
  skills: string[];
  roles: Role[];
  /** Sections after Experience, kept verbatim (Education, Projects, ...). */
  otherSections: { heading: string; body: string }[];
  /** Whole source text, lower-cased, for keyword-honesty checks. */
  corpus: string;
}

export function parseResume(md: string): Resume {
  const lines = md.replace(/\r/g, "").split("\n");
  const resume: Resume = { name: "", contact: "", summary: "", skills: [], roles: [], otherSections: [], corpus: md.toLowerCase() };
  let section = "";
  let currentRole: Role | null = null;
  let other: { heading: string; body: string } | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      resume.name = line.slice(2).trim();
      section = "header";
      continue;
    }
    if (line.startsWith("## ")) {
      section = line.slice(3).trim().toLowerCase();
      currentRole = null;
      if (!["summary", "skills", "experience"].includes(section)) {
        other = { heading: line.slice(3).trim(), body: "" };
        resume.otherSections.push(other);
      } else other = null;
      continue;
    }
    if (section === "header" && line.trim() && !resume.contact) {
      resume.contact = line.trim();
      continue;
    }
    if (section === "summary" && line.trim()) {
      resume.summary += (resume.summary ? " " : "") + line.trim();
      continue;
    }
    if (section === "skills" && line.trim().startsWith("-")) {
      resume.skills.push(line.trim().replace(/^-\s*/, ""));
      continue;
    }
    if (section === "experience") {
      if (line.startsWith("### ")) {
        currentRole = { id: `r${resume.roles.length + 1}`, heading: line.slice(4).trim(), bullets: [] };
        resume.roles.push(currentRole);
      } else if (currentRole && line.trim().startsWith("-")) {
        currentRole.bullets.push({
          id: `${currentRole.id}.b${currentRole.bullets.length + 1}`,
          text: line.trim().replace(/^-\s*/, ""),
        });
      }
      continue;
    }
    if (other) other.body += line + "\n";
  }
  return resume;
}

/** Renders the resume as the editor sees it: every bullet tagged with its id. */
export function resumeForPrompt(r: Resume): string {
  const out = [`NAME: ${r.name}`, `SUMMARY: ${r.summary}`, "SKILLS:", ...r.skills.map((s) => `- ${s}`), "EXPERIENCE:"];
  for (const role of r.roles) {
    out.push(`[${role.id}] ${role.heading}`);
    for (const b of role.bullets) out.push(`  [${b.id}] ${b.text}`);
  }
  for (const s of r.otherSections) out.push(`${s.heading.toUpperCase()}:\n${s.body.trim()}`);
  return out.join("\n");
}
