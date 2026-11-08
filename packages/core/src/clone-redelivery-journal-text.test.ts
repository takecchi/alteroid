import { describe, expect, it } from 'vitest';

import {
  describeFailedTimerRetryClause,
  describeRestoreUnreadPassEnd,
  describeRestoreUnreadPassStart,
  describeStaleRedeliveryDropped,
} from './clone-redelivery-text.js';
import { inboxEventShape } from './dropped-record.js';
import type { RestoredInboxEventVerdict } from './inbox-staleness.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

// 純関数へ移した本文を、移す前の `clone.ts` の式（逐語。`this.#...` を引数へ置き換えただけ）と 1 文字ずつ比べる。
// 「移し替えで 1 文字も変えていない」ことの歯であって、文面の正しさの保証ではない（文面は `clone-redelivery-journal-text-pin.test.ts` が `createClone` 越しに固定する）。
// 下の `old*` は、切り出し前の `Clone#dropStaleRedelivery`・`#journalRestoreUnreadPassStart`・`#journalRestoreUnreadPassEnd`・`#settleTimerRun` の式の写しである（接頭辞は呼び元に残るので含めない）。

// --- 旧式の写し（切り出し前の clone.ts の式。`this.#restoredCohort` は引数 `restoredCohort`） ---

function oldDropStaleText(
  record: PendingInboxEvent,
  context: { readonly alone: boolean; readonly completedRound?: boolean },
  restoredCohort: number,
): string {
  return (
    `未読のまま残っていた合図を配り直したが（${record.deliveries}回目の配達` +
    (context.alone
      ? ''
      : `＝器が入れ替わった回数。同じ起動で一緒に拾い直した未読が ${restoredCohort} 件あり、` +
        `配達回数は残っている未読の全行で一緒に進む — この合図の処理が落ちた回数ではない`) +
    `、${record.at} に受け取ったもの）、` +
    (context.completedRound === true
      ? `その回は既に完了していた（定期の依頼の \`lastScheduledRunAt\` 以前）ので` +
        `ターンを起こさずに消した（モデルへは1文字も渡していない。本文は` +
        `直前の行に残してある。完了した回を二度走らせないための畳みで、まだ走っていない回は畳まない）: `
      : `もう効く先の無い種類だったので` +
        `ターンを起こさずに消した（モデルへは1文字も渡していない。本文は` +
        `直前の行に残してある。まだ要る状況なら、この種類の合図は作り直される）: `) +
    `${inboxEventShape(record.event)}`
  );
}

function oldStartText(total: number): string {
  return `未読の拾い直しを始める（claimPending が返した総数 ${total} 件）`;
}

function oldEndText(
  decided: ReadonlyArray<{ readonly verdict: RestoredInboxEventVerdict }>,
  processed: number,
  context: { readonly interrupted: boolean },
): string {
  const total = decided.length;
  const staleCount = decided
    .slice(0, processed)
    .filter((entry) => entry.verdict === 'stale').length;
  const liveCount = processed - staleCount;
  return context.interrupted
    ? `未読の拾い直しを中断した（#stopped または #inbox.closed。` +
        `総数 ${total} 件のうち ${processed} 件を処理した＝内訳 stale ${staleCount} 件・` +
        `live ${liveCount} 件。残り ${total - processed} 件は次の起動で拾い直す）`
    : `未読の拾い直しが終わった（総数 ${total} 件のうち ${processed} 件を` +
        `処理した＝内訳 stale ${staleCount} 件・live ${liveCount} 件）`;
}

// 旧式の `FAILED_TURN_RETRY_DELAYS_MS` は `[10, 30, 120, 360, 720].map((minutes) => minutes * 60_000)`
const OLD_FAILED_TURN_RETRY_DELAYS_MS: readonly number[] = [10, 30, 120, 360, 720].map(
  (minutes) => minutes * 60_000,
);

function oldRetryClause(retryDelayMs: number | undefined): string {
  return retryDelayMs === undefined
    ? '手で起こした回なので再試行せず、次の起動か次の定刻で配り直される'
    : `${String(retryDelayMs / 60_000)} 分後に配り直す。成功するまで最長 ` +
        `${String(OLD_FAILED_TURN_RETRY_DELAYS_MS.at(-1)! / 60_000)} 分ごとに配り直し続ける`;
}

// --- 入力 ---

const events: readonly InboxEvent[] = [
  {
    type: 'external',
    id: 'evt-ext',
    at: '2026-08-01T00:00:00.000Z',
    source: 'daemon.token_pool_reopened',
    payload: { note: 'stale' },
  },
  { type: 'timer', id: 'evt-timer', at: '2026-08-01T00:00:00.000Z', kind: 'weekly-check' },
  {
    type: 'manager_message',
    id: 'evt-mgr',
    at: '2026-08-01T00:00:00.000Z',
    managerId: 'mgr-1',
    kind: 'report',
    text: '本文',
  },
];

function record(event: InboxEvent, deliveries: number, at: string): PendingInboxEvent {
  return { event, deliveries, at };
}

describe('describeStaleRedeliveryDropped は移す前の式と 1 文字も違わない', () => {
  const contexts: ReadonlyArray<{ readonly alone: boolean; readonly completedRound?: boolean }> = [
    { alone: true },
    { alone: true, completedRound: false },
    { alone: true, completedRound: true },
    { alone: false },
    { alone: false, completedRound: false },
    { alone: false, completedRound: true },
  ];

  it('alone × completedRound（未指定・false・true）× 配達回数 × 同時に拾い直した件数 × 合図の種類', () => {
    let compared = 0;
    for (const event of events) {
      for (const deliveries of [1, 2, 10]) {
        for (const restoredCohort of [0, 1, 2, 7, 200]) {
          for (const context of contexts) {
            const target = record(event, deliveries, '2026-08-01T10:00:00.000Z');
            expect(describeStaleRedeliveryDropped(target, context, restoredCohort)).toBe(
              oldDropStaleText(target, context, restoredCohort),
            );
            compared += 1;
          }
        }
      }
    }
    // 空の比較で緑にならない
    expect(compared).toBe(3 * 3 * 5 * 6);
  });
});

describe('describeRestoreUnreadPassStart は移す前の式と 1 文字も違わない', () => {
  it('総数を変えて比べる', () => {
    for (const total of [1, 2, 3, 10, 200, 12345]) {
      expect(describeRestoreUnreadPassStart(total)).toBe(oldStartText(total));
    }
  });
});

describe('describeRestoreUnreadPassEnd は移す前の式と 1 文字も違わない', () => {
  const verdictLists: ReadonlyArray<readonly RestoredInboxEventVerdict[]> = [
    ['stale'],
    ['live'],
    ['stale', 'stale', 'stale'],
    ['live', 'live'],
    ['live', 'stale', 'live', 'stale', 'stale'],
    ['stale', 'live', 'stale'],
    Array.from({ length: 200 }, (_, i): RestoredInboxEventVerdict =>
      i % 3 === 0 ? 'live' : 'stale',
    ),
  ];

  it('中断・完了 × 並び × 処理した件数（0 から総数まで）', () => {
    let compared = 0;
    for (const verdicts of verdictLists) {
      const decided = verdicts.map((verdict) => ({ verdict }));
      for (let processed = 0; processed <= decided.length; processed += 1) {
        for (const interrupted of [true, false]) {
          expect(describeRestoreUnreadPassEnd(decided, processed, { interrupted })).toBe(
            oldEndText(decided, processed, { interrupted }),
          );
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(400);
  });
});

describe('describeFailedTimerRetryClause は移す前の式と 1 文字も違わない', () => {
  it('手で起こした回（retryDelayMs なし）と、後退の各間隔', () => {
    const last = OLD_FAILED_TURN_RETRY_DELAYS_MS.at(-1)!;
    expect(describeFailedTimerRetryClause(undefined, last)).toBe(oldRetryClause(undefined));
    for (const retryDelayMs of OLD_FAILED_TURN_RETRY_DELAYS_MS) {
      expect(describeFailedTimerRetryClause(retryDelayMs, last)).toBe(oldRetryClause(retryDelayMs));
    }
  });

  it('分に割り切れない値でも同じ（旧式は String(retryDelayMs / 60_000) のまま）', () => {
    const last = OLD_FAILED_TURN_RETRY_DELAYS_MS.at(-1)!;
    for (const retryDelayMs of [1, 90_000, 61_000]) {
      expect(describeFailedTimerRetryClause(retryDelayMs, last)).toBe(oldRetryClause(retryDelayMs));
    }
  });
});
