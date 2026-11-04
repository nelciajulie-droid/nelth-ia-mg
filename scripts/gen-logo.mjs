/**
 * Nelth-AI static (raster) assets generator — v2, line-mark glyph.
 *
 * The animated line-art "N" monogram (static/animated SVG variants are
 * favicon.svg / favicon-tab.svg) rendered as static rasters for contexts
 * that cannot run SVG animations (PWA manifest, iOS, .ico, fallbacks).
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(__dirname, '..', 'public', 'static');

const PATH_D = fs.readFileSync('/tmp/nelth/path.txt', 'utf-8').trim();

/** Static glyph — fully drawn + filled (end state of the draw-in animation). */
function glyphSvg({ fill, stroke, scale = 1, bg = null }) {
  const size = Math.round(497 * scale);
  const bgRect = bg ? `<rect x="0" y="0" width="497" height="502" fill="${bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(502 * scale)}" viewBox="0 0 497 502">
  ${bgRect}
  <path d="${PATH_D}" fill="${fill}" stroke="${stroke}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

async function renderPng(svg, out, width, height) {
  await sharp(Buffer.from(svg)).resize(width, height).png().toFile(out);
  console.log('✓', out);
}

async function renderIco(out) {
  const png = await sharp(Buffer.from(glyphSvg({ fill: '#0a0a0a', stroke: '#0a0a0a' })))
    .resize(32, 32)
    .png()
    .toBuffer();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(32, 0);
  entry.writeUInt8(32, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  fs.writeFileSync(out, Buffer.concat([header, entry, png]));
  console.log('✓', out);
}

const DARK = '#0a0a0a';
const LIGHT = '#fafafa';
const TILE = '#131318';

(async () => {
  // Transparent dark glyph — general fallbacks (auth card, light surfaces)
  await renderPng(glyphSvg({ fill: DARK, stroke: DARK }), path.join(STATIC, 'favicon.png'), 512, 512);
  await renderPng(glyphSvg({ fill: DARK, stroke: DARK }), path.join(STATIC, 'favicon-96x96.png'), 96, 96);
  await renderIco(path.join(STATIC, 'favicon.ico'));

  // iOS app icon + PWA maskable icons — dark tile, light glyph (safe on any mask)
  await renderPng(glyphSvg({ fill: LIGHT, stroke: LIGHT, bg: TILE }), path.join(STATIC, 'apple-touch-icon.png'), 180, 180);
  await renderPng(glyphSvg({ fill: LIGHT, stroke: LIGHT, bg: TILE }), path.join(STATIC, 'web-app-manifest-192x192.png'), 192, 192);
  await renderPng(glyphSvg({ fill: LIGHT, stroke: LIGHT, bg: TILE }), path.join(STATIC, 'web-app-manifest-512x512.png'), 512, 512);

  // Sidebar home button / generic logo — theme-paired transparent variants
  await renderPng(glyphSvg({ fill: DARK, stroke: DARK }), path.join(STATIC, 'logo.png'), 500, 500);
  await renderPng(glyphSvg({ fill: DARK, stroke: DARK }), path.join(STATIC, 'splash.png'), 500, 500);
  await renderPng(glyphSvg({ fill: LIGHT, stroke: LIGHT }), path.join(STATIC, 'splash-dark.png'), 500, 500);
  console.log('All static assets regenerated.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
