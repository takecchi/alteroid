import { reasonOf, type Stores } from '@alteroid/core';

/**
 * 添付ファイル（`stores.attachments`。#3111 段1a）の保持期間の定期掃除。
 *
 * 形は `archive-folder.ts` と同じ（`setTimeout` チェーン・重ねない・`stop()`・`off` 系の綴りで外せる・
 * 例外でプロセスを落とさない）。掃除そのものは `AttachmentStore.prune(now)` に委ねる——期限切れ
 * （`expiresAt`）と、作成から1時間たっても発言へ結び付いていないものを消す。**日誌には書かない**
 * （添付は記憶ではなく、何も消えなかった周を記録しない。`archive-folder.ts` の同じ判断）。
 */

/** `ALTEROID_ATTACHMENT_PRUNE_EVERY` を読む。値は分。 */
export const ATTACHMENT_PRUNE_EVERY_ENV = 'ALTEROID_ATTACHMENT_PRUNE_EVERY';

/** 周期の既定値（分）。暫定値で、`60` という数そのものに根拠は無い（`DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES` と同じ立場）。 */
export const DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES = 60;

/** `archive-folder.ts` の `OFF` と綴りを揃えてある。 */
const OFF = new Set(['off', 'none', 'false', '0']);

export interface AttachmentPruneConfig {
  /** `null` なら周期を仕込まない。 */
  readonly everyMinutes: number | null;
  /** 読めなかった設定値についての注意（呼び出し元が人間に見せる）。 */
  readonly notes: string[];
}

export function readAttachmentPruneConfig(
  env: NodeJS.ProcessEnv = process.env,
): AttachmentPruneConfig {
  const notes: string[] = [];
  const raw = env[ATTACHMENT_PRUNE_EVERY_ENV]?.trim();
  let everyMinutes: number | null = DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES;
  if (raw !== undefined && raw.length > 0) {
    if (OFF.has(raw.toLowerCase())) {
      everyMinutes = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        notes.push(
          `${ATTACHMENT_PRUNE_EVERY_ENV}="${raw}" は分数として読めないので既定 ` +
            `${DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES} を使う`,
        );
      } else {
        everyMinutes = parsed;
      }
    }
  }
  return { everyMinutes, notes };
}

export interface AttachmentPrunerOptions {
  readonly stores: Pick<Stores, 'attachments'>;
  /** `readAttachmentPruneConfig().everyMinutes`。`null` なら周期を仕込まない。 */
  readonly everyMinutes: number | null;
  /** テスト用。指定すると `everyMinutes` から求めた間隔を上書きする。 */
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  /** 1周終わるたびに呼ぶ（消した件数）。 */
  readonly onResult?: (pruned: number) => void;
}

export interface AttachmentPruner {
  /** いま1周走らせる（テスト用）。`off` のとき・失敗したときは `null`。 */
  refresh(): Promise<number | null>;
  stop(): void;
}

export function startAttachmentPruning(options: AttachmentPrunerOptions): AttachmentPruner {
  if (options.everyMinutes === null) {
    return { refresh: async () => null, stop: () => {} };
  }
  const interval = options.intervalMs ?? options.everyMinutes * 60_000;

  let inFlight: Promise<number | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  const runOnce = (): Promise<number | null> => {
    // 重ねない。
    if (inFlight !== null) return inFlight;
    inFlight = options.stores.attachments
      .prune(options.now?.() ?? new Date())
      .then((pruned) => {
        options.onResult?.(pruned);
        return pruned;
      })
      .catch((error: unknown) => {
        process.stderr.write(`alteroidd: 添付ファイルの掃除に失敗しました: ${reasonOf(error)}\n`);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce().then(() => schedule(interval));
    }, delay);
    timer.unref?.();
  };

  // 起動直後に1回。待たない。
  void runOnce().then(() => schedule(interval));

  return { refresh: runOnce, stop };
}
