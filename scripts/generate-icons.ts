/**
 * Generates the app icons from one definition.
 *
 * The mark is a keyhole — access control — in the same two colours as the in-app
 * brand mark, so the browser tab reads as the same product. It is drawn as paths
 * rather than text: an SVG favicon cannot rely on a font being present, and
 * letterforms would shift or vanish depending on the viewer's system.
 *
 * Raster fallbacks are emitted because Safari and several PWA surfaces do not use
 * an SVG favicon.
 *
 * Regenerate with: npm run icons
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";

/** Matches `--ink` and `--lime` in app/globals.css. */
const INK = "#171a18";
const LIME = "#b8f43e";

/**
 * Keyhole on a 32×32 grid. Deliberately chunky: at a 16px tab size every unit is
 * half a pixel, so thin strokes turn to mush.
 */
const MARK = `
  <circle cx="16" cy="12.2" r="5.4" fill="${LIME}"/>
  <path d="M13.1 16.2 L11.1 24.1 Q10.8 25.6 12.3 25.6 L19.7 25.6 Q21.2 25.6 20.9 24.1 L18.9 16.2 Z" fill="${LIME}"/>
`;

/** Rounded tile, for the favicon: browsers show it as-is. */
const rounded = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" rx="7" fill="${INK}"/>
  ${MARK.trim()}
</svg>
`;

/** Full-bleed tile, for touch icons: the OS applies its own corner mask. */
const bleed = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" fill="${INK}"/>
  ${MARK.trim()}
</svg>
`;

writeFileSync("public/favicon.svg", rounded);
process.stdout.write("wrote public/favicon.svg\n");

const targets: { file: string; size: number; source: string }[] = [
  { file: "public/favicon-32.png", size: 32, source: rounded },
  { file: "public/favicon-192.png", size: 192, source: rounded },
  { file: "public/apple-touch-icon.png", size: 180, source: bleed },
];

for (const { file, size, source } of targets) {
  const png = await sharp(Buffer.from(source), { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(file, png);
  process.stdout.write(`wrote ${file} (${size}px, ${png.length} bytes)\n`);
}
