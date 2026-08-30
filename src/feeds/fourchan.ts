import { fetchJson } from "../util/http.ts";
import { log, errFields } from "../util/log.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, clamp01, logNorm } from "./types.ts";

/**
 * 4chan catalog (default /biz/). Free, no auth, no key.
 *
 * The earliest and by far the noisiest feed here. An initial cashtag-only
 * version of this adapter returned almost nothing -- a live catalog of 199
 * threads contained exactly one `$TICKER` -- because the board mostly discusses
 * things by name. So thread subjects and comment text are emitted as signals
 * and left to the phrase extractor, with cashtags boosted when they do appear.
 *
 * Weighted down in the default config: it surfaces things hours before Google
 * Trends, and most of them are nothing.
 */

type CatalogThread = {
  no: number;
  sub?: string;
  com?: string;
  replies?: number;
  images?: number;
  time?: number;
};
type CatalogPage = { page: number; threads: CatalogThread[] };

const HTML_TAG = /<[^>]+>/g;
const CASHTAG = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
/** Greentext and quote-links are conversational noise, not subject matter. */
const QUOTELINK = /&gt;&gt;\d+/g;

function stripHtml(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(QUOTELINK, " ")
    .replace(HTML_TAG, " ")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const fourchanFeed: FeedAdapter = {
  id: "fourchan",
  weight: 0.6,
  pollSeconds: 120,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const cfg = ctx.cfg.feeds.fourchan;
    // `boards` is the list; the legacy `board` string is merged for configs
    // written before multi-board existed. All boards share one feed id and
    // one independence family on purpose -- one site, one population.
    const boards = [...new Set([cfg.board, ...cfg.boards].filter(Boolean))];

    const out: RawSignal[] = [];
    for (const board of boards) {
      try {
        out.push(...await pollBoard(board));
      } catch (e) {
        // One board down (or slow) must not cost the others their poll.
        log.warn("fourchan: board failed, continuing", { board, ...errFields(e) });
      }
    }
    return out;
  },
};

async function pollBoard(board: string): Promise<RawSignal[]> {
    const pages = await fetchJson<CatalogPage[]>(
      `https://a.4cdn.org/${encodeURIComponent(board)}/catalog.json`,
      { timeoutMs: 15_000 },
    );

    const now = new Date();
    const out: RawSignal[] = [];
    const cashtags = new Map<string, { mentions: number; replies: number; thread: number }>();

    for (const page of pages) {
      for (const t of page.threads ?? []) {
        const subject = stripHtml(t.sub);
        const comment = stripHtml(t.com);
        const replies = t.replies ?? 0;
        const url = `https://boards.4chan.org/${board}/thread/${t.no}`;

        // Reply count is the board's own measure of what is being discussed.
        const attention = logNorm(replies, 300);

        // A thread subject is the closest thing /biz/ has to a headline.
        if (subject.length >= 3) {
          out.push({
            feed: "fourchan",
            term: subject.slice(0, 200),
            rawScore: clamp01(0.35 + 0.65 * attention),
            observedAt: t.time ? new Date(t.time * 1000) : now,
            url,
            meta: { replies, board, kind: "subject", threadNo: t.no },
          });
        } else if (comment.length >= 12 && replies >= 5) {
          // No subject: fall back to the opening post, but only if the thread
          // actually drew discussion. Otherwise it is pure noise.
          out.push({
            feed: "fourchan",
            term: comment.slice(0, 200),
            rawScore: clamp01(0.2 + 0.6 * attention),
            observedAt: t.time ? new Date(t.time * 1000) : now,
            url,
            meta: { replies, board, kind: "comment", threadNo: t.no },
          });
        }

        for (const m of `${subject} ${comment}`.matchAll(CASHTAG)) {
          const sym = m[1]!.toUpperCase();
          if (sym.length < 2) continue;
          const prev = cashtags.get(sym) ?? { mentions: 0, replies: 0, thread: t.no };
          prev.mentions += 1;
          prev.replies += replies;
          cashtags.set(sym, prev);
        }
      }
    }

    // Explicit cashtags are unambiguous subjects, so they score above prose.
    for (const [sym, v] of cashtags) {
      out.push({
        feed: "fourchan",
        term: sym,
        rawScore: clamp01(0.5 + 0.3 * logNorm(v.mentions, 15) + 0.2 * logNorm(v.replies, 400)),
        observedAt: now,
        url: `https://boards.4chan.org/${board}/thread/${v.thread}`,
        meta: { mentions: v.mentions, replies: v.replies, board, kind: "cashtag" },
      });
    }

    return out;
}
