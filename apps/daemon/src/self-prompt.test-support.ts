import type { ClonePromptSnapshot } from '@alteroid/core';

// `GET /self/prompt` の試験が共有する、クローンのスナップショットの作り方。
// `self-prompt.test.ts`（応答の中身）と `self-prompt-input-pin.test.ts`（core の読み取りの写しとの突き合わせ）が同じ作り方を使い、
// 「本物の応答の形」の定義を二重に持たない。

export const usageOf = (overrides: Record<string, unknown> = {}) =>
  ({
    ok: true,
    at: '2026-11-15T00:00:05.000Z',
    totalTokens: 1000,
    rawMaxTokens: 200_000,
    percentage: 0.5,
    autoCompactThreshold: null,
    isAutoCompactEnabled: true,
    categories: {
      available: true,
      value: { rows: [{ name: 'System prompt', tokens: 10, kind: 'used' }], omitted: 0 },
    },
    mcpTools: {
      available: true,
      value: {
        rows: [{ name: 'journal_read', serverName: 'alteroid', tokens: 20, isLoaded: true }],
        omitted: 0,
      },
    },
    systemPromptSections: { available: true, value: { rows: [], omitted: 0 } },
    memoryFiles: {
      available: true,
      value: { rows: [{ path: '/data/memory/values.md', type: 'Project', tokens: 5 }], omitted: 0 },
    },
    systemTools: {
      available: true,
      value: {
        rows: [
          { name: 'Bash', tokens: 120 },
          { name: 'Read', tokens: 80 },
        ],
        omitted: 0,
      },
    },
    deferredBuiltinTools: {
      available: true,
      value: { rows: [{ name: 'WebFetch', tokens: 30, isLoaded: false }], omitted: 0 },
    },
    mcpInstructions: { available: false, reason: 'この欄が無かった' },
    messageBreakdown: { available: false, reason: 'この欄が無かった' },
    ...overrides,
  }) as ClonePromptSnapshot['contextUsage'];

export const sessionOf = (overrides: Record<string, unknown> = {}) =>
  ({
    ok: true,
    builtAt: '2026-11-15T00:00:00.000Z',
    resumedFrom: null,
    sessionId: 'sess-1',
    model: 'opus',
    systemPrompt: { text: 'あなたはクローンである。通常の文章はそのまま出る。', chars: 24 },
    memoryInPrompt: {
      documents: [
        {
          slug: 'values',
          type: 'premise',
          description: '価値観の要旨',
          chars: 900,
          index: { kind: 'baked', form: 'premise-card', chars: 210 },
        },
        {
          slug: 'old-note',
          type: 'fact',
          description: null,
          chars: 50,
          index: { kind: 'omitted', reason: 'fact の目次から省かれた（件数の上限に当たった）' },
        },
      ],
      omitted: 0,
    },
    tools: [
      {
        name: 'journal_read',
        description: '日誌を読む',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: '行の id' } },
        },
        descriptionChars: 5,
        inputSchemaChars: 80,
      },
    ],
    builtinTools: {
      available: false,
      reason: '組み込みの道具の定義は取れない（SDK の型に口が無い）',
    },
    externalMcpServers: [
      { name: 'github', type: 'stdio' },
      { name: 'remote', type: 'http' },
    ],
    externalMcpServersLive: null,
    plugins: [{ name: 'alpha' }],
    ...overrides,
  }) as ClonePromptSnapshot['session'];

export const snapshotOf = (
  session: ClonePromptSnapshot['session'] = sessionOf(),
  contextUsage: ClonePromptSnapshot['contextUsage'] = usageOf(),
): ClonePromptSnapshot => ({ session, contextUsage });
