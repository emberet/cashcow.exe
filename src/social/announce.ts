import { createHmac, randomBytes } from "node:crypto";
import { fetchJson } from "../util/http.ts";
import { log, errFields } from "../util/log.ts";
import type { Config } from "../config/schema.ts";
import type { BudgetGuard } from "../risk/budget.ts";
import type { TokenIdentity } from "../assets/naming.ts";

/**
 * Announces the bot's own real launches on X, from its own disclosed
 * account -- NOT the excluded "automated shilling from fake accounts"
 * (docs/DECISIONS.md #2). The disclosure marker in the post text is fixed,
 * not configurable, so it cannot be quietly edited away.
 *
 * POST /2/tweets requires OAuth 1.0a or OAuth 2.0 user-context -- the
 * app-only bearer token feeds/xApi.ts uses for reads cannot post. OAuth 1.0a
 * is used here rather than OAuth 2.0: four static credentials, generated
 * once in the X Developer Portal for this single bot-owned account, with no
 * runtime token refresh/rotation to manage.
 *
 * Env: X_ANNOUNCE_API_KEY, X_ANNOUNCE_API_SECRET, X_ANNOUNCE_ACCESS_TOKEN,
 * X_ANNOUNCE_ACCESS_TOKEN_SECRET -- deliberately distinct names from
 * X_BEARER_TOKEN (a different credential for a different purpose).
 */

export const METER_KEY = "x-announce-usd";

const POST_URL = "https://api.x.com/2/tweets";

/** RFC 3986 percent-encoding: encodeURIComponent does not escape !*'() . */
function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * OAuth 1.0a HMAC-SHA1 signature (RFC 5849 §3.4).
 *
 * Takes parameter pairs rather than a Record so a request with a repeated
 * parameter name normalizes correctly (RFC 5849 §3.4.1.3.2 sorts on encoded
 * *value* too when keys tie) -- a plain object would silently drop one of
 * the two. This codebase's only caller never repeats a key, but the RFC's
 * own worked example does, and that example is what this is tested against.
 *
 * A JSON POST body carries no form-encoded or query parameters, so per
 * §3.4.1.3 only the oauth_* parameters feed the signature base string in
 * this codebase's actual usage -- unlike the classic form-encoded examples
 * in most OAuth 1.0a tutorials, which also sign the request body's fields.
 */
export function signOAuth1(
  method: string, url: string, params: [string, string][],
  consumerSecret: string, tokenSecret: string,
): string {
  const encoded = params.map(([k, v]) => [percentEncode(k), percentEncode(v)] as const);
  encoded.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  const paramString = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  const base = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join("&");
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(base).digest("base64");
}

/** Builds the `Authorization: OAuth ...` header value for one signed request. */
export function buildAuthHeader(
  method: string, url: string,
  creds: { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string },
  nonce: string = randomBytes(16).toString("hex"),
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
): string {
  const oauthParams: [string, string][] = [
    ["oauth_consumer_key", creds.apiKey],
    ["oauth_nonce", nonce],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", timestamp],
    ["oauth_token", creds.accessToken],
    ["oauth_version", "1.0"],
  ];
  const signature = signOAuth1(method, url, oauthParams, creds.apiSecret, creds.accessTokenSecret);

  return "OAuth " + [...oauthParams, ["oauth_signature", signature] as [string, string]]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");
}

/**
 * Fixed disclosure template -- not a config value. Every post self-identifies
 * as automated, both because X's platform rules require bot accounts to
 * disclose and because that disclosure is what keeps this on the
 * transparent side of docs/DECISIONS.md #2's line.
 */
export function announcementText(identity: Pick<TokenIdentity, "name" | "symbol">, mint: string): string {
  return `🐄 auto-launched $${identity.symbol} (${identity.name}) -- pump.fun/coin/${mint}`;
}

type Creds = { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string };

function readCreds(): Creds | undefined {
  const apiKey = process.env.X_ANNOUNCE_API_KEY;
  const apiSecret = process.env.X_ANNOUNCE_API_SECRET;
  const accessToken = process.env.X_ANNOUNCE_ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ANNOUNCE_ACCESS_TOKEN_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return undefined;
  return { apiKey, apiSecret, accessToken, accessTokenSecret };
}

/**
 * Best-effort only: a failure here must never affect the launch it is
 * announcing. Caught and logged, never thrown -- a dead X credential must
 * never stop launches (runner/loop.ts's MAX_CONSECUTIVE_FAILURES counts
 * launch failures, not announcement failures, and this function must never
 * become a way to trip it).
 */
export async function postLaunchAnnouncement(
  identity: Pick<TokenIdentity, "name" | "symbol">, mint: string, cfg: Config, budget: BudgetGuard,
): Promise<void> {
  if (!cfg.social.xAnnounce.enabled) return;

  const creds = readCreds();
  if (!creds) {
    log.warn("x announce skipped: credentials not set", {
      need: ["X_ANNOUNCE_API_KEY", "X_ANNOUNCE_API_SECRET", "X_ANNOUNCE_ACCESS_TOKEN", "X_ANNOUNCE_ACCESS_TOKEN_SECRET"],
    });
    return;
  }

  const { monthlyUsdCap, estimatedCostPerPost } = cfg.social.xAnnounce;
  if (!budget.meterCharge(METER_KEY, estimatedCostPerPost, monthlyUsdCap)) {
    log.warn("x announce skipped: monthly USD cap would be exceeded", {
      used: budget.meterUsed(METER_KEY), cap: monthlyUsdCap,
    });
    return;
  }

  const text = announcementText(identity, mint);

  try {
    await fetchJson(POST_URL, {
      method: "POST",
      headers: {
        authorization: buildAuthHeader("POST", POST_URL, creds),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
      timeoutMs: 12_000,
      retries: 0, // billable, and a late announcement is harmless
    });
    log.info("x announce posted", { mint, text });
  } catch (e) {
    // Charged whether or not the post lands -- same as xApi.ts's read meter,
    // which charges an estimate before knowing the result. Retrying a failed
    // post is not worth a second charge for a best-effort feature.
    log.warn("x announce failed", { mint, ...errFields(e) });
  }
}
