// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { links, meta } from './root';

/**
 * ホーム画面のアイコン（#2722）。iOS は SVG の favicon を使わないので、PNG の
 * `apple-touch-icon` と manifest が要る。**配っていないものを指す link は、本番では SPA の
 * フォールバックの HTML が返るだけで気づけない**ので、指す先の実在と寸法を測る。
 */
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const publicFile = (href: string) => path.join(PUBLIC_DIR, href.replace(/^\//, ''));

/** PNG の IHDR（署名の直後）から幅・高さ・カラータイプを読む。 */
function pngHeader(file: string) {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('ascii'), `${file} は PNG ではない`).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

describe('root の links', () => {
  it('apple-touch-icon（180x180）と manifest を載せている', () => {
    const all = links() as { rel: string; href: string; sizes?: string }[];
    const touch = all.find((l) => l.rel === 'apple-touch-icon');
    expect(touch?.href).toBe('/apple-touch-icon.png');
    expect(touch?.sizes).toBe('180x180');
    expect(all.find((l) => l.rel === 'manifest')?.href).toBe('/manifest.webmanifest');
  });

  it('ホーム画面の名前を持つ', () => {
    const all = meta() as { name?: string; content?: string }[];
    expect(all.find((m) => m.name === 'apple-mobile-web-app-title')?.content).toBe('alteroid');
  });
});

describe('apple-touch-icon.png', () => {
  const header = pngHeader(publicFile('/apple-touch-icon.png'));
  it('180x180', () => {
    expect([header.width, header.height]).toEqual([180, 180]);
  });
  it('透過を持たない（カラータイプ 2 = RGB。alpha 付きの 4・6 と、パレットの 3 でない）', () => {
    expect(header.colorType).toBe(2);
  });
});

describe('manifest.webmanifest', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'),
  ) as {
    name: string;
    start_url: string;
    display: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };

  it('standalone で、名前と色を持つ', () => {
    expect(manifest.name).toBe('alteroid');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('192・512・maskable を宣言している', () => {
    const keys = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(keys).toEqual(
      expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']),
    );
  });

  it.each(['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'])(
    '%s が public に実在し、PNG の寸法が宣言と一致し、不透明である',
    (src) => {
      const icon = manifest.icons.find((i) => i.src === src)!;
      expect(icon, `manifest に ${src} が無い`).toBeTruthy();
      expect(existsSync(publicFile(src))).toBe(true);
      const { width, height, colorType } = pngHeader(publicFile(src));
      expect(`${width}x${height}`).toBe(icon.sizes);
      expect(colorType).toBe(2);
    },
  );

  it('宣言した src は全部実在する', () => {
    for (const icon of manifest.icons) expect(existsSync(publicFile(icon.src))).toBe(true);
  });
});
