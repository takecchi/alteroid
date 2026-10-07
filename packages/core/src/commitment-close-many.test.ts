import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Commitment, CommitmentOrigin } from './schema.js';
import { commitmentOriginSchema } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLOSE_MANY_JOURNAL_ID_CHARS, chunkIdsByChars, createCloneTools } from './tools.js';

function closer(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'commitment_close_many');
  expect(found, 'commitment_close_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

// toContain で済ませない: 別の機構が同じ字面を出していると、測りたい行が消えても緑のまま当たり続けるため。行を丸ごと逐語で固定しない: 守りたいのは行の在処と実数で、句読点ではないため
function soleLineWith(reply: string, marker: string): string {
  const lines = reply.split('\n').filter((line) => line.includes(marker));
  expect(lines, `目印「${marker}」を含む行が1本ではない:\n${reply}`).toHaveLength(1);
  return lines[0]!;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function idsIn(texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(UUID_RE)) found.add(match[0]);
  }
  return found;
}

const BASE_AT = Date.parse('2026-01-01T00:00:00.000Z');

function entryAt(
  index: number,
  origin: CommitmentOrigin,
  overrides: Partial<Commitment> = {},
): Commitment {
  return {
    id: randomUUID(),
    at: new Date(BASE_AT + index * 1000).toISOString(),
    origin,
    body: `仕事 ${index}`,
    ...overrides,
  };
}

async function openAll(stores: Stores, entries: readonly Commitment[]): Promise<void> {
  for (const entry of entries) await stores.commitments.open(entry);
}

describe('commitment_close_many（絞り込みでの一括 close。issue #844）', () => {
  it('1. origin に4値全部を並べた呼びは断り、未了は1件も変わらない', async () => {
    const stores = createMemoryStores();
    const entries = [
      entryAt(0, 'human'),
      entryAt(1, 'manager', { source: 'mgr-1' }),
      entryAt(2, 'external', { source: 'github' }),
      entryAt(3, 'self'),
    ];
    await openAll(stores, entries);

    const reply = await closer(stores)({
      origin: commitmentOriginSchema.options,
      reason: '全部片付けたつもりだった',
      dryRun: false,
    });

    expect(reply.length).toBeGreaterThan(0);
    const open = (await stores.commitments.list()).entries;
    expect(open).toHaveLength(4);
    expect(open.every((entry) => entry.closedAt === undefined)).toBe(true);
  });

  it('2. dryRun を省いた呼びは、当たる行があっても1件も閉じない', async () => {
    const stores = createMemoryStores();
    const entry = entryAt(0, 'external');
    await stores.commitments.open(entry);

    await closer(stores)({ origin: ['external'], reason: '試算のつもり' });

    expect((await stores.commitments.get(entry.id))?.closedAt).toBeUndefined();
  });

  it('3. dryRun: false は当たった行だけを閉じ、他 origin は無傷。closedReason/closedBy が入る', async () => {
    const stores = createMemoryStores();
    const target = entryAt(0, 'external');
    const other = entryAt(1, 'human');
    await openAll(stores, [target, other]);

    await closer(stores)({
      origin: ['external'],
      reason: '確認して片付けた',
      dryRun: false,
    });

    const closed = await stores.commitments.get(target.id);
    expect(closed?.closedAt).not.toBeUndefined();
    expect(closed?.closedReason).toBe('確認して片付けた');
    expect(closed?.closedBy).toBe('clone');

    const untouched = await stores.commitments.get(other.id);
    expect(untouched?.closedAt).toBeUndefined();
  });

  it('4. source は完全一致——別の source を巻き込まない', async () => {
    const stores = createMemoryStores();
    const exact = entryAt(0, 'external', { source: 'token-pool' });
    const near = entryAt(1, 'external', { source: 'token-pool-2' });
    await openAll(stores, [exact, near]);

    await closer(stores)({
      origin: ['external'],
      source: ['token-pool'],
      reason: 'トークンプールの件',
      dryRun: false,
    });

    expect((await stores.commitments.get(exact.id))?.closedAt).not.toBeUndefined();
    expect((await stores.commitments.get(near.id))?.closedAt).toBeUndefined();
  });

  it('5. q は body/source の両方に大小無視の部分一致で当たる', async () => {
    const stores = createMemoryStores();
    const hitsBody = entryAt(0, 'external', { body: 'これは NeeDLE-mixed-case を含む依頼' });
    const hitsSource = entryAt(1, 'external', { body: '無関係な本文', source: 'needle-in-source' });
    const missesBoth = entryAt(2, 'external', { body: '無関係な本文', source: 'unrelated-source' });
    await openAll(stores, [hitsBody, hitsSource, missesBoth]);

    await closer(stores)({
      origin: ['external'],
      q: 'NeEdLe',
      reason: 'q で絞った',
      dryRun: false,
    });

    expect((await stores.commitments.get(hitsBody.id))?.closedAt).not.toBeUndefined();
    expect((await stores.commitments.get(hitsSource.id))?.closedAt).not.toBeUndefined();
    expect((await stores.commitments.get(missesBoth.id))?.closedAt).toBeUndefined();
  });

  it('6. until は「その瞬間ちょうど」を含み、それより後は含まない', async () => {
    const stores = createMemoryStores();
    const boundary = '2026-02-01T00:00:00.000Z';
    const atBoundary = entryAt(0, 'external', { at: boundary });
    const afterBoundary = entryAt(1, 'external', { at: '2026-02-01T00:00:00.001Z' });
    await openAll(stores, [atBoundary, afterBoundary]);

    await closer(stores)({
      origin: ['external'],
      until: boundary,
      reason: 'until で絞った',
      dryRun: false,
    });

    expect((await stores.commitments.get(atBoundary.id))?.closedAt).not.toBeUndefined();
    expect((await stores.commitments.get(afterBoundary.id))?.closedAt).toBeUndefined();
  });

  it('7. until が ISO8601 として読めない呼びは、当たる行があっても1件も閉じない', async () => {
    const stores = createMemoryStores();
    const entry = entryAt(0, 'external');
    await stores.commitments.open(entry);

    await closer(stores)({
      origin: ['external'],
      until: 'きのう',
      reason: '読めない until',
      dryRun: false,
    });

    expect((await stores.commitments.get(entry.id))?.closedAt).toBeUndefined();
  });

  describe.each([
    { label: '秒あり', until: '2026-02-01T00:00:00.000Z', closes: true },
    { label: '秒なし（Z）', until: '2026-02-01T00:00Z', closes: true },
    { label: '秒なし（+09:00）', until: '2026-02-01T09:00+09:00', closes: true },
    { label: '壊れた値', until: '2026-02-01T25:99Z', closes: false },
  ])('7b. until の書き方: $label', ({ until, closes }) => {
    it(closes ? '境界ちょうどの行まで閉じ、1ms 後の行は閉じない' : '1件も閉じない', async () => {
      const stores = createMemoryStores();
      const atBoundary = entryAt(0, 'external', { at: '2026-02-01T00:00:00.000Z' });
      const afterBoundary = entryAt(1, 'external', { at: '2026-02-01T00:00:00.001Z' });
      await openAll(stores, [atBoundary, afterBoundary]);

      const reply = await closer(stores)({
        origin: ['external'],
        until,
        reason: 'until の書き方',
        dryRun: false,
      });

      expect(reply.includes(`until に渡された「${until}」は日時として読めない`)).toBe(!closes);

      expect((await stores.commitments.get(atBoundary.id))?.closedAt !== undefined).toBe(closes);
      expect((await stores.commitments.get(afterBoundary.id))?.closedAt).toBeUndefined();
    });
  });

  describe.each([
    '2026-02-01T00:00',
    '2026-02-01T00:00:00',
    '2026/02/01',
    'Feb 1 2026',
    '2026-02-01',
  ])('7c. 時差の無い until: %s', (until) => {
    it('断り、当たる行があっても1件も閉じない', async () => {
      const stores = createMemoryStores();
      const entry = entryAt(0, 'external', { at: '2026-01-01T00:00:00.000Z' });
      await openAll(stores, [entry]);

      const reply = await closer(stores)({
        origin: ['external'],
        until,
        reason: '時差の無い until',
        dryRun: false,
      });

      expect(reply).toContain(`until に渡された「${until}」`);
      expect(reply).toContain('時差');
      expect((await stores.commitments.get(entry.id))?.closedAt).toBeUndefined();
    });
  });

  it('7d. 時差の付いた until（小数秒・-05:00 を含む）は通る', async () => {
    for (const until of ['2026-02-01T00:00:00.123+09:00', '2026-01-31T19:00-05:00']) {
      const stores = createMemoryStores();
      const entry = entryAt(0, 'external', { at: '2026-01-01T00:00:00.000Z' });
      await openAll(stores, [entry]);

      await closer(stores)({
        origin: ['external'],
        until,
        reason: '時差の付いた until',
        dryRun: false,
      });

      expect((await stores.commitments.get(entry.id))?.closedAt, until).not.toBeUndefined();
    }
  });

  it('8. 0件の3つの区別は互いに異なる文言で、該当する段の実数を含む', async () => {
    const emptyStores = createMemoryStores();
    const textEmpty = await closer(emptyStores)({ origin: ['external'], reason: 'r' });

    const originStores = createMemoryStores();
    await openAll(originStores, [entryAt(0, 'human'), entryAt(1, 'human')]);
    const textOriginZero = await closer(originStores)({ origin: ['external'], reason: 'r' });
    expect(soleLineWith(textOriginZero, 'いま未了に在る起点の内訳')).toContain(
      'human 2 / manager 0 / external 0 / self 0',
    );

    const sourceStores = createMemoryStores();
    await openAll(sourceStores, [
      entryAt(0, 'external', { source: 'aaa-source' }),
      entryAt(1, 'external', { source: 'aaa-source' }),
    ]);
    const textSourceZero = await closer(sourceStores)({
      origin: ['external'],
      source: ['bbb-nomatch'],
      reason: 'r',
    });
    expect(soleLineWith(textSourceZero, '実在する source（多い順）')).toContain('aaa-source 2');

    const distinct = new Set([textEmpty, textOriginZero, textSourceZero]);
    expect(distinct.size, [textEmpty, textOriginZero, textSourceZero].join('\n---\n')).toBe(3);
  });

  it('9. limit は古い側から limit 件だけを閉じ、残りは残す。戻り値に残件数が出る', async () => {
    const stores = createMemoryStores();
    const entries = [0, 1, 2, 3, 4].map((i) => entryAt(i, 'external'));
    await openAll(stores, entries);

    const reply = await closer(stores)({
      origin: ['external'],
      limit: 2,
      reason: '上限を試す',
      dryRun: false,
    });

    expect((await stores.commitments.get(entries[0]!.id))?.closedAt).not.toBeUndefined();
    expect((await stores.commitments.get(entries[1]!.id))?.closedAt).not.toBeUndefined();
    for (const entry of entries.slice(2)) {
      expect((await stores.commitments.get(entry.id))?.closedAt).toBeUndefined();
    }
    expect(soleLineWith(reply, '1回の上限')).toContain('残り 3 件');
  });

  it('10. 既に閉じている行は当たらず、二度と閉じられない（元の closedReason/closedBy も無傷）', async () => {
    const stores = createMemoryStores();
    const entry = entryAt(0, 'external');
    await stores.commitments.open(entry);
    await stores.commitments.close(entry.id, new Date().toISOString(), '先に閉じた', 'human');

    await closer(stores)({
      origin: ['external'],
      reason: '後からもう一度閉じようとした',
      dryRun: false,
    });

    const after = await stores.commitments.get(entry.id);
    expect(after?.closedReason).toBe('先に閉じた');
    expect(after?.closedBy).toBe('human');
  });

  it('11. 250件を一括で閉じると、閉じた id が全部・過不足なく日誌に残る（2件以上に分割）', async () => {
    const CLOSE_MANY_JOURNAL_ID_CHARS_COPY = 3_600;
    const stores = createMemoryStores();
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, 'external'));
    await openAll(stores, entries);
    const allIds = entries.map((entry) => entry.id);

    await closer(stores)({
      origin: ['external'],
      reason: '250件を一括で片付けた',
      dryRun: false,
    });

    const stillOpen = (await stores.commitments.list()).entries;
    expect(stillOpen).toHaveLength(0);

    const texts = await decisionTexts(stores);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    const seen = idsIn(texts);
    expect(seen.size).toBe(allIds.length);
    expect(seen).toEqual(new Set(allIds));

    for (const text of texts) {
      // 切り出す前に目印の在ることを確かめる: 目印が消えると slice が id 列でないものを切り出し、下の長さの上限が緑のまま残るため
      expect(text).toContain('閉じた id: ');
      const idsPart = text.slice(text.indexOf('閉じた id: ') + '閉じた id: '.length);
      expect(idsPart.length).toBeLessThanOrEqual(CLOSE_MANY_JOURNAL_ID_CHARS_COPY + 37);
    }
  });

  it('12. 1件も閉じなかった塊では日誌へ書かない（他の経路が先に閉じていた形を模す）', async () => {
    const stores = createMemoryStores();
    const entries = [entryAt(0, 'external'), entryAt(1, 'external'), entryAt(2, 'external')];
    await openAll(stores, entries);

    const raced: Stores = {
      ...stores,
      commitments: {
        ...stores.commitments,
        closeMany: () => Promise.resolve([]),
      },
    };

    await closer(raced)({
      origin: ['external'],
      reason: '閉じたつもりだった',
      dryRun: false,
    });

    expect(await decisionTexts(stores)).toEqual([]);
  });

  // failingJournalAppend を使わない: 全部落とすので、2回目以降の journal.append だけを落とす専用の包みを書く
  it('13. 塊の途中で日誌が落ちると throw し、①最初の塊の id は日誌に残り ②途中まで閉じた行は閉じたまま', async () => {
    const stores = createMemoryStores();
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, 'external'));
    await openAll(stores, entries);
    const allIds = entries.map((entry) => entry.id);
    const chunks = chunkIdsByChars(allIds, 3_600);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    let calls = 0;
    const flaky: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: (entry) => {
          calls += 1;
          if (calls >= 2) return Promise.reject(new Error('日誌が落ちた（テスト用）'));
          return stores.journal.append(entry);
        },
      },
    };

    await expect(
      closer(flaky)({ origin: ['external'], reason: '途中で落ちた', dryRun: false }),
    ).rejects.toThrow();

    const texts = await decisionTexts(stores);
    expect(texts).toHaveLength(1);
    expect(idsIn(texts)).toEqual(new Set(chunks[0]));

    for (const id of [...chunks[0]!, ...chunks[1]!]) {
      expect((await stores.commitments.get(id))?.closedAt, id).not.toBeUndefined();
    }
    for (const id of chunks[2]!) {
      expect((await stores.commitments.get(id))?.closedAt, id).toBeUndefined();
    }
  });
});

// 予算の定数を手で書き写さない: 写しは本物の CLOSE_MANY_JOURNAL_ID_CHARS が変わっても追随せず、実装が1塊しか作らなくても期待値と偶然一致して緑になるため
describe('commitment_close_many の応答が言う「日誌に N 件」は、実際に書いた件数である', () => {
  it('2つ目以降の塊が丸ごと競合になっても、応答の N は日誌の行の数と一致する', async () => {
    const stores = createMemoryStores();
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, 'external'));
    await openAll(stores, entries);
    const allIds = entries.map((entry) => entry.id);
    const chunksExpected = chunkIdsByChars(allIds, CLOSE_MANY_JOURNAL_ID_CHARS);
    expect(chunksExpected.length).toBeGreaterThanOrEqual(2);

    // フェイクの戻り値を手で組み立てない: 本物の closeMany を先打ちして競合を作る
    const originalCloseMany = stores.commitments.closeMany.bind(stores.commitments);
    let calls = 0;
    stores.commitments.closeMany = async (ids, at, reason, by) => {
      calls += 1;
      if (calls > 1) {
        await originalCloseMany(ids, at, '別経路が先に閉じた', 'human');
      }
      return originalCloseMany(ids, at, reason, by);
    };

    const reply = await closer(stores)({
      origin: ['external'],
      reason: '250件を一括で片付けた',
      dryRun: false,
    });

    expect(
      calls,
      'closeMany が2回以上呼ばれていない＝道具は実際には複数の塊に割っていない' +
        '（この前提が崩れると、下のアサーションは競合が1回も起きなくても緑になりうる）',
    ).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(chunksExpected.length);

    const claimed = /全 id は日誌に (\d+) 件に分けて残してある/.exec(reply);
    expect(claimed, '省略の断り書きが出ていない（20件を超えて閉じていない）').not.toBeNull();
    const chunkEntries = (await decisionTexts(stores)).filter((text) => text.includes('塊目'));
    expect(chunkEntries.length).toBeGreaterThan(0);
    expect(chunkEntries.length).toBeLessThan(calls);
    expect(Number(claimed?.[1])).toBe(chunkEntries.length);
  });
});

describe('chunkIdsByChars（id の列を文字数の予算で塊に割る）', () => {
  it('14a. 塊を全部つなげると元の列に戻る（1つも落とさない・順序も保つ）', () => {
    const ids = Array.from({ length: 40 }, () => randomUUID());
    const chunks = chunkIdsByChars(ids, 100);
    expect(chunks.flat()).toEqual(ids);
  });

  it("14b. 各塊の join(' ') の長さは予算を超えない。ただし1つで予算を超える id は単独の塊として返る", () => {
    const normal = Array.from({ length: 10 }, () => randomUUID());
    const tooLong = 'x'.repeat(200);
    const ids = [...normal.slice(0, 5), tooLong, ...normal.slice(5)];
    const budget = 100;
    const chunks = chunkIdsByChars(ids, budget);

    const longChunkIndex = chunks.findIndex((chunk) => chunk.includes(tooLong));
    expect(longChunkIndex).toBeGreaterThanOrEqual(0);
    expect(chunks[longChunkIndex]).toEqual([tooLong]);

    for (const [index, chunk] of chunks.entries()) {
      if (index === longChunkIndex) continue;
      expect(chunk.join(' ').length).toBeLessThanOrEqual(budget);
    }
    expect(chunks.flat()).toEqual(ids);
  });

  it('14c. 空配列を渡すと空配列が返る', () => {
    expect(chunkIdsByChars([], 100)).toEqual([]);
  });

  it('14d. 境界: 塊の合計（区切り込み）がちょうど予算に一致するとき、分割しない', () => {
    const a = 'a'.repeat(10);
    const b = 'b'.repeat(9);
    const budget = 20;
    expect(chunkIdsByChars([a, b], budget).length).toBe(1);
    expect(chunkIdsByChars([a, b], budget)).toEqual([[a, b]]);

    const bPlusOne = 'b'.repeat(10);
    const split = chunkIdsByChars([a, bPlusOne], budget);
    expect(split.length).toBe(2);
    expect(split).toEqual([[a], [bPlusOne]]);
  });

  it('14e. 境界: 予算超えの id が先頭・末尾に在っても単独の塊になり、空の塊は生まれない', () => {
    const tooLong = 'x'.repeat(50);
    const budget = 10;

    const headChunks = chunkIdsByChars([tooLong, 'a', 'b'], budget);
    expect(headChunks[0]).toEqual([tooLong]);
    expect(headChunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(headChunks.flat()).toEqual([tooLong, 'a', 'b']);

    const tailChunks = chunkIdsByChars(['a', 'b', tooLong], budget);
    expect(tailChunks.at(-1)).toEqual([tooLong]);
    expect(tailChunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(tailChunks.flat()).toEqual(['a', 'b', tooLong]);

    const allTooLong = chunkIdsByChars([tooLong, tooLong], budget);
    expect(allTooLong).toEqual([[tooLong], [tooLong]]);
  });

  it('14f. 区切りは1文字ぶんとして数えている（chunkIdsByChars 内部の前提）', () => {
    const ids = ['aa', 'bb', 'cc'];
    const budget = 8;
    const chunks = chunkIdsByChars(ids, budget);
    expect(chunks).toEqual([ids]);
    expect(chunks[0]!.join(' ').length).toBe(budget);

    const chunksMinusOne = chunkIdsByChars(ids, budget - 1);
    expect(chunksMinusOne.length).toBeGreaterThan(1);
  });
});
