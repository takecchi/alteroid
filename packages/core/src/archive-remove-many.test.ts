import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

/**
 * `archive_remove_many`（issue #698 の残タスク）を固定する。
 *
 * **雛形は `commitment-close-many.test.ts` / `inbox-remove-many.test.ts`
 * である。** 選定ロジック自体（`selectArchiveRemovalTargets` の安全弁・
 * 含有の証明・優先順位）は `archive-prune.test.ts` が既に固定しているので、
 * ここで測るのは**道具としてのふるまい**——既定 dryRun・絞り込み無しの拒否・
 * 走行中の委譲の扱い（**一括からは開けない**）・数の帳尻・日誌への記録——
 * だけである。
 *
 * ⚠️ **文言ではなく実状態で測る**（`commitment-close-many.test.ts` と同じ
 * 教訓、PR #826）。消えたかどうかは `stores.archive.read()` を読み直して
 * 測り、日誌の中身は `journal.list({ types: ['decision'] })` の実データで測る。
 *
 * **`archive_remove`（単発）と違い、`selectArchiveRemovalTargets` の安全弁
 * （`isNewest` / 含有の証明）がそのまま効く。** ⟹ セッションに1行しか
 * 積んでいないと、その1行は必ず「セッションの最新行」として `skipped.newest`
 * に落ち、対象にならない。**対象を作るテストは、必ず2行以上を同じ
 * セッションへ積み、新しい行の本文が古い行の本文を前方一致で含む形にする**
 * （`continuity: 'continues'` を得るため。`classifyArchiveContinuity` の doc）。
 */

/** 誰も走行中に抱えていないことにする既定の `ManagerPool` スタブ。 */
const NO_ONE_RUNNING = { runningManagerOwning: () => undefined } as unknown as ManagerPool;

/**
 * その `stores` / `managers` に配線した `archive_remove_many` を呼ぶ関数を返す。
 *
 * **`managers` を省略すると `NO_ONE_RUNNING`（誰も走行中に抱えていない）を渡す**
 * ——ほとんどのテストは guard の判定そのものを見たいわけではないので、既定は
 * 「guard は必ず `allowed` を返す」側にしておく。**`managers` を配線しない
 * 場面そのもの**（`guard.kind === 'unknown'`）を測るテストは、`null` を明示的に
 * 渡すこと。
 */
function remover(stores: Stores, managers: ManagerPool | null = NO_ONE_RUNNING) {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(managers === null ? {} : { managers }),
  };
  const tools = createCloneTools(context);
  const found = tools.find((entry) => entry.name === 'archive_remove_many');
  expect(found, 'archive_remove_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

/**
 * `archive_remove_many` が MCP へ差し出している入力の形（zod の shape）。
 * **JSDoc ではなく、実際に呼び出し側へ見える形**を読む（`tools.test.ts` の
 * `shapeOf` と同じ作法）。
 */
function inputShape(stores: Stores): Record<string, unknown> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'archive_remove_many');
  expect(found, 'archive_remove_many という道具が無い').toBeDefined();
  return (found?.inputSchema ?? {}) as Record<string, unknown>;
}

/** 日誌に積まれた `decision` の本文だけを取り出す。 */
async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

/**
 * 同じセッションへ、前方一致で連なる2行を積む（`古い行` が `新しい行` に
 * 前方一致で含まれる。`新しい行` が最新行として安全弁で必ず守られ、
 * `古い行` が選定の対象になりうる唯一の形）。
 */
async function seedRemovableSession(
  stores: Stores,
  sessionId: string,
): Promise<{ oldId: string; newId: string }> {
  const oldRow = await stores.archive.archive(sessionId, 'AAA');
  const newRow = await stores.archive.archive(sessionId, 'AAABBB');
  expect(newRow.continuity, '前方一致の前提が崩れている（テストの組み立てミス）').toBe('continues');
  return { oldId: oldRow.id, newId: newRow.id };
}

describe('archive_remove_many（アーカイブ済み生ログの本文を絞り込んでまとめて tombstone する）', () => {
  it('既定（dryRun 省略）は試算——1件も消さない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-dry');
    const call = remover(stores);

    const reply = await call({ sessionIds: ['sess-dry'], summary: '試しに絞り込んでみる' });

    expect(reply).toContain('試算');
    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('sessionIds / before / minStoredBytes のどれも渡さない呼びは断る（1件も消さない）', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-nofilter');
    const call = remover(stores);

    const reply = await call({ summary: '絞り込み忘れ', dryRun: false });

    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('dryRun: false で実際に消える（新しい行は最新行として守られ、古い行だけ消える）', async () => {
    const stores = createMemoryStores();
    const { oldId, newId } = await seedRemovableSession(stores, 'sess-real');
    const call = remover(stores);

    const reply = await call({
      sessionIds: ['sess-real'],
      summary: 'もう要らないので消した',
      dryRun: false,
    });

    expect(reply).toContain('1 件');
    expect(await stores.archive.read(oldId)).toMatchObject({ kind: 'removed' });
    // **新しい行（セッションの最新行）は安全弁で消えない。**
    expect(await stores.archive.read(newId)).toEqual({ kind: 'body', body: 'AAABBB' });

    const texts = await decisionTexts(stores);
    const entry = texts.find((t) => t.includes(oldId));
    expect(entry).toBeDefined();
    expect(entry).toContain('もう要らないので消した');
    // **本文は日誌へ写さない。**
    expect(texts.some((t) => t.includes('AAABBB'))).toBe(false);
  });

  it('走行中のマネージャーが使っている行は飛ばして数える（overrideReason 無し）', async () => {
    const stores = createMemoryStores();
    const { oldId, newId } = await seedRemovableSession(stores, 'sess-running');
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === oldId ? 'mgr-running-1' : undefined,
    } as unknown as ManagerPool;
    const call = remover(stores, managers);

    const reply = await call({
      sessionIds: ['sess-running'],
      summary: '掃除',
      dryRun: false,
    });

    // 飛ばされたので何も変わっていない。
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
    expect(await stores.archive.read(newId)).toEqual({ kind: 'body', body: 'AAABBB' });
    expect(reply).toContain('inUse');
    expect(reply).toContain('0 件');
  });

  /**
   * ⭐ **「一括からは開けない」という性質そのものに歯を当てる。**
   *
   * `POST /archive/remove` が `overrideReason` を持たないのと同じ判断
   * （`app.ts` の doc「一括で複数件を無条件に開ける形は事故の芽が大きい」）。
   * ⟹ 口が無いことと、万一渡ってきても開かないことの両方を撃つ。
   * **あわせて「黙って能力を削っていない」ことも撃つ**——断り文が、単発の
   * `archive_remove` に `overrideReason` を渡して1件ずつ名指しせよと案内する。
   */
  it('一括に override の口は無い——入力の形に overrideReason が無く、渡しても開かない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-no-override');
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === oldId ? 'mgr-running-2' : undefined,
    } as unknown as ManagerPool;

    // 歯1: 入力の形そのものに口が無い（クローンからは渡しようがない）。
    expect(Object.keys(inputShape(stores))).not.toContain('overrideReason');

    // 歯2: それでも渡ってきたとき（＝ schema を迂回した最悪の形）でも開かない。
    const reply = await remover(
      stores,
      managers,
    )({
      sessionIds: ['sess-no-override'],
      summary: '掃除',
      dryRun: false,
      overrideReason: '理由を書けば通ると思った',
    });

    expect(reply).toContain('inUse(走行中) 1');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
    // 消していないのだから日誌にも残らない。
    expect((await decisionTexts(stores)).some((t) => t.includes(oldId))).toBe(false);
    // **黙って能力を削ったように見せない**——開ける道は残っていると言う。
    expect(reply).toContain('archive_remove（単発）');
    expect(reply).toContain('overrideReason');
  });

  it('managers が配線されていない場面は安全側に倒して消さない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-no-pool');
    // `null` を明示 ＝ context.managers は undefined（配線しない場面そのもの）。
    const call = remover(stores, null);

    const reply = await call({
      sessionIds: ['sess-no-pool'],
      summary: '掃除',
      dryRun: false,
    });

    expect(reply).toContain('inUse');
    expect(reply).toContain('0 件');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });

  it('絞り込みに当たる行が0件なら、その旨を言って1件も消さない', async () => {
    const stores = createMemoryStores();
    await seedRemovableSession(stores, 'sess-other');
    const call = remover(stores);

    const reply = await call({
      sessionIds: ['sess-does-not-exist'],
      summary: '絞り込みが外れている',
      dryRun: false,
    });

    expect(reply).toContain('0件だった');
    expect(reply).toContain('1件も消していない');
  });

  it('before が ISO8601 として読めない場合は断る', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-bad-before');
    const call = remover(stores);

    const reply = await call({
      before: 'not-a-date',
      summary: '掃除',
      dryRun: false,
    });

    expect(reply).toContain('ISO8601');
    expect(reply).toContain('1件も消していない');
    expect(await stores.archive.read(oldId)).toEqual({ kind: 'body', body: 'AAA' });
  });
  /**
   * ⭐ **数の帳尻そのものを撃つ歯**（`app.test.ts` の同名の歯と対。#698 欠陥1・欠陥3）。
   *
   * 欄を1つずつ確かめる歯は「その欄が正しいか」しか言わない。**1行が0回または
   * 2回数えられている**という壊れ方は、欄を個別に見ても見つからない——HTTP 側では
   * 実際に、guard で飛ばした行を `targeted` と `skipped.inUse` の両方で数える
   * 欠陥が既存の歯を全部通り抜けていた。この道具も同じ数を自前で組み立てて
   * 文面に出すので、**同じ等式をこちら側でも撃つ。**
   */
  it('数の帳尻: 当たった件数 === 対象 + remaining + skipped5欄（下見でも実行でも）', async () => {
    const stores = createMemoryStores();
    // newest / alreadyRemoved / notContained / inUse が全部1以上になるよう仕込む。
    const { oldId: chainOld } = await seedRemovableSession(stores, 'sess-inv-chain');
    const { oldId: runningOld } = await seedRemovableSession(stores, 'sess-inv-run');
    const { oldId: goneOld } = await seedRemovableSession(stores, 'sess-inv-gone');
    await stores.archive.remove(goneOld); // → alreadyRemoved
    await stores.archive.archive('sess-inv-div', 'XYZ'); // 前方一致しない → notContained
    await stores.archive.archive('sess-inv-div', 'QQQ'); // → newest
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === runningOld ? 'mgr-inv' : undefined,
    } as unknown as ManagerPool;
    const call = remover(stores, managers);

    /** 文面から数だけを取り出す（文言の確認ではなく、数の帳尻を測るため）。 */
    const numbersOf = (reply: string) => {
      const pick = (re: RegExp) => {
        const hit = re.exec(reply);
        expect(hit, `${re} が文面に無い: ${reply}`).not.toBeNull();
        return Number(hit?.[1]);
      };
      const skipped =
        /skipped: protected\(墓標\) (\d+) \/ alreadyRemoved (\d+) \/ newest (\d+) \/ notContained (\d+) \/ inUse\(走行中\) (\d+)/.exec(
          reply,
        );
      expect(skipped, `skipped 行が文面に無い: ${reply}`).not.toBeNull();
      return {
        matched: pick(/絞り込みで (\d+) 件/),
        remaining: pick(/対象にすらならなかった件数）: (\d+)/),
        skipped: {
          protected: Number(skipped?.[1]),
          alreadyRemoved: Number(skipped?.[2]),
          newest: Number(skipped?.[3]),
          notContained: Number(skipped?.[4]),
          inUse: Number(skipped?.[5]),
        },
      };
    };
    const skippedTotal = (n: ReturnType<typeof numbersOf>) =>
      n.skipped.protected +
      n.skipped.alreadyRemoved +
      n.skipped.newest +
      n.skipped.notContained +
      n.skipped.inUse;

    const preview = await call({ minStoredBytes: 0, summary: '帳尻を撃つ' });
    const previewNumbers = numbersOf(preview);
    const previewTargeted = Number(/この呼びで消すのは (\d+) 件/.exec(preview)?.[1]);
    // 🔑 これが本体。1行は必ず1回だけ数えられる。
    expect(previewTargeted + previewNumbers.remaining + skippedTotal(previewNumbers)).toBe(
      previewNumbers.matched,
    );
    // 仕込んだ4つの理由が実際に立っていること（全部0で等式が成り立つ空振りを防ぐ）。
    expect(previewNumbers.skipped.newest).toBeGreaterThan(0);
    expect(previewNumbers.skipped.alreadyRemoved).toBeGreaterThan(0);
    expect(previewNumbers.skipped.notContained).toBeGreaterThan(0);
    expect(previewNumbers.skipped.inUse).toBeGreaterThan(0);
    expect(previewTargeted).toBeGreaterThan(0);

    const executed = await call({ minStoredBytes: 0, summary: '帳尻を撃つ', dryRun: false });
    const executedNumbers = numbersOf(executed);
    // 実行側では `targeted === 消した件数 + raced`（ここでは競合なし ＝ raced 0)。
    const removed = Number(/\*\*(\d+) 件の本文を tombstone した\*\*/.exec(executed)?.[1]);
    expect(executed).not.toContain('は消せなかった'); // raced が立っていない
    expect(removed + executedNumbers.remaining + skippedTotal(executedNumbers)).toBe(
      executedNumbers.matched,
    );
    // **下見は実行の予告になっている**（走行中の委譲が混ざっていても）。
    expect(removed).toBe(previewTargeted);
    expect(executedNumbers.skipped.inUse).toBe(previewNumbers.skipped.inUse);
    // 実状態でも裏を取る。
    expect(await stores.archive.read(chainOld)).toMatchObject({ kind: 'removed' });
    expect(await stores.archive.read(runningOld)).toEqual({ kind: 'body', body: 'AAA' });
  });
});
