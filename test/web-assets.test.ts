import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { versionAssetUrls, VERSIONED_ASSETS } from "../src/web/server.ts";

const PUBLIC_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public",
);

/**
 * The dashboard is served through Cloudflare, whose default Browser Cache TTL
 * overrides the origin's `cache-control: no-cache` for static extensions. In
 * practice that means `index.html` is always fresh (uncached, `DYNAMIC`) while
 * `styles.css` and `app.js` are held for up to four hours -- so a visitor can
 * be handed NEW markup rendered against OLD styles.
 *
 * That combination is not merely cosmetic. Adding `nav.social` shipped inline
 * `<svg>` icons that had a viewBox but no intrinsic size, so with the matching
 * `.social-link svg` rule missing from a cached stylesheet each icon expanded
 * to fill its column -- measured at 1228x1228px, burying the footer under a
 * page-sized GitHub logo. Reported as "a sizing issue and it's misplaced".
 *
 * Two independent guards, because either alone leaves a hole:
 *  1. Asset URLs carry a content hash, so a stale copy is never requested.
 *  2. Inline icons carry width/height attributes, so even with no stylesheet
 *     at all they render at roughly the right size instead of enormous.
 */
describe("stale-stylesheet hardening", () => {
  test("HTML asset references are content-hashed", async () => {
    const out = await versionAssetUrls(
      `<link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>`,
    );
    for (const asset of ["/styles.css", "/app.js"]) {
      const m = out.match(new RegExp(`${asset.replace(".", "\\.")}\\?v=([0-9a-f]{10})`));
      assert.ok(m, `expected a version on ${asset}, got: ${out}`);
    }
    // The bare, unversioned form must be gone -- leaving one behind would keep
    // the stale-cache path alive for exactly the file that changed.
    assert.ok(!out.includes(`"/styles.css"`));
    assert.ok(!out.includes(`"/app.js"`));
  });

  test("the version tracks file contents, so a change busts the cache", async () => {
    const first = await versionAssetUrls(`<a href="/styles.css">`);
    const again = await versionAssetUrls(`<a href="/styles.css">`);
    assert.equal(first, again, "same bytes must yield the same version");

    // Derived from the real file, not a constant: if the hash were stubbed or
    // the read silently failed we would get the "0" fallback instead.
    const version = first.match(/\?v=([0-9a-f]+)/)?.[1];
    assert.ok(version && version !== "0", `expected a real hash, got ${version}`);
  });

  test("every asset the pages reference is in the versioned list", async () => {
    for (const page of ["index.html", "admin.html"]) {
      const html = await readFile(join(PUBLIC_DIR, page), "utf8");
      for (const m of html.matchAll(/(?:href|src)="(\/[^"?]+\.(?:css|js))"/g)) {
        assert.ok(
          (VERSIONED_ASSETS as readonly string[]).includes(m[1]!),
          `${page} references ${m[1]} but it is not in VERSIONED_ASSETS, so a `
          + `change to it will be served against stale HTML`,
        );
      }
    }
  });

  test("footer social icons have explicit width and height", async () => {
    const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    const nav = html.match(/<nav class="social"[\s\S]*?<\/nav>/)?.[0];
    assert.ok(nav, "nav.social is missing from index.html");

    const icons = [...nav.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(icons.length, 2, "expected one icon per social link");
    for (const svg of icons) {
      assert.match(svg, /\bwidth="\d+"/, `no width attribute: ${svg}`);
      assert.match(svg, /\bheight="\d+"/, `no height attribute: ${svg}`);
    }
  });
});

/**
 * The "what the cow does" popup shows once per browser (localStorage) and is
 * reopenable via a topbar button. It must render hidden by default: if the
 * `hidden` attribute is ever dropped from the markup, every first-time
 * visitor gets an un-dismissable-looking overlay before app.js even runs.
 *
 * Also guards the economics claim in the copy against schema drift. The
 * splits it quotes (40 holders / 50 operator / 10 raffle) come from
 * `distributionSchema` in `src/config/schema.ts` and are explicitly
 * accounting-only there -- no token, no recipient list, no payout mechanism.
 * If a future change edits those numbers without updating this popup, the
 * dashboard would state a split that no longer matches the schema default.
 */
describe("analogy popup", () => {
  test("is hidden by default in the served markup", async () => {
    const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    const popup = html.match(/<div class="popup-backdrop"[^>]*>/)?.[0];
    assert.ok(popup, "popup-backdrop is missing from index.html");
    assert.match(popup, /\bhidden\b/, `popup must ship hidden: ${popup}`);
  });

  test("has a close control and is not the only place the disclaimer appears", async () => {
    const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    assert.match(html, /id="analogy-close"/, "no close button in the popup");
    assert.match(html, /id="p-analogy"/, "no way to reopen the popup once dismissed");

    // The popup echoes the disclaimer rather than replacing it -- confirm the
    // full disclaimer card still exists independently of the popup's summary.
    assert.match(html, /class="disclaimer"/, "the full disclaimer card is missing");
  });

  test("the quoted split matches the schema default, so the two cannot drift", async () => {
    const { configSchema } = await import("../src/config/schema.ts");
    const splits = configSchema.parse({}).distribution.splits;
    const pct = (label: string) => splits.find((s) => s.label === label)?.pct;

    const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
    const raw = html.match(/<div class="popup-backdrop"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
    // Collapse markup whitespace/line-wrapping so the copy can be reflowed in
    // the HTML without breaking these assertions on incidental line breaks.
    const popup = raw.replace(/\s+/g, " ");

    assert.equal(pct("operator"), 50);
    assert.match(popup, /half stays with me/i);
    assert.equal(pct("token holders (future)"), 40);
    assert.match(popup, /40%/);
    assert.match(popup, /not live yet/i, "must not imply the holder split is active");
  });
});

/**
 * RFC 9116, served from `.well-known/` so security researchers have a
 * documented disclosure path. Points at GitHub's security-advisory form
 * rather than a personal email, so there is nothing to redact if this file
 * is ever quoted back verbatim.
 */
describe("security.txt", () => {
  test("exists and has the fields RFC 9116 requires", async () => {
    const txt = await readFile(join(PUBLIC_DIR, ".well-known", "security.txt"), "utf8");

    const contact = txt.match(/^Contact:\s*(\S+)/m)?.[1];
    assert.ok(contact, "no Contact: field");
    assert.match(contact!, /^https:\/\//, "Contact should be a URL, not a bare email");

    const expires = txt.match(/^Expires:\s*(\S+)/m)?.[1];
    assert.ok(expires, "no Expires: field");
    assert.ok(new Date(expires!).getTime() > Date.now(), "Expires must be in the future");
  });
});
