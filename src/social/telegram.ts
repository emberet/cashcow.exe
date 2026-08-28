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
