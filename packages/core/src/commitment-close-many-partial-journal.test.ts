import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { chunkIdsByChars } from './chunk-ids.js';
import { CLOSE_MANY_JOURNAL_ID_CHARS } from './commitment-close-many.js';
import type { Commitment } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// 道具 `commitment_close_many` は塊ごとに「閉じる → その塊の id を日誌へ書く」を回す。日誌が塊の途中で落ちたとき、
// 「完了した・やり直さないこと」の定型だけを返すと、残りの塊を閉じていないことも、閉じた id も伝わらない（#5452）。

const SECRET_REASON = 'FAKE-SECRET-CANARY-close-many-reason';
const ID_COUNT = 200;

// n 回目の `journal.append` だけを落とす置き場
function failingJournalAppendAt(failAt: number): Stores {
  const stores = createMemoryStores();
  let calls = 0;
  return {
    ...stores,
    journal: {
      ...stores.journal,
      append: (entry) => {
        calls += 1;
        if (calls === failAt) return Promise.reject(new Error('boom-close-many-journal'));
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

describe('commitment_close_many: 塊の日誌が落ちた回は「途中で止まった」と言う（#5452）', () => {
  it('⭐ 2 塊目の日誌だけが落ちる: 「完了した」と言わず、1 塊目の全 id・2 塊目の id・残りの塊は閉じていないを言う', async () => {
    const stores = failingJournalAppendAt(2);
    const ids = await openMany(stores);
    const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);
    expect(chunks.length, '塊が 3 つに割れる件数').toBe(3);

    const { text, threw } = await call(stores);

    expect(threw).toBe(true);
    expect(text).not.toContain('完了した（');
    expect(text.replace('「完了した」ではない', '')).not.toContain('完了した');
    expect(text).toContain('途中で止まった');
    for (const id of chunks[0] ?? []) expect(text, `1 塊目の id ${id}`).toContain(id);
    for (const id of chunks[1] ?? []) expect(text, `2 塊目の id ${id}`).toContain(id);
    for (const id of chunks[2] ?? []) expect(text, `閉じていない 3 塊目の id`).not.toContain(id);
    expect(text).toContain('残りの 1 塊は閉じていない');
    expect(text).toContain('同じ絞り込みでもう一度呼べば続きを閉じられる');
    expect(text).toContain('journal_write');
    expect(text).toContain('boom-close-many-journal');
    // 鍵や本文（reason）を応答へ出さない
    expect(text).not.toContain(SECRET_REASON);

    // 台帳の事実と応答が一致する: 1・2 塊目は閉じ済み、3 塊目は未了のまま
    const open = new Set((await stores.commitments.list()).entries.map((entry) => entry.id));
    for (const id of [...(chunks[0] ?? []), ...(chunks[1] ?? [])]) expect(open.has(id)).toBe(false);
    for (const id of chunks[2] ?? []) expect(open.has(id)).toBe(true);
  });

  it('1 塊目で落ちる: 閉じた塊（1 塊目）の id と、残りの 2 塊は閉じていないを言う。前の塊の行は出さない', async () => {
    const stores = failingJournalAppendAt(1);
    const ids = await openMany(stores);
    const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);

    const { text, threw } = await call(stores);

    expect(threw).toBe(true);
    expect(text.replace('「完了した」ではない', '')).not.toContain('完了した');
    expect(text).toContain('1/3 塊目');
    for (const id of chunks[0] ?? []) expect(text, `1 塊目の id ${id}`).toContain(id);
    for (const id of chunks[1] ?? []) expect(text).not.toContain(id);
    expect(text).toContain('残りの 2 塊は閉じていない');
    expect(text).not.toContain('前の塊の閉じた id');
    expect(text).toContain('journal_write');
  });

  it('全部成功する回: 応答は従来どおり（「N 件を片付けた」、止まった旨も警告の先頭行も無い）', async () => {
    const stores = createMemoryStores();
    await openMany(stores);

    const { text, threw } = await call(stores);

    expect(threw).toBe(false);
    expect(text).toContain(`**${ID_COUNT} 件を片付けた**`);
    expect(text).toContain(`全 id は日誌に 3 件に分けて残してある`);
    expect(text).not.toContain('⚠⚠');
    expect(text).not.toContain('途中で止まった');
  });
});
