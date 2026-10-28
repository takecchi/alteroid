import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { chunkIdsByChars } from './chunk-ids.js';
import { CLOSE_MANY_JOURNAL_ID_CHARS } from './commitment-close-many.js';
import type { Commitment } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 道具 `commitment_close_many` は塊ごとに「閉じる → その塊の id を日誌へ書く」を回す。
// 2 塊目以降で台帳の書き込み（`commitments.closeMany`）自体が投げたとき、閉じた id も「ここで止まった」も伝わらなかった（#5454）。

const SECRET_REASON = 'FAKE-SECRET-CANARY-close-many-closefail';
const ID_COUNT = 200;

interface Faults {
  /** n 回目の `commitments.closeMany` を投げさせる */
  closeFailAt?: number;
  /** n 回目の `journal.append` を落とす */
  journalFailAt?: number;
  /** n 回目の `closeMany` の直前に、その塊の先頭の 1 件を他の経路が先に閉じた形にする（競合） */
  raceAtCall?: number;
}

function faultyStores(faults: Faults): Stores {
  const stores = createMemoryStores();
  let closeCalls = 0;
  let journalCalls = 0;
  return {
    ...stores,
    commitments: {
      ...stores.commitments,
      closeMany: async (ids, at, reason, by) => {
        closeCalls += 1;
        if (closeCalls === faults.closeFailAt) throw new Error('boom-close-many-ledger');
        const first = ids[0];
        if (faults.raceAtCall === closeCalls && first !== undefined) {
          await stores.commitments.close(first, at, '他の経路が先に閉じた', by);
        }
        return stores.commitments.closeMany(ids, at, reason, by);
      },
    },
    journal: {
      ...stores.journal,
      append: (entry) => {
        journalCalls += 1;
        if (journalCalls === faults.journalFailAt) {
          return Promise.reject(new Error('boom-close-many-journal'));
        }
        return stores.journal.append(entry);
      },
    },
  };
}

const external = (index: number): Commitment => ({
  id: randomUUID(),
  at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString(),
  origin: 'external',
  body: `仕事 ${index}`,
});

async function openMany(stores: Stores): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < ID_COUNT; index += 1) {
    const entry = external(index);
    await stores.commitments.open(entry);
    ids.push(entry.id);
  }
  return ids;
}

async function call(stores: Stores): Promise<{ text: string; threw: boolean }> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'commitment_close_many');
  expect(found, 'commitment_close_many という道具が無い').toBeDefined();
  try {
    const result = await found?.handler(
      { origin: ['external'], reason: SECRET_REASON, dryRun: false, limit: ID_COUNT } as never,
      {} as never,
    );
    const text = (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text, threw: false };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true };
  }
}

const openIds = async (stores: Stores): Promise<Set<string>> =>
  new Set((await stores.commitments.list()).entries.map((entry) => entry.id));

describe('commitment_close_many: 塊の台帳の書き込みが投げた回は「途中で止まった」と言う（#5454）', () => {
  it('⭐ 2 塊目の closeMany だけが投げる: 1 塊目の全 id・「この塊以降は閉じていない」・再呼びで続きを閉じられる。「全件閉じた」と言わない', async () => {
    const stores = faultyStores({ closeFailAt: 2 });
    const ids = await openMany(stores);
    const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);
    expect(chunks.length, '塊が 3 つに割れる件数').toBe(3);

    const { text, threw } = await call(stores);

    expect(threw).toBe(true);
    expect(text.split('\n')[0]).toBe(
      '⚠⚠ 一括は途中で止まった・この塊の台帳の書き込みが失敗した・この塊以降は閉じていない',
    );
    expect(text.replace('「完了した」ではない', '')).not.toContain('完了した');
    expect(text).not.toContain('片付けた');
    expect(text).toContain('2/3 塊目の台帳の書き込みが失敗した（この塊は閉じていない）');
    for (const id of chunks[0] ?? []) expect(text, `1 塊目の id ${id}`).toContain(id);
    for (const id of [...(chunks[1] ?? []), ...(chunks[2] ?? [])]) {
      expect(text, '閉じていない塊の id').not.toContain(id);
    }
    expect(text).toContain(
      `ここまでに閉じた id は ${chunks[0]?.length} 件（前の塊の分。日誌に記録済み）`,
    );
    expect(text).toContain('この塊以降の 2 塊は閉じていない');
    expect(text).toContain('同じ絞り込みでもう一度呼べば続きを閉じられる');
    expect(text).toContain('boom-close-many-ledger');
    expect(text).not.toContain(SECRET_REASON);
    expect(text).not.toContain('閉じられなかった（この呼びの最中に');

    const open = await openIds(stores);
    for (const id of chunks[0] ?? []) expect(open.has(id)).toBe(false);
    for (const id of [...(chunks[1] ?? []), ...(chunks[2] ?? [])]) expect(open.has(id)).toBe(true);
    // 日誌には 1 塊目の行だけが在る（応答の「記録済み」と一致する）
    expect(await stores.journal.list({})).toHaveLength(1);
  });

  it('1 塊目で投げる: 閉じた id は 0 件、3 塊すべて閉じていない', async () => {
    const stores = faultyStores({ closeFailAt: 1 });
    const ids = await openMany(stores);

    const { text, threw } = await call(stores);

    expect(threw).toBe(true);
    expect(text).toContain('1/3 塊目の台帳の書き込みが失敗した（この塊は閉じていない）');
    expect(text).toContain(
      'ここまでに閉じた id は 0 件（1 塊目で失敗したので、1件も閉じていない）',
    );
    expect(text).toContain('この塊以降の 3 塊は閉じていない');
    expect(text).not.toContain('前の塊の閉じた id');
    expect(text.replace('「完了した」ではない', '')).not.toContain('完了した');
    expect(await openIds(stores)).toEqual(new Set(ids));
  });

  it('競合の数え方（台帳が投げた回）: 処理した塊だけで数え、まだ処理していない塊は混ぜない', async () => {
    // 3 塊目で投げ、1 塊目の 1 件は他の経路が先に閉じていた: 処理済みは 1・2 塊目、競合は 1 件だけ
    const stores = faultyStores({ closeFailAt: 3, raceAtCall: 1 });
    const ids = await openMany(stores);
    const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);
    const processed = (chunks[0]?.length ?? 0) + (chunks[1]?.length ?? 0);

    const { text } = await call(stores);

    expect(text).toContain(`ここまでに処理した ${processed} 件のうち 1 件は閉じられなかった`);
    // 対象の総数との差（3 塊目の分を含む）で数えた値は出さない
    expect(text).not.toContain(`ここまでに処理した ${ID_COUNT} 件`);
    expect(text).not.toContain(`のうち ${1 + (chunks[2]?.length ?? 0)} 件は閉じられなかった`);
    expect(text).toContain(`ここまでに閉じた id は ${processed - 1} 件`);
  });

  it('競合の数え方（日誌が落ちた回・途中で止まった側）: 処理した塊だけで数える', async () => {
    // 2 塊目の日誌が落ち、2 塊目の 1 件は他の経路が先に閉じていた。3 塊目はまだ処理していない
    const stores = faultyStores({ journalFailAt: 2, raceAtCall: 2 });
    const ids = await openMany(stores);
    const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);
    const processed = (chunks[0]?.length ?? 0) + (chunks[1]?.length ?? 0);

    const { text, threw } = await call(stores);

    expect(threw).toBe(true);
    expect(text).toContain('一括は途中で止まった');
    expect(text).toContain(`ここまでに処理した ${processed} 件のうち 1 件は閉じられなかった`);
    expect(text).not.toContain(`のうち ${1 + (chunks[2]?.length ?? 0)} 件は閉じられなかった`);
    expect(text).toContain(`ここまでに閉じた id は ${processed - 1} 件`);
  });

  it('競合が無い途中で止まった回は、競合の行を出さない', async () => {
    const stores = faultyStores({ journalFailAt: 2 });
    await openMany(stores);

    const { text } = await call(stores);

    expect(text).toContain('一括は途中で止まった');
    expect(text).not.toContain('閉じられなかった');
  });
});
