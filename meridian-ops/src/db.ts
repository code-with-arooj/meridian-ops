import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const root = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(root, "..", "meridian.db");

export const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    category TEXT,
    priority TEXT,
    summary TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

export type User = { id: number; email: string };

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string) {
  const next = scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, "hex");
  if (next.length !== prev.length) return false;
  return timingSafeEqual(next, prev);
}

export function createUser(email: string, password: string): User {
  const { hash, salt } = hashPassword(password);
  const result = db
    .prepare("INSERT INTO users (email, password_hash, salt) VALUES (?, ?, ?)")
    .run(email.toLowerCase().trim(), hash, salt);
  return { id: Number(result.lastInsertRowid), email: email.toLowerCase().trim() };
}

export function findUserByEmail(email: string) {
  return db
    .prepare("SELECT id, email, password_hash, salt FROM users WHERE email = ?")
    .get(email.toLowerCase().trim()) as
    | { id: number; email: string; password_hash: string; salt: string }
    | undefined;
}

export function createSession(userId: number) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expiresAt,
  );
  return token;
}

export function userFromToken(token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as User | undefined;
  return row ?? null;
}

export function destroySession(token: string) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

const marker = path.join(root, "..", ".seeded");
export function seedIfNeeded(userId: number) {
  const key = `${marker}-${userId}`;
  if (fs.existsSync(key)) return;
  const docs = [
    [
      "KYC review SOP",
      "Level-1 KYC needs government ID and a liveness selfie. Escalate if mismatch score exceeds 0.35. Freeze withdrawals until KYC is cleared. SLA is 4 hours for P1.",
    ],
    [
      "Withdrawal delay playbook",
      "Confirm the on-chain tx hash. If unbroadcast, check hot-wallet balance and network congestion. Amounts over $50k USD equivalent need dual control. Do not ask the user to resubmit unless the address checksum failed.",
    ],
    [
      "API error-rate incident",
      "Trigger: 5xx rate above 2% for 5 minutes on POST /api/v3/order. Shed non-critical reads, enable stale cache for market data, page matching-engine on-call. Never restart the matching engine without a runbook owner.",
    ],
    [
      "Account lockout policy",
      "Five failed logins in 15 minutes lock the account for 30 minutes. Support may unlock after verifying device fingerprint and last successful IP. Never send 2FA codes over chat.",
    ],
  ];
  const tickets = [
    ["USDT withdrawal stuck for 6 hours", "VIP2 user requested 12,400 USDT TRC20. No tx hash in app.", "open", "trading", "p1"],
    ["KYC selfie rejected twice", "CNIC applicant. Liveness score 0.41.", "open", "kyc", "p2"],
    ["Spot order API returning 503", "Market makers report 6% 5xx since 14:12 UTC.", "in_progress", "infra", "p0"],
    ["2FA loop after travel", "SG to DE. Email code arrives, app says invalid. No funds moved.", "open", "security", "p1"],
  ];
  const insDoc = db.prepare("INSERT INTO docs (user_id, title, content) VALUES (?, ?, ?)");
  const insT = db.prepare(
    "INSERT INTO tickets (user_id, title, body, status, category, priority) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const [title, content] of docs) insDoc.run(userId, title, content);
  for (const t of tickets) insT.run(userId, ...t);
  fs.writeFileSync(key, "ok");
}
