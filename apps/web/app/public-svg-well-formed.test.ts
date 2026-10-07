// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { links } from './root';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

function parseErrorOf(source: string): string | null {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error !== undefined) return error.textContent ?? 'parsererror';
  if (doc.documentElement.nodeName !== 'svg') return `root is <${doc.documentElement.nodeName}>`;
  return null;
}

const svgFiles = readdirSync(PUBLIC_DIR).filter((name) => name.endsWith('.svg'));

describe('public/ の SVG', () => {
  it('少なくとも favicon.svg を見ている（対象が0件で緑にならない）', () => {
    expect(svgFiles).toContain('favicon.svg');
  });

  it.each(svgFiles)('%s は XML として正しい', (name) => {
    expect(parseErrorOf(readFileSync(path.join(PUBLIC_DIR, name), 'utf8'))).toBeNull();
  });

  it('陰性対照: 注釈にハイフン2つの並びがあると、このパーサは壊れていると判定する', () => {
    const broken =
      '<svg xmlns="http://www.w3.org/2000/svg"><!-- `--primary` --><circle r="1"/></svg>';
    expect(parseErrorOf(broken)).not.toBeNull();
  });
});

describe('root の icon の link', () => {
  it('指している先が public/ に在る', () => {
    const icons = links().filter((link) => link.rel === 'icon');
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(readdirSync(PUBLIC_DIR)).toContain(icon.href.replace(/^\//, ''));
    }
  });
});
