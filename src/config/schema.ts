import { z } from "zod";

/**
 * Every knob the operator can turn lives here. Nothing that affects spend,
 * risk, or launch behaviour may be hardcoded elsewhere in the codebase.
 *
 * Defaults are deliberately conservative: the base rates on pump.fun mean an
 * untuned bot loses money, so the defaults are sized so that a bad week costs
 * lunch rather than rent.
 */

const solAmount = z.number().positive().finite();
const pct = z.number().min(0).max(100);

export const priorityFeeSchema = z.object({
  /** `fixed` uses microLamports directly; `dynamic` samples recent fees from the RPC. */
  mode: z.enum(["fixed", "dynamic"]).default("dynamic"),
  fixedMicroLamports: z.number().int().nonnegative().default(200_000),
  /** Percentile of recent prioritization fees to target when mode=dynamic. */
  percentile: z.number().min(0).max(100).default(75),
  minMicroLamports: z.number().int().nonnegative().default(50_000),
  /** Hard ceiling. Landing fast matters, but not at any price. */
  maxMicroLamports: z.number().int().nonnegative().default(2_000_000),
  computeUnitLimit: z.number().int().positive().default(400_000),
});

export const riskSchema = z.object({
  /** Rolling 24h window, not calendar day. */
  maxLaunchesPerDay: z.number().int().positive().default(3),
  maxSolPerDay: solAmount.default(0.5),
  maxConcurrentPositions: z.number().int().positive().default(5),
  /** Refuse to launch if the wallet would drop below this. Leaves gas for exits. */
  minWalletBalanceSol: solAmount.default(0.05),
  /** Abort everything if realised losses over the window exceed this. */
  maxDailyLossSol: solAmount.default(0.3),

  /**
   * Derive the daily launch cap from what the wallet can actually sustain,
   * instead of a fixed number.
   *
   * A static cap is wrong in both directions: too low on a funded wallet that
   * could afford more attempts at a power-law payoff, and far too high on one
   * that has been ground down. With this on, capacity scales up as creator fees
   * accumulate and shrinks the moment the bot starts losing -- which is what
   * "as many as possible without burning out the wallet" actually requires.
   *
   * The static ceilings above remain absolute maxima. Adaptive capacity can
   * only ever ask for LESS than `maxSolPerDay`, never more.
   */
  adaptive: z.object({
    enabled: z.boolean().default(false),
    /** The wallet must survive at least this many days at the current burn. */
    minRunwayDays: z.number().positive().default(7),
    /** Never commit more than this fraction of spendable balance per day. */
    maxDailyBurnPct: z.number().min(0.01).max(1).default(0.2),
    /** Untouchable floor: exit-transaction gas, never spent on launches. */
    reserveSol: solAmount.default(0.05),
    /** Hard ceiling however rich the wallet gets. */
    maxLaunchesPerDayCeiling: z.number().int().positive().default(48),
    /** Cut capacity when recent launches have been losing money. */
    throttleOnLoss: z.boolean().default(true),
    lossThrottleFactor: z.number().min(0.05).max(1).default(0.5),
    /** Settled-launch hit rate below which capacity is throttled. */
    minHitRateBeforeThrottle: z.number().min(0).max(1).default(0.05),
  }).default({}),
});

export const devPositionSchema = z.object({
  /** Set false to run a pure fee-harvesting bot with no dev bag at all. */
  enabled: z.boolean().default(true),
  buySol: solAmount.default(0.05),
  buySlippagePct: pct.default(15),
  exit: z.object({
    /** Sell when price reaches this multiple of entry. */
    takeProfitMultiple: z.number().min(1).default(3),
    /** Sell unconditionally after this long, win or lose. */
    maxHoldMinutes: z.number().positive().default(30),
    /** Sell if down this much from entry. */
    stopLossPct: pct.default(50),
    /** How often to re-evaluate open positions. */
    pollSeconds: z.number().positive().default(15),
    sellSlippagePct: pct.default(20),
    /** Retries before flagging a position as stuck for manual attention. */
    maxSellAttempts: z.number().int().positive().default(5),
  }).default({}),
});

export const scoringSchema = z.object({
  /** Composite score a candidate must clear to be launched. 0-100. */
  threshold: z.number().min(0).max(100).default(65),
  weights: z.object({
    velocity: z.number().default(0.35),
    corroboration: z.number().default(0.25),
    cryptoAffinity: z.number().default(0.2),
    tickerability: z.number().default(0.1),
    reach: z.number().default(0.1),
  }).default({}),
  /** Score halves every N minutes since first detection. Being early is the edge. */
  decayHalfLifeMinutes: z.number().positive().default(45),
  /**
   * Hard gate on distinct feeds. Lowered to 1 because the corroboration
   * *component* now scores independence rather than raw feed count, so a
   * single-source candidate is admitted but scores badly and has to be strong
   * elsewhere to clear the threshold. Raise it back to 2 to restore a hard bar.
   */
  minCorroboratingFeeds: z.number().int().min(1).default(1),
  /**
   * Minimum number of independent source FAMILIES (crypto / search / press /
   * forum / social / markets). Two feeds from the same family are close to one
   * source talking to itself; see scoring/independence.ts.
   */
  minIndependentFamilies: z.number().int().min(1).default(1),
  /** Ignore signals older than this on intake. */
  maxSignalAgeMinutes: z.number().positive().default(180),
  /**
   * A term seen exactly once has no measurable velocity -- on a cold start
   * every term looks maximally accelerating because there is no earlier half to
   * compare against. Requiring repeat sightings is what stops a freshly started
   * bot from launching on its first glimpse of noise.
   */
  minObservations: z.number().int().min(1).default(3),
  /**
   * Refuse to launch until the signal history spans this long, for the same
   * reason. Scoring still runs during warmup so the operator can watch.
   */
  warmupMinutes: z.number().nonnegative().default(30),
});

export const saturationSchema = z.object({
  lookbackHours: z.number().positive().default(24),
  /** Reject if this many similar tokens already exist in the lookback window. */
  maxSimilar: z.number().int().positive().default(2),
  /** 0-1 normalised similarity above which two names are "the same trend". */
  similarityThreshold: z.number().min(0).max(1).default(0.72),
  /** Never launch the same normalised term twice, regardless of the above. */
  neverRelaunchSameTerm: z.boolean().default(true),
});

const feedBase = {
  enabled: z.boolean().default(false),
  weight: z.number().min(0).default(1),
  pollSeconds: z.number().positive().default(300),
};

export const feedsSchema = z.object({
  googleTrends: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(600),
    geo: z.string().default("US"),
  }).default({}),
  reddit: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(180),
    subreddits: z.array(z.string()).default([
      "all", "memes", "dankmemes", "OutOfTheLoop", "news", "CryptoCurrency",
    ]),
    listing: z.enum(["rising", "hot", "new"]).default("rising"),
    limit: z.number().int().positive().max(100).default(50),
  }).default({}),
  xApi: z.object({
    ...feedBase,
    /** Off by default: pay-per-use since Feb 2026, there is no free tier. */
    enabled: z.boolean().default(false),
    pollSeconds: z.number().positive().default(300),
    query: z.string().default("(meme OR trending OR viral) -is:retweet lang:en"),
    maxResults: z.number().int().min(10).max(100).default(25),
    /** Metered separately from SOL spend so a polling bug cannot run up a bill. */
    monthlyUsdCap: z.number().positive().default(25),
    estimatedCostPerRead: z.number().positive().default(0.005),
  }).default({}),
  fourchan: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(120),
    board: z.string().default("biz"),
    /** Very noisy. Down-weighted relative to mainstream feeds. */
    weight: z.number().min(0).default(0.6),
  }).default({}),
  farcaster: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(240),
    limit: z.number().int().positive().max(100).default(50),
  }).default({}),
  polymarket: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(300),
    /** Minimum 24h volume for a market to count as an attention signal. */
    minVolume24hUsd: z.number().nonnegative().default(25_000),
    limit: z.number().int().positive().max(200).default(60),
  }).default({}),
  hackernews: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(300),
    /** Independent of both crypto boards and mainstream search. */
    weight: z.number().min(0).default(0.8),
    limit: z.number().int().positive().max(100).default(40),
  }).default({}),
  googleNews: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(420),
    weight: z.number().min(0).default(0.9),
    /** Topic-scoped RSS; empty means the general front page. */
    topic: z.string().default(""),
  }).default({}),
  wikipedia: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    /** Pageview data is daily, so polling faster than hourly is wasted. */
    pollSeconds: z.number().positive().default(3600),
    weight: z.number().min(0).default(0.7),
    limit: z.number().int().positive().max(100).default(40),
  }).default({}),
  onchain: z.object({
    ...feedBase,
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(90),
    /** Fast-follow, not origination. Weighted low so it informs rather than drives. */
    weight: z.number().min(0).default(0.5),
    /** A young coin already carrying real market cap is the momentum signal. */
    minMarketCapUsd: z.number().nonnegative().default(50_000),
    maxAgeHours: z.number().positive().default(48),
    limit: z.number().int().positive().max(200).default(60),
  }).default({}),
}).default({});

export const filtersSchema = z.object({
  /** Brand/likeness terms are a takedown and trademark risk, not a hypothetical. */
  blockTrademarks: z.boolean().default(true),
  /** Deaths, attacks, disasters. Distasteful and a fast route to removal. */
  blockTragedy: z.boolean().default(true),
  blockSlurs: z.boolean().default(true),
  /**
   * Reject terms that look like a person's name (capitalised multi-word terms
   * such as "Kevin Keegan" or "Enzo Maresca").
   *
   * This is a blunt instrument and it WILL cost you some legitimate launches --
   * "Moo Deng" and "Baby Gronk" look identical to a surname pair. It is on by
   * default because the asymmetry favours it: a false positive costs one missed
   * launch, a false negative is a right-of-publicity claim. If you set an
   * Anthropic API key the model screen classifies far more precisely and you can
   * safely turn this off.
   */
  blockLikelyPersonNames: z.boolean().default(true),
  /**
   * Permit a LIVE MAINNET run without the model-based brand/likeness screen.
   *
   * Off by default, and startup refuses the combination. The static blocklist
   * plus the capitalisation heuristic demonstrably leak: live testing launched
   * "usa network", "kevin keegan", "isack hadjar" and "sling tv" past them.
   * Dry runs and devnet are unaffected -- this gate only guards real money on
   * mainnet.
   */
  allowUnscreenedLive: z.boolean().default(false),
  /** Extra operator-supplied terms to always reject. */
  extraBlocklist: z.array(z.string()).default([]),
  /** Terms to always allow through, overriding the built-in lists. */
  allowlist: z.array(z.string()).default([]),
});

export const assetsSchema = z.object({
  naming: z.object({
    model: z.string().default("claude-sonnet-5"),
    maxNameLength: z.number().int().positive().default(32),
    minTickerLength: z.number().int().positive().default(3),
    maxTickerLength: z.number().int().positive().default(8),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
  }).default({}),
  image: z.object({
    /** `template` renders locally for ~free; `none` requires a fallback image. */
    mode: z.enum(["template", "none"]).default("template"),
    width: z.number().int().positive().default(512),
    height: z.number().int().positive().default(512),
  }).default({}),
  ipfs: z.object({
    provider: z.literal("pinata").default("pinata"),
    jwtEnv: z.string().default("PINATA_JWT"),
    uploadUrl: z.string().url().default("https://uploads.pinata.cloud/v3/files"),
    gatewayUrl: z.string().url().default("https://gateway.pinata.cloud/ipfs/"),
  }).default({}),
});

export const feesSchema = z.object({
  /** pump.fun claims creator fees in bulk across all tokens, so this is one job. */
  claimIntervalMinutes: z.number().positive().default(720),
  /** Skip the claim if the vault holds less than this; the tx would cost more. */
  minClaimSol: solAmount.default(0.01),
  enabled: z.boolean().default(true),
});

export const configSchema = z.object({
  /** Global no-op switch. When true, nothing ever signs or sends a transaction. */
  dryRun: z.boolean().default(true),
  network: z.enum(["mainnet-beta", "devnet", "localnet"]).default("devnet"),
  wallet: z.object({
    secretEnv: z.string().default("DEV_WALLET_SECRET"),
    keypairPath: z.string().optional(),
  }).default({}),
  rpc: z.object({
    primary: z.string().url().default("https://api.devnet.solana.com"),
    fallback: z.string().url().optional(),
    commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
    priorityFee: priorityFeeSchema.default({}),
  }).default({}),
  launch: z.object({
    provider: z.enum(["pump-sdk", "pumpportal"]).default("pump-sdk"),
    pool: z.enum(["pump", "bonk"]).default("pump"),
    /**
     * PERMANENT AND PER-TOKEN, chosen at creation and never changeable after.
     * false = trading fees accrue to the creator (this bot's entire revenue
     * model). true = fees are redirected to traders as a "cashback coin",
     * which means the bot earns nothing. Do not flip this without meaning to.
     */
    cashback: z.boolean().default(false),
    mayhemMode: z.boolean().default(false),
    /** Upper bound on rent + protocol fee for a create, used for budgeting. */
    estimatedCreateCostSol: z.number().positive().default(0.025),
  }).default({}),
  risk: riskSchema.default({}),
  devPosition: devPositionSchema.default({}),
  scoring: scoringSchema.default({}),
  saturation: saturationSchema.default({}),
  feeds: feedsSchema,
  filters: filtersSchema.default({}),
  assets: assetsSchema.default({}),
  fees: feesSchema.default({}),
  learning: z.object({
    /**
     * Off by default. A config that rewrites itself should be an explicit
     * choice, and it is worthless before there are real outcomes to learn from.
     */
    enabled: z.boolean().default(false),
    /**
     * Propose only, never apply, unless this is true. Even when true, changes
     * are confined to the guardrails allowlist and rate-limited per run.
     */
    autoApply: z.boolean().default(false),
    /** A launch is not judged until it has had this long to catch or die. */
    settleAfterHours: z.number().positive().default(6),
    /** How often pending outcomes are re-checked against pump.fun. */
    outcomeRefreshMinutes: z.number().positive().default(5),
    /** Peak market cap that counts as a real hit (top creator-fee band). */
    hitMcapUsd: z.number().positive().default(88_000),
    modestMcapUsd: z.number().positive().default(15_000),
    /** Refuse to tune on a handful of launches; noise would look like signal. */
    minSampleSize: z.number().int().min(5).default(20),
    intervalHours: z.number().positive().default(24),
    maxChangesPerRun: z.number().int().min(1).max(10).default(4),
    /** Config paths the tuner may never touch, on top of the built-in denials. */
    pinned: z.array(z.string()).default([]),
    model: z.string().default("claude-opus-5"),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
  }).default({}),
  web: z.object({
    /**
     * Binds to loopback by default. Exposing the dashboard to the internet is
     * an explicit decision: the public page is read-only and screened, but the
     * admin portal on the same port is not something to put on 0.0.0.0 without
     * TLS in front of it.
     */
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(4600),
    /** Serve the public dashboard. Turn off to run an admin-only instance. */
    publicEnabled: z.boolean().default(true),
    /** How often the server re-reads state and pushes to connected browsers. */
    pushIntervalSeconds: z.number().positive().default(3),
    /** Set true when running behind an HTTPS reverse proxy, so cookies get Secure. */
    behindTlsProxy: z.boolean().default(false),
    /**
     * How long a rejected candidate is held back before the PUBLIC page shows
     * it. A live rejection feed still reveals what the bot is looking at right
     * now; delayed, it is an honest record instead of a tip sheet. The admin
     * portal is unaffected.
     */
    declineDelayHours: z.number().nonnegative().default(6),
  }).default({}),
  storage: z.object({
    dbPath: z.string().default("data/bot.db"),
    haltFile: z.string().default("data/HALT"),
  }).default({}),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    json: z.boolean().default(true),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type FeedsConfig = z.infer<typeof feedsSchema>;
export type RiskConfig = z.infer<typeof riskSchema>;
export type DevPositionConfig = z.infer<typeof devPositionSchema>;
export type ScoringConfig = z.infer<typeof scoringSchema>;
export type SaturationConfig = z.infer<typeof saturationSchema>;
