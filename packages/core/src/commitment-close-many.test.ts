import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Commitment, CommitmentOrigin } from './schema.js';
import { commitmentOriginSchema } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { chunkIdsByChars, createCloneTools } from './tools.js';

/**
 * `commitment_close_many`（issue #844）の一括 close を固定する。
 *
 * **実装（`packages/core/src/tools.ts` の `commitment_close_many`）は既に
 * ある。ここは追加ではなく、受け入れ基準そのものを歯として固定するために書く。**
 *
 * ⚠️ **文言ではなく実状態で測る**（PR #826 の教訓）。閉じたかどうかは
 * `stores.commitments` を読み直して測り、日誌の中身は `journal.list({ types:
 * ['decision'] })` から取った実データ（id・件数）で測る。戻り値の文言を見る
 * 必要がある0件の区別だけは「3つの戻り値が互いに異なること」＋「実数が
 * 入っていること」で測る（本文冒頭の依頼どおり）。
 */

/** その `stores` に配線した `commitment_close_many` を呼ぶ関数を返す。 */
function closer(stores: Stores) {
  const tools = createCloneTools({ stores, emit: () => undefined, memoryCause: () => 'clone' });
  const found = tools.find((entry) => entry.name === 'commitment_close_many');
  expect(found, 'commitment_close_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

/** 日誌に積まれた `decision` の本文だけを取り出す。 */
async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

/**
 * 返り値の中から、目印を含む行を**1本だけ**取り出す。
 *
 * **`toContain` は「どこかに在る」しか言わず、「どこに在るか」を言わない。**
 * 同じ出力の別の機構が同じ字面を出していれば、測りたい行が丸ごと消えても
 * 歯は緑のまま当たり続ける（#841 の歯が実際にこれで抜かれた —— 束の本文から
 * 件数を落とす変異を当てても、台帳の断り書きが出していた同じ「N 件」に
 * `toContain` が当たり、赤くなった歯は0本だった）。
 *
 * **目印に当たる行が2本以上あれば、それ自体を赤にする。** 「同じ字面が別の
 * 場所にも在る」状態そのものを、歯が抜かれる前に検出するためである。
 *
 * ⚠️ **行を丸ごと逐語で固定する形は採らない。** ここで守りたいのは「その行が
 * 在ること」と「その行に実数が入っていること」であって、句読点ではない。
 * ⟹ 1段目で**どこに在るか**を固定し、2段目で**何が入っているか**を固定する。
 */
function soleLineWith(reply: string, marker: string): string {
  const lines = reply.split('\n').filter((line) => line.includes(marker));
  expect(lines, `目印「${marker}」を含む行が1本ではない:\n${reply}`).toHaveLength(1);
  return lines[0]!;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** 文字列群から UUID 形式の id を全部拾い集めて集合にする。 */
function idsIn(texts: string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(UUID_RE)) found.add(match[0]);
  }
  return found;
}

const BASE_AT = Date.parse('2026-01-01T00:00:00.000Z');

/** `index` 番目の行を古い順に並ぶ時刻で作る（1秒ずつずらす）。 */
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

  it('8. 0件の3つの区別は互いに異なる文言で、該当する段の実数を含む', async () => {
    // ① 台帳が空。
    const emptyStores = createMemoryStores();
    const textEmpty = await closer(emptyStores)({ origin: ['external'], reason: 'r' });

    // ② origin で0件（他の起点の未了は在る——ここでは human が2件）。
    const originStores = createMemoryStores();
    await openAll(originStores, [entryAt(0, 'human'), entryAt(1, 'human')]);
    const textOriginZero = await closer(originStores)({ origin: ['external'], reason: 'r' });
    expect(soleLineWith(textOriginZero, 'いま未了に在る起点の内訳')).toContain(
      'human 2 / manager 0 / external 0 / self 0',
    );

    // ③ source で0件（origin では当たる——ここでは実在する source が aaa-source）。
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

    // 古い側 (0, 1) だけが閉じている
    expect((await stores.commitments.get(entries[0]!.id))?.closedAt).not.toBeUndefined();
    expect((await stores.commitments.get(entries[1]!.id))?.closedAt).not.toBeUndefined();
    // 残り (2, 3, 4) は無傷
    for (const entry of entries.slice(2)) {
      expect((await stores.commitments.get(entry.id))?.closedAt).toBeUndefined();
    }
    // 残件数 (5 - 2 = 3) が戻り値に出る
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

  /**
   * 🔴 11. 閉じた id が全部日誌に在ること（issue #844 の受け入れ基準そのもの）。
   *
   * 250件を一括で閉じ、日誌の `decision` 全部から正規表現で id を拾い集めた
   * 集合が、実際に閉じた id の集合（＝仕込んだ250件）と完全に一致することを
   * 見る。**日誌が2件以上に分かれていること**（＝実際に割れたこと）と、
   * **各 `decision` の id 列の文字数が予算を大きく超えないこと**（＝1件が
   * 巨大にならない、という性質そのもの）も併せて見る。
   *
   * `CLOSE_MANY_JOURNAL_ID_CHARS` は `tools.ts` の private 定数なので import
   * できない。ここでは値をそのまま書き写す
   * （`grep -Fn -- 'CLOSE_MANY_JOURNAL_ID_CHARS = ' packages/core/src/tools.ts`
   * で値がずれていないことを確認できる。ずれたらこの歯が最初に気づく）。
   */
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

    // 実際に全部閉じたことを store で確かめる。
    const stillOpen = (await stores.commitments.list()).entries;
    expect(stillOpen).toHaveLength(0);

    const texts = await decisionTexts(stores);
    expect(texts.length).toBeGreaterThanOrEqual(2);

    const seen = idsIn(texts);
    expect(seen.size).toBe(allIds.length);
    expect(seen).toEqual(new Set(allIds));

    // 各 decision の id 列は予算 + id 1個分を大きくは超えない。
    for (const text of texts) {
      const idsPart = text.slice(text.indexOf('閉じた id: ') + '閉じた id: '.length);
      expect(idsPart.length).toBeLessThanOrEqual(CLOSE_MANY_JOURNAL_ID_CHARS_COPY + 37);
    }
  });

  it('12. 1件も閉じなかった塊では日誌へ書かない（他の経路が先に閉じていた形を模す）', async () => {
    const stores = createMemoryStores();
    const entries = [entryAt(0, 'external'), entryAt(1, 'external'), entryAt(2, 'external')];
    await openAll(stores, entries);

    // closeMany だけを、常に「誰も閉じられなかった」に置き換える
    // （commitment.test.ts の「close の戻り値が false のとき」と同じ形の競合の模し方）。
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

  /**
   * 🔴 13. 塊の途中で日誌が落ちたとき、throw すること。①最初の塊の id は
   * 日誌に残り ②既に閉じた行は閉じたまま（巻き戻らない）ことを見る。
   *
   * `testing.ts` の `failingJournalAppend` は**全部**落とすので使えない
   * （依頼どおり、ここに専用の包みを書く）。2回目以降の `journal.append` だけを
   * 落とし、1回目（最初の塊の記帳）は通す。
   */
  it('13. 塊の途中で日誌が落ちると throw し、①最初の塊の id は日誌に残り ②途中まで閉じた行は閉じたまま', async () => {
    const stores = createMemoryStores();
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, 'external'));
    await openAll(stores, entries);
    const allIds = entries.map((entry) => entry.id);
    // `chunkIdsByChars` は道具本体が使っているのと同じ export。同じ引数
    // （id の並び・予算）で呼べば、道具の中で実際に切れる境界と一致する。
    const chunks = chunkIdsByChars(allIds, 3_600);
    expect(chunks.length).toBeGreaterThanOrEqual(3); // 3個目が「まだ手を付けていない」ことを見るのに要る

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

    // ① 最初の塊の id は日誌に残る。
    const texts = await decisionTexts(stores);
    expect(texts).toHaveLength(1);
    expect(idsIn(texts)).toEqual(new Set(chunks[0]));

    // ② 巻き戻らない: 1・2番目の塊は closeMany までは進んでいたので閉じたまま。
    for (const id of [...chunks[0]!, ...chunks[1]!]) {
      expect((await stores.commitments.get(id))?.closedAt, id).not.toBeUndefined();
    }
    // 3番目の塊はまだ手を付けていない。
    for (const id of chunks[2]!) {
      expect((await stores.commitments.get(id))?.closedAt, id).toBeUndefined();
    }
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
    // 単独の塊として返る(落とさない代わりに、予算を譲る)。
    expect(chunks[longChunkIndex]).toEqual([tooLong]);

    for (const [index, chunk] of chunks.entries()) {
      if (index === longChunkIndex) continue;
      expect(chunk.join(' ').length).toBeLessThanOrEqual(budget);
    }
    // 全部が元の列に戻ること(順序込み)もここで併せて確認する。
    expect(chunks.flat()).toEqual(ids);
  });

  it('14c. 空配列を渡すと空配列が返る', () => {
    expect(chunkIdsByChars([], 100)).toEqual([]);
  });
});
