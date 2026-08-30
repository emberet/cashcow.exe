/**
 * One-time, PIN-based OAuth 1.0a authorization -- mints access tokens for
 * the account that clicks "Authorize", which is how the BOT account
 * (@cashcowEXE) gets tokens under an app owned by the operator's personal
 * developer account. The portal's own "Access Token" button can only ever
 * mint tokens for the app owner, which is exactly the wrong account here:
 * preflight caught the first attempt authenticating as the operator.
 *
 * Usage:
 *   node scripts/x-authorize.ts request
 *     -> prints an authorize URL. Open it in a browser logged in as the BOT
 *        account, click Authorize, copy the 7-digit PIN.
 *   node scripts/x-authorize.ts exchange --pin 1234567
 *     -> prints the access token + secret for .env (and which account they
 *        belong to, so the @emberetme mistake cannot repeat silently).
 *
 * Reads X_ANNOUNCE_API_KEY / X_ANNOUNCE_API_SECRET from the environment.
 * The intermediate request token is held in a scratch file between the two
 * steps; it is worthless without the PIN and expires in minutes.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signOAuth1 } from "../src/social/announce.ts";

const REQUEST_URL = "https://api.x.com/oauth/request_token";
const AUTHORIZE_URL = "https://api.x.com/oauth/authorize";
const ACCESS_URL = "https://api.x.com/oauth/access_token";
const STATE = join(tmpdir(), "cashcow-x-authorize.json");

function oauthHeader(
  method: string, url: string, extra: [string, string][],
  consumerSecret: string, tokenSecret: string,
): string {
  const params: [string, string][] = [
    ["oauth_consumer_key", process.env.X_ANNOUNCE_API_KEY!],
    ["oauth_nonce", randomBytes(16).toString("hex")],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", Math.floor(Date.now() / 1000).toString()],
    ["oauth_version", "1.0"],
    ...extra,
  ];
  const signature = signOAuth1(method, url, params, consumerSecret, tokenSecret);
  const enc = (s: string) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return "OAuth " + [...params, ["oauth_signature", signature] as [string, string]]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(", ");
}

async function post(url: string, header: string): Promise<Record<string, string>> {
  const res = await fetch(url, { method: "POST", headers: { authorization: header } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  return Object.fromEntries(new URLSearchParams(text));
}

const mode = process.argv[2];
if (!process.env.X_ANNOUNCE_API_KEY || !process.env.X_ANNOUNCE_API_SECRET) {
  console.error("X_ANNOUNCE_API_KEY / X_ANNOUNCE_API_SECRET must be set (source .env)");
  process.exit(1);
}

if (mode === "request") {
  const header = oauthHeader("POST", REQUEST_URL, [["oauth_callback", "oob"]],
    process.env.X_ANNOUNCE_API_SECRET!, "");
  const r = await post(REQUEST_URL, header);
  if (r.oauth_callback_confirmed !== "true") throw new Error("callback not confirmed");
  writeFileSync(STATE, JSON.stringify({ token: r.oauth_token, secret: r.oauth_token_secret }));
  console.log(`\n  1. In a browser where the BOT account is logged in, open:\n`);
  console.log(`     ${AUTHORIZE_URL}?oauth_token=${r.oauth_token}\n`);
  console.log(`  2. Click Authorize, copy the PIN, then run:`);
  console.log(`     node scripts/x-authorize.ts exchange --pin <PIN>\n`);
} else if (mode === "exchange") {
  const i = process.argv.indexOf("--pin");
  const pin = i >= 0 ? process.argv[i + 1] : undefined;
  if (!pin) { console.error("--pin <PIN> required"); process.exit(1); }
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { token: string; secret: string };
  const header = oauthHeader("POST", ACCESS_URL,
    [["oauth_token", st.token], ["oauth_verifier", pin]],
    process.env.X_ANNOUNCE_API_SECRET!, st.secret);
  const r = await post(ACCESS_URL, header);
  console.log(`\n  authorized account : @${r.screen_name}`);
  console.log(`  X_ANNOUNCE_ACCESS_TOKEN=${r.oauth_token}`);
  console.log(`  X_ANNOUNCE_ACCESS_TOKEN_SECRET=${r.oauth_token_secret}\n`);
  if (r.screen_name?.toLowerCase() !== "cashcowexe") {
    console.log(`  WARNING: that is not the bot account. The browser that opened the`);
    console.log(`  authorize URL was logged in as @${r.screen_name}. Re-run 'request'`);
    console.log(`  from a browser session where @cashcowEXE is the active account.\n`);
  }
} else {
  console.error("usage: x-authorize.ts request | exchange --pin <PIN>");
  process.exit(1);
}
