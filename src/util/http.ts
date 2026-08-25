import { log, errFields } from "./log.ts";

export const USER_AGENT = "cashcow.exe/0.1";

export type FetchOpts = {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string | Uint8Array;
  /** Treat these status codes as acceptable rather than errors. */
  acceptStatuses?: number[];
};

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** Fetch with a hard timeout and bounded exponential backoff on 5xx/429. */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 12_000, retries = 2 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: { "user-agent": USER_AGENT, ...opts.headers },
        body: opts.body,
        signal: ctl.signal,
      });

      if (res.ok || opts.acceptStatuses?.includes(res.status)) return res;

      const retryable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => "");
      if (!retryable || attempt === retries) throw new HttpError(res.status, url, body);

      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt);
      log.debug("http retry", { url, status: res.status, attempt, waitMs: wait });
      await sleep(wait);
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      if (attempt === retries) break;
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`fetch failed for ${url}: ${errFields(lastErr).err}`);
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await httpFetch(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await httpFetch(url, opts);
  return res.text();
}

function backoff(attempt: number): number {
  // Jittered, so parallel feeds do not synchronise their retries.
  return Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
}

/**
 * A URL safe to put in an `href`, or null.
 *
 * HTML-escaping does NOT make a URL safe: `esc()` touches `& < > " '` and
 * leaves the scheme untouched, so `javascript:alert(1)` survives it intact and
 * lands in a clickable link. Feed URLs are third-party data -- a Hacker News
 * submission URL is whatever the submitter typed -- so the scheme has to be
 * checked explicitly against an allowlist.
 *
 * Leading control characters and whitespace are stripped first, because
 * browsers ignore them when resolving a scheme and "  jAvAsCrIpT:" is a
 * perfectly good payload otherwise.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0020]/g, "").trim();
  if (!cleaned) return null;

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
