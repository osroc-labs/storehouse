// Builds the storehouse brand kit (direction D, Ward Clerk) into the directory given as argv[2].
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import opentype from 'opentype.js';

const OUT = path.resolve(process.argv[2]);
const FS = 'node_modules/@fontsource';

const C = {
  paper: '#FAFAF5',
  ink: '#26335C',
  muted: '#5D6580',
  greenbar: '#DCEBD6',
  canary: '#F4E39C',
  pink: '#F3CDD3',
  red: '#B2393A',
  hole: '#D9D6CA',
};

// ---------- fonts ----------
function loadFont(file) {
  const buf = fs.readFileSync(file);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const marc = loadFont(`${FS}/marcellus-sc/files/marcellus-sc-latin-400-normal.woff`);
const courier = loadFont(`${FS}/courier-prime/files/courier-prime-latin-400-normal.woff`);

const r = (n) => Math.round(n * 1000) / 1000;

// Outlines a string at baseline y=0. Tracking is in em.
function outline(font, str, size, tracking = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(str);
  let x = 0;
  const parts = [];
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(x, 0, size).toPathData(2));
    x += g.advanceWidth * scale;
    if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale + tracking * size;
  });
  const cap = font.charToGlyph('H').getBoundingBox().y2 * scale;
  return { d: parts.join(''), width: x, cap };
}

// One glyph centered on (cx, cy) by its ink box.
function centeredGlyph(font, ch, size, cx, cy) {
  const g = font.charToGlyph(ch);
  const p = g.getPath(0, 0, size);
  const b = p.getBoundingBox();
  const dx = cx - (b.x1 + b.x2) / 2, dy = cy - (b.y1 + b.y2) / 2;
  return `<path transform="translate(${r(dx)} ${r(dy)})" d="${p.toPathData(2)}"/>`;
}

// Text on an arc, outlined. Top arcs read clockwise with the baseline inside;
// bottom arcs read left to right with the baseline outside, so both stay upright.
function arcText(font, str, size, tracking, radius, centerDeg, bottom, cx = 32, cy = 32) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(str);
  const advs = glyphs.map((g) => g.advanceWidth * scale);
  const total = advs.reduce((a, b) => a + b, 0) + tracking * size * (glyphs.length - 1);
  let pos = -total / 2;
  const out = [];
  glyphs.forEach((g, i) => {
    const mid = pos + advs[i] / 2;
    const deg = centerDeg + (bottom ? -1 : 1) * (mid / radius) * (180 / Math.PI);
    const d = g.getPath(-advs[i] / 2, 0, size).toPathData(2);
    if (d) out.push(`<path transform="translate(${cx} ${cy}) rotate(${r(deg)}) translate(0 ${-radius})${bottom ? ' rotate(180)' : ''}" d="${d}"/>`);
    pos += advs[i] + tracking * size;
  });
  return out.join('\n');
}

// ---------- marks ----------
// Full mark: a records seal. 64-unit box, centered on (32, 32), outer edge at r = 31.2.
function markFull(color, tx = 0, ty = 0, s = 1) {
  return `<g transform="translate(${r(tx)} ${r(ty)}) scale(${r(s)})" fill="${color}">
<circle cx="32" cy="32" r="30" fill="none" stroke="${color}" stroke-width="2.4"/>
<circle cx="32" cy="32" r="19.6" fill="none" stroke="${color}" stroke-width="1.2"/>
${arcText(marc, 'STOREHOUSE', 6.2, 0.2, 22.4, 0, false)}
${arcText(marc, 'RECORDS KEPT', 6.2, 0.2, 26.7, 180, true)}
<circle cx="8.4" cy="32" r="1.1"/><circle cx="55.6" cy="32" r="1.1"/>
${centeredGlyph(marc, 'S', 25, 32, 32)}
</g>`;
}
// Small mark for 16 to 95px: the ring and the S, no lettering.
function markSmall(color, tx = 0, ty = 0, s = 1) {
  return `<g transform="translate(${r(tx)} ${r(ty)}) scale(${r(s)})" fill="${color}">
<circle cx="32" cy="32" r="28" fill="none" stroke="${color}" stroke-width="4.5"/>
${centeredGlyph(marc, 'S', 36, 32, 32.5)}
</g>`;
}

const svg = (w, h, body, vb = `0 0 ${r(w)} ${r(h)}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${r(w)}" height="${r(h)}" viewBox="${vb}">\n${body}\n</svg>\n`;

// ---------- write helpers ----------
const written = [];
function write(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written.push(rel);
}
const png = (svgText, width) => new Resvg(svgText, { fitTo: { mode: 'width', value: width } }).render().asPng();

// ---------- logo ----------
const WORD = outline(marc, 'STOREHOUSE', 100, 0.16);
const wordmark = (color) =>
  svg(WORD.width, WORD.cap, `<path fill="${color}" transform="translate(0 ${r(WORD.cap)})" d="${WORD.d}"/>`);

// Horizontal lockup: the seal is 2.8x the cap height, centered on the caps.
function lockupH(color) {
  const k = (WORD.cap * 2.8) / 64;
  const seal = 62.4 * k;
  const gap = WORD.cap * 0.55;
  const w = seal + gap + WORD.width;
  return svg(w, seal, `${markFull(color, -0.8 * k, -0.8 * k, k)}
<path fill="${color}" transform="translate(${r(seal + gap)} ${r(seal / 2 + WORD.cap / 2)})" d="${WORD.d}"/>`);
}
function lockupS(color) {
  const k = (WORD.cap * 4) / 64;
  const seal = 62.4 * k;
  const gap = WORD.cap * 0.6;
  const w = Math.max(WORD.width, seal);
  return svg(w, seal + gap + WORD.cap, `${markFull(color, (w - seal) / 2 - 0.8 * k, -0.8 * k, k)}
<path fill="${color}" transform="translate(${r((w - WORD.width) / 2)} ${r(seal + gap + WORD.cap)})" d="${WORD.d}"/>`);
}
const markOnly = (color) => svg(512, 512, markFull(color), '0.8 0.8 62.4 62.4');
const markSmallOnly = (color) => svg(512, 512, markSmall(color), '1.75 1.75 60.5 60.5');

for (const [name, color] of [['ink', C.ink], ['paper', C.paper], ['red', C.red]]) {
  write(`logo/mark-${name}.svg`, markOnly(color));
  write(`logo/mark-small-${name}.svg`, markSmallOnly(color));
  if (name === 'red') continue;
  write(`logo/wordmark-${name}.svg`, wordmark(color));
  write(`logo/lockup-horizontal-${name}.svg`, lockupH(color));
  write(`logo/lockup-stacked-${name}.svg`, lockupS(color));
  write(`logo/png/lockup-horizontal-${name}.png`, png(lockupH(color), 1600));
  write(`logo/png/lockup-stacked-${name}.png`, png(lockupS(color), 1000));
  write(`logo/png/mark-${name}.png`, png(markOnly(color), 1024));
}

// ---------- favicons ----------
const favTile = svg(32, 32, `<rect width="32" height="32" rx="6" fill="${C.ink}"/>
<circle cx="16" cy="16" r="12.2" fill="none" stroke="${C.paper}" stroke-width="2"/>
<g fill="${C.paper}" stroke="${C.paper}" stroke-width="0.9" stroke-linejoin="round">${centeredGlyph(marc, 'S', 18.5, 16, 16.2)}</g>`);
write('favicon/favicon.svg', favTile);
const fav16 = png(favTile, 16), fav32 = png(favTile, 32), fav48 = png(favTile, 48);
write('favicon/favicon-16.png', fav16);
write('favicon/favicon-32.png', fav32);

function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dirs = images.map(({ size, buf }) => {
    const d = Buffer.alloc(16);
    d.writeUInt8(size, 0); d.writeUInt8(size, 1);
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6);
    d.writeUInt32LE(buf.length, 8); d.writeUInt32LE(offset, 12);
    offset += buf.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...images.map((i) => i.buf)]);
}
write('favicon/favicon.ico', ico([{ size: 16, buf: fav16 }, { size: 32, buf: fav32 }, { size: 48, buf: fav48 }]));

// Full-bleed squares; the seal stays inside the maskable safe zone (a circle of 40% radius).
const square = (size, s) => svg(size, size,
  `<rect width="${size}" height="${size}" fill="${C.ink}"/>\n${markFull(C.paper, size / 2 - 32 * s, size / 2 - 32 * s, s)}`);
write('favicon/apple-touch-icon.png', png(square(180, 2.2), 180));
write('favicon/icon-192.png', png(square(192, 2.3), 192));
write('favicon/icon-512.png', png(square(512, 6.4), 512));
write('favicon/site.webmanifest', JSON.stringify({
  name: 'storehouse',
  short_name: 'storehouse',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  theme_color: C.ink,
  background_color: C.paper,
  display: 'browser',
}, null, 2) + '\n');

// ---------- social card: green-bar paper with tractor-feed margins ----------
function ogCard() {
  const W = 1200, H = 630, EDGE = 48, M = 104;
  const bars = [];
  for (let y = 0; y < H; y += 80) bars.push(`<rect x="${EDGE}" y="${y}" width="${W - 2 * EDGE}" height="40" fill="${C.greenbar}"/>`);
  const holes = [];
  for (let y = 20; y < H; y += 40) holes.push(`<circle cx="24" cy="${y}" r="7"/><circle cx="${W - 24}" cy="${y}" r="7"/>`);
  const perf = [];
  for (let y = 0; y < H; y += 10) perf.push(`<rect x="${EDGE - 1}" y="${y}" width="1.5" height="5"/><rect x="${W - EDGE - 0.5}" y="${y}" width="1.5" height="5"/>`);

  const word = outline(marc, 'STOREHOUSE', 100, 0.16);
  const k = (word.cap * 2.8) / 64;
  const seal = 62.4 * k, gap = word.cap * 0.55;
  const fit = Math.min(1, (W - 2 * M) / (seal + gap + word.width));
  const top = 112;
  const ruleY = top + seal * fit + 40;
  const line1 = outline(courier, 'A command-line tool for Google Secret Manager,', 34);
  const line2 = outline(courier, 'with a manifest in the repo.', 34);
  const cmd = outline(courier, 'npm install -g @osroc-labs/storehouse', 26);
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${C.paper}"/>
${bars.join('\n')}
<g fill="${C.hole}">${holes.join('')}</g>
<g fill="${C.muted}" opacity=".5">${perf.join('')}</g>
<g transform="translate(${M} ${top}) scale(${r(fit)})">
${markFull(C.ink, -0.8 * k, -0.8 * k, k)}
<path fill="${C.ink}" transform="translate(${r(seal + gap)} ${r(seal / 2 + word.cap / 2)})" d="${word.d}"/>
</g>
<rect x="${M}" y="${r(ruleY)}" width="${W - 2 * M}" height="3" fill="${C.ink}"/>
<rect x="${M}" y="${r(ruleY + 7)}" width="${W - 2 * M}" height="3" fill="${C.ink}"/>
<path fill="${C.ink}" transform="translate(${M} ${r(ruleY + 78)})" d="${line1.d}"/>
<path fill="${C.ink}" transform="translate(${M} ${r(ruleY + 124)})" d="${line2.d}"/>
<path fill="${C.muted}" transform="translate(${M} ${H - 62})" d="${cmd.d}"/>
<rect x="${M}" y="${H - 84}" width="12" height="30" fill="${C.red}" transform="translate(-26 0)"/>`);
}
const og = ogCard();
write('social/og-image.svg', og);
write('social/og-image.png', png(og, 1200));

// ---------- tokens ----------
function lum(hex) {
  const [R, G, B] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const pairs = [
  ['ink', 'paper'], ['muted', 'paper'], ['red', 'paper'], ['ink', 'greenbar'], ['muted', 'greenbar'],
  ['ink', 'canary'], ['ink', 'pink'], ['red', 'pink'], ['paper', 'ink'], ['paper', 'red'],
].map(([fg, bg]) => ({ fg, bg, ratio: Math.round(contrast(C[fg], C[bg]) * 10) / 10 }));

const { hole, ...palette } = C;
write('tokens/colors.css', `/* storehouse colors. Light theme only. */
:root {
  --sh-paper:    ${C.paper};  /* page background */
  --sh-ink:      ${C.ink};  /* text, logo, rules */
  --sh-muted:    ${C.muted};  /* labels, captions, secondary text */
  --sh-greenbar: ${C.greenbar};  /* stripes behind terminal output */
  --sh-canary:   ${C.canary};  /* one callout or section ground, sparingly */
  --sh-pink:     ${C.pink};  /* one callout or section ground, sparingly */
  --sh-red:      ${C.red};  /* small accents: links, the one primary button, markers */

  --sh-font-display: "Marcellus SC", "Marcellus", Georgia, serif;
  --sh-font-body:    "Courier Prime", "Courier New", Courier, monospace;
  --sh-font-label:   "IBM Plex Sans", system-ui, sans-serif;
}
`);
write('tokens/tokens.json', JSON.stringify({
  color: Object.fromEntries(Object.entries(palette).map(([k, v]) => [k, { value: v }])),
  font: {
    display: { family: 'Marcellus SC', weights: [400], note: 'Headings, wordmark. Tracking 0.02em on headings, 0.16em on the wordmark.' },
    body: { family: 'Courier Prime', weights: [400, 700], note: 'Body text, commands and terminal output.' },
    label: { family: 'IBM Plex Sans', weights: [400, 500], note: 'Small uppercase labels, tracked 0.1em.' },
  },
  contrast: pairs,
}, null, 2) + '\n');

// ---------- fonts ----------
const fontFiles = [
  ['marcellus-sc', 'Marcellus SC', 'marcellus-sc-latin-400-normal.woff2', 400],
  ['courier-prime', 'Courier Prime', 'courier-prime-latin-400-normal.woff2', 400],
  ['courier-prime', 'Courier Prime', 'courier-prime-latin-700-normal.woff2', 700],
  ['ibm-plex-sans', 'IBM Plex Sans', 'ibm-plex-sans-latin-400-normal.woff2', 400],
  ['ibm-plex-sans', 'IBM Plex Sans', 'ibm-plex-sans-latin-500-normal.woff2', 500],
];
for (const [pkg, , file] of fontFiles) write(`fonts/${pkg}/${file}`, fs.readFileSync(`${FS}/${pkg}/files/${file}`));
for (const pkg of new Set(fontFiles.map((f) => f[0]))) write(`fonts/${pkg}/OFL.txt`, fs.readFileSync(`${FS}/${pkg}/LICENSE`));
write('fonts/fonts.css', `/* Latin subset, self-hosted. All three families are under the SIL Open Font License (OFL.txt in each folder). */
${fontFiles.map(([pkg, family, file, w]) => `@font-face {
  font-family: "${family}";
  font-style: normal;
  font-weight: ${w};
  font-display: swap;
  src: url("./${pkg}/${file}") format("woff2");
}`).join('\n')}
`);

console.log(written.join('\n'));
console.log(JSON.stringify(pairs));
