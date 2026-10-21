import { describe, expect, it, vi } from 'vitest';

import { setup, waitForDone } from './clone-test-harness.js';
import type { JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

const NOTES_OLD = '## notes見出し\n旧い本文。';
const NOTES_NEW = '## notes見出し\n新しい本文。';
const HUMAN_LINE = '人間が書き換えた記憶: ';
const UNTRACED_LINE = '日誌に書き手が残っていない変更: ';

function memoryUpdate(
  cause: 'distill' | 'clone' | 'human',
  action: 'write' | 'write_failed' = 'write',
): JournalEntryInput {
  return { type: 'memory_update', slug: 'notes', cause, action, summary: 'notes を書いた' };
}

// 1回目のターンでセッションを組ませ、`change` の後の2回目のターン入力を返す
async function secondTurnInput(stores: Stores, change: () => Promise<void>): Promise<string> {
  const s = setup(undefined, stores);
  s.clone.post(humanMessage('1回目'));
  await waitForDone(s.events);

  await change();

  s.clone.post(humanMessage('2回目'));
  await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= 2);
  const input = s.calls[0]?.inputs[1] ?? '';
  await s.clone.stop();
  return input;
}

describe('記憶の差分に、誰が書き換えたかを添える', () => {
  it('⭐ 人間が記憶を書き換えたら、次のターン入力に「人間が書き換えた記憶: <slug>」が載る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', NOTES_OLD);

    const input = await secondTurnInput(stores, async () => {
      await stores.persona.write('notes', NOTES_NEW);
      await stores.journal.append(memoryUpdate('human'));
    });

    expect(input).toContain(`${HUMAN_LINE}notes`);
    expect(input).not.toContain(UNTRACED_LINE);
  });

  it('クローン自身の更新だけなら、人間の行も書き手不明の行も載らない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', NOTES_OLD);

    const input = await secondTurnInput(stores, async () => {
      await stores.persona.write('notes', NOTES_NEW);
      await stores.journal.append(memoryUpdate('clone'));
    });

    expect(input).toContain('## notes見出し');
    expect(input).not.toContain(HUMAN_LINE);
    expect(input).not.toContain(UNTRACED_LINE);
  });

  it('日誌に行が無い変更（ストアだけの書き換え）は「日誌に書き手が残っていない変更」に載る', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', NOTES_OLD);

    const input = await secondTurnInput(stores, async () => {
      await stores.persona.write('notes', NOTES_NEW);
    });

    expect(input).toContain(`${UNTRACED_LINE}notes`);
    expect(input).not.toContain(HUMAN_LINE);
  });

  it('前回載せた時刻より前の人間の行は数えない（古い書き込みで今回の変更を人間のものと名乗らない）', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', NOTES_OLD);
    // 時計だけを偽にする（タイマーは本物のまま）: 実時間の待ちでミリ秒をずらすと、遅い環境で同じミリ秒に落ちうるため
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
      await stores.journal.append(memoryUpdate('human'));
      vi.setSystemTime(new Date('2026-10-21T00:01:00.000Z'));

      const input = await secondTurnInput(stores, async () => {
        await stores.persona.write('notes', NOTES_NEW);
      });

      expect(input).not.toContain(HUMAN_LINE);
      expect(input).toContain(`${UNTRACED_LINE}notes`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('人間の書き込みが write_failed で打ち消されていれば、人間のものとして名指さない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', NOTES_OLD);

    const input = await secondTurnInput(stores, async () => {
      await stores.persona.write('notes', NOTES_NEW);
      await stores.journal.append(memoryUpdate('human', 'write_failed'));
    });

    expect(input).not.toContain(HUMAN_LINE);
  });

  it('日誌の読み出しが投げても、ターンは進み、帰属の行は出ない', async () => {
    const stores = createMemoryStores();
    await stores.persona.write('notes', NOTES_OLD);
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: (query) =>
          query?.types?.length === 1 && query.types[0] === 'memory_update'
            ? Promise.reject(new Error('日誌が読めない'))
            : stores.journal.list(query),
      },
    };

    const input = await secondTurnInput(failing, async () => {
      await stores.persona.write('notes', NOTES_NEW);
      await stores.journal.append(memoryUpdate('human'));
    });

    expect(input).toContain('## notes見出し');
    expect(input).toContain('2回目');
    expect(input).not.toContain(HUMAN_LINE);
    expect(input).not.toContain(UNTRACED_LINE);
  });
});
