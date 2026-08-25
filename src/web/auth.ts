import {
  randomBytes, scryptSync, timingSafeEqual, createHash,
} from "node:crypto";
import type { Db } from "../util/db.ts";
import { log } from "../util/log.ts";

/**
 * Admin authentication.
 *
 * Design rules, in order of importance:
 *
 * 1. **Default deny.** With no password configured the admin portal is
 *    *disabled*, not open. A misconfiguration must never fail into access.
 * 2. **The password is never stored.** Only a scrypt hash, supplied through the
 *    environment. There is no default and no fallback credential.
 * 3. **Session tokens are stored hashed.** A leak of the database does not hand
 *    over live sessions.
 * 4. **Comparisons are timing-safe**, and failed logins are rate limited per IP.
 */

const SESSION_TTL_MS = 12 * 3600_000;
const SCRYPT_KEYLEN = 64;
/**
 * scrypt work factor. The default N=16384 measured ~24ms per guess, which is
 * thin cover for a human-chosen password if throttling is ever defeated.
 * N=2^17 costs ~8x more per attempt and is still imperceptible on one login.
 */
const SCRYPT_PARAMS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const COOKIE_NAME = "cashcow_admin";

// Login throttling. In-memory is adequate: a restart clears it, and the bot is
// a single long-lived process.
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; first: number }>();

export type AuthState =
  | { configured: false; reason: string }
  | { configured: true };

/** `scrypt$<saltHex>$<hashHex>` */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return timingSafeEqual(derived, expected);
}

export function authState(): AuthState {
  const stored = process.env.ADMIN_PASSWORD_HASH;
  if (!stored) {
    return {
      configured: false,
      reason:
        "ADMIN_PASSWORD_HASH is not set, so the admin portal is disabled. " +
        "Generate one with: node src/cli.ts admin-password",
    };
  }
  if (!/^scrypt\$[0-9a-f]+\$[0-9a-f]{128}$/.test(stored)) {
    return {
      configured: false,
      reason:
        "ADMIN_PASSWORD_HASH is set but malformed. It must be the full " +
        "`scrypt$salt$hash` string from: node src/cli.ts admin-password",
    };
  }
  return { configured: true };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: string; retryAfterMs?: number };

/**
 * @param throttleKey  The real socket address. MUST NOT be anything the client
 *                     can set -- keying this on `X-Forwarded-For` allowed
 *                     unlimited guesses by rotating the header.
 * @param label        Human-facing address for logs, which may be proxy-derived.
 */
export function login(db: Db, password: string, throttleKey: string, label = throttleKey): LoginResult {
  const state = authState();
  if (!state.configured) return { ok: false, reason: state.reason };

  const ip = throttleKey;
  const rec = attempts.get(ip);
  if (rec && rec.count >= MAX_ATTEMPTS) {
    const elapsed = Date.now() - rec.first;
    if (elapsed < LOCKOUT_MS) {
      return {
        ok: false,
        reason: "Too many failed attempts. Try again later.",
        retryAfterMs: LOCKOUT_MS - elapsed,
      };
    }
    attempts.delete(ip);
  }

  if (!password || !verifyPassword(password, process.env.ADMIN_PASSWORD_HASH!)) {
    const now = Date.now();
    const cur = attempts.get(ip);
    if (cur && now - cur.first < LOCKOUT_MS) cur.count++;
    else attempts.set(ip, { count: 1, first: now });

    log.warn("admin login failed", { ip: label, attempts: attempts.get(ip)?.count });
    return { ok: false, reason: "Incorrect password." };
  }

  attempts.delete(ip);

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  db.prepare(
    `INSERT INTO web_sessions (token_hash, created_at, expires_at, last_seen, label)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sha256(token), now, expiresAt, now, label);

  pruneSessions(db);
  log.info("admin login succeeded", { ip: label });
  return { ok: true, token, expiresAt };
}

export function validateSession(db: Db, token: string | undefined): boolean {
  if (!token) return false;
  if (!authState().configured) return false;

  const row = db.prepare(
    `SELECT expires_at FROM web_sessions WHERE token_hash = ?`,
  ).get(sha256(token)) as { expires_at: number } | undefined;

  if (!row) return false;
  if (Date.now() > row.expires_at) {
    db.prepare(`DELETE FROM web_sessions WHERE token_hash = ?`).run(sha256(token));
    return false;
  }

  db.prepare(`UPDATE web_sessions SET last_seen = ? WHERE token_hash = ?`)
    .run(Date.now(), sha256(token));
  return true;
}

export function logout(db: Db, token: string | undefined): void {
  if (!token) return;
  db.prepare(`DELETE FROM web_sessions WHERE token_hash = ?`).run(sha256(token));
}

export function pruneSessions(db: Db): void {
  db.prepare(`DELETE FROM web_sessions WHERE expires_at < ?`).run(Date.now());
}

export function sessionCount(db: Db): number {
  pruneSessions(db);
  return (db.prepare(`SELECT COUNT(*) n FROM web_sessions`).get() as { n: number }).n;
}

export function revokeAllSessions(db: Db): number {
  const res = db.prepare(`DELETE FROM web_sessions`).run();
  return Number(res.changes ?? 0);
}

// ------------------------------------------------------------------ cookies

export function cookieHeader(token: string, secure: boolean, maxAgeMs: number): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    // Strict rather than Lax: nothing here is meant to be reachable by
    // following a link from another site.
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader(secure: boolean): string {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return undefined;
}

// --------------------------------------------------------------------- CSRF

/**
 * Double-submit CSRF token, derived from the session so it needs no storage.
 * SameSite=Strict already blocks the classic cross-site POST; this is defence
 * in depth for older clients and for any future relaxation of the cookie.
 */
export function csrfToken(sessionToken: string): string {
  return createHash("sha256").update(`csrf:${sessionToken}`).digest("base64url");
}

export function checkCsrf(sessionToken: string | undefined, provided: string | undefined): boolean {
  if (!sessionToken || !provided) return false;
  const expected = csrfToken(sessionToken);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function auditAction(db: Db, action: string, detail: string, ip: string): void {
  db.prepare(`INSERT INTO audit_log (ts, action, detail, ip) VALUES (?, ?, ?, ?)`)
    .run(Date.now(), action, detail.slice(0, 500), ip);
}
