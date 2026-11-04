import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { localDay } from "../dates.js";
import { LedgerRowSchema, type LedgerRow, type LedgerStatus } from "../types.js";

/**
 * THE LEDGER: one row per role. A plain JSON file so it's diffable and you can
 * open it in anything; `exportCsv` gives a spreadsheet view.
 */
export class Ledger {
  private rows: LedgerRow[];

  constructor(private path = process.env.JOB_AGENT_LEDGER ?? "data/ledger.json") {
    this.rows = existsSync(path) ? z.array(LedgerRowSchema).parse(JSON.parse(readFileSync(path, "utf8"))) : [];
  }

  all(): LedgerRow[] {
    return [...this.rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(key: string): LedgerRow | undefined {
    return this.rows.find((r) => r.key === key);
  }

  /** True if this job has already gone out (or is past that stage). */
  alreadyApplied(key: string): boolean {
    const r = this.get(key);
    return !!r && !["skipped", "ready", "needs_manual", "failed"].includes(r.status);
  }

  appliedToday(now = new Date()): number {
    const day = localDay(now);
    return this.rows.filter((r) => r.appliedAt && localDay(new Date(r.appliedAt)) === day).length;
  }

  upsert(row: Partial<LedgerRow> & Pick<LedgerRow, "key" | "company" | "title" | "url">): LedgerRow {
    const now = new Date().toISOString();
    const existing = this.get(row.key);
    const next: LedgerRow = LedgerRowSchema.parse({
      score: null,
      status: "ready",
      appliedAt: null,
      followedUpAt: null,
      nextStep: "",
      nextStepDate: null,
      notes: "",
      outDir: null,
      ...existing,
      ...row,
      updatedAt: now,
    });
    if (existing) this.rows[this.rows.indexOf(existing)] = next;
    else this.rows.push(next);
    this.save();
    return next;
  }

  setStatus(key: string, status: LedgerStatus, nextStep?: string, nextStepDate?: string | null): LedgerRow {
    const r = this.get(key);
    if (!r) throw new Error(`No ledger row with key ${key}`);
    const patch: Partial<LedgerRow> = { status };
    if (status === "applied" && !r.appliedAt) patch.appliedAt = new Date().toISOString();
    if (status === "followed_up") patch.followedUpAt = new Date().toISOString();
    if (nextStep !== undefined) patch.nextStep = nextStep;
    if (nextStepDate !== undefined) patch.nextStepDate = nextStepDate;
    return this.upsert({ ...r, ...patch });
  }

  /** Applied roles with no follow-up after `days`, or with a next step due. */
  due(now = new Date(), days = 7): LedgerRow[] {
    const cutoff = now.getTime() - days * 86_400_000;
    const today = localDay(now);
    return this.all().filter(
      (r) =>
        (r.status === "applied" && r.appliedAt && new Date(r.appliedAt).getTime() < cutoff) ||
        (r.nextStepDate && r.nextStepDate <= today && !["rejected", "withdrawn", "skipped"].includes(r.status)),
    );
  }

  exportCsv(): string {
    const cols: (keyof LedgerRow)[] = ["company", "title", "score", "status", "appliedAt", "followedUpAt", "nextStep", "nextStepDate", "url", "notes"];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(","), ...this.all().map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.rows, null, 2) + "\n");
  }
}
