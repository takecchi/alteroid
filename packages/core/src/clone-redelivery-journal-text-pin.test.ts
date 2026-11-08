import { describe, expect, it } from 'vitest';

import { fakeSdk, waitFor } from './clone-test-harness.js';
import { DAEMON_TOKEN_POOL_REOPENED_SOURCE, createClone } from './clone.js';
import type { CloneHost } from './host.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createScheduler } from './schedule.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// `Clone` の private メソッド `#dropStaleRedelivery`（捨てた行）・`#journalRestoreUnreadPassStart` / `#journalRestoreUnreadPassEnd`（拾い直しの区切り）・
// `#settleTimerRun` の `retryClause`（定期の失敗の再試行の言い回し）が日誌へ書く本文を、`createClone` 経由で逐語に固定する。
// 期待の文字列は仕様を先に書いたものではない: 今の作りの出力を `vitest -u` で生成し、目で読んで確かめたものを置いている。
// 「今の出力から変えない」ための歯であって、文面の正しさの保証ではない。
// 既存の `stale-redelivery-batch.test.ts`・`clone-restore-unread-retry.test.ts`・`clone-schedule-failed-turn-retry.test.ts` は `includes` / 件数だけで一部を縛るので、ここで全文を縛る。
// 実時間の待ちは足さない: 日誌の行が出るのを `waitFor` で待つ。

const STALE_AT = '2026-08-01T00:00:00.000Z';

function bootClone(stores: Stores, replyFor?: () => string): CloneHost {
  const sdk = fakeSdk(replyFor);
  return createClone({
    stores,
    queryFn: sdk.fn,
    env: {},
    inboxSettleMs: 0,
    reportSettleMs: 0,
    runners: createRunnerRegistry([
      createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
    ]),
  });
}

function staleTokenPool(id: string, note: string = 'stale'): InboxEvent {
  return {
    type: 'external',
    id,
    at: STALE_AT,
    source: DAEMON_TOKEN_POOL_REOPENED_SOURCE,
    payload: { note },
  };
}

function liveReport(id: string, at: string): InboxEvent {
  return { type: 'manager_message', id, at, managerId: 'mgr-1', kind: 'report', text: '本文' };
}

const RESTORE_MARKS = ['未読の拾い直し', '配り直したが'];

/** 拾い直しに関わる自分の日誌行（区切り・捨てた行）を、書かれた順に返す。 */
async function restoreLines(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'] });
  const lines: string[] = [];
  // `journal.list` は新しい順なので、書かれた順へ直す
  for (const row of [...rows].reverse()) {
    if (row.type !== 'exchange' || row.with !== 'self' || row.role !== 'outbound') continue;
    if (RESTORE_MARKS.some((mark) => row.text.includes(mark))) lines.push(row.text);
  }
  return lines;
}

async function endLineWritten(stores: Stores): Promise<boolean> {
  return (await restoreLines(stores)).some(
    (line) =>
      line.includes('未読の拾い直しが終わった') || line.includes('未読の拾い直しを中断した'),
  );
}

async function runToEnd(stores: Stores): Promise<string[]> {
  const clone = bootClone(stores);
  await waitFor(() => endLineWritten(stores), '拾い直しの終わりの行');
  await clone.stop();
  return restoreLines(stores);
}

describe('#dropStaleRedelivery の捨てた行の逐語固定', () => {
  it('1件・同じ起動の未読が1件（alone）・1回目の配達・もう効く先の無い種類', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');

    expect(await runToEnd(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 1 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達、2026-08-01T10:00:00.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しが終わった（総数 1 件のうち 1 件を処理した＝内訳 stale 1 件・live 0 件）",
      ]
    `);
  });

  it('1件・alone・2回目の配達（前の器が拾い直しただけで落ちた）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');
    await stores.inbox.claimPending();

    expect(await runToEnd(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 1 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（2回目の配達、2026-08-01T10:00:00.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しが終わった（総数 1 件のうち 1 件を処理した＝内訳 stale 1 件・live 0 件）",
      ]
    `);
  });

  it('2件・alone でない側（同じ起動の未読が2件）。1件ごとに1行', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');
    await stores.inbox.put(staleTokenPool('evt-stale-2', 'second'), '2026-08-01T10:00:01.000Z');

    expect(await runToEnd(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 2 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:00.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:01.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しが終わった（総数 2 件のうち 2 件を処理した＝内訳 stale 2 件・live 0 件）",
      ]
    `);
  });

  it('完了済みの回の timer 行（定期の依頼の lastScheduledRunAt 以前）: alone の側', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-check',
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: '週に1回、状態を見て進める',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      lastScheduledRunAt: '2026-08-01T00:00:00.000Z',
    });
    await stores.inbox.put(
      { type: 'timer', id: 'evt-timer-done', at: '2026-08-01T00:00:00.000Z', kind: 'weekly-check' },
      '2026-08-01T00:00:00.000Z',
    );

    expect(await runToEnd(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 1 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達、2026-08-01T00:00:00.000Z に受け取ったもの）、その回は既に完了していた（定期の依頼の \`lastScheduledRunAt\` 以前）のでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。完了した回を二度走らせないための畳みで、まだ走っていない回は畳まない）: timer kind=weekly-check",
        "[計器] 未読の拾い直しが終わった（総数 1 件のうち 1 件を処理した＝内訳 stale 1 件・live 0 件）",
      ]
    `);
  });

  it('完了済みの回の timer 行と、効く先の無い合図が同居（alone でない側。完了済みの文言と stale の文言が1行ずつ）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-check',
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: '週に1回、状態を見て進める',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      lastScheduledRunAt: '2026-08-01T00:00:00.000Z',
    });
    await stores.inbox.put(
      { type: 'timer', id: 'evt-timer-done', at: '2026-08-01T00:00:00.000Z', kind: 'weekly-check' },
      '2026-08-01T00:00:00.000Z',
    );
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');

    expect(await runToEnd(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 2 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T00:00:00.000Z に受け取ったもの）、その回は既に完了していた（定期の依頼の \`lastScheduledRunAt\` 以前）のでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。完了した回を二度走らせないための畳みで、まだ走っていない回は畳まない）: timer kind=weekly-check",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:00.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しが終わった（総数 2 件のうち 2 件を処理した＝内訳 stale 2 件・live 0 件）",
      ]
    `);
  });

  it('一部だけ捨てる（live 1件 + stale 2件）: 捨てた行は stale の分だけ、区切りは live を数える', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');
    await stores.inbox.put(
      liveReport('evt-live', '2026-08-01T10:00:01.000Z'),
      '2026-08-01T10:00:01.000Z',
    );
    await stores.inbox.put(staleTokenPool('evt-stale-2', 'second'), '2026-08-01T10:00:02.000Z');

    expect(await runToEnd(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 3 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 3 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:00.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 3 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:02.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しが終わった（総数 3 件のうち 3 件を処理した＝内訳 stale 2 件・live 1 件）",
      ]
    `);
  });

  it('timer 行が完了済みでない回（lastScheduledRunAt より後）は捨てない', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-check',
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: '週に1回、状態を見て進める',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      lastScheduledRunAt: '2026-08-01T00:00:00.000Z',
    });
    await stores.inbox.put(
      { type: 'timer', id: 'evt-timer-next', at: '2026-08-08T00:00:00.000Z', kind: 'weekly-check' },
      '2026-08-08T00:00:00.000Z',
    );
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-08T10:00:00.000Z');

    const lines = await runToEnd(stores);
    expect(lines.filter((line) => line.includes('配り直したが')).length).toBe(1);
    expect(lines).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 2 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 2 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-08T10:00:00.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しが終わった（総数 2 件のうち 2 件を処理した＝内訳 stale 1 件・live 1 件）",
      ]
    `);
  });
});

describe('拾い直しの区切り（#journalRestoreUnreadPassStart・#journalRestoreUnreadPassEnd）の逐語固定', () => {
  it('未読が0件: 始まりも終わりも書かない', async () => {
    const stores = createMemoryStores();
    const clone = bootClone(stores);
    // 0件のときは何も書かないので、書かれないことを日誌の件数で待つことはできない。
    // 起動の完了は、後から届いた合図が処理されることで見る
    clone.post(liveReport('evt-live', '2026-08-01T00:00:00.000Z'));
    await waitFor(async () => {
      const rows = await stores.journal.list({ types: ['exchange'] });
      return rows.some((row) => row.type === 'exchange' && row.role === 'outbound');
    }, '起動後の合図が処理される');
    await clone.stop();

    expect(await restoreLines(stores)).toEqual([]);
  });

  it('始まり: 総数 1 件・終わり: 1 件を処理（stale 1・live 0）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');

    const lines = await runToEnd(stores);
    expect(lines.filter((line) => !line.includes('配り直したが'))).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 1 件）",
        "[計器] 未読の拾い直しが終わった（総数 1 件のうち 1 件を処理した＝内訳 stale 1 件・live 0 件）",
      ]
    `);
  });

  it('終わり: 総数 3 件のうち 3 件を処理（stale 2・live 1）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');
    await stores.inbox.put(
      liveReport('evt-live', '2026-08-01T10:00:01.000Z'),
      '2026-08-01T10:00:01.000Z',
    );
    await stores.inbox.put(staleTokenPool('evt-stale-2', 'second'), '2026-08-01T10:00:02.000Z');

    const lines = await runToEnd(stores);
    expect(lines.filter((line) => !line.includes('配り直したが'))).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 3 件）",
        "[計器] 未読の拾い直しが終わった（総数 3 件のうち 3 件を処理した＝内訳 stale 2 件・live 1 件）",
      ]
    `);
  });

  it('終わり: 全件が live（stale 0・live 2）', async () => {
    const stores = createMemoryStores();
    await stores.inbox.put(
      liveReport('evt-live-1', '2026-08-01T10:00:00.000Z'),
      '2026-08-01T10:00:00.000Z',
    );
    await stores.inbox.put(
      liveReport('evt-live-2', '2026-08-01T10:00:01.000Z'),
      '2026-08-01T10:00:01.000Z',
    );

    const lines = await runToEnd(stores);
    expect(lines.filter((line) => !line.includes('配り直したが'))).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 2 件）",
        "[計器] 未読の拾い直しが終わった（総数 2 件のうち 2 件を処理した＝内訳 stale 0 件・live 2 件）",
      ]
    `);
  });

  // 中断は、日誌への書き込みの直後に `stop()` を呼んで起こす（`stale-redelivery-batch.test.ts` と同じ形）。
  // 書き込みの直後の `#sdkSession.stopped || #inbox.closed` の判定が真になるのは、その次の確認の点である
  function interruptingStores(
    base: Stores,
    when: (text: string) => boolean,
    ref: { clone?: CloneHost; stopping?: Promise<void> },
  ): Stores {
    return {
      ...base,
      journal: {
        ...base.journal,
        async append(entry) {
          const result = await base.journal.append(entry);
          if (
            ref.stopping === undefined &&
            entry.type === 'exchange' &&
            when(entry.text) &&
            ref.clone !== undefined
          ) {
            ref.stopping = ref.clone.stop();
          }
          return result;
        },
      },
    };
  }

  it('中断: 始まりの行の直後に止まる（処理 0 件・残り 3 件）', async () => {
    const base = createMemoryStores();
    await base.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:00.000Z');
    await base.inbox.put(staleTokenPool('evt-stale-2'), '2026-08-01T10:00:01.000Z');
    await base.inbox.put(staleTokenPool('evt-stale-3'), '2026-08-01T10:00:02.000Z');
    const ref: { clone?: CloneHost; stopping?: Promise<void> } = {};
    const stores = interruptingStores(base, (text) => text.includes('未読の拾い直しを始める'), ref);

    ref.clone = bootClone(stores);
    await waitFor(() => endLineWritten(stores), '中断の行');
    await ref.stopping;

    expect(await restoreLines(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 3 件）",
        "[計器] 未読の拾い直しを中断した（#stopped または #inbox.closed。総数 3 件のうち 0 件を処理した＝内訳 stale 0 件・live 0 件。残り 3 件は次の起動で拾い直す）",
      ]
    `);
  });

  it('中断: live を1件配ったあと、最初の stale を捨てた行の直後に止まる（処理 2 件＝内訳 stale 1・live 1・残り 1 件）', async () => {
    const base = createMemoryStores();
    await base.inbox.put(
      liveReport('evt-live', '2026-08-01T10:00:00.000Z'),
      '2026-08-01T10:00:00.000Z',
    );
    await base.inbox.put(staleTokenPool('evt-stale-1'), '2026-08-01T10:00:01.000Z');
    await base.inbox.put(staleTokenPool('evt-stale-2'), '2026-08-01T10:00:02.000Z');
    const ref: { clone?: CloneHost; stopping?: Promise<void> } = {};
    const stores = interruptingStores(base, (text) => text.includes('配り直したが'), ref);

    ref.clone = bootClone(stores);
    await waitFor(() => endLineWritten(stores), '中断の行');
    await ref.stopping;

    expect(await restoreLines(stores)).toMatchInlineSnapshot(`
      [
        "[計器] 未読の拾い直しを始める（claimPending が返した総数 3 件）",
        "[間引き] 未読のまま残っていた合図を配り直したが（1回目の配達＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が 3 件あり、配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない、2026-08-01T10:00:01.000Z に受け取ったもの）、もう効く先の無い種類だったのでターンを起こさずに消した（モデルへは1文字も渡していない。本文は直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: external source.chars=10 payload=yes",
        "[計器] 未読の拾い直しを中断した（#stopped または #inbox.closed。総数 3 件のうち 2 件を処理した＝内訳 stale 1 件・live 1 件。残り 1 件は次の起動で拾い直す）",
      ]
    `);
  });
});

describe('#settleTimerRun の retryClause（定期の失敗の再試行の言い回し）の逐語固定', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-08-11T00:00:00.000Z');
  const WEEK = 7 * 24 * 60 * MIN;
  const DUE = T0 + WEEK;

  async function build() {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'weekly-check',
      spec: { type: 'every', minutes: 7 * 24 * 60 },
      request: '週に1回、状態を見て進める',
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
    });
    const sdk = fakeSdk(() => '進めた', {
      resultFor: () => ({
        subtype: 'error_during_execution',
        text: 'internal failure: something broke',
      }),
    });
    let clock = new Date(DUE);
    // eslint-disable-next-line prefer-const -- 前方参照（デーモンの index.ts と同じ形）
    let scheduler: ReturnType<typeof createScheduler>;
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
      onScheduledRunNotStarted: (kind, delayMs) => scheduler.retrySoon(kind, delayMs),
    });
    scheduler = createScheduler({
      entries: [],
      post: (event) => clone.post(event),
      schedules: stores.schedules,
      now: () => clock,
    });
    await scheduler.refresh();
    return {
      stores,
      clone,
      tick: async (ms: number) => {
        await scheduler.refresh();
        return scheduler.tick(new Date((clock = new Date(ms)).getTime()));
      },
    };
  }

  async function failureTexts(stores: Stores): Promise<string[]> {
    const rows = (await stores.journal.list({ types: ['exchange'] })) as { text: string }[];
    return rows.filter((row) => row.text.includes('ターンが失敗で終わった')).map((row) => row.text);
  }

  it('定期の回: 10 → 30 → 120 → 360 → 720 分と進み、使い切ったあとの7回目も 720 分（最長 720 分）', async () => {
    const t = await build();
    let now = DUE;
    expect(await t.tick(now)).toEqual(['weekly-check']);
    await waitFor(async () => (await failureTexts(t.stores)).length === 1, '失敗 1');
    const delays = [10, 30, 120, 360, 720, 720];
    for (const [index, minutes] of delays.entries()) {
      now += minutes * MIN;
      expect(await t.tick(now)).toEqual(['weekly-check']);
      await waitFor(
        async () => (await failureTexts(t.stores)).length === index + 2,
        `失敗 ${index + 2}`,
      );
    }
    await t.clone.stop();

    // 新しい順を書かれた順へ直す
    expect((await failureTexts(t.stores)).reverse()).toMatchInlineSnapshot(`
      [
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。10 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。30 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。120 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。360 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。720 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。720 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
        "[障害] 定期の依頼 weekly-check（2026-08-18T00:00:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。720 分後に配り直す。成功するまで最長 720 分ごとに配り直し続ける）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
      ]
    `);
  });

  it('手で起こした回: 再試行せず、次の起動か次の定刻で配り直される（retryDelayMs が無い側）', async () => {
    const stores = createMemoryStores();
    await stores.schedules.put({
      kind: 'issue-round',
      spec: { type: 'every', minutes: 60 },
      request: 'open issue を見て実装を進める',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T08:00:00.000Z',
    });
    const sdk = fakeSdk(() => '進めた', {
      resultFor: () => ({
        subtype: 'error_during_execution',
        text: 'internal failure: something broke',
      }),
    });
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    clone.post({
      type: 'timer',
      id: 'evt-manual',
      at: '2026-08-12T09:10:00.000Z',
      kind: 'issue-round',
      cause: 'manual',
    });
    await waitFor(async () => (await failureTexts(stores)).length === 1, '失敗の行');
    await clone.stop();

    expect(await failureTexts(stores)).toMatchInlineSnapshot(`
      [
        "[障害] 定期の依頼 issue-round（2026-08-12T09:10:00.000Z）のターンが失敗で終わったので「終わった」とは記録しない（引き受けた印は残る。手で起こした回なので再試行せず、次の起動か次の定刻で配り直される）: 結果なしで終了: error_during_execution（result_subtype） / internal failure: something broke",
      ]
    `);
  });
});
