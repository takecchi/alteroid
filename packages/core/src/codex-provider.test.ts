import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { missingRequirementCapabilities } from './agent-ports.js';
import { CODEX_PROVIDER } from './codex-provider.js';
import { describeProviderGaps } from './provider-gaps.js';

describe('CODEX_PROVIDER（正直な申告）', () => {
  it('id と表示名', () => {
    expect(CODEX_PROVIDER.id).toBe('codex');
    expect(CODEX_PROVIDER.displayName).toBe('Codex');
  });

  it('満たしているものだけ true。満たせないものは false と申告する', () => {
    expect(CODEX_PROVIDER.capabilities).toEqual({
      permissions: true,
      toolAudit: true,
      compactionHook: false,
      resume: true,
      sessionLog: false,
      subagents: false,
      mcpServers: false,
      childUser: true,
      usage: true,
      partialMessages: true,
    });
  });

  it('欠けた要件は provider-gaps が日報・自己認識へ出す（持たないふりをしない）', () => {
    expect(missingRequirementCapabilities(CODEX_PROVIDER.capabilities)).toEqual([
      'compactionHook',
      'sessionLog',
      'subagents',
      'mcpServers',
    ]);
    const lines = describeProviderGaps({ manager: CODEX_PROVIDER });
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.startsWith('マネージャー層（Codex）は '))).toBe(true);
  });

  it('このファイルは Claude Agent SDK を import しない', () => {
    const source = readFileSync(new URL('./codex-provider.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
