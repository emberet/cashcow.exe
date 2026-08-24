type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";
let asJson = true;

export function configureLogger(level: Level, json: boolean): void {
  minLevel = level;
  asJson = json;
}

/**
 * Keys whose values must never reach a log sink.
 *
 * `token` is deliberately anchored: a bare /token/ also matched `tokens` and
 * `tokensReceived`, redacting harmless amounts and making live launch logs
 * unreadable. Match auth-ish token keys, not every word containing "token".
 */
const REDACT =
  /secret|private|jwt|apikey|api_key|password|keypair|mnemonic|(^|[^a-z])(access|bearer|auth|session|csrf)?_?token([^a-z]|$)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const scrubbed = fields ? (scrub(fields) as Record<string, unknown>) : undefined;
  if (asJson) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...scrubbed });
    (level === "error" || level === "warn" ? console.error : console.log)(line);
    return;
  }
  const tail = scrubbed && Object.keys(scrubbed).length ? ` ${JSON.stringify(scrubbed)}` : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

export function errFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { err: e.message, stack: e.stack?.split("\n").slice(0, 4).join(" | ") };
  return { err: String(e) };
}
