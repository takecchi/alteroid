import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Commitment, CommitmentOrigin } from './schema.js';
import { commitmentOriginSchema } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { CLOSE_MANY_JOURNAL_ID_CHARS, chunkIdsByChars, createCloneTools } from './tools.js';

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

  // **until の書き方の揺れで断らない**（PR #1561 で zod 4.6 が秒を省いた形を
  // 落とすようになったのを受けて、読み方を日誌の since / until と同じ `Date.parse`
  // に揃えた）。秒あり・秒なし（Z / +09:00）は同じ瞬間として読んで境界の行まで
  // 閉じ、1ms 後の行は閉じない。壊れた値は1件も閉じない。
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

      // 断ったことは戻り値でも見る——検査を消しても `Date.parse` が NaN を返して
      // 何も当たらないので、閉じた件数だけでは「断った」と「0件だった」を区別できない。
      expect(reply.includes(`until に渡された「${until}」は ISO8601 として読めない`)).toBe(!closes);

      expect((await stores.commitments.get(atBoundary.id))?.closedAt !== undefined).toBe(closes);
      expect((await stores.commitments.get(afterBoundary.id))?.closedAt).toBeUndefined();
    });
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

/**
 * **応答の「全 id は日誌に N 件に分けて残してある」の N は、実際に書いた日誌の行の数で言う。**
 * 1件も閉じられなかった塊は日誌に書かない（上の12番）ので、塊の数（`chunks.length`）で
 * 言うと、塊が丸ごと競合になった回に、無い日誌の行を名乗っていた（PR #1711 で直したが、
 * 専用の歯は `archive_remove_many` にしか無かった——`archive-remove-many-raced.test.ts`
 * の「応答が言う『日誌に N 件』は、実際に書いた件数である」と同じ形で、ここに足す）。
 *
 * ⚠️ **横断レビュー（13回目）で見つかった穴**: PR #1727 が最初に足したこの歯は、
 * 期待する塊の数を予算の定数の**写し**（`3_600` を手で書き写したもの）から計算していた。
 * 本物の `CLOSE_MANY_JOURNAL_ID_CHARS` を（250件が1塊に収まるほど大きい値へ）変えても、
 * 写しの側は追随しないので歯は緑のまま——実装が1塊しか作らず競合が1回も起きなくても、
 * 写しから計算した「複数の塊」という期待値と偶然に一致して通ってしまっていた。
 * ⟹ 対策は2つ、両方要る。**(1)** 写しではなく道具本体と同じ export
 * （`CLOSE_MANY_JOURNAL_ID_CHARS`）を import して使う。**(2)** それだけでは
 * 「将来また誰かが写しを書き足す」規制にならないので、実装が実際に複数回 `closeMany` を
 * 呼んだこと（＝実際に2つ以上の塊に割ったこと）を、道具の実挙動（呼ばれた回数）から
 * 直接測り、歯の前提として明示的に検査する。
 */
describe('commitment_close_many の応答が言う「日誌に N 件」は、実際に書いた件数である', () => {
  it('2つ目以降の塊が丸ごと競合になっても、応答の N は日誌の行の数と一致する', async () => {
    const stores = createMemoryStores();
    const entries = Array.from({ length: 250 }, (_, i) => entryAt(i, 'external'));
    await openAll(stores, entries);
    const allIds = entries.map((entry) => entry.id);
    // `chunkIdsByChars` は道具本体が使っているのと同じ export。同じ引数
    // （id の並び・道具本体と同じ `CLOSE_MANY_JOURNAL_ID_CHARS`）で呼べば、道具の中で
    // 実際に切れる境界と一致する——写し（値を手で書き写したもの）は使わない。
    const chunksExpected = chunkIdsByChars(allIds, CLOSE_MANY_JOURNAL_ID_CHARS);
    expect(chunksExpected.length).toBeGreaterThanOrEqual(2); // 2個目以降を丸ごと競合にするのに要る

    // **1つ目の塊は本当に閉じ、2つ目以降は「呼ぶ直前に他経路が丸ごと先に閉じていた」を
    // 模す。** `archive-remove-many-raced.test.ts` と同じ作法——本物の `closeMany` 実装
    // だけで競合を作る（フェイクの戻り値を手で組み立てない）。2回目以降の呼びでは、
    // 本物の `closeMany` を1回先打ちして「別経路」が閉じたことにしてから、道具自身の
    // 呼びをもう一度本物へ通す（その時点では既に閉じているので `[]` が返る）。
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

    // **この歯が意味を持つための前提を、定数から計算した期待値だけに頼らず、
    // 道具の実挙動（`closeMany` が実際に呼ばれた回数）からも直接測る。** 道具は
    // 塊ごとに1回 `closeMany` を呼ぶので、`calls` は実際に道具が作った塊の数と
    // 一致する。定数を import しただけでは「将来また写しが生まれる」ことは防げ
    // ないが、この検査は写しの有無に関わらず、実装が実際に複数回呼んだかどうか
    // だけを見るので、写しが再び紛れ込んでも実装側の挙動が変わらない限り機能する。
    expect(
      calls,
      'closeMany が2回以上呼ばれていない＝道具は実際には複数の塊に割っていない' +
        '（この前提が崩れると、下のアサーションは競合が1回も起きなくても緑になりうる）',
    ).toBeGreaterThanOrEqual(2);
    // 写し由来ではない期待値（`chunksExpected`）と、実挙動そのもの（`calls`）が
    // 一致することも確かめる——両者がずれるなら、上の import か下の前提の
    // どちらかが本物の挙動を追えていない。
    expect(calls).toBe(chunksExpected.length);

    const claimed = /全 id は日誌に (\d+) 件に分けて残してある/.exec(reply);
    expect(claimed, '省略の断り書きが出ていない（20件を超えて閉じていない）').not.toBeNull();
    const chunkEntries = (await decisionTexts(stores)).filter((text) => text.includes('塊目'));
    expect(chunkEntries.length).toBeGreaterThan(0);
    // **この歯が意味を持つための前提**: 実際に複数回 closeMany が呼ばれた
    // （＝複数の塊に割れた）のに、日誌に書いたのは1つ目の塊だけ
    // （＝ journaledChunks < calls）であること。
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

  /**
   * 14d. **境界: 塊の合計（区切り込み）がちょうど予算に一致するとき、
   * 分割しない。**
   *
   * 実装は `width + added > budget` のときだけ塊を切る（`>` であって
   * `>=` ではない）——ちょうど一致は「超えていない」なので同じ塊に留まる。
   * `id.length` を2つと区切り1文字ぶんを足してちょうど budget になるよう
   * 仕込む。
   */
  it('14d. 境界: 塊の合計（区切り込み）がちょうど予算に一致するとき、分割しない', () => {
    const a = 'a'.repeat(10);
    const b = 'b'.repeat(9); // 10 + 1(区切り) + 9 = 20 = budget ちょうど
    const budget = 20;
    expect(chunkIdsByChars([a, b], budget).length).toBe(1);
    expect(chunkIdsByChars([a, b], budget)).toEqual([[a, b]]);

    // 陰性対照: 1文字でも超えると2塊に割れる。
    const bPlusOne = 'b'.repeat(10); // 10 + 1 + 10 = 21 > 20
    const split = chunkIdsByChars([a, bPlusOne], budget);
    expect(split.length).toBe(2);
    expect(split).toEqual([[a], [bPlusOne]]);
  });

  /**
   * 14e. **境界: 1件だけで予算を超える id が列の途中・先頭・末尾のどこに
   * 在っても、単独の塊として残り、空の塊は1つも生まれず、無限ループにも
   * ならない。**
   *
   * 14b は「途中に挟まった」形だけを見ている。ここは先頭・末尾という
   * 別の位置も見て、位置に依らないことを確かめる。
   */
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

    // 予算超えの id が連続しても、1つずつ単独の塊になる（まとめられない・
    // 空の塊を挟まない）。
    const allTooLong = chunkIdsByChars([tooLong, tooLong], budget);
    expect(allTooLong).toEqual([[tooLong], [tooLong]]);
  });

  /**
   * 14f. **`chunkIdsByChars` は、区切りを1文字ぶんとして数えている
   * （内部の前提そのものを固定する）。**
   *
   * ⚠️ **この歯が測っているのは `chunkIdsByChars` の内部だけである。**
   * `tools.ts` / `apps/daemon/src/app.ts` の呼び出し側は、日誌へ書くとき
   * 実際に `chunk.join(' ')`（半角スペース1文字）で塊をつなぐ——これは
   * 別途 grep で確認した事実であって、この歯はそれを検査していない。
   * **呼び出し側の区切りが2文字以上（例: `', '`）に変わっても、この歯は
   * 赤くならない**——呼び出し側は見ていない。もし呼び出し側の区切りが
   * 変わってこの前提とずれれば、`chunkIdsByChars` が守っている予算は
   * 呼び出し側にとって過小になり（実際に繋いだ文字列が budget を超えうる）、
   * それはこの歯ではなく呼び出し側のテストで捕まえる必要がある。
   * この歯が固定するのは「区切りは1文字」という `chunkIdsByChars` 内部の
   * 前提だけで、前提が壊れたら（誰かが `chunkIdsByChars` の中の `+ 1` を
   * 書き換えたら）赤くなる。
   */
  it('14f. 区切りは1文字ぶんとして数えている（chunkIdsByChars 内部の前提）', () => {
    const ids = ['aa', 'bb', 'cc']; // 2+1+2+1+2 = 8
    const budget = 8;
    const chunks = chunkIdsByChars(ids, budget);
    expect(chunks).toEqual([ids]);
    expect(chunks[0]!.join(' ').length).toBe(budget);

    // 1文字減らすと入りきらず割れる。
    const chunksMinusOne = chunkIdsByChars(ids, budget - 1);
    expect(chunksMinusOne.length).toBeGreaterThan(1);
  });
});
