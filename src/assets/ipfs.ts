import type { Config } from "../config/schema.ts";
import type { TokenIdentity } from "./naming.ts";
import type { RenderedImage } from "./image.ts";
import { httpFetch } from "../util/http.ts";
import { log } from "../util/log.ts";

/**
 * Metadata hosting.
 *
 * pump.fun's own /api/ipfs upload endpoint is deprecated, so metadata has to be
 * pinned externally and the resulting gateway URI handed to the create
 * instruction. Two uploads per launch: the image first, then a metadata JSON
 * document that references the image's CID.
 *
 * Env: PINATA_JWT
 */

export type PinnedMetadata = {
  /** The `uri` passed to the pump.fun create instruction. */
  uri: string;
  imageUri: string;
  metadataCid: string;
  imageCid: string;
};

type PinataUploadResponse = {
  data?: { cid?: string; id?: string; name?: string };
  error?: unknown;
};

function requireJwt(cfg: Config): string {
  const jwt = process.env[cfg.assets.ipfs.jwtEnv];
  if (!jwt) {
    throw new Error(
      `${cfg.assets.ipfs.jwtEnv} is not set. pump.fun's own IPFS endpoint is ` +
      `deprecated, so a Pinata JWT (free tier is enough) is required to host ` +
      `token metadata.`,
    );
  }
  return jwt;
}

async function uploadFile(
  cfg: Config,
  jwt: string,
  file: Blob,
  name: string,
): Promise<string> {
  const form = new FormData();
  form.append("network", "public");
  form.append("file", file, name);
  form.append("name", name);

  const res = await httpFetch(cfg.assets.ipfs.uploadUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    // FormData sets its own multipart boundary; passing it through untouched.
    body: form as unknown as Uint8Array,
    timeoutMs: 30_000,
    retries: 2,
  });

  const json = (await res.json()) as PinataUploadResponse;
  const cid = json.data?.cid;
  if (!cid) throw new Error(`Pinata upload for "${name}" returned no CID`);
  return cid;
}

export async function pinTokenMetadata(
  cfg: Config,
  identity: TokenIdentity,
  image: RenderedImage,
  links: { twitter?: string; telegram?: string; website?: string } = {},
): Promise<PinnedMetadata> {
  // Pinning is a real external write to a third-party service. A dry run must
  // not perform it, and skipping it also means the pipeline can be exercised
  // before a Pinata account exists.
  if (cfg.dryRun) {
    const stub = `dry-run-${identity.symbol.toLowerCase()}`;
    log.info("DRY RUN: skipping IPFS pin", {
      symbol: identity.symbol, imageBytes: image.buffer.length,
    });
    return {
      uri: `ipfs://${stub}.json`,
      imageUri: `ipfs://${stub}.png`,
      metadataCid: stub, imageCid: stub,
    };
  }

  const jwt = requireJwt(cfg);
  const gateway = cfg.assets.ipfs.gatewayUrl.replace(/\/+$/, "") + "/";

  const imageCid = await uploadFile(
    cfg,
    jwt,
    new Blob([new Uint8Array(image.buffer)], { type: image.contentType }),
    image.filename,
  );
  const imageUri = `${gateway}${imageCid}`;

  // Field names follow the shape pump.fun's own metadata documents use.
  const metadata = {
    name: identity.name,
    symbol: identity.symbol,
    description: identity.description,
    image: imageUri,
    showName: true,
    createdOn: "https://pump.fun",
    ...(links.twitter ? { twitter: links.twitter } : {}),
    ...(links.telegram ? { telegram: links.telegram } : {}),
    ...(links.website ? { website: links.website } : {}),
  };

  const metadataCid = await uploadFile(
    cfg,
    jwt,
    new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }),
    `${identity.symbol.toLowerCase()}.json`,
  );

  const uri = `${gateway}${metadataCid}`;
  log.info("metadata pinned", { symbol: identity.symbol, uri, imageUri });

  return { uri, imageUri, metadataCid, imageCid };
}
