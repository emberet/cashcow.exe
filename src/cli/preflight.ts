import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { Config } from "../config/schema.ts";
import { configuredWalletAddress } from "../chain/wallet.ts";
import type { Db } from "../util/db.ts";
import { authState } from "../web/auth.ts";
import { httpFetch } from "../util/http.ts";
import { redactEndpoint } from "../chain/rpc.ts";
import { enabledFeeds } from "../feeds/registry.ts";
import type { FeedContext } from "../feeds/types.ts";

/**
 * Pre-flight for a live run.
 *
 * Every check does the real thing rather than testing whether a variable is
 * non-empty: a present-but-revoked API key and an absent one fail identically
 * at 3am, and only one of them is obvious from `echo $VAR`. Nothing here spends
 * SOL or signs anything.
 */

export type CheckResult = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
};

const OK = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const WARN = (name: string, detail: string, fix?: string): CheckResult =>
  ({ name, status: "warn", detail, ...(fix ? { fix } : {}) });
const FAIL = (name: string, detail: string, fix?: string): CheckResult =>
  ({ name, status: "fail", detail, ...(fix ? { fix } : {}) });

/** Does the Anthropic key actually authenticate? */
async function checkAnthropic(cfg: Config, forMainnet: boolean): Promise<CheckResult> {
  const name = "Anthropic API key";
  const key = process.env[cfg.learning.apiKeyEnv];
  const live = forMainnet || (!cfg.dryRun && cfg.network === "mainnet-beta");

  if (!key) {
    return live
      ? FAIL(name, "not set — mainnet startup will refuse",
          "https://console.anthropic.com/settings/keys")
      : WARN(name, "not set — naming falls back to deterministic, no model screen",
          "https://console.anthropic.com/settings/keys");
  }

  try {
    const res = await httpFetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      timeoutMs: 15_000,
      retries: 0,
      acceptStatuses: [401, 403],
    });
    if (res.status === 401 || res.status === 403) {
      return FAIL(name, `key rejected (HTTP ${res.status}) — revoked or mistyped`,
        "https://console.anthropic.com/settings/keys");
    }
    return OK(name, "authenticates; naming and the brand/likeness screen are live");
  } catch (e) {
    return WARN(name, `could not reach the API: ${String(e).slice(0, 60)}`);
  }
}

/** Does the Pinata JWT actually authenticate? Without it, mainnet launches fail. */
async function checkPinata(cfg: Config, forMainnet: boolean): Promise<CheckResult> {
  const name = "Pinata JWT (IPFS)";
  const jwt = process.env[cfg.assets.ipfs.jwtEnv];
  const mainnet = forMainnet || cfg.network === "mainnet-beta";

  if (!jwt) {
    return mainnet
      ? FAIL(name, "not set — every mainnet launch will fail at the metadata step",
          "https://app.pinata.cloud/developers/api-keys")
      : WARN(name, "not set — off-mainnet uses a placeholder URI",
          "https://app.pinata.cloud/developers/api-keys");
  }

  try {
    const res = await httpFetch("https://api.pinata.cloud/data/testAuthentication", {
      headers: { authorization: `Bearer ${jwt}` },
      timeoutMs: 15_000,
      retries: 0,
      acceptStatuses: [401, 403],
    });
    if (res.status === 401 || res.status === 403) {
      return FAIL(name, `JWT rejected (HTTP ${res.status})`,
        "https://app.pinata.cloud/developers/api-keys");
    }
    return OK(name, "authenticates; token metadata can be pinned");
  } catch (e) {
    return WARN(name, `could not reach Pinata: ${String(e).slice(0, 60)}`);
  }
}

/** Does the Gemini key actually authenticate? Only relevant when opted in --
 *  the local SVG templates work with no credential at all. */
async function checkImageGenerator(cfg: Config): Promise<CheckResult> {
  const name = "Image generator";
  const i = cfg.assets.image;
  const provider = i.provider !== "local"
    ? i.provider
    : (i.gemini.enabled ? "gemini" : "local");

  if (provider === "local") {
    return OK(name, "local templates -- no credential needed");
  }

  if (provider === "cloudflare") {
    const c = i.cloudflare;
    const accountId = process.env[c.accountIdEnv];
    const apiToken = process.env[c.apiTokenEnv];
    if (!accountId || !apiToken) {
      return FAIL(name,
        `provider is "cloudflare" but ${!accountId ? c.accountIdEnv : c.apiTokenEnv} is not set -- ` +
        "every launch will silently fall back to local art",
        "https://dash.cloudflare.com/profile/api-tokens");
    }
    try {
      // Real authenticated call, per this file's own convention: a
      // present-but-revoked token and an absent one fail identically at 3am.
      const res = await httpFetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
        {
          headers: { authorization: `Bearer ${apiToken}` },
          timeoutMs: 15_000, retries: 0, acceptStatuses: [400, 401, 403, 404],
        },
      );
      if (res.status === 401 || res.status === 403) {
        return FAIL(name, `Cloudflare token rejected (HTTP ${res.status}) -- revoked, mistyped, or missing the Workers AI permission`,
          "https://dash.cloudflare.com/profile/api-tokens");
      }
      if (res.status === 404) {
        return FAIL(name, "account not found -- check CLOUDFLARE_ACCOUNT_ID",
          "https://dash.cloudflare.com/profile/api-tokens");
      }
      return OK(name, `Cloudflare Workers AI authenticates; ${c.model} is live`);
    } catch (e) {
      return WARN(name, `could not reach Cloudflare: ${String(e).slice(0, 60)}`);
    }
  }

  const g = i.gemini;
  const apiKey = process.env[g.apiKeyEnv];
  if (!apiKey) {
    return FAIL(name, `provider is "gemini" but ${g.apiKeyEnv} is not set -- every launch will fall back to local art`,
      "https://aistudio.google.com/apikey");
  }

  try {
    const res = await httpFetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
      timeoutMs: 15_000,
      retries: 0,
      acceptStatuses: [401, 403],
    });
    if (res.status === 401 || res.status === 403) {
      return FAIL(name, `key rejected (HTTP ${res.status}) — revoked or mistyped`,
        "https://aistudio.google.com/apikey");
    }
    return OK(name, "Gemini authenticates; generated art is live");
  } catch (e) {
    return WARN(name, `could not reach the API: ${String(e).slice(0, 60)}`);
  }
}

/** Is the RPC reachable, and is it one that can actually compete? */
async function checkRpc(cfg: Config, forMainnet: boolean): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const name = "Solana RPC";
  const url = cfg.rpc.primary;
  const isPublic = /api\.(mainnet-beta|devnet|testnet)\.solana\.com/.test(url);

  try {
    const conn = new Connection(url, cfg.rpc.commitment);
    const t0 = Date.now();
    const version = await conn.getVersion();
    const ms = Date.now() - t0;
    out.push(OK(name, `${redactEndpoint(url)} responding in ${ms}ms (v${version["solana-core"]})`));
  } catch (e) {
    out.push(FAIL(name, `${redactEndpoint(url)} unreachable: ${String(e).slice(0, 50)}`,
      "https://dashboard.helius.dev/signup"));
    return out;
  }

  if (isPublic && (forMainnet || cfg.network === "mainnet-beta")) {
    out.push(FAIL("RPC is the public endpoint",
      "rate-limited and shared; you will lose the races that matter",
      "https://dashboard.helius.dev/signup  ·  https://www.quicknode.com/chains/sol"));
  } else if (isPublic) {
    out.push(WARN("RPC is the public endpoint",
      "fine off-mainnet, not for competing on launches",
      "https://dashboard.helius.dev/signup"));
  }
  return out;
}

/** Wallet: present, on the right network, and funded enough to act. */
async function checkWallet(cfg: Config): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const name = "Dev wallet";
  const address = configuredWalletAddress(cfg);

  if (!address) {
    out.push(FAIL(name, "none configured",
      "generate one locally — see `npm run preflight -- --links`"));
    return out;
  }

  // A devnet keypair pointed at mainnet is a very easy mistake to make.
  const pathHint = cfg.wallet.keypairPath ?? "";
  if (cfg.network === "mainnet-beta" && /devnet|test/i.test(pathHint)) {
    out.push(WARN(name, `mainnet is configured but the keypair path reads "${pathHint}"`,
      "confirm this is really the wallet you mean to spend from"));
  }

  try {
    const conn = new Connection(cfg.rpc.primary, cfg.rpc.commitment);
    const sol = (await conn.getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
    const need = cfg.launch.estimatedCreateCostSol +
      (cfg.devPosition.enabled ? cfg.devPosition.buySol : 0) + cfg.risk.minWalletBalanceSol;

    if (sol < need) {
      out.push(FAIL(name,
        `${address.slice(0, 8)}… holds ${sol.toFixed(4)} SOL; one launch plus the reserve needs ~${need.toFixed(4)}`));
    } else {
      out.push(OK(name, `${address.slice(0, 8)}… holds ${sol.toFixed(4)} SOL on ${cfg.network}`));
    }
  } catch (e) {
    out.push(WARN(name, `could not read balance: ${String(e).slice(0, 50)}`));
  }
  return out;
}

/**
 * Which enabled feeds cannot actually poll.
 *
 * A feed with a missing credential stays `enabled: true` in config and fails
 * `readiness()` on every tick, logging one line nobody reads. Reddit and
 * Farcaster sat dead this way long enough to starve two of the five
 * independence families that corroboration is scored on, while preflight
 * reported all green -- it only ever checked launch-path credentials.
 */
const FEED_SIGNUP: Record<string, string> = {
  reddit: "https://www.reddit.com/prefs/apps",
  farcaster: "https://neynar.com/",
  xApi: "https://developer.x.com/en/portal/dashboard",
};

function checkFeeds(ctx: FeedContext): CheckResult[] {
  const feeds = enabledFeeds(ctx.cfg);
  const dead: CheckResult[] = [];

  for (const { adapter } of feeds) {
    const ready = adapter.readiness(ctx);
    if (ready.ready) continue;
    dead.push(WARN(`Feed: ${adapter.id}`,
      `enabled but cannot poll — ${ready.reason}`, FEED_SIGNUP[adapter.id]));
  }

  return dead.length ? dead : [OK("Feeds", `all ${feeds.length} enabled feeds can poll`)];
}

/** Config combinations that decide how much can be lost. */
function checkPosture(db: Db, cfg: Config): CheckResult[] {
  const out: CheckResult[] = [];
  const live = !cfg.dryRun && cfg.network === "mainnet-beta";

  out.push(cfg.dryRun
    ? OK("Mode", "dry run — nothing is signed")
    : WARN("Mode", `LIVE on ${cfg.network} — transactions will be signed`));

  if (live && cfg.filters.allowUnscreenedLive) {
    out.push(WARN("Brand screening", "allowUnscreenedLive is on — the model screen is bypassed"));
  }

  const perDay = cfg.risk.maxSolPerDay;
  out.push(live && perDay > 1
    ? WARN("Daily ceiling", `${perDay} SOL/day is a large first exposure`)
    : OK("Daily ceiling", `${perDay} SOL/day, ${cfg.risk.maxLaunchesPerDay} launches`));

  const auth = authState(db);
  out.push(auth.configured
    ? OK("Admin portal", "password configured")
    : WARN("Admin portal", "disabled — no ADMIN_PASSWORD_HASH", "npm run admin-password"));

  if (cfg.web.host !== "127.0.0.1" && cfg.web.host !== "localhost") {
    out.push(WARN("Dashboard exposure",
      `bound to ${cfg.web.host} — /admin is reachable from the network`,
      "put TLS in front and set web.behindTlsProxy"));
  }

  return out;
}

/**
 * @param forMainnet  Judge readiness for a live mainnet run even while the
 *                    config still says devnet. Without this you could not check
 *                    whether you are ready, because startup refuses mainnet
 *                    until the very keys you are checking for are present.
 */
export async function runPreflight(
  db: Db, cfg: Config, ctx: FeedContext, forMainnet = false,
): Promise<CheckResult[]> {
  const [anthropic, pinata, gemini, rpc, wallet] = await Promise.all([
    checkAnthropic(cfg, forMainnet),
    checkPinata(cfg, forMainnet),
    checkImageGenerator(cfg),
    checkRpc(cfg, forMainnet),
    checkWallet(cfg),
  ]);
  const posture = checkPosture(db, cfg);
  if (forMainnet && cfg.network !== "mainnet-beta") {
    posture.unshift(WARN("Target",
      `judging readiness for MAINNET while config says ${cfg.network}`));
  }
  return [...posture, anthropic, pinata, gemini, ...rpc, ...wallet, ...checkFeeds(ctx)];
}

export const SETUP_LINKS = `
  Anthropic API key   https://console.anthropic.com/settings/keys
                      Required for mainnet. Powers naming and the brand/likeness
                      screen that startup refuses to run without.

  Pinata (IPFS)       https://app.pinata.cloud/developers/api-keys
                      Free tier is enough. pump.fun's own IPFS endpoint is
                      deprecated, so metadata must be pinned externally.
                      Pricing: https://pinata.cloud/pricing

  Image generator     Only needed if assets.image.provider is not "local" --
                      the local SVG templates work with no credential at all.

                      Cloudflare Workers AI (free, recommended):
                        https://dash.cloudflare.com/profile/api-tokens
                        Create a Custom token with Account > Workers AI > Read.
                        Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
                        10,000 neurons/day free; one image is ~50-150.

                      Gemini (paid, no free image tier):
                        https://aistudio.google.com/apikey

  Dedicated RPC       https://dashboard.helius.dev/signup
                      https://www.quicknode.com/chains/sol
                      https://www.alchemy.com/solana
                      https://triton.one/
                      The public endpoint is shared and rate-limited; landing
                      speed is most of the edge on a trend.

  Mainnet wallet      Not a signup — generate it yourself, locally:
                        node -e "const {Keypair}=require('@solana/web3.js');\\
                          require('fs').writeFileSync('data/mainnet-keypair.json',\\
                          JSON.stringify([...Keypair.generate().secretKey]))"
                      Or via the Solana CLI: https://docs.anza.xyz/cli/install
                        solana-keygen new -o data/mainnet-keypair.json
                      Fund it from an exchange or an existing wallet
                      (https://phantom.app/download). Use a FRESH wallet holding
                      only what you would write off, and never paste its secret
                      into a chat, an issue, or a screenshot.
`;
