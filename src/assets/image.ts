import sharp from "sharp";
import type { Config } from "../config/schema.ts";
import type { TokenIdentity } from "./naming.ts";

/**
 * Token artwork.
 *
 * Rendered locally from a template so the per-launch marginal cost is
 * effectively zero. Given the base rates -- most launches earn nothing --
 * paying an image-generation API on every candidate would reliably cost more
 * than the launches return. Swap `mode` to wire in a generator once launches
 * are actually earning and the spend is justified by data rather than hope.
 *
 * The palette is derived from the symbol, so a given ticker always renders the
 * same way and the output is reproducible from the database alone.
 */

export type RenderedImage = {
  buffer: Buffer;
  contentType: "image/png";
  filename: string;
};

/** FNV-1a: small, fast, and stable across runs. */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function palette(symbol: string): { from: string; to: string; ink: string } {
  const h = hash(symbol);
  const hue = h % 360;
  const partner = (hue + 40 + (h >> 8) % 60) % 360;
  return {
    from: `hsl(${hue}, 82%, 56%)`,
    to: `hsl(${partner}, 78%, 42%)`,
    // Light text on these saturated mid-tones stays legible at thumbnail size.
    ink: "#ffffff",
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Shrink the type as the ticker lengthens so it never overflows the canvas. */
function fontSizeFor(symbol: string, width: number): number {
  const len = Math.max(symbol.length, 1);
  const fitted = (width * 0.82) / (len * 0.62);
  return Math.max(36, Math.min(width * 0.34, fitted));
}

export async function renderTokenImage(
  cfg: Config,
  identity: TokenIdentity,
): Promise<RenderedImage> {
  const { width, height } = cfg.assets.image;
  const { from, to, ink } = palette(identity.symbol);
  const symbol = escapeXml(identity.symbol);
  const name = escapeXml(identity.name.slice(0, 28));
  const fontSize = fontSizeFor(identity.symbol, width);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="38%" r="62%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>

  <text x="50%" y="49%" text-anchor="middle" dominant-baseline="middle"
        font-family="Helvetica, Arial, sans-serif" font-weight="800"
        font-size="${fontSize.toFixed(0)}" fill="${ink}"
        letter-spacing="-2">${symbol}</text>

  <text x="50%" y="${(height * 0.79).toFixed(0)}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-weight="600"
        font-size="${(width * 0.052).toFixed(0)}" fill="${ink}"
        opacity="0.82" letter-spacing="1">${name}</text>
</svg>`;

  const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

  return {
    buffer,
    contentType: "image/png",
    filename: `${identity.symbol.toLowerCase()}.png`,
  };
}
