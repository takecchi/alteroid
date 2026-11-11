import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CODEX_PROVIDER } from './codex-provider.js';

describe('CODEX_PROVIDER（正直な申告）', () => {
  it('id と表示名', () => {
    expect(CODEX_PROVIDER.id).toBe('codex');
    expect(CODEX_PROVIDER.displayName).toBe('Codex');
  });

  it('読まれる旗（使用量の報告）だけを持ち、使用量を報告できると申告する', () => {
    expect(CODEX_PROVIDER.capabilities).toEqual({ usage: true });
  });

  it('このファイルは Claude Agent SDK を import しない', () => {
    const source = readFileSync(new URL('./codex-provider.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
