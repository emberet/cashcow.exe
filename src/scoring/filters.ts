import { normalize, tokens } from "../util/text.ts";
import type { Config } from "../config/schema.ts";

/**
 * Hard rejects, evaluated before a candidate is allowed to cost money.
 *
 * These are not squeamishness. Minting a trending brand name is the fastest
 * route to a takedown and a trademark claim; minting a disaster is both
 * distasteful and gets the token removed, which kills the fee stream that is
 * the entire point of the bot. A rejected candidate costs nothing; a rejected
 * *launch* costs rent, fees and potentially a lawyer.
 */

export type FilterCategory = "trademark" | "tragedy" | "slur" | "operator";

export type FilterResult =
  | { allowed: true }
  | { allowed: false; category: FilterCategory; matched: string; reason: string };

/** Brands and marks with active enforcement programmes. */
const TRADEMARKS = [
  "disney", "marvel", "pixar", "star wars", "pokemon", "nintendo", "mario",
  "pikachu", "netflix", "spotify", "youtube", "tiktok", "instagram", "facebook",
  "meta", "whatsapp", "snapchat", "twitter", "google", "alphabet", "apple",
  "iphone", "ipad", "macbook", "microsoft", "windows", "xbox", "playstation",
  "sony", "samsung", "amazon", "alexa", "tesla", "spacex", "starlink", "nvidia",
  "intel", "amd", "coca cola", "coke", "pepsi", "mcdonalds", "burger king",
  "starbucks", "nike", "adidas", "gucci", "louis vuitton", "prada", "chanel",
  "rolex", "ferrari", "lamborghini", "porsche", "bmw", "mercedes", "toyota",
  "honda", "ford", "walmart", "target", "costco", "ikea", "lego", "barbie",
  "mattel", "hasbro", "nfl", "nba", "mlb", "fifa", "uefa", "olympics",
  "super bowl", "openai", "chatgpt", "anthropic", "claude", "gemini", "deepmind",
  "hbo", "warner", "paramount", "universal", "dreamworks", "nickelodeon",
  "cartoon network", "minecraft", "roblox", "fortnite", "valve", "steam",
  "labubu", "pop mart", "hello kitty", "sanrio", "sesame street", "harry potter",
  // Media properties and networks. Live testing launched "usa network" straight
  // through an earlier version of this list, which is what prompted adding the
  // model-based screen in assets/naming.ts -- a static list cannot enumerate
  // every mark on earth, and this section will always be incomplete.
  "usa network", "espn", "abc news", "nbc", "cbs", "fox news", "cnn", "bbc",
  "sky sports", "bein sports", "dazn", "hulu", "peacock", "disney plus",
  "prime video", "apple tv", "crunchyroll", "twitch", "discord", "reddit",
  "premier league", "la liga", "serie a", "bundesliga", "champions league",
  "man city", "manchester united", "liverpool fc", "real madrid", "barcelona fc",
  "formula 1", "nascar", "indycar", "ufc", "wwe", "pga tour", "wimbledon",
  // Single-word marks: the person-name heuristic needs two or more words, so
  // these can only be caught by name. Inherently incomplete -- the model screen
  // is what covers the long tail.
  "liverpool", "arsenal", "chelsea", "tottenham", "juventus", "psg", "bayern",
  "netflix", "roblox", "spotify", "twitch", "discord", "tesla", "nvidia",
];

/** Names where a token launch invites a likeness / right-of-publicity claim. */
const PUBLIC_FIGURES = [
  "taylor swift", "beyonce", "rihanna", "drake", "kanye", "ye west", "eminem",
  "ariana grande", "billie eilish", "bad bunny", "the weeknd", "travis scott",
  "kim kardashian", "kylie jenner", "kendall jenner", "selena gomez",
  "justin bieber", "lady gaga", "bruno mars", "post malone", "sza", "adele",
  "elon musk", "jeff bezos", "mark zuckerberg", "bill gates", "warren buffett",
  "sam altman", "jensen huang", "tim cook", "satya nadella",
  "donald trump", "joe biden", "kamala harris", "barack obama", "hillary clinton",
  "vladimir putin", "xi jinping", "narendra modi", "volodymyr zelensky",
  "cristiano ronaldo", "lionel messi", "lebron james", "stephen curry",
  "michael jordan", "tom brady", "serena williams", "tiger woods", "conor mcgregor",
  "mrbeast", "pewdiepie", "logan paul", "jake paul", "andrew tate", "joe rogan",
  "mark cuban", "michael saylor", "vitalik buterin", "changpeng zhao", "cz binance",
  "sam bankman", "do kwon", "justin sun",
  // Single surnames the two-word heuristic cannot reach. "Trump" cleared the
  // launch threshold during testing. Inherently incomplete -- the model screen
  // is what covers the long tail of people who trend without a full name.
  "trump", "biden", "obama", "putin", "zelensky", "modi", "netanyahu",
  "musk", "bezos", "zuckerberg", "beyonce", "rihanna", "drake", "eminem",
  "messi", "ronaldo", "lebron", "jordan", "brady", "federer", "nadal",
  "swift", "adele", "madonna", "oprah", "kardashian", "jenner", "bieber",
  // "Bessent" (US Treasury Secretary) launched for real on mainnet -- both this
  // list and the model screen missed it. Sitting cabinet officials trend under
  // a bare surname the same way heads of state do.
  "bessent", "powell", "yellen", "rubio", "vance",
];

/** Death, violence and disaster. */
const TRAGEDY = [
  "dead", "dies", "died", "death", "deaths", "dying", "killed", "kills",
  "killing", "murder", "murdered", "homicide", "manslaughter",
  "shooting", "shooter", "gunman", "shot dead", "massacre", "genocide",
  "stabbing", "stabbed", "bombing", "bomber", "explosion", "blast",
  "terror", "terrorist", "terrorism", "hostage", "kidnapped", "abduction",
  "assassinated", "assassination", "execution", "executed",
  "suicide", "overdose", "od death", "funeral", "obituary", "memorial",
  "rip", "passed away", "mourning", "condolences", "tribute to",
  "earthquake", "tsunami", "hurricane", "tornado", "wildfire", "flooding",
  "landslide", "famine", "epidemic", "pandemic", "outbreak",
  "plane crash", "crash victims", "derailment", "capsized", "sinking",
  "casualties", "fatalities", "victims", "war crimes", "airstrike", "missile strike",
  "school shooting", "mass shooting", "hate crime", "assault", "rape", "trafficking",
  "abuse", "molest", "missing child", "amber alert",
];

/** Unambiguous slurs. Substring-matched, so variants are caught too. */
const SLURS = [
  "nigg", "n1gg", "faggot", "fagg0t", "chink", "gook", "spic", "wetback",
  "kike", "tranny", "trannie", "retard", "raghead", "towelhead", "beaner",
  "coon", "paki", "gypsy", "cracker ass", "sandnigger", "jigaboo",
];

/**
 * Words that make a capitalised multi-word term *not* a person.
 * Keeps the person-name heuristic from eating obvious non-people.
 */
const NOT_A_PERSON = new Set([
  "coin", "token", "inu", "cat", "dog", "frog", "bear", "bull", "moon", "meme",
  "day", "week", "year", "cup", "league", "final", "finals", "game", "show",
  "season", "episode", "series", "movie", "film", "album", "tour", "live",
  "news", "update", "sale", "deal", "price", "stock", "market", "index",
  "city", "united", "county", "state", "island", "park", "beach", "street",
  "water", "reserve", "energy", "power", "labs", "group", "corp", "inc",
  "the", "of", "and", "vs", "with", "for", "new", "old", "big", "little",
]);

/**
 * Does this look like a real person's name?
 *
 * Two or three capitalised words, no digits, no obvious non-person vocabulary.
 * Deliberately crude -- see the config comment on `blockLikelyPersonNames` for
 * why the false positives are worth eating.
 */
export function looksLikePersonName(text: string): boolean {
  const raw = text.trim();
  if (!raw || /\d/.test(raw)) return false;

  const words = raw.split(/\s+/);
  if (words.length < 2 || words.length > 3) return false;

  for (const w of words) {
    // Must be a capitalised alphabetic word (allowing O'Brien, Al-Hassan).
    if (!/^[A-Z][a-z'-]{1,}$/.test(w)) return false;
    if (NOT_A_PERSON.has(w.toLowerCase())) return false;
  }
  return true;
}

export type CompiledFilters = {
  substrings: Array<{ term: string; category: FilterCategory }>;
  tokenTerms: Array<{ term: string; category: FilterCategory }>;
  allowlist: Set<string>;
  blockLikelyPersonNames: boolean;
};

export function compileFilters(cfg: Config["filters"]): CompiledFilters {
  const substrings: Array<{ term: string; category: FilterCategory }> = [];
  const tokenTerms: Array<{ term: string; category: FilterCategory }> = [];

  const add = (list: string[], category: FilterCategory, mode: "sub" | "token") => {
    for (const raw of list) {
      const term = normalize(raw);
      if (!term) continue;
      (mode === "sub" ? substrings : tokenTerms).push({ term, category });
    }
  };

  if (cfg.blockTrademarks) {
    // Multi-word marks are phrases; single words match on token boundary so
    // "coke" does not fire on "cokehead" -- but brands are substring-matched
    // when they are distinctive enough to have no innocent usage.
    add(TRADEMARKS.filter((t) => t.includes(" ")), "trademark", "sub");
    add(TRADEMARKS.filter((t) => !t.includes(" ")), "trademark", "token");
    add(PUBLIC_FIGURES.filter((t) => t.includes(" ")), "trademark", "sub");
    add(PUBLIC_FIGURES.filter((t) => !t.includes(" ")), "trademark", "token");
  }
  if (cfg.blockTragedy) {
    add(TRAGEDY.filter((t) => t.includes(" ")), "tragedy", "sub");
    add(TRAGEDY.filter((t) => !t.includes(" ")), "tragedy", "token");
  }
  if (cfg.blockSlurs) add(SLURS, "slur", "sub");
  add(cfg.extraBlocklist, "operator", "sub");

  return {
    substrings,
    tokenTerms,
    allowlist: new Set(cfg.allowlist.map(normalize).filter(Boolean)),
    blockLikelyPersonNames: cfg.blockLikelyPersonNames,
  };
}

/**
 * Check a term, and any generated name/symbol/description derived from it.
 * Call this both before generation (on the trend term) and after (on the
 * model's output) -- a clean trend can still yield a dirty name.
 */
export function checkTerm(text: string, f: CompiledFilters): FilterResult {
  const norm = normalize(text);
  if (!norm) return { allowed: true };

  if (f.allowlist.has(norm)) return { allowed: true };
  for (const allowed of f.allowlist) {
    if (allowed && norm.includes(allowed)) return { allowed: true };
  }

  const padded = ` ${norm} `;
  for (const { term, category } of f.substrings) {
    if (padded.includes(term)) return reject(category, term, text);
  }

  const toks = new Set(tokens(norm, false));
  for (const { term, category } of f.tokenTerms) {
    if (toks.has(term)) return reject(category, term, text);
  }

  // Checked on the ORIGINAL string: capitalisation is the whole signal, and
  // `norm` has already folded it away.
  if (f.blockLikelyPersonNames && looksLikePersonName(text)) {
    return {
      allowed: false, category: "trademark", matched: text,
      reason: `"${text}" rejected: looks like a real person's name ` +
        `(right-of-publicity exposure). Set filters.blockLikelyPersonNames=false ` +
        `to disable, ideally only with the model screen enabled.`,
    };
  }

  return { allowed: true };
}

/** Convenience: check several fields at once, first rejection wins. */
export function checkAll(texts: Array<string | undefined>, f: CompiledFilters): FilterResult {
  for (const t of texts) {
    if (!t) continue;
    const r = checkTerm(t, f);
    if (!r.allowed) return r;
  }
  return { allowed: true };
}

function reject(category: FilterCategory, matched: string, text: string): FilterResult {
  const why: Record<FilterCategory, string> = {
    trademark: "trademark or likeness exposure",
    tragedy: "death, violence or disaster",
    slur: "slur",
    operator: "operator blocklist",
  };
  return {
    allowed: false, category, matched,
    reason: `"${text}" rejected: ${why[category]} (matched "${matched}")`,
  };
}
