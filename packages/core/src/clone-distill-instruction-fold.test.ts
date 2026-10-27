import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { buildDistillPrompt } from './prompt.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { setup, waitFor } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

// 蒸留の指示の固定の本体を、同じ会話の2回目以降は参照にする。全文へ戻す条件は #4937 の控え（`DigestSessionDelta`）そのもの。
// 枕（理由）・棚卸しの的は毎回出る。pre_compact は別の短命セッションなので畳まない。

const INTRO_FULL = '承認・確認への人間の答え';
const CONSOLIDATION_FULL = '相対的な日付表現（「昨日」「先週」）を見つけたら';
const REF_MARK = '先の蒸留の指示と同じ';
const FAT = `---\ntype: premise\ndescription: 要旨\n---\n${Array.from(
  { length: 300 },
  (_, i) => `## これは十分に長い見出しであり予算を食い尽くす ${i}\n本文`,
).join('\n')}`;

const compactBoundary = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'auto', pre_tokens: 100_000 },
  session_id: 'sess-fake',
  uuid: 'uuid-compact',
} as unknown as SDKMessage;

function scheduledEvent(n: number): InboxEvent {
  return {
    type: 'distill',
    id: `evt-tidy-${String(n)}`,
    at: new Date().toISOString(),
    reason: 'scheduled',
  };
}

function boot(compactAtTurn?: number) {
  let turn = 0;
  const stores = createMemoryStores();
  const s = setup(undefined, stores, {
    getContextUsage: () => ({
      categories: [],
      totalTokens: 10_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 1,
      autoCompactThreshold: 200_000,
      isAutoCompactEnabled: true,
    }),
    beforeAssistant: () => {
      turn += 1;
      return turn === compactAtTurn ? [compactBoundary] : [];
    },
  });
  const inputs = (): string[] => (s.calls[0] as FakeCall | undefined)?.inputs ?? [];
  const human = async (text: string): Promise<void> => {
    const n = inputs().length;
    s.clone.post(humanMessage(text));
    await waitFor(() => inputs().length > n, `人間の入力 ${String(n + 1)} 本目`);
  };
  const scheduled = async (n: number): Promise<string> => {
    const before = inputs().length;
    s.clone.post(scheduledEvent(n));
    await waitFor(() => inputs().length > before, `棚卸し ${String(n)} 回目`);
    return inputs()[before] ?? '';
  };
  const endConversation = async (): Promise<string> => {
    const before = inputs().length;
    await s.clone.endConversation('conv-1');
    return inputs()[before] ?? '';
  };
  return { s, stores, human, scheduled, endConversation };
}

describe('蒸留の指示の固定の本体は、同じ会話の2回目から参照になる', () => {
  it('⭐ 1回目は全文、同じ会話の2回目は参照。枕は毎回出る（会話終了 → 棚卸し）', async () => {
    const t = boot();
    await t.human('1回目');
    const first = await t.endConversation();
    await t.human('2回目');
    const second = await t.scheduled(1);

    expect(first).toContain('いまの会話が終わった');
    expect(first).toContain(INTRO_FULL);
    expect(first).toContain(CONSOLIDATION_FULL);
    expect(first).not.toContain(REF_MARK);

    expect(second).toContain('定期の棚卸しの刻みが来た');
    expect(second).toContain(REF_MARK);
    expect(second).not.toContain(INTRO_FULL);
    expect(second).not.toContain(CONSOLIDATION_FULL);
    expect(second.length).toBeLessThan(first.length * 0.2);
    process.stderr.write(
      `[蒸留の指示 測定] 会話終了の1回目 ${String(first.length)} 字 → 同じ会話の棚卸し2回目 ${String(second.length)} 字（枕込みの入力全体）\n`,
    );
    await t.s.clone.stop();
  });

  it('⭐ 棚卸しの的（可変部）は、参照になった回にも毎回出る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('alteroid-work', FAT);
    const s = setup(undefined, stores, {
      getContextUsage: () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    s.clone.post(humanMessage('1回目'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '人間の入力');
    s.clone.post(scheduledEvent(1));
    await waitFor(() => inputs().length >= 2, '棚卸し1回目');
    s.clone.post(humanMessage('2回目'));
    await waitFor(() => inputs().length >= 3, '人間の入力2');
    s.clone.post(scheduledEvent(2));
    await waitFor(() => inputs().length >= 4, '棚卸し2回目');

    const first = inputs()[1] ?? '';
    const second = inputs()[3] ?? '';
    expect(first).toContain(INTRO_FULL);
    expect(first).toContain('- alteroid-work:');
    expect(second).toContain(REF_MARK);
    expect(second).not.toContain(INTRO_FULL);
    expect(second).toContain('棚卸しの的');
    expect(second).toContain('- alteroid-work:');
    await s.clone.stop();
  });

  it('⭐ 自動の要約が走った（compact_boundary）あとの蒸留は全文へ戻る', async () => {
    // 5本目のターン（3回目の人間の入力）で要約が走る
    const t = boot(5);
    await t.human('1回目');
    await t.endConversation(); // turn 2: 全文
    await t.human('2回目'); // turn 3
    const second = await t.scheduled(1); // turn 4: 参照
    await t.human('3回目'); // turn 5: ここで compact_boundary
    const third = await t.scheduled(2); // turn 6: 全文へ戻る

    expect(second).toContain(REF_MARK);
    expect(second).not.toContain(INTRO_FULL);
    expect(third).not.toContain(REF_MARK);
    expect(third).toContain(INTRO_FULL);
    expect(third).toContain(CONSOLIDATION_FULL);
    await t.s.clone.stop();
  });

  it('⭐ 失敗した蒸留のあとは全文へ戻る（全文が会話に載ったか分からないため）', async () => {
    let turn = 0;
    const s = setup(undefined, createMemoryStores(), {
      getContextUsage: () => ({
        categories: [],
        totalTokens: 10_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 1,
        autoCompactThreshold: 200_000,
        isAutoCompactEnabled: true,
      }),
      resultFor: () => {
        turn += 1;
        return turn === 2 ? { subtype: 'error_during_execution', isError: true } : undefined;
      },
    });
    const inputs = (): string[] => (s.calls[0] as FakeCall).inputs;
    s.clone.post(humanMessage('1回目'));
    await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '人間の入力');
    s.clone.post(scheduledEvent(1)); // 失敗する
    await waitFor(() => inputs().length >= 2, '棚卸し1回目');
    s.clone.post(humanMessage('2回目'));
    await waitFor(() => inputs().length >= 3, '人間の入力2');
    s.clone.post(scheduledEvent(2));
    await waitFor(() => inputs().length >= 4, '棚卸し2回目');
    expect(inputs()[3]).toContain(INTRO_FULL);
    expect(inputs()[3]).not.toContain(REF_MARK);
    await s.clone.stop();
  });

  it('⭐ 畳みを渡さない buildDistillPrompt（pre_compact を含む）は、全文のまま変わらない', () => {
    for (const reason of ['conversation_end', 'scheduled', 'pre_compact'] as const) {
      const plain = buildDistillPrompt(reason);
      expect(plain).toContain(INTRO_FULL);
      expect(plain).toContain(CONSOLIDATION_FULL);
      expect(plain).not.toContain(REF_MARK);
      // 畳まない fold（常に全文）は、既定と1文字も違わない
      expect(buildDistillPrompt(reason, { fold: (_id, full) => full })).toBe(plain);
    }
  });

  it('参照へ畳む fold を渡すと、枕と的は残り、本体の2つの塊だけが参照になる', () => {
    const folded = buildDistillPrompt('scheduled', {
      tidyTargets: '的の一覧MARKER',
      fold: (_id, _full, ref) => ref,
    });
    expect(folded).toContain('定期の棚卸しの刻みが来た');
    expect(folded).toContain('的の一覧MARKER');
    expect(folded).not.toContain(INTRO_FULL);
    expect(folded).not.toContain(CONSOLIDATION_FULL);
    expect(folded.match(new RegExp(REF_MARK, 'g'))?.length).toBe(2);
  });
});
