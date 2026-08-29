import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { configSchema } from "../src/config/schema.ts";
import { pinTokenMetadata } from "../src/assets/ipfs.ts";
import type { TokenIdentity } from "../src/assets/naming.ts";
import type { RenderedImage } from "../src/assets/image.ts";

// ==================================================================
// What actually gets pinned is what wallets read, and two of Solflare's three
// warnings came from fields that were simply never written (DECISIONS #37):
//
//   "Missing file metadata"  -> no properties.files / category
//   "Unverified token"       -> no social links at all
//
// Nothing in the suite looked at the pinned document, which is how a live
// token shipped without them. This captures the upload body from a stub
// Pinata and asserts on the real JSON.
// ==================================================================

let server: Server;
let uploads: { name: string; body: string }[] = [];
let uploadUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      // Crude multipart read: enough to recover the JSON part and the name.
      const name = /name="name"\r?\n\r?\n([^\r\n]+)/.exec(raw)?.[1] ?? "";
      uploads.push({ name, body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { cid: `cid-for-${name}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  uploadUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});

after(() => new Promise<void>((r) => { server.close(() => r()); }));

const identity = (): TokenIdentity => ({
  name: "Motor City",
  symbol: "MOTOR",
  description: "Motor city is trending. Auto-launched from the trend \"Motor\".",
  creativeDescription: "Motor city is trending.",
} as TokenIdentity);

const image = (): RenderedImage => ({
  buffer: Buffer.from("not-really-a-png"),
  contentType: "image/png",
  theme: "monogram",
  filename: "motor.png",
});

/** Pull the pinned metadata JSON back out of the captured upload. */
function pinnedJson(): Record<string, unknown> {
  const meta = uploads.find((u) => u.name.endsWith(".json"));
  assert.ok(meta, "no metadata document was uploaded");
  const start = meta.body.indexOf("{");
  const end = meta.body.lastIndexOf("}");
  return JSON.parse(meta.body.slice(start, end + 1));
}

describe("pinned metadata shape", () => {
  test("carries properties.files and category, and the social links", async () => {
    uploads = [];
    process.env.PINATA_JWT = "test-jwt";
    const cfg = configSchema.parse({
      dryRun: false,
      network: "mainnet-beta",
      assets: { ipfs: { uploadUrl, gatewayUrl: "https://gw.test/ipfs" } },
    });

    const res = await pinTokenMetadata(cfg, identity(), image(), {
      twitter: "x.com/cashcowEXE",
      website: "https://cashcowexe.win",
    });

    const meta = pinnedJson();
    const props = meta.properties as { files?: { uri: string; type: string }[]; category?: string };

    // The Metaplex descriptor -- the "missing file metadata" warning.
    assert.ok(props, "properties block must exist");
    assert.equal(props.category, "image");
    assert.equal(props.files?.length, 1);
    assert.equal(props.files?.[0]?.type, "image/png");
    // The file must point at the SAME image the token uses, not a second upload.
    assert.equal(props.files?.[0]?.uri, meta.image);
    assert.equal(meta.image, res.imageUri);

    // The links half of the "unverified" warning.
    assert.equal(meta.twitter, "x.com/cashcowEXE");
    assert.equal(meta.website, "https://cashcowexe.win");

    // Everything that was already there is untouched -- this change is additive.
    assert.equal(meta.name, "Motor City");
    assert.equal(meta.symbol, "MOTOR");
    assert.equal(meta.showName, true);
    assert.equal(meta.createdOn, "https://pump.fun");
  });

  test("omits link fields entirely when none are configured", async () => {
    uploads = [];
    process.env.PINATA_JWT = "test-jwt";
    const cfg = configSchema.parse({
      dryRun: false,
      network: "mainnet-beta",
      assets: { ipfs: { uploadUrl, gatewayUrl: "https://gw.test/ipfs" } },
    });

    await pinTokenMetadata(cfg, identity(), image(), {});
    const meta = pinnedJson();

    // Absent, not empty-string: a blank twitter field reads as a broken link.
    assert.ok(!("twitter" in meta));
    assert.ok(!("website" in meta));
    assert.ok(!("telegram" in meta));
    // properties is NOT optional -- it must be there regardless of links.
    assert.ok(meta.properties, "file metadata must not depend on social links");
  });
});
