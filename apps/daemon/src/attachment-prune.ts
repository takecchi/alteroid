import { pruneAttachmentCopies, reasonOf, writeStderrLine, type Stores } from '@alteroid/core';

import {
  clampedIntervalMs,
  readEveryMinutes,
  type EveryMinutesConfig,
} from './env-every-minutes.js';
import { startPeriodicRun } from './periodic-runner.js';

export const ATTACHMENT_PRUNE_EVERY_ENV = 'ALTEROID_ATTACHMENT_PRUNE_EVERY';

export const DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES = 60;

// 下限は 1 分: これを許すと `0.00001` のような値で `setTimeout` が 1ms へ倒れ、DELETE と readdir が休みなく回るため。切り上げて採るのではなく既定へ倒す（添付の上限の読み取りと同じ作法）。
export const MIN_ATTACHMENT_PRUNE_EVERY_MINUTES = 1;

/** 控えの無い blob の掃除（バケットの列挙）は、前回から 24 時間経つまで呼ばない。 */
export const ATTACHMENT_BLOB_SWEEP_EVERY_MS = 24 * 60 * 60_000;

export type AttachmentPruneConfig = EveryMinutesConfig;

export function readAttachmentPruneConfig(
  env: NodeJS.ProcessEnv = process.env,
): AttachmentPruneConfig {
  return readEveryMinutes(env, ATTACHMENT_PRUNE_EVERY_ENV, {
    defaultMinutes: DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES,
    minMinutes: MIN_ATTACHMENT_PRUNE_EVERY_MINUTES,
  });
}

/**
 * 行の掃除で消した件数を、1件以上のときだけ stderr に1行出す。0件の回は出さない（周期ごとにログが増えない。blob の掃除と同じ流儀）。
 * 日誌へは書かない: 周期の運用の行で DB（最大のテーブルが日誌）を増やさないため。写し（`pruneAttachmentCopies`）の件数は対象外。
 */
export function reportAttachmentPruned(pruned: number): void {
  if (pruned < 1) return;
  writeStderrLine(`alteroidd: 添付の期限掃除: 期限を過ぎた ${pruned} 件を消した\n`);
}

export interface AttachmentPrunerOptions {
  readonly stores: Pick<Stores, 'attachments'>;
  readonly everyMinutes: number | null;
  readonly copiesDir?: string;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly onResult?: (pruned: number) => void;
}

export interface AttachmentPruner {
  refresh(): Promise<number | null>;
  stop(): void;
}

export function startAttachmentPruning(options: AttachmentPrunerOptions): AttachmentPruner {
  if (options.everyMinutes === null) {
    return { refresh: async () => null, stop: () => {} };
  }
  const interval = clampedIntervalMs(options.intervalMs, options.everyMinutes);

  const pruneCopies = async (): Promise<void> => {
    if (options.copiesDir === undefined) return;
    try {
      await pruneAttachmentCopies(options.stores, options.copiesDir, options.now?.() ?? new Date());
    } catch (error: unknown) {
      writeStderrLine(`alteroidd: 添付の写しの掃除に失敗しました: ${reasonOf(error)}\n`);
    }
  };

  // バケットの列挙は事業者によって有料なので、1日に1回までにする。失敗しても時刻は戻さない: 毎周列挙し直さないため。
  let lastBlobSweepAt: number | undefined;
  const sweepOrphanBlobs = async (): Promise<void> => {
    const sweep = options.stores.attachments.sweepOrphanBlobs;
    if (sweep === undefined) return;
    const now = options.now?.() ?? new Date();
    if (
      lastBlobSweepAt !== undefined &&
      now.getTime() - lastBlobSweepAt < ATTACHMENT_BLOB_SWEEP_EVERY_MS
    ) {
      return;
    }
    lastBlobSweepAt = now.getTime();
    try {
      const result = await sweep.call(options.stores.attachments, now);
      if (result === undefined) return;
      const aborted = result.abortedUploads ?? 0;
      const abortFailed = result.abortFailedUploads ?? 0;
      if (result.removed > 0 || result.failed > 0 || aborted > 0 || abortFailed > 0) {
        const trouble =
          result.failed > 0
            ? `、${result.failed} 件は消せなかった（${result.reason ?? '理由不明'}）`
            : '';
        // 上げかけの部品は 0 件のとき文に出さない: 既存の文面を変えないため
        const uploads =
          aborted > 0 || abortFailed > 0
            ? `、未完了の分割アップロードを ${aborted} 件取り消した` +
              (abortFailed > 0
                ? `（${abortFailed} 件は取り消せなかった: ${result.reason ?? '理由不明'}）`
                : '')
            : '';
        writeStderrLine(
          `alteroidd: 添付の中身の掃除: 控えの無い ${result.removed} 件を消した${trouble}${uploads}\n`,
        );
      }
    } catch (error: unknown) {
      writeStderrLine(`alteroidd: 添付の中身の掃除に失敗しました: ${reasonOf(error)}\n`);
    }
  };

  // 本体の prune の成否にかかわらず写しの掃除も走らせる: 本体が落ちている間も写しを溜めないため。
  // 中身（blob）の掃除も同じ作法: 行の掃除が落ちていても、控えの無い blob は別の話のため。
  const pruneOnce = async (): Promise<number | null> => {
    let pruned: number | null = null;
    try {
      pruned = await options.stores.attachments.prune(options.now?.() ?? new Date());
    } catch (error: unknown) {
      writeStderrLine(`alteroidd: 添付ファイルの掃除に失敗しました: ${reasonOf(error)}\n`);
    }
    await pruneCopies();
    await sweepOrphanBlobs();
    if (pruned !== null) options.onResult?.(pruned);
    return pruned;
  };

  // 重ねない・止める・次の予約は `startPeriodicRun` が持つ
  return startPeriodicRun({ intervalMs: interval, signal: options.signal, run: pruneOnce });
}
