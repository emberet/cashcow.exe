import sharp from "sharp";
import type { Config } from "../config/schema.ts";
import type { TokenIdentity } from "./naming.ts";
import { themeOf, type ArtTheme } from "./theme.ts";
import { banner, GLYPH_H } from "./font5x7.ts";

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
 *
 * Three templates, chosen by `assets/theme.ts` from the trend text:
 *   monogram  the original gradient wordmark, and the fallback for anything
 *             that does not clearly fit the other two
 *   ascii     terminal treatment for AI/compute trends, glyphs drawn from the
 *             bundled 5x7 bitmap font
 *   slop      loud meme-poster treatment for political/officialdom trends
 *
 * All three are drawn here from primitives. None of them reproduces third-party
 * artwork, a character, a logo or a photograph: this bot mints permanent,
 * public, fee-earning tokens, so borrowing someone's image for the coin face
 * would be an ongoing infringement with our wallet's name on it. Same reason
 * `filters.ts` refuses to mint brands and people in the first place.
 */

export type RenderedImage = {
  buffer: Buffer;
  contentType: "image/png";
  filename: string;
  /** Which template drew it, for the launch log and after-the-fact review. */
  theme: ArtTheme;
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

function monogramSvg(identity: TokenIdentity, width: number, height: number): string {
  const { from, to, ink } = palette(identity.symbol);
  const symbol = escapeXml(identity.symbol);
  const name = escapeXml(identity.name.slice(0, 28));
  const fontSize = fontSizeFor(identity.symbol, width);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
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
}

/**
 * Terminal treatment. The ticker is drawn as a block banner from the bundled
 * bitmap font -- every lit cell is a literal "#" glyph, so it reads as ASCII
 * art rather than as a font with a monospace look.
 *
 * Cells are painted individually at computed coordinates instead of one string
 * per row, because the widths of an installed monospace font are not knowable
 * here and a half-pixel of drift per column visibly shears a seven-row glyph.
 */
function asciiSvg(identity: TokenIdentity, width: number, height: number): string {
  const rows = banner(identity.symbol.slice(0, 8));
  const cols = rows[0]?.length ?? 1;

  // Fit the banner to ~78% of the canvas, then keep cells squarish so the
  // letterforms stay in proportion no matter how long the ticker is.
  const cell = Math.min((width * 0.78) / cols, (height * 0.42) / GLYPH_H);
  const blockW = cols * cell;
  const blockH = GLYPH_H * cell;
  const originX = (width - blockW) / 2;
  const originY = height * 0.30;

  const glow = "#39ff9e";
  const cells: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < cols; c++) {
      if (row[c] !== "#") continue;
      const x = originX + c * cell + cell / 2;
      const y = originY + r * cell + cell / 2;
      cells.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" ` +
        `dominant-baseline="central" font-size="${(cell * 1.28).toFixed(1)}">#</text>`,
      );
    }
  }

  const name = escapeXml(identity.name.slice(0, 30).toLowerCase());
  const mono = "Menlo, DejaVu Sans Mono, Consolas, monospace";
  const chrome = (width * 0.030).toFixed(0);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="crt" cx="50%" cy="45%" r="72%">
      <stop offset="0%" stop-color="#0d2318"/>
      <stop offset="100%" stop-color="#04070a"/>
    </radialGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#crt)"/>

  <g font-family="${mono}" fill="${glow}" opacity="0.55" font-size="${chrome}">
    <text x="${(width * 0.07).toFixed(0)}" y="${(height * 0.13).toFixed(0)}">$ ./cashcow --mint</text>
  </g>

  <g font-family="${mono}" fill="${glow}" font-weight="700">
    ${cells.join("\n    ")}
  </g>

  <g font-family="${mono}" fill="${glow}" font-size="${chrome}">
    <text x="${(width * 0.07).toFixed(0)}" y="${(height * 0.86).toFixed(0)}" opacity="0.92">&gt; ${name}</text>
    <rect x="${(width * 0.07).toFixed(0)}" y="${(height * 0.90).toFixed(0)}"
          width="${(width * 0.028).toFixed(0)}" height="${(height * 0.035).toFixed(0)}" opacity="0.8"/>
  </g>
</svg>`;
}

/**
 * Meme-poster treatment: clashing saturated wedges, a hard black outline and a
 * mis-registered colour copy behind the wordmark, like a bad print.
 *
 * Deliberately an ORIGINAL loud aesthetic and not a riff on any established
 * meme character. Pepe in particular is Matt Furie's copyright and he has
 * enforced it against crypto projects; "looks like the internet" is free,
 * "looks like someone's frog" is a lawsuit attached to a permanent on-chain
 * asset that pays us fees.
 */
function slopSvg(identity: TokenIdentity, width: number, height: number): string {
  const h = hash(identity.symbol);
  const hueA = h % 360;
  const hueB = (hueA + 150 + (h >> 5) % 60) % 360;
  const hueC = (hueA + 300) % 360;

  const cx = width / 2;
  const cy = height * 0.46;
  const rays: string[] = [];
  const RAY_COUNT = 18;
  const reach = Math.max(width, height);
  for (let i = 0; i < RAY_COUNT; i++) {
    const a0 = (i / RAY_COUNT) * Math.PI * 2;
    const a1 = ((i + 0.5) / RAY_COUNT) * Math.PI * 2;
    const p = (a: number) =>
      `${(cx + Math.cos(a) * reach).toFixed(0)},${(cy + Math.sin(a) * reach).toFixed(0)}`;
    rays.push(
      `<polygon points="${cx.toFixed(0)},${cy.toFixed(0)} ${p(a0)} ${p(a1)}" ` +
      `fill="hsl(${hueB}, 95%, 62%)" opacity="0.55"/>`,
    );
  }

  const symbol = escapeXml(identity.symbol);
  const name = escapeXml(identity.name.slice(0, 26).toUpperCase());
  const fontSize = fontSizeFor(identity.symbol, width) * 0.92;
  const tilt = -6 + (h % 13);
  const stroke = (width * 0.014).toFixed(0);
  const face = "Impact, Haettenschweiler, Helvetica, Arial, sans-serif";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="hsl(${hueA}, 96%, 58%)"/>
  <g>${rays.join("")}</g>
  <circle cx="${cx}" cy="${cy}" r="${(width * 0.33).toFixed(0)}"
          fill="hsl(${hueC}, 98%, 66%)" stroke="#000" stroke-width="${stroke}"/>

  <g transform="rotate(${tilt} ${cx} ${cy})" font-family="${face}" font-weight="900"
     text-anchor="middle" font-size="${fontSize.toFixed(0)}">
    <text x="${(cx + width * 0.014).toFixed(0)}" y="${(cy + width * 0.016).toFixed(0)}"
          dominant-baseline="middle" fill="hsl(${hueB}, 100%, 50%)">${symbol}</text>
    <text x="${cx}" y="${cy}" dominant-baseline="middle"
          fill="#fff" stroke="#000" stroke-width="${stroke}"
          paint-order="stroke">${symbol}</text>
  </g>

  <rect x="0" y="${(height * 0.855).toFixed(0)}" width="${width}" height="${(height * 0.145).toFixed(0)}"
        fill="#000" opacity="0.88"/>
  <text x="50%" y="${(height * 0.935).toFixed(0)}" text-anchor="middle" dominant-baseline="middle"
        font-family="${face}" font-weight="900" font-size="${(width * 0.062).toFixed(0)}"
        fill="hsl(${hueC}, 100%, 70%)" letter-spacing="2">${name}</text>
</svg>`;
}

export async function renderTokenImage(
  cfg: Config,
  identity: TokenIdentity,
  /** The trend phrase behind the coin. Drives template choice; artwork only. */
  term = "",
): Promise<RenderedImage> {
  const { width, height } = cfg.assets.image;

  const theme: ArtTheme = cfg.assets.image.themed
    ? themeOf(term, identity.description)
    : "monogram";

  const svg =
    theme === "ascii" ? asciiSvg(identity, width, height) :
    theme === "slop" ? slopSvg(identity, width, height) :
    monogramSvg(identity, width, height);

  const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

  return {
    buffer,
    contentType: "image/png",
    theme,
    filename: `${identity.symbol.toLowerCase()}.png`,
  };
}
