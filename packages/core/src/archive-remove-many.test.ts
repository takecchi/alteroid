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
 * 走行中の委譲の扱い（`overrideReason`）・日誌への記録——だけである。
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

  it('overrideReason があれば走行中でも通す——理由と managerId を日誌に残す', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-override');
    const managers = {
      runningManagerOwning: (archiveId: string) =>
        archiveId === oldId ? 'mgr-running-2' : undefined,
    } as unknown as ManagerPool;
    const call = remover(stores, managers);

    const reply = await call({
      sessionIds: ['sess-override'],
      summary: '掃除',
      dryRun: false,
      overrideReason: '本番障害の調査で緊急に消す必要があった',
    });

    expect(reply).toContain('override');
    expect(reply).toContain('mgr-running-2');
    expect(await stores.archive.read(oldId)).toMatchObject({ kind: 'removed' });

    const texts = await decisionTexts(stores);
    const entry = texts.find((t) => t.includes(oldId));
    expect(entry).toBeDefined();
    expect(entry).toContain('override');
    expect(entry).toContain('mgr-running-2');
    expect(entry).toContain('本番障害の調査で緊急に消す必要があった');
  });

  it('managers が配線されていない場面（overrideReason があっても）は安全側に倒して消さない', async () => {
    const stores = createMemoryStores();
    const { oldId } = await seedRemovableSession(stores, 'sess-no-pool');
    // `null` を明示 ＝ context.managers は undefined（配線しない場面そのもの）。
    const call = remover(stores, null);

    const reply = await call({
      sessionIds: ['sess-no-pool'],
      summary: '掃除',
      dryRun: false,
      overrideReason: 'それでも消したい',
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
});
