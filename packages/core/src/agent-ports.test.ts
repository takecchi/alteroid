import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS } from './agent-ports.js';

describe('AGENT_PROVIDER_IDS', () => {
  it('claude と codex を持つ（出所はここ1つ）', () => {
    expect(AGENT_PROVIDER_IDS).toEqual(['claude', 'codex']);
  });
});

describe('agent-ports.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-ports.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
