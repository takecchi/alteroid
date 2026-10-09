import { describe, expect, it } from 'vitest';

import { computePluginContentSha256, parseRunnerPlugin, PLUGIN_LIMITS } from './plugins.js';
import {
  decodeRunnerPlugin,
  encodeRunnerPlugin,
  RUNNER_PLUGIN_BODY_LIMIT_BYTES,
} from './runner-plugin-wire.js';

const files = [
  { path: 'a.txt', executable: false, content: new Uint8Array([0, 255, 128, 1]) },
  { path: 'bin/b', executable: true, content: Buffer.from('dummy-content') },
];

const plugin = {
  name: 'p-one',
  sourceSha: 'a'.repeat(40),
  scope: 'runner' as const,
  enableHooks: true,
  enableMcp: false,
  contentSha256: computePluginContentSha256(files),
  files,
};

describe('runner への plugin の本文', () => {
  it('encode → decode → parseRunnerPlugin で、バイトも欄も往復する', () => {
    const parsed = parseRunnerPlugin(decodeRunnerPlugin(encodeRunnerPlugin(plugin)));
    expect(parsed.name).toBe('p-one');
    expect(parsed.enableHooks).toBe(true);
    expect(parsed.files.map((f) => [f.path, f.executable, [...f.content]])).toEqual(
      files
        .map((f) => [f.path, f.executable, [...f.content]] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  });

  it('標準の綴りでない base64（空白・url-safe・padding 欠け）は黙って許さない', () => {
    for (const content of ['AP+B AQ==', 'AP-BAQ==', 'AP+BAQ', '====']) {
      const command = encodeRunnerPlugin(plugin);
      command.files[0] = { ...command.files[0]!, content };
      expect(() => decodeRunnerPlugin(command)).toThrow('base64');
    }
  });

  it('parseRunnerPlugin は scope が app のもの・contentSha256 の不一致を拒み、文言に値を載せない', () => {
    expect(() => parseRunnerPlugin({ ...plugin, scope: 'app' })).toThrow();
    let message = '';
    try {
      parseRunnerPlugin({ ...plugin, contentSha256: 'f'.repeat(64) });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('contentSha256');
    expect(message).not.toContain('dummy-content');
  });

  it('bodyLimit は PLUGIN_LIMITS の合計を base64 にした大きさ以上で、導出元から離れすぎない', () => {
    const base64OfTotal = Math.ceil(PLUGIN_LIMITS.maxTotalBytes / 3) * 4;
    expect(RUNNER_PLUGIN_BODY_LIMIT_BYTES).toBeGreaterThan(base64OfTotal);
    expect(RUNNER_PLUGIN_BODY_LIMIT_BYTES - base64OfTotal).toBeLessThan(base64OfTotal / 10);
  });
});
