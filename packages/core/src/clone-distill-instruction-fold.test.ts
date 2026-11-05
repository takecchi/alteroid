import { describe, expect, it } from 'vitest';

import { buildDistillPrompt } from './prompt.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

// 蒸留の指示の固定の本体は、同じ会話の2回目以降も全文のまま出す。枕（理由）・棚卸しの的は毎回出る。

const INTRO_FULL = '承認・確認への人間の答え';
const CONSOLIDATION_FULL = '相対的な日付表現（「昨日」「先週」）を見つけたら';
const REF_MARK = '先の蒸留の指示と同じ';

function scheduledEvent(n: number): InboxEvent {
  return {
    type: 'distill',
    id: `evt-tidy-${String(n)}`,
    at: new Date().toISOString(),
    reason: 'scheduled',
  };
}

describe('蒸留の指示の固定の本体は、同じ会話の2回目も全文', () => {
  it('⭐ 会話終了の蒸留も、同じ会話の棚卸しも、本体は全文。枕は毎回出る', async () => {
    const s = setup(
      undefined,
      createMemoryStores(),
      {
        getContextUsage: () => ({
          categories: [],
          totalTokens: 10_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          percentage: 1,
          autoCompactThreshold: 200_000,
          isAutoCompactEnabled: true,
        }),
      },
      {},
    );
    const inputs = (): string[] => (s.calls[0] as FakeCall | undefined)?.inputs ?? [];
    s.clone.post(humanMessage('1回目'));
    await waitFor(() => inputs().length >= 1, '人間の入力');
    await s.clone.endConversation('conv-1');
    await waitFor(() => inputs().length >= 2, '会話終了の蒸留');
    s.clone.post(humanMessage('2回目'));
    await waitFor(() => inputs().length >= 3, '人間の入力2');
    s.clone.post(scheduledEvent(1));
    await waitFor(() => inputs().length >= 4, '棚卸し');

    const first = inputs()[1] ?? '';
    const second = inputs()[3] ?? '';
    expect(first).toContain('いまの会話が終わった');
    expect(second).toContain('定期の棚卸しの刻みが来た');
    for (const text of [first, second]) {
      expect(text).toContain(INTRO_FULL);
      expect(text).toContain(CONSOLIDATION_FULL);
      expect(text).not.toContain(REF_MARK);
    }
    await s.clone.stop();
  });

  it('⭐ 畳みを渡さない buildDistillPrompt（pre_compact を含む）は、全文のまま変わらない', () => {
    for (const reason of ['conversation_end', 'scheduled', 'pre_compact'] as const) {
      const plain = buildDistillPrompt(reason);
      expect(plain).toContain(INTRO_FULL);
      expect(plain).toContain(CONSOLIDATION_FULL);
      expect(plain).not.toContain(REF_MARK);
    }
  });
});
