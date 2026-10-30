import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PLUGIN_NAME_PATTERN,
  PLUGIN_SHA_PATTERN,
  validatePluginFilePath,
  validatePluginRepoUrl,
  validatePluginSourceRef,
} from './plugin-source-input.js';
import {
  pluginNameSchema,
  pluginPreviewRequestSchema,
  pluginRelativePathSchema,
  pluginRepoUrlSchema,
  pluginSourceRefSchema,
  pluginSourceShaSchema,
} from './plugins.js';

// zod のスキーマと zod なしの規則が、同じ入力で同じ判定になること（#5903）。
// web は zod なしの規則だけを使い、daemon は zod のスキーマを使う
const NAMES = ['demo', 'my plugin', 'demo.v2', 'a'.repeat(64), 'a'.repeat(65), '', 'あ', 'a-b_C9'];
const SHAS = ['a'.repeat(40), 'a'.repeat(39), 'A'.repeat(40), 'main', '', 'g'.repeat(40)];
const URLS = [
  'https://example.com/o/r',
  'http://example.com/o/r',
  'https://user:pw@example.com/o/r',
  'https://example.com/o/r?x=1',
  'https://example.com/o/r#x',
  'https://example.com/o/r?',
  'https://example.com/o r',
  'https:///x',
  'not a url',
  '',
  `https://example.com/${'a'.repeat(2100)}`,
];
const PATHS = [
  'a/b',
  '/abs',
  'a/../b',
  'a//b',
  'C:\\x',
  'C:x',
  'a\\b',
  '',
  'a'.repeat(255),
  'a'.repeat(256),
  'あ'.repeat(85),
  'あ'.repeat(86),
  `a${'/b'.repeat(300)}`,
  'a\u0000b',
  'a\tb',
  './x',
];
const REFS = ['main', 'v1.2.3', '-x', 'a b', '', 'a'.repeat(256), 'a'.repeat(257), 'a\tb', 'あ'];

describe('plugin-source-input（zod なしの規則）と zod のスキーマの突き合わせ（#5903）', () => {
  it('plugin 名', () => {
    for (const v of NAMES) {
      expect(PLUGIN_NAME_PATTERN.test(v), v).toBe(pluginNameSchema.safeParse(v).success);
    }
  });

  it('SHA', () => {
    for (const v of SHAS) {
      expect(PLUGIN_SHA_PATTERN.test(v), v).toBe(pluginSourceShaSchema.safeParse(v).success);
    }
  });

  it('URL', () => {
    for (const v of URLS) {
      expect(validatePluginRepoUrl(v) === null, v.slice(0, 40)).toBe(
        pluginRepoUrlSchema.safeParse(v).success,
      );
    }
  });

  it('path', () => {
    for (const v of PATHS) {
      expect(validatePluginFilePath(v) === null, v.slice(0, 40)).toBe(
        pluginRelativePathSchema.safeParse(v).success,
      );
    }
  });

  it('ref', () => {
    for (const v of REFS) {
      expect(validatePluginSourceRef(v) === null, v.slice(0, 40)).toBe(
        pluginSourceRefSchema.safeParse(v).success,
      );
    }
  });

  it('取り元の指定の全体（zod）が、欄の規則と同じ向きで通す・断る', () => {
    const schema = pluginPreviewRequestSchema;
    expect(schema.safeParse({ kind: 'marketplace', plugin: 'demo_plugin-2' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'marketplace', plugin: 'my plugin' }).success).toBe(false);
    expect(
      schema.safeParse({
        kind: 'url',
        url: 'https://example.com/o/r',
        path: 'a/b',
        ref: 'v1.0',
        sha: 'a'.repeat(40),
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ kind: 'url', url: 'https://example.com/o/r', ref: '-x' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ kind: 'url', url: 'https://example.com/o/r', extra: 1 }).success,
    ).toBe(false);
  });

  it('入口は zod も node: も Buffer も plugins.js も import しない（ブラウザの束に入れられる）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./plugin-source-input.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/^import /m);
    expect(source).not.toMatch(/from\s+'(zod|node:)/);
    expect(source).not.toMatch(/\bBuffer\./);
  });
});
