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

    /**
     * Scale today's effective allowance down when qualifying signal is thin,
     * so the bot doesn't spend its full daily budget on marginal candidates
     * just because they technically cleared the score threshold on a quiet
     * news day. Can only ever move the allowance DOWN from the static
     * ceiling above -- never above it. Off by default.
     */
    newsVolumeThrottle: z.object({
      enabled: z.boolean().default(false),
      /** Rolling window over which qualifying signal is counted. */
      lookbackHours: z.number().positive().default(24),
      /** At or below this many qualifying candidates in the window, apply
       *  the full throttle (minScale). */
      lowVolumeScoredCount: z.number().int().nonnegative().default(3),
      /** At or above this many, apply no throttle (scale = 1.0). */
      highVolumeScoredCount: z.number().int().nonnegative().default(20),
      /** Multiplier applied to solPerDay on the quietest day. Linear ramp to
       *  1.0 between lowVolumeScoredCount and highVolumeScoredCount. */
      minScale: z.number().min(0).max(1).default(0.34),
      /** Guaranteed minimum launches/day even on the quietest day -- but
       *  only up to whatever runway/burn/static/loss-throttle already
       *  permitted; this floor can never grant more than those allowed. */
      floorLaunchesPerDay: z.number().int().min(0).default(1),
    }).default({}),
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

  /**
   * Rolling window in which OUR OWN launches dedupe on similarity alone.
   *
   * `maxSimilar` answers "is this trend crowded?", where one other token is
   * normal and a count threshold is right. It is the wrong instrument for "did
   * we already mint this?", where one is already one too many -- and because
   * both self and market tokens land in the same tally, a fresh self-launch
   * only contributed 1 of the 2 needed and the near-duplicate went out anyway.
   * Measured against the live DB: with "Crypto Market" launched two hours
   * earlier, "Crypto Market Crash" (0.90) and "crypto markets" (0.78) both
   * passed the gate.
   *
   * `neverRelaunchSameTerm` does not cover this either -- it is an exact
   * normalised-key match, so a single added word slips past it.
   *
   * Set to 0 to disable.
   */
  selfDedupeHours: z.number().nonnegative().default(24),
  /**
   * Similarity floor for the self-dedupe window. Separate from
   * `similarityThreshold` on purpose: that one trades against market crowding,
   * this one against repeating ourselves, and they should be able to move
   * independently.
   */
  selfDedupeSimilarity: z.number().min(0).max(1).default(0.72),
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
    /**
     * Rough estimate of pump.fun's graduation market cap in USD, used only to
     * compute curveProgress (0..1 closeness to bonding-curve graduation).
     * APPROXIMATE and drifts with SOL price / pump.fun's own curve parameters
     * -- there is no reserve-level field on this endpoint to compute it
     * exactly. Tune from observed graduations, not trusted as authoritative.
     */
    graduationMarketCapUsd: z.number().positive().default(100_000),
    /** How much of rawScore comes from curveProgress vs size/freshness. Set
     *  to 0 to disable the graduation-proximity signal without disabling the
     *  whole feed. */
    curveProgressWeight: z.number().min(0).max(1).default(0.25),
  }).default({}),
  dexActivity: z.object({
    ...feedBase,
    /**
     * On as of 2026-08-28, after the buy-share ceiling below was corrected to
     * match where real graduated coins actually sit. Note this feed is unlike
     * the others: each poll fans out to up to `maxCandidatesPerPoll`
     * DexScreener calls rather than one request.
     */
    enabled: z.boolean().default(true),
    pollSeconds: z.number().positive().default(600),
    weight: z.number().min(0).default(0.4),
    /**
     * Proxy for "recently migrated": pump.fun's /coins endpoint has no true
     * migration timestamp, only creation timestamp + a `complete` flag, so
     * this filters on age-since-creation instead.
     */
    candidateMaxAgeHours: z.number().positive().default(72),
    /** Caps DexScreener calls per poll. */
    maxCandidatesPerPoll: z.number().int().positive().max(50).default(15),
    concurrency: z.number().int().positive().max(10).default(3),
    /** Below this, a buy/sell imbalance is too easy to move on thin liquidity
     *  to mean anything. */
    minLiquidityUsd: z.number().nonnegative().default(20_000),
    /**
     * Inclusive band on buys as a percentage of 24h transactions. Below the
     * floor there's no real imbalance to report; above the ceiling is the
     * same near-100%-buys pattern src/research/classify.ts's own
     * DEFAULT_THRESHOLDS treats as an untested pump or wash-trading
     * fingerprint, not stronger organic accumulation -- so the signal is
     * deliberately NOT monotonic past this ceiling.
     *
     * The ceiling was 85 and is now 95, from the one real calibration sample
     * on file: 25 graduated pump.fun coins (2026-08-27) put freshly-migrated
     * tokens at 86-98% buy share and long-settled ones at 38-55%, so at 85
     * this feed scored near-zero for almost exactly the population it exists
     * to detect. 95 rather than 98 leaves the very top of that cluster still
     * reading as suspicious; actual wash trading inside the wider band is
     * caught by `maxWashSuspicionScore` below, which is a separate signal
     * (tx-count vs replies) rather than more ceiling.
     *
     * Still a 25-sample basis -- confirm with `node src/cli.ts feeds --feed
     * dexActivity` that live scores are non-zero AND still discriminating
     * (not everything pinned near the ceiling).
     */
    minBuyShareForSignal: z.number().min(50).max(100).default(60),
    maxBuyShareForSignal: z.number().min(50).max(100).default(95),
    /** Reuses classify.ts's washSuspicionScore (txCount/replies) as a hard
     *  dampener; above this the signal is zeroed regardless of buy share. */
    maxWashSuspicionScore: z.number().positive().default(5),
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
    /**
     * pump.fun publishes no description limit, so this is our choice, not
     * theirs. 200 characters is what the code already truncated at; the model
     * prompt asked for 120 and the two disagreed silently, so a compliant model
     * wrote 120 and a chatty one got cut mid-word at 200. One number now feeds
     * both. Lives off-chain in the metadata JSON, so it costs no packet bytes.
     */
    maxDescriptionLength: z.number().int().positive().default(200),
    apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
    /**
     * Append a factual provenance line to the coin's description saying which
     * trend it came from and why it cleared the bar -- the term, the sources
     * that corroborated it, and the score. A reader landing on the pump.fun
     * page can then see what real-world thing the coin is about instead of
     * only a model-written joke. On by default: a coin nobody can trace back
     * to anything is exactly the shape of the ones that never traded.
     */
    includeProvenance: z.boolean().default(true),
    /**
     * Cap on creative description + provenance combined. Separate from
     * maxDescriptionLength (which bounds only the model's own sentence), so
     * turning provenance on cannot silently truncate the creative half.
     */
    maxTotalDescriptionLength: z.number().int().positive().default(500),
  }).default({}),
  image: z.object({
    /** `template` renders locally for ~free; `none` requires a fallback image. */
    mode: z.enum(["template", "none"]).default("template"),
    /**
     * 1000x1000 square, because that is pump.fun's stated MINIMUM resolution
     * for a coin image -- "Minimum resolution: 1000x1000px", recommended
     * aspect ratio 1:1 (square), max 15MB, .jpg/.gif/.png:
     * https://intercom.help/pumpfun-web/en/articles/11002205-create-a-coin-on-pump-fun
     *
     * This was 512x512, i.e. UNDER their floor. Nothing here touches the launch
     * transaction -- the image is referenced by IPFS URL, not embedded -- so
     * raising it costs pin size only, never the ~17 bytes of packet headroom
     * the create instruction has left.
     */
    width: z.number().int().positive().default(1000),
    height: z.number().int().positive().default(1000),
    /**
     * Pick the artwork template from the trend text (see assets/theme.ts):
     * a terminal/ASCII face for AI and compute trends, a loud meme-poster face
     * for political ones, the gradient monogram for everything else.
     *
     * Off by default so the repo default keeps rendering exactly what it
     * rendered before. Purely cosmetic either way -- every template is drawn
     * locally from primitives, costs nothing per launch, and reproduces from
     * the ticker alone.
     */
    themed: z.boolean().default(false),
    /**
     * Real per-image AI art (Gemini's "Nano Banana" line) in place of the
     * local SVG templates above -- a deliberate reversal of this block's own
     * original "no generator API, no third-party imagery, no per-launch
     * cost" posture (see docs/DECISIONS.md). Off by default like every other
     * new capability here: the local templates keep working unchanged as
     * the fallback on any failure (missing key, budget cap, timeout,
     * content-safety rejection) -- same "never blocks a launch, degrades to
     * deterministic local output" shape as assets/naming.ts's model call.
     */
    /**
     * Which generator draws the coin face. "local" keeps the SVG templates
     * below and calls nothing -- the safe default, unchanged for any
     * deployment that does not opt in.
     *
     * Whatever a provider returns is resized locally to width/height before
     * it is pinned, so the pump.fun minimum is met no matter what the
     * provider emits. See the note on `width` above: art shipped at 512x512,
     * under that floor, once already.
     */
    provider: z.enum(["local", "cloudflare", "gemini"]).default("local"),
    /**
     * Cloudflare Workers AI. 10,000 neurons/day are free with no billing
     * setup. Measured against the live API (2026-08-29), FLUX.1 [schnell]
     * bills 172.8 neurons per image -- about 57 images a day free, against a
     * launch rate of 3-10. Zero marginal cost per launch, which answers this
     * file's original objection to calling a generator API at all.
     *
     * The model takes no width/height parameter and returns a 1024x1024
     * JPEG, which is exactly why the resize/re-encode step above is
     * mandatory rather than defensive.
     */
    cloudflare: z.object({
      accountIdEnv: z.string().default("CLOUDFLARE_ACCOUNT_ID"),
      apiTokenEnv: z.string().default("CLOUDFLARE_API_TOKEN"),
      model: z.string().default("@cf/black-forest-labs/flux-1-schnell"),
      /** Diffusion iterations. The model caps this at 8. */
      steps: z.number().int().min(1).max(8).default(4),
    }).default({}),
    gemini: z.object({
      /** Superseded by `provider: "gemini"`; still honoured so an existing
       *  config that set it keeps working. */
      enabled: z.boolean().default(false),
      /** "Nano Banana 2 Lite" -- cheapest current tier. Not a preview alias;
       *  those were shut down 2026-06-25 and would 404. */
      model: z.string().default("gemini-3.1-flash-lite-image"),
      apiKeyEnv: z.string().default("GEMINI_API_KEY"),
      /** ~88 images/month at estimatedCostPerImage's default. Its own USD
       *  meter, separate from every other one in this repo, so image-gen
       *  spend can never silently compete with naming/feed/announce budgets. */
      monthlyUsdCap: z.number().nonnegative().default(3),
      estimatedCostPerImage: z.number().positive().default(0.034),
    }).default({}),
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

/**
 * Accounting groundwork only. There is no token yet, no recipient list, and
 * no on-chain payout mechanism -- renaming or reweighting `splits` creates no
 * entitlement and moves no funds. Deliberately absent from both `TUNABLE` and
 * `FORBIDDEN_PREFIXES` in `src/learning/guardrails.ts`: the allowlist is
 * default-deny, so simple absence already makes this unreachable by the
 * tuner, and no allowlist edit should be made for it.
 */
export const distributionSchema = z.object({
  /** Off by default. Nothing is ever written to profit_distributions until
   *  this is explicitly turned on. Never touches BudgetGuard or spending. */
  enabled: z.boolean().default(false),
  /** Calculated splits applied to netProfitSol for reporting only. */
  splits: z.array(z.object({
    label: z.string(),
    pct: z.number().min(0).max(100),
  })).default([
    { label: "token holders (future)", pct: 40 },
    { label: "operator", pct: 50 },
    { label: "weekly raffle", pct: 10 },
  ]),
}).default({});

/**
 * Outbound notifications about the bot's own activity.
 *
 * NOTE: a separate in-flight change adds `xAnnounce` to this same block for
 * public launch announcements on X. These are different things and should
 * coexist -- `telegram` here is a PRIVATE operator alert (one chat, the
 * operator's own), not public promotion, which is why it carries no
 * disclosure text and no USD meter (the Telegram Bot API is free).
 */
export const socialSchema = z.object({
  telegram: z.object({
    /** Off by default; no-ops harmlessly without credentials either way. */
    enabled: z.boolean().default(false),
    botTokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
    chatIdEnv: z.string().default("TELEGRAM_CHAT_ID"),
  }).default({}),
}).default({});

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
    /**
     * Build the real transaction against the real program and SIMULATE it,
     * instead of sending.
     *
     * Stronger evidence than `dryRun`: dry run never touches the chain at all,
     * so it cannot tell you whether the instruction set is well formed. This
     * validates account resolution, the bonding-curve maths and the program's
     * own checks -- everything except actually spending. Nothing is signed to
     * the network and no lamports move.
     */
    simulate: z.boolean().default(false),
    /**
     * If set, grind a mint keypair whose address ends in this suffix before
     * launching (e.g. "pump", matching pump.fun's own frontend vanity
     * convention -- cosmetic only, not required by the on-chain program).
     * Off by default: it adds latency to every launch it touches, so it must
     * be opted into per-run via an override, never silently on for the
     * automated pipeline.
     */
    vanitySuffix: z.string().optional(),
    /**
     * Give up and fall back to a random address rather than stall a launch.
     *
     * Measured on the deploy machine at ~9,400 Keypair.generate()/sec/core, a
     * 4-char suffix needs ~11.3M expected attempts -- the earlier 45s default
     * was sized for a "quick grind" assumption that turned out wrong by ~40x.
     * 300s gives real headroom (not just the expected case but the geometric
     * distribution's tail) once spread across `vanityWorkers` cores; grinding
     * a longer suffix or running on fewer cores will still time out and fall
     * back to a random address, which is the intended fail-open behaviour.
     */
    vanityTimeoutMs: z.number().positive().default(300_000),
    /**
     * OS threads to spread the grind across. Unset uses every core the
     * runtime reports available (`os.availableParallelism()`), since the
     * search is independent per-worker and near-linear in core count.
     */
    vanityWorkers: z.number().int().positive().optional(),
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
    /**
     * Serve the admin portal at all.
     *
     * A configured password is NOT sufficient protection for an
     * internet-facing instance, for a reason that is easy to miss: login
     * throttling keys on the socket address (invariant 10), and behind a
     * tunnel or reverse proxy every request arrives from 127.0.0.1. That
     * collapses the per-attacker throttle into a single shared bucket -- so
     * one attacker's failures lock out the operator, and the limit no longer
     * tracks individual attackers at all.
     *
     * When this is off the admin routes and assets return 404 before any auth
     * check runs: the surface is absent, not merely guarded. Run the
     * public-facing instance with this false and keep an admin instance on
     * loopback.
     */
    adminEnabled: z.boolean().default(true),
    /** How often the server re-reads state and pushes to connected browsers. */
    pushIntervalSeconds: z.number().positive().default(3),
    /** Set true when running behind an HTTPS reverse proxy, so cookies get Secure. */
    behindTlsProxy: z.boolean().default(false),
    /**
     * Trust `X-Forwarded-For` for the *displayed* client address.
     *
     * Off by default because the header is attacker-supplied: anything that
     * reaches the socket can claim any address. Even when this is on, rate
     * limiting still keys on the real socket address -- see auth.ts. This only
     * affects what gets shown and logged.
     */
    trustProxyHeader: z.boolean().default(false),
    /**
     * How long a rejected candidate is held back before the PUBLIC page shows
     * it. A live rejection feed still reveals what the bot is looking at right
     * now; delayed, it is an honest record instead of a tip sheet. The admin
     * portal is unaffected.
     */
    declineDelayMinutes: z.number().nonnegative().default(5),
    /**
     * Show the dev wallet address and balance on the PUBLIC page.
     *
     * On by default, because both are already public: the page lists every mint
     * it created, and a token's creator (and that creator's balance) is one
     * lookup away on any explorer. Hiding them would obscure verification
     * without actually concealing anything.
     *
     * Turn it off if you would rather not advertise capacity to competitors —
     * but understand that determined readers can still derive it. The admin
     * portal always shows it.
     */
    showWallet: z.boolean().default(true),
    /**
     * The project's OWN token, if one exists -- a mint address published on
     * the dashboard so visitors can find it.
     *
     * Deliberately separate from the `launches` table: this coin did not come
     * out of the scoring pipeline, so folding it in would flatter every
     * automated statistic on the page (hit rate, best market cap, fees per
     * launch). It is displayed on its own and excluded from all of them.
     * Empty by default -- most deployments have no such token.
     */
    projectTokenMint: z.string().default(""),
  }).default({}),
  storage: z.object({
    dbPath: z.string().default("data/bot.db"),
    haltFile: z.string().default("data/HALT"),
  }).default({}),
  distribution: distributionSchema,
  social: socialSchema,
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    json: z.boolean().default(true),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Did this run actually move money?
 *
 * `dryRun` never touches the chain; `launch.simulate` builds and simulates a
 * real transaction but sends nothing. Both spend zero, so both must be booked
 * against the simulated ledger -- otherwise a simulation would consume the real
 * daily allowance and show up as live spend that never happened.
 */
export function isPretend(cfg: Config): boolean {
  return cfg.dryRun || cfg.launch.simulate;
}
export type FeedsConfig = z.infer<typeof feedsSchema>;
export type RiskConfig = z.infer<typeof riskSchema>;
export type DevPositionConfig = z.infer<typeof devPositionSchema>;
export type ScoringConfig = z.infer<typeof scoringSchema>;
export type SaturationConfig = z.infer<typeof saturationSchema>;
