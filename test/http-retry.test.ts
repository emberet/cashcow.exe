import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { httpFetch, HttpError } from "../src/util/http.ts";

// ==================================================================
// Retrying is opt-in per status, and 409 is the case that made it necessary.
//
// Cloudflare Workers AI returns 409 under momentary capacity pressure. The
// default predicate (429 or 5xx) did not cover it, so a 409 threw straight
// through to renderTokenImage()'s catch, which falls back to the LOCAL
// template -- the single identical-looking output that DECISIONS #38 exists
// to get away from. Measured: 6 coins generated back to back, 3 got 409s,
// and all 3 of those exact prompts returned 200 seconds later.
//
// It is opt-in rather than global on purpose: 409 Conflict on most APIs
// means the request collided with existing state, where repeating it is
// exactly the wrong move.
// ==================================================================

/** Serves the given statuses in order, one per request, then 200s forever. */
async function serveSequence(statuses: number[]): Promise<{
  url: string; hits: () => number; close: () => Promise<void>; server: Server;
}> {
  let n = 0;
  const server = createServer((_req, res) => {
    const status = statuses[n] ?? 200;
    n++;
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(status === 200 ? "ok" : `status ${status}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: () => n,
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
    server,
  };
}

describe("httpFetch retryStatuses", () => {
  test("a 409 is NOT retried by default", async () => {
    const s = await serveSequence([409]);
    try {
      await assert.rejects(
        () => httpFetch(s.url, { retries: 3, timeoutMs: 2000 }),
        (e: unknown) => e instanceof HttpError && e.status === 409,
      );
      assert.equal(s.hits(), 1, "default behaviour must not repeat a 409");
    } finally { await s.close(); }
  });

  test("a 409 IS retried when opted in, and the retry's success is returned", async () => {
    const s = await serveSequence([409, 409]);
    try {
      const res = await httpFetch(s.url, {
        retries: 2, timeoutMs: 2000, retryStatuses: [409],
      });
      assert.equal(res.status, 200);
      assert.equal(s.hits(), 3, "two 409s then the 200");
    } finally { await s.close(); }
  });

  test("opting a status in does not disable the default 429/5xx retries", async () => {
    const s = await serveSequence([503, 429]);
    try {
      const res = await httpFetch(s.url, {
        retries: 3, timeoutMs: 2000, retryStatuses: [409],
      });
      assert.equal(res.status, 200);
      assert.equal(s.hits(), 3);
    } finally { await s.close(); }
  });

  test("retries are still bounded -- a permanent 409 gives up and throws", async () => {
    const s = await serveSequence(Array(10).fill(409));
    try {
      await assert.rejects(
        () => httpFetch(s.url, { retries: 2, timeoutMs: 2000, retryStatuses: [409] }),
        (e: unknown) => e instanceof HttpError && e.status === 409,
      );
      assert.equal(s.hits(), 3, "initial attempt + 2 retries, then stop");
    } finally { await s.close(); }
  });

  test("a non-listed 4xx is still fatal", async () => {
    const s = await serveSequence([400]);
    try {
      await assert.rejects(
        () => httpFetch(s.url, { retries: 3, timeoutMs: 2000, retryStatuses: [409] }),
        (e: unknown) => e instanceof HttpError && e.status === 400,
      );
      assert.equal(s.hits(), 1);
    } finally { await s.close(); }
  });
});
