/**
 * PWA / ホーム画面のアイコン（PNG）を `public/favicon.svg` の絵柄から作る。
 *
 *   node apps/web/scripts/generate-pwa-icons.mjs
 *
 * **ビルドでは回さない**（PNG は git に入れてある）。絵柄か色を変えたときだけ回して、差分をコミットする。
 *
 * なぜ自前のラスタライザか: この環境には sharp / resvg / rsvg-convert / ImageMagick が無く、
 * 描く図形は円3つ（重なりの塗り・実線の輪・破線の輪）だけで足りる。依存を足さず、
 * `node:zlib` で PNG を書く。**形（円の中心・半径・線幅・破線）は `favicon.svg` と同じ値を
 * ここに写してある**ので、SVG の形を変えたらここも直す（下の `assertSvgMatches` が、値が
 * ずれたら落とす）。
 *
 * 色は `favicon.svg` の「暗い側」の値（`prefers-color-scheme: dark` の枝）。アプリの既定が暗い側
 * （`root.tsx` の `<html class="dark">`）で、ホーム画面に置くアイコンはブラウザの明暗でなく
 * アプリの顔だから。背景は `styles.css` の `.dark` の `--background`（`oklch(0.165 0.022 272)`）で
 * **不透明**にする（iOS は透過を黒で塗る。maskable も端まで地で埋める必要がある）。
 */
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../public');

// --- favicon.svg の形（viewBox 24x24） ---
const R = 6.5;
const C1 = { x: 9.5, y: 12 }; // 塗りと実線の輪
const C2 = { x: 14.5, y: 12 }; // 破線の輪。塗りはこの円で切り抜く
const STROKE = 1.5;
const DASH = [2.2, 1.8];
// 記号の外接（線幅の半分まで含む）。中心は (12, 12)。
const HALF_W = (C2.x + R + STROKE / 2 - (C1.x - R - STROKE / 2)) / 2; // 9.75
const HALF_H = R + STROKE / 2; // 7.25
const HALF_DIAG = Math.hypot(HALF_W, HALF_H); // 12.15

function assertSvgMatches() {
  const svg = readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');
  const expected = [
    'cx="9.5" cy="12" r="6.5"',
    'cx="14.5" cy="12" r="6.5"',
    'stroke-width="1.5"',
    'stroke-dasharray="2.2 1.8"',
    'oklch(0.94 0.012 280)',
    'oklch(0.8 0.12 285)',
  ];
  for (const piece of expected) {
    if (!svg.includes(piece)) {
      throw new Error(
        `favicon.svg の形か色が変わっている（${piece}）。このスクリプトの値も直すこと`,
      );
    }
  }
}

// --- 色（oklch → sRGB） ---
function oklch(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g * 255);
  });
}
const BG = oklch(0.165, 0.022, 272);
const FG = oklch(0.94, 0.012, 280);
const PRIMARY = oklch(0.8, 0.12, 285);

// --- 描画 ---
const SS = 4; // 1画素あたり SS×SS の標本

/** 点（記号の座標系）の色。上に重なるものが勝つ。 */
function sample(x, y) {
  const d1 = Math.hypot(x - C1.x, y - C1.y);
  const d2 = Math.hypot(x - C2.x, y - C2.y);
  // 破線の輪（最前面）。パスは (cx+r, cy) から時計回り。
  if (Math.abs(d2 - R) <= STROKE / 2) {
    let ang = Math.atan2(y - C2.y, x - C2.x);
    if (ang < 0) ang += Math.PI * 2;
    const along = ang * R;
    const period = DASH[0] + DASH[1];
    if (along % period < DASH[0]) return PRIMARY;
  }
  if (Math.abs(d1 - R) <= STROKE / 2) return FG;
  if (d1 <= R && d2 <= R) return PRIMARY;
  return null;
}

/** 一辺 `size` px の正方形。記号の外接の半対角が `fit * size / 2` になる縮尺で、中央に置く。 */
function render(size, fit) {
  const scale = (fit * size) / 2 / HALF_DIAG;
  const rgb = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = 12 + (px + (sx + 0.5) / SS - size / 2) / scale;
          const y = 12 + (py + (sy + 0.5) / SS - size / 2) / scale;
          const c = sample(x, y) ?? BG;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 3;
      rgb[i] = Math.round(r / n);
      rgb[i + 1] = Math.round(g / n);
      rgb[i + 2] = Math.round(b / n);
    }
  }
  return rgb;
}

// --- PNG（8bit RGB。alpha を持たない＝透過が無い） ---
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 2; // カラータイプ 2 = RGB（alpha 無し）
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `fit` = 記号の外接円の直径 / 一辺。
 * - any（192・512・apple-touch）: 0.70。記号の幅は一辺の約 0.58。角丸（iOS）で欠けない余白
 * - maskable: 0.80。W3C の安全域（中央の直径 80% の円）の中に記号の全部が収まる
 */
const TARGETS = [
  ['apple-touch-icon.png', 180, 0.7],
  ['icon-192.png', 192, 0.7],
  ['icon-512.png', 512, 0.7],
  ['icon-maskable-512.png', 512, 0.8],
];

assertSvgMatches();
for (const [name, size, fit] of TARGETS) {
  writeFileSync(path.join(PUBLIC, name), png(size, render(size, fit)));
  process.stdout.write(`${name} ${size}x${size} fit=${fit}\n`);
}
