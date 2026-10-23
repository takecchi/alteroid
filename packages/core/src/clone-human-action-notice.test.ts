import { describe, expect, it, vi } from 'vitest';

import { setup, waitForDone } from './clone-test-harness.js';
import type { HumanActionKind, JournalEntryInput } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

const HEAD = '人間が自分の手で直したことがある';
const VIA = { kind: 'operator', auth: 'operator-token' } as const;

function humanDecision(
  kind: HumanActionKind,
  target: string,
  decision = `${target} を人間が操作した`,
): JournalEntryInput {
  return { type: 'decision', decision, grounds: 'API', humanAction: { kind, target, via: VIA } };
}

// 1回目のターンでセッションを組ませ、`change` の後の2回目・3回目のターン入力を返す
async function turnInputs(stores: Stores, change: () => Promise<void>): Promise<string[]> {
  const s = setup(undefined, stores);
  s.clone.post(humanMessage('1回目'));
  await waitForDone(s.events);

  await change();

  s.clone.post(humanMessage('2回目'));
  await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= 2);
  s.clone.post(humanMessage('3回目'));
  await s.waitForEvents((events) => events.filter((event) => event.type === 'done').length >= 3);
  const inputs = s.calls[0]?.inputs ?? [];
  await s.clone.stop();
  return inputs;
}

describe('人間が API から直接した操作を、次のターンの入力で名指しする', () => {
  it('⭐ 印のある decision が在ると、種類・対象・経路・decision の抜粋が載る', async () => {
    const stores = createMemoryStores();

    const inputs = await turnInputs(stores, async () => {
      await stores.journal.append(humanDecision('commitment_close', 'c-42', 'c-42 を閉じた'));
      await stores.journal.append(humanDecision('practice_write', 'deploy-flow'));
    });

    expect(inputs[1]).toContain(HEAD);
    expect(inputs[1]).toContain(
      '台帳の行を閉じた: c-42（c-42 を閉じた） 経路: operator（operator token）',
    );
    expect(inputs[1]).toContain('やり方を書き直した: deploy-flow');
    expect(inputs[1]).toContain('経路は監査の記録であって、人間がした証拠ではない');
    expect(inputs[1]).toContain('2回目');
  });

  it('印の無い decision（クローン自身の判断）だけなら載らない', async () => {
    const stores = createMemoryStores();

    const inputs = await turnInputs(stores, async () => {
      await stores.journal.append({ type: 'decision', decision: '自分で決めた', grounds: '記憶' });
    });

    expect(inputs[1]).not.toContain(HEAD);
    expect(inputs[1]).toContain('2回目');
  });

  it('前回載せた時刻より前の行は載らない', async () => {
    const stores = createMemoryStores();
    // 時計だけを偽にする（タイマーは本物のまま）: 実時間の待ちでミリ秒をずらすと、遅い環境で同じミリ秒に落ちうるため
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
      await stores.journal.append(humanDecision('schedule_remove', 'sched-old'));
      vi.setSystemTime(new Date('2026-10-21T00:01:00.000Z'));

      const inputs = await turnInputs(stores, async () => undefined);

      expect(inputs[1]).not.toContain(HEAD);
      expect(inputs[1]).not.toContain('sched-old');
    } finally {
      vi.useRealTimers();
    }
  });

  it('載せた後のターンでは、同じ行を二度載せない', async () => {
    const stores = createMemoryStores();

    const inputs = await turnInputs(stores, async () => {
      await stores.journal.append(humanDecision('practice_remove', 'old-way'));
    });

    expect(inputs[1]).toContain('やり方を消した: old-way');
    expect(inputs[2]).not.toContain(HEAD);
    expect(inputs[2]).not.toContain('old-way');
  });

  it('上限を超えたら残りの件数を言う（窓がいっぱいでなければ「窓の外」とは言わない）', async () => {
    const stores = createMemoryStores();

    const inputs = await turnInputs(stores, async () => {
      for (let i = 0; i < 23; i += 1) {
        await stores.journal.append(humanDecision('commitment_reopen', `c-${i}`));
      }
    });

    expect(inputs[1]).toContain('ほか 3 件');
    expect(inputs[1]).toContain('c-22');
    expect(inputs[1]).not.toContain('台帳の行を開き直した: c-0（');
    expect(inputs[1]).not.toContain('窓の外にもあるかもしれない');
  });

  it('引いた行が窓ちょうどなら、「これで全部」と言わず窓の外を断る', async () => {
    const stores = createMemoryStores();

    const inputs = await turnInputs(stores, async () => {
      for (let i = 0; i < 200; i += 1) {
        await stores.journal.append(humanDecision('manager_message', `job-${i}`));
      }
    });

    expect(inputs[1]).toContain('窓の外にもあるかもしれない');
    expect(inputs[1]).toContain('これで全部とは限らない');
  });

  it('日誌の読み出しが投げても、ターンは進み、節は出ない', async () => {
    const stores = createMemoryStores();
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        list: (query) =>
          query?.types?.length === 1 && query.types[0] === 'decision'
            ? Promise.reject(new Error('日誌が読めない'))
            : stores.journal.list(query),
      },
    };

    const inputs = await turnInputs(failing, async () => {
      await stores.journal.append(humanDecision('commitment_close', 'c-1'));
    });

    expect(inputs[1]).toContain('2回目');
    expect(inputs[1]).not.toContain(HEAD);
  });
});
