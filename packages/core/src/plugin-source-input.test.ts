import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as fromPlugins from './plugins.js';
import * as fromInput from './plugin-source-input.js';

describe('plugin-source-input（web の送る前の検査が使う小さな入口。#5903）', () => {
  it('plugins.ts から出す規則は、この入口のものと同一（検査が2つに分かれない）', () => {
    expect(fromPlugins.pluginNameSchema).toBe(fromInput.pluginNameSchema);
    expect(fromPlugins.pluginSourceShaSchema).toBe(fromInput.pluginSourceShaSchema);
    expect(fromPlugins.pluginRepoUrlSchema).toBe(fromInput.pluginRepoUrlSchema);
    expect(fromPlugins.pluginRelativePathSchema).toBe(fromInput.pluginRelativePathSchema);
    expect(fromPlugins.pluginPreviewRequestSchema).toBe(fromInput.pluginPreviewRequestSchema);
    expect(fromPlugins.validatePluginFilePath).toBe(fromInput.validatePluginFilePath);
    expect(fromPlugins.PLUGIN_LIMITS).toBe(fromInput.PLUGIN_LIMITS);
  });

  it('取り元の指定: 通る形と、断る形', () => {
    const schema = fromInput.pluginPreviewRequestSchema;
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
    expect(schema.safeParse({ kind: 'url', url: 'http://example.com/o/r' }).success).toBe(false);
    expect(
      schema.safeParse({ kind: 'url', url: 'https://example.com/o/r', ref: '-x' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ kind: 'url', url: 'https://example.com/o/r', extra: 1 }).success,
    ).toBe(false);
  });

  it('セグメントの長さは UTF-8 のバイト数で見る（255 バイトまで）', () => {
    expect(fromInput.validatePluginFilePath('a'.repeat(255))).toBeNull();
    expect(fromInput.validatePluginFilePath('a'.repeat(256))).not.toBeNull();
    // 「あ」は UTF-8 で 3 バイト: 85 文字で 255 バイト、86 文字で 258 バイト
    expect(fromInput.validatePluginFilePath('あ'.repeat(85))).toBeNull();
    expect(fromInput.validatePluginFilePath('あ'.repeat(86))).not.toBeNull();
  });

  it('node: の組み込み・Buffer・plugins.js を使わない（ブラウザの束に入れられる）', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./plugin-source-input.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+'node:/);
    expect(source).not.toMatch(/\bBuffer\./);
    expect(source).not.toMatch(/from\s+'\.\/plugins\.js'/);
  });
});
