import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * 番人テスト: `agent-session.ts`（マネージャーのセッションの駆動役の中立の口）に
 * `@anthropic-ai/claude-agent-sdk` の文字列が混ざっていないことを、ソースを
 * 直接読んで確かめる（`agent-ports.test.ts` と同じ形。型 import も検査対象）。
 */
describe('agent-session.ts の中立性（番人テスト）', () => {
  it('@anthropic-ai/claude-agent-sdk を import していない', () => {
    const path = fileURLToPath(new URL('./agent-session.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');

    expect(source).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});
