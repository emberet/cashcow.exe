/**
 * Which artwork template fits a trend.
 *
 * The monogram template is fine but says nothing -- every coin looks like every
 * other coin with a different ticker in the middle. A trend about a model
 * release and a trend about a press-briefing gaffe want visibly different
 * artwork, and the trend text already tells us which is which.
 *
 * Deliberately keyword-based rather than a model call. The naming model already
 * runs once per launch and classification could ride along on it, but that
 * couples artwork to a network round trip that can fail, and this decision is
 * cosmetic -- a wrong guess costs a slightly off-theme picture, not money. A
 * table that is wrong in an obvious, greppable way beats a prompt that is wrong
 * in an unpredictable one.
 *
 * Everything here is local and deterministic, so a given trend always renders
 * the same way and the result is reproducible from the database alone.
 */

export type ArtTheme =
  /** Terminal/ASCII treatment: models, chips, agents, anything compute-shaped. */
  | "ascii"
  /** Loud meme-poster treatment: politics, officialdom, public-statement noise. */
  | "slop"
  /** The original gradient monogram. Used whenever nothing else clearly fits. */
  | "monogram";

/**
 * Matched on word boundaries, never as substrings. "ai" inside "said", "chair"
 * and "captain" is the obvious trap, but "gpu" in "gpus" is a case we DO want,
 * so the boundary allows a trailing plural rather than requiring an exact word.
 */
const ASCII_TERMS = [
  "ai", "agi", "asi", "llm", "llms", "gpt", "chatgpt", "openai", "anthropic",
  "claude", "gemini", "grok", "deepseek", "mistral", "copilot",
  "model", "models", "neural", "transformer", "inference", "training",
  "agent", "agents", "agentic", "chatbot", "prompt", "prompts",
  "gpu", "gpus", "tpu", "chip", "chips", "silicon", "nvidia", "compute",
  "algorithm", "algorithms", "dataset", "benchmark", "opensource",
  "robot", "robots", "robotics", "android", "humanoid", "automation",
  "quantum", "supercomputer", "datacenter", "api", "sdk", "codegen",
];

const SLOP_TERMS = [
  "whitehouse", "potus", "president", "presidential", "oval",
  "senate", "senator", "congress", "congressional", "capitol",
  "governor", "mayor", "cabinet", "secretary", "administration",
  "election", "elections", "campaign", "ballot", "primary", "caucus",
  "tariff", "tariffs", "sanctions", "executive", "veto", "filibuster",
  "impeach", "impeachment", "subpoena", "indictment", "testimony",
  "briefing", "press", "podium", "statement", "remarks", "transcript",
  "policy", "bill", "legislation", "amendment", "ruling", "scotus",
  "federal", "government", "shutdown", "budget", "deficit", "debate",
  "diplomat", "summit", "treaty", "embassy", "pentagon",
];

/**
 * Normalise for matching: lowercase, strip punctuation to spaces, collapse
 * runs. "White House's" and "white-house" both have to reach "white house",
 * and "whitehouse" is listed as its own term because the space survives here
 * but not in every source's phrasing.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function hits(list: readonly string[], tokens: string[], joined: string): number {
  let n = 0;
  for (const t of list) {
    // Multi-word entries cannot match a single token, so test the joined form.
    if (t.includes(" ") ? joined.includes(t) : tokens.includes(t)) n++;
  }
  return n;
}

/**
 * Pick a template from the trend phrase plus whatever the namer wrote.
 *
 * The trend term is weighted double: the description is model prose that tends
 * to reach for grand technology framing regardless of subject ("a revolution
 * in..."), which drags unrelated trends toward the ascii bucket if both inputs
 * count equally.
 */
export function themeOf(term: string, description = ""): ArtTheme {
  const termTokens = words(term);
  const termJoined = termTokens.join(" ");
  const descTokens = words(description);
  const descJoined = descTokens.join(" ");

  const ascii =
    hits(ASCII_TERMS, termTokens, termJoined) * 2 +
    hits(ASCII_TERMS, descTokens, descJoined);
  const slop =
    hits(SLOP_TERMS, termTokens, termJoined) * 2 +
    hits(SLOP_TERMS, descTokens, descJoined);

  if (ascii === 0 && slop === 0) return "monogram";
  // A tie means the trend is genuinely both (AI policy hearings, chip export
  // bans). Politics is the louder read, and the slop template degrades more
  // gracefully on a technical subject than ascii does on a political one.
  return ascii > slop ? "ascii" : "slop";
}
