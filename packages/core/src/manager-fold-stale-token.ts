import { HELD_FORCE_FOLD_AFTER_MS, type StaleHoldStuck } from './held-messages.js';
import { FOLD_NOTICE_COMMANDS_MAX } from './manager-notices.js';
import type { Job } from './schema.js';

/*
 * `Pool#foldStaleTokenBeforeDelivery`（段F）の、状態にも時計にも触れない同期の部分（`Pool` から切り出した。振る舞いは変えていない）。
 * 時計（`#now`・`#nowIso`）の読み・`StaleTokenFold#fold` ほかの協力者の呼び出し・`await`・`record` の書き込みは `Pool` に残す:
 * 注入された時計は呼び出しごとに違う値を返しうるので、読む回数と位置は `Pool` が握り、ここへは値で渡す。
 */

// 読めない時刻と無い時刻は数えない: 全部無ければ `undefined`（待ちの数え始めが分からない）
export function earliestMs(times: readonly (string | undefined)[]): number | undefined {
  return times
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at) => !Number.isNaN(at))
    .reduce<number | undefined>(
      (min, at) => (min === undefined ? at : Math.min(min, at)),
      undefined,
    );
}

/** `Pool#send` の届け方 `SendDelivery.mode` と同じ値。 */
export type FoldDeliveryMode = 'caller' | 'held-delivery' | 'usage-rotation';

/**
 * 待ちの数え始めは、いちばん古い預かりと、背景処理待ちに入った時刻の早いほう（#5041）: 担当は預かりより前から古い鍵のまま
 * 背景処理を待っていて、話しかけたい伝言が届いた時点で、もう止まっている時間を数えるため（預かりだけから数えると、LAND-9 は8分で畳まれなかった）。
 */
export function heldWaitStartedAt(
  oldestHeldAt: string | undefined,
  awaitingSince: string | undefined,
): number | undefined {
  return earliestMs([oldestHeldAt, awaitingSince]);
}

/** 待ちの上限（`HELD_FORCE_FOLD_AFTER_MS`）に届いたか。`now` は呼び手が読んで渡す（読むのは前の 3 条件が揃った回だけ）。 */
export function heldWaitReachedForceFold(now: number, waitStartedAt: number): boolean {
  return now - waitStartedAt >= HELD_FORCE_FOLD_AFTER_MS;
}

/**
 * 鍵の回転の起こし直しの待ちの上限の時刻（#5044）。待ちの数え始めは、枠で止まった時刻と、背景処理待ちに入った時刻の早いほう。
 * どちらも分からなければ待たない（#4850 の今まで）: 数え始めの無い待ちは、上限が来ないまま古い鍵で居座るため。
 * `usageStoppedAt` は門（`Pool` の `#usageStopped`）を通した値だけを渡す。
 */
export function rotationFoldDueAtOf(
  mode: FoldDeliveryMode,
  usageStoppedAt: string | undefined,
  awaitingSince: string | undefined,
): number | undefined {
  const rotationWaitStartedAt =
    mode === 'usage-rotation' ? earliestMs([usageStoppedAt, awaitingSince]) : undefined;
  return rotationWaitStartedAt === undefined
    ? undefined
    : rotationWaitStartedAt + HELD_FORCE_FOLD_AFTER_MS;
}

/**
 * `StaleTokenFold#fold` へ渡す options。`rotationFoldDueAt` が決まっている回だけ、呼び手が `now` を読んで渡す
 * （決まっていない回は読まない: `undefined`）。`now` が上限以後なら欄ごと無い。
 */
export function staleTokenFoldOptionsOf(input: {
  waitedLongEnough: boolean;
  mode: FoldDeliveryMode;
  pollRetry: boolean;
  rotationFoldDueAt: number | undefined;
  now: number | undefined;
}): {
  foldBackgroundAfterWait: boolean;
  foldBackgroundIfHeldTokenNotReady: boolean;
  rotationFoldDueAt?: number;
  skipUnchangedDeclineRecord: boolean;
} {
  const { waitedLongEnough, mode, pollRetry, rotationFoldDueAt, now } = input;
  return {
    foldBackgroundAfterWait: waitedLongEnough,
    foldBackgroundIfHeldTokenNotReady: mode === 'usage-rotation',
    ...(rotationFoldDueAt === undefined || now === undefined || now >= rotationFoldDueAt
      ? {}
      : { rotationFoldDueAt }),
    skipUnchangedDeclineRecord: mode === 'held-delivery' && pollRetry,
  };
}

/** 畳めない理由が背景処理だけか。 */
export function isBackgroundOnlyStuck(stuck: StaleHoldStuck | undefined): boolean {
  return stuck !== undefined && stuck.blockers.length === 1 && (stuck.backgroundTasks ?? 0) > 0;
}

/** 畳んだ後の `pendingFoldNotice`。`previous` は台帳にある今の値、`at` は呼び手が読んで渡す時刻。 */
export function foldNoticeOf(
  folded: {
    foldedBackground?: number;
    foldedPeers?: number;
    foldedBackgroundCommands?: string[];
  },
  previous: Job['pendingFoldNotice'],
  at: string,
): NonNullable<Job['pendingFoldNotice']> {
  const peers = (folded.foldedPeers ?? 0) + (previous?.peers ?? 0);
  return {
    backgroundTasks: (folded.foldedBackground ?? 0) + (previous?.backgroundTasks ?? 0),
    ...(peers === 0 ? {} : { peers }),
    ...(folded.foldedBackgroundCommands === undefined && previous?.commands === undefined
      ? {}
      : {
          commands: [
            ...(previous?.commands ?? []),
            ...(folded.foldedBackgroundCommands ?? []),
          ].slice(0, FOLD_NOTICE_COMMANDS_MAX),
        }),
    at,
  };
}
