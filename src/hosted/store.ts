import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProfileSchema, type Profile } from "../profile.js";

/**
 * Hosted-mode storage: accounts, sessions, and each user's profile + base resume.
 * SQLite for now (single node). Every row that belongs to a person is keyed by
 * `user_id`; nothing here reads or writes another user's data. Ledger and
 * generated documents live in a per-user directory (see `userDir`).
 */
export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.JOB_AGENT_DB ?? "data/hosted.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_json TEXT,
        resume_md TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  createUser(id: string, email: string, passwordHash: string): UserRow {
    const createdAt = new Date().toISOString();
    this.db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)").run(id, email, passwordHash, createdAt);
    return { id, email, passwordHash, createdAt };
  }

  userByEmail(email: string): UserRow | undefined {
    return this.mapUser(this.db.prepare("SELECT * FROM users WHERE email = ?").get(email));
  }

  userById(id: string): UserRow | undefined {
    return this.mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  private mapUser(r: unknown): UserRow | undefined {
    if (!r) return undefined;
    const x = r as Record<string, string>;
    return { id: x.id, email: x.email, passwordHash: x.password_hash, createdAt: x.created_at };
  }

  addSession(tokenHash: string, userId: string, expiresAt: number): void {
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt);
  }

  sessionUser(tokenHash: string, now = Date.now()): string | undefined {
    const r = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as { user_id: string; expires_at: number } | undefined;
    if (!r) return undefined;
    if (r.expires_at < now) {
      this.deleteSession(tokenHash);
      return undefined;
    }
    return r.user_id;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  /** Raw saved data for a user; either part may still be missing during onboarding. */
  getData(userId: string): { profile: unknown | null; resumeMarkdown: string | null } {
    const r = this.db.prepare("SELECT profile_json, resume_md FROM user_data WHERE user_id = ?").get(userId) as { profile_json: string | null; resume_md: string | null } | undefined;
    return { profile: r?.profile_json ? JSON.parse(r.profile_json) : null, resumeMarkdown: r?.resume_md ?? null };
  }

  saveProfile(userId: string, profile: Profile): void {
    this.upsert(userId, "profile_json", JSON.stringify(profile));
  }

  saveResume(userId: string, markdown: string): void {
    this.upsert(userId, "resume_md", markdown);
  }

  private upsert(userId: string, col: "profile_json" | "resume_md", value: string): void {
    this.db
      .prepare(
        `INSERT INTO user_data (user_id, ${col}, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = excluded.updated_at`,
      )
      .run(userId, value, new Date().toISOString());
  }

  /** Both parts present and valid, or null (user still has onboarding to finish). */
  loadComplete(userId: string): { profile: Profile; resumeMarkdown: string } | null {
    const d = this.getData(userId);
    if (!d.profile || !d.resumeMarkdown?.trim()) return null;
    const parsed = ProfileSchema.safeParse(d.profile);
    return parsed.success ? { profile: parsed.data, resumeMarkdown: d.resumeMarkdown } : null;
  }

  close(): void {
    this.db.close();
  }
}
