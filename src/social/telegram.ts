import { httpFetch } from "../util/http.ts";
import { log, errFields } from "../util/log.ts";
import type { Config } from "../config/schema.ts";
import type { TokenIdentity } from "../assets/naming.ts";
import type { Candidate } from "../scoring/score.ts";

/**
 * Private operator alerts on Telegram.
 *
 * This is NOT promotion -- it is one message to the operator's own chat so a
 * human knows a launch happened without watching the dashboard. No
 * disclosure footer (nobody but the operator sees it) and no USD meter (the
 * Telegram Bot API is free, unlike the X write API).
 *
 * Best-effort by construction, same contract as every other side call in the
 * launch path: it never throws, so a dead token or a network blip can never
 * fail a launch that already succeeded on-chain, and never counts toward
 * runner/loop.ts's MAX_CONSECUTIVE_FAILURES.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (names configurable).
 */

const API = "https://api.telegram.org";

type Creds = { token: string; chatId: string };

function readCreds(cfg: Config): Creds | undefined {
  const token = process.env[cfg.social.telegram.botTokenEnv];
  const chatId = process.env[cfg.social.telegram.chatIdEnv];
  if (!token || !chatId) return undefined;
  return { token, chatId };
}

/** Escapes the small set of characters Telegram's HTML parse mode reserves. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pure, and exported for testing. Uses HTML parse mode rather than Markdown:
 * coin names routinely contain underscores and asterisks, which Markdown
 * would treat as formatting and then reject the whole message as malformed.
 */
export function launchMessage(
  identity: Pick<TokenIdentity, "name" | "symbol" | "description">,
  mint: string,
  candidate?: Pick<Candidate, "term" | "feeds" | "score">,
): string {
  const lines = [
    `🐄 <b>Launched ${esc(identity.symbol)}</b> — ${esc(identity.name)}`,
  ];
  if (candidate) {
    lines.push(
      `<b>Trend:</b> ${esc(candidate.term)}`,
      `<b>Sources:</b> ${esc(candidate.feeds.join(", "))}`,
      `<b>Score:</b> ${Math.round(candidate.score)}/100`,
    );
  }
  lines.push(
    "",
    `<a href="https://pump.fun/coin/${esc(mint)}">View on pump.fun</a>`,
    `<code>${esc(mint)}</code>`,
  );
  return lines.join("\n");
}

/** Fire-and-forget alert. Never throws. */
export async function notifyLaunch(
  identity: Pick<TokenIdentity, "name" | "symbol" | "description">,
  mint: string,
  cfg: Config,
  candidate?: Pick<Candidate, "term" | "feeds" | "score">,
): Promise<void> {
  if (!cfg.social.telegram.enabled) return;

  const creds = readCreds(cfg);
  if (!creds) {
    log.warn("telegram notify skipped: credentials not set", {
      need: [cfg.social.telegram.botTokenEnv, cfg.social.telegram.chatIdEnv],
    });
    return;
  }

  try {
    await httpFetch(`${API}/bot${creds.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text: launchMessage(identity, mint, candidate),
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
      timeoutMs: 10_000,
      retries: 1,
    });
    log.info("telegram launch alert sent", { mint, symbol: identity.symbol });
  } catch (e) {
    // Deliberately swallowed. The coin is already minted; failing here would
    // turn a successful launch into a counted failure.
    log.warn("telegram notify failed", { mint, ...errFields(e) });
  }
}

/**
 * Pure, and exported for testing. All four fields are STRANGER INPUT from
 * the public CTO form -- esc() on every one, and the pitch is additionally
 * length-capped upstream (server.ts). HTML parse mode for the same reason
 * as launchMessage.
 */
export function ctoApplicationMessage(app: {
  mint: string; xHandle: string; wallet: string; pitch: string; symbol?: string | null;
}): string {
  return [
    `🤠 <b>CTO application</b>${app.symbol ? ` for ${esc(app.symbol)}` : ""}`,
    `<b>Coin:</b> pump.fun/coin/${esc(app.mint)}`,
    `<b>Applicant:</b> @${esc(app.xHandle)} — x.com/${esc(app.xHandle)}`,
    `<b>Their wallet (gets 80%):</b> <code>${esc(app.wallet)}</code>`,
    "",
    `<b>Pitch:</b> ${esc(app.pitch)}`,
    "",
    "Review in the admin portal. Accepting means MANUAL fee payouts to that wallet.",
  ].join("\n");
}

/**
 * Same never-throws contract as notifyLaunch: a Telegram blip must never
 * fail the application POST that already stored the row. Called from the
 * PUBLIC web process -- which holds the telegram token (an alert channel)
 * but still never the wallet key (invariant 4).
 */
export async function notifyCtoApplication(
  cfg: Config,
  app: { mint: string; xHandle: string; wallet: string; pitch: string; symbol?: string | null },
): Promise<void> {
  if (!cfg.social.telegram.enabled) return;
  const creds = readCreds(cfg);
  if (!creds) {
    log.warn("telegram cto notify skipped: credentials not set", {
      need: [cfg.social.telegram.botTokenEnv, cfg.social.telegram.chatIdEnv],
    });
    return;
  }
  try {
    await httpFetch(`${API}/bot${creds.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text: ctoApplicationMessage(app),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      timeoutMs: 10_000,
      retries: 1,
    });
    log.info("telegram cto application sent", { xHandle: app.xHandle, mint: app.mint });
  } catch (e) {
    log.warn("telegram cto notify failed", errFields(e));
  }
}
