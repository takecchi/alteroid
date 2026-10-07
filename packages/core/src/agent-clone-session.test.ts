import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('agent-clone-session.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-clone-session.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
