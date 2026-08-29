import {
  randomBytes, scryptSync, timingSafeEqual, createHash,
} from "node:crypto";
import type { Db } from "../util/db.ts";
import { kvGet, kvSet } from "../util/db.ts";
import { log } from "../util/log.ts";

/**
 * Admin authentication.
 *
 * Design rules, in order of importance:
 *
 * 1. **Default deny.** With no password configured the admin portal is
 *    *disabled*, not open. A misconfiguration must never fail into access.
 * 2. **The password is never stored.** Only a scrypt hash -- bootstrapped from
 *    the environment, overridable by a rotation written to `kv`. There is no
 *    default and no fallback credential.
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

/**
 * `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 *
 * The work factor is stored *in* the hash. Raising the cost for new passwords
 * must never invalidate existing ones -- an earlier version of this file
 * hard-coded the parameters on both sides, so bumping N locked the operator out
 * of their own portal with a bare "Incorrect password."
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/** Node's scrypt defaults, used by hashes written before params were stored. */
const LEGACY_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Verify against the parameters the hash was CREATED with, not today's.
 * That is what lets the work factor rise without locking anyone out.
 */
function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return false;

  let params: { N: number; r: number; p: number; maxmem: number };
  let saltHex: string | undefined;
  let hashHex: string | undefined;

  if (parts.length === 6) {
    const [, n, r, p, salt, hash] = parts;
    const N = Number(n), rr = Number(r), pp = Number(p);
    if (!Number.isInteger(N) || !Number.isInteger(rr) || !Number.isInteger(pp)) return false;
    // Guard against a hostile hash string demanding absurd work of us.
    if (N < 1024 || N > (1 << 20) || rr < 1 || rr > 32 || pp < 1 || pp > 16) return false;
    params = { N, r: rr, p: pp, maxmem: 512 * 1024 * 1024 };
    saltHex = salt; hashHex = hash;
  } else if (parts.length === 3) {
    params = LEGACY_PARAMS;
    saltHex = parts[1]; hashHex = parts[2];
  } else {
    return false;
  }

  const salt = Buffer.from(saltHex!, "hex");
  const expected = Buffer.from(hashHex!, "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, params);
  return timingSafeEqual(derived, expected);
}

/** True when the stored hash predates parameter versioning and is worth rotating. */
export function isLegacyHash(stored: string): boolean {
  return stored.split("$").length === 3;
}

/** kv key holding a hash set from the portal or `admin-password --save`. */
const PASSWORD_KEY = "admin_password_hash";

export type HashSource = "db" | "env" | "none";

/**
 * The hash currently in force, and where it came from.
 *
 * `ADMIN_PASSWORD_HASH` is the BOOTSTRAP credential; a hash written to `kv`
 * overrides it. The override exists because the portal has to be able to
 * rotate the password, and a request handler cannot durably change an
 * environment variable -- rewriting the operator's `.env` from a web request
 * would be both invasive and easy to corrupt.
 *
 * Every reader calls this on each use rather than caching, so a rotation takes
 * effect immediately without a restart.
 *
 * The sharp edge: once a `kv` override exists, editing `.env` does nothing.
 * That is why `source` is reported everywhere auth status is shown, and why
 * `admin-password --clear` exists to hand control back to the environment.
 */
export function storedHash(db: Db): { hash: string | undefined; source: HashSource } {
  const fromDb = kvGet(db, PASSWORD_KEY);
  if (fromDb) return { hash: fromDb, source: "db" };
  const fromEnv = process.env.ADMIN_PASSWORD_HASH;
  if (fromEnv) return { hash: fromEnv, source: "env" };
  return { hash: undefined, source: "none" };
}

/** Hash and persist a new password. The plaintext is never stored or logged. */
export function setStoredPassword(db: Db, plaintext: string): void {
  kvSet(db, PASSWORD_KEY, hashPassword(plaintext));
}

/** Drop the DB override so `ADMIN_PASSWORD_HASH` governs again. */
export function clearStoredPassword(db: Db): void {
  db.prepare(`DELETE FROM kv WHERE key = ?`).run(PASSWORD_KEY);
}

/** True when the string is a hash we know how to verify against. */
function wellFormedHash(stored: string): boolean {
  const legacy = /^scrypt\$[0-9a-f]+\$[0-9a-f]{128}$/.test(stored);
  if (legacy) return true;

  const versioned = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$[0-9a-f]+\$[0-9a-f]{128}$/.exec(stored);
  if (!versioned) return false;

  const N = Number(versioned[1]);
  const r = Number(versioned[2]);
  const p = Number(versioned[3]);
  // Reject if parameters would require more than the 512 MiB maxmem used by login
  const requiredMem = 128 * N * r * p;
  if (requiredMem > 512 * 1024 * 1024) return false;

  return true;
}

export function authState(db: Db): AuthState {
  const { hash: stored, source } = storedHash(db);
  if (!stored) {
    return {
      configured: false,
      reason:
        "No admin password is set, so the admin portal is disabled. " +
        "Set one with: node src/cli.ts admin-password --save",
    };
  }
  if (!wellFormedHash(stored)) {
    // Name the source: a malformed value in the DB is invisible if the message
    // only ever talks about the environment variable.
    return {
      configured: false,
      reason: source === "db"
        ? "The stored admin password hash is malformed. Reset it with: " +
          "node src/cli.ts admin-password --save (or --clear to fall back to .env)"
        : "ADMIN_PASSWORD_HASH is set but malformed. It must be the full " +
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
  const state = authState(db);
  if (!state.configured) return { ok: false, reason: state.reason };
  const current = storedHash(db).hash!;

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

  if (!password || !verifyPassword(password, current)) {
    const now = Date.now();
    const cur = attempts.get(ip);
    if (cur && now - cur.first < LOCKOUT_MS) cur.count++;
    else attempts.set(ip, { count: 1, first: now });

    log.warn("admin login failed", { ip: label, attempts: attempts.get(ip)?.count });
    return { ok: false, reason: "Incorrect password." };
  }

  attempts.delete(ip);

  if (isLegacyHash(current)) {
    log.warn("admin password hash uses the old work factor", {
      note: "still valid; re-run `npm run admin-password` to upgrade it",
    });
  }

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
  if (!authState(db).configured) return false;

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

// -------------------------------------------------------- changing it

export const MIN_PASSWORD_LENGTH = 12;

export type ChangeResult =
  | { ok: true }
  | { ok: false; status: 400 | 401 | 429; reason: string; retryAfterMs?: number };

/**
 * Verify the current password and replace it.
 *
 * Throttled on its OWN bucket, separate from login. The session is what
 * authorises this call, so the throttle is not an auth control -- it is there
 * because `verifyPassword` at N=2^17 burns ~200ms of CPU, and without a limit
 * even a legitimately authenticated client could pin a core by hammering the
 * endpoint.
 *
 * `throttleKey` MUST be the real socket address, never a client-supplied
 * header (invariant 10).
 *
 * On success EVERY session is revoked, including the caller's. "Someone else
 * has a session I did not authorise" is a main reason to change a password, so
 * a rotation that left other sessions alive would miss the point.
 */
export function changePassword(
  db: Db, current: string, next: string, confirm: string, throttleKey: string,
): ChangeResult {
  const key = `pw:${throttleKey}`;
  const rec = attempts.get(key);
  if (rec && rec.count >= MAX_ATTEMPTS) {
    const elapsed = Date.now() - rec.first;
    if (elapsed < LOCKOUT_MS) {
      return {
        ok: false, status: 429,
        reason: "Too many attempts. Try again later.",
        retryAfterMs: LOCKOUT_MS - elapsed,
      };
    }
    attempts.delete(key);
  }

  const state = authState(db);
  if (!state.configured) return { ok: false, status: 400, reason: state.reason };

  if (!current || !verifyPassword(current, storedHash(db).hash!)) {
    const now = Date.now();
    const cur = attempts.get(key);
    if (cur && now - cur.first < LOCKOUT_MS) cur.count++;
    else attempts.set(key, { count: 1, first: now });
    return { ok: false, status: 401, reason: "Current password is incorrect." };
  }

  if (next !== confirm) {
    return { ok: false, status: 400, reason: "New passwords do not match." };
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false, status: 400,
      reason: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (next === current) {
    return { ok: false, status: 400, reason: "New password must be different." };
  }

  attempts.delete(key);
  setStoredPassword(db, next);
  revokeAllSessions(db);
  // Deliberately logs no part of the password, not even its length.
  log.warn("admin password changed", { sessionsRevoked: true });
  return { ok: true };
}

/** Test seam: clears both login and password-change throttle buckets. */
export function __resetThrottle(): void {
  attempts.clear();
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
