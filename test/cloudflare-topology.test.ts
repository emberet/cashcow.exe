import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config/schema.ts";
import { checkCloudflareTunnelTopology } from "../src/web/server.ts";

/**
 * An external code review pointed out that nothing in code stops the
 * Cloudflare tunnel from being pointed at the admin-enabled bot instance
 * (4600) instead of the public-only one (4601) -- the separation was, until
 * now, enforced only by a comment in ~/.cloudflared/config.yml and a README
 * paragraph. See docs/DECISIONS.md.
 *
 * `checkCloudflareTunnelTopology` is a best-effort, advisory heuristic (a
 * regex scan, not a real YAML parser, to avoid a new dependency for a
 * warning) -- these tests cover the collision case, the non-collision case,
 * and both fail-open paths (missing file, admin disabled) that invariant 7
 * requires: a misconfigured or absent tunnel config must never be read as
 * "definitely a problem", only ever as "nothing detected".
 */
describe("Cloudflare tunnel topology guard", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cashcow-cf-"));
    configPath = join(dir, "config.yml");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cfg = (over: Record<string, unknown> = {}) =>
    configSchema.parse({ dryRun: true, web: { adminEnabled: true, port: 4600, host: "127.0.0.1", ...over } });

  test("flags a tunnel ingress that targets this admin-enabled instance's own port", () => {
    writeFileSync(configPath, [
      "ingress:",
      "  - hostname: example.win",
      "    service: http://127.0.0.1:4600",
      "  - service: http_status:404",
      "",
    ].join("\n"));

    const warning = checkCloudflareTunnelTopology(cfg(), configPath);
    assert.ok(warning, "expected a collision warning");
    assert.match(warning!, /4600/);
  });

  test("does not flag a tunnel pointed at a different port (the intended public-only instance)", () => {
    writeFileSync(configPath, [
      "ingress:",
      "  - hostname: example.win",
      "    service: http://127.0.0.1:4601",
      "  - service: http_status:404",
      "",
    ].join("\n"));

    assert.equal(checkCloudflareTunnelTopology(cfg(), configPath), undefined);
  });

  test("fails open when the config file does not exist", () => {
    assert.equal(
      checkCloudflareTunnelTopology(cfg(), join(dir, "does-not-exist.yml")),
      undefined,
    );
  });

  test("does not run at all when this instance has no admin portal to protect", () => {
    writeFileSync(configPath, "ingress:\n  - service: http://127.0.0.1:4600\n");
    assert.equal(
      checkCloudflareTunnelTopology(cfg({ adminEnabled: false }), configPath),
      undefined,
    );
  });
});
