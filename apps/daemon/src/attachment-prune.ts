import { pruneAttachmentCopies, reasonOf, type Stores } from '@alteroid/core';

/**
 * 添付ファイル（`stores.attachments`。#3111 段1a）の保持期間の定期掃除。
 *
 * 形は `archive-folder.ts` と同じ（`setTimeout` チェーン・重ねない・`stop()`・`off` 系の綴りで外せる・
 * 例外でプロセスを落とさない）。掃除そのものは `AttachmentStore.prune(now)` に委ねる——期限切れ
 * （`expiresAt`）と、作成から1時間たっても発言へ結び付いていないものを消す。**日誌には書かない**
 * （添付は記憶ではなく、何も消えなかった周を記録しない。`archive-folder.ts` の同じ判断）。
 *
 * **`attachment_fetch` が手元へ置いた写し**（`copiesDir`）も同じ周で掃く——24時間より古いもの、
 * 元の添付が消えたもの。写しは正本ではないので消えてよい（`attachment-fetch.ts`）。
 */

/** `ALTEROID_ATTACHMENT_PRUNE_EVERY` を読む。値は分。 */
export const ATTACHMENT_PRUNE_EVERY_ENV = 'ALTEROID_ATTACHMENT_PRUNE_EVERY';

/** 周期の既定値（分）。暫定値で、`60` という数そのものに根拠は無い（`DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES` と同じ立場）。 */
export const DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES = 60;

/**
 * 周期の上限（ms）。**運用の上限ではなく、タイマーの仕様の範囲を守るためのもの**——
 * `setTimeout` は 2^31-1 ms（約24.8日）を超える遅延を 1ms へ倒すので、掃除が休みなく回ってしまう
 * （#3539）。#3535 の `MAX_ARCHIVE_FOLD_INTERVAL_MS`（#3534）と同じ形・同じ値で、core の
 * scratch-sweep の `MAX_*_MS` とも同じ値（あちらは core から公開されていないので、ここに持つ）。
 * `intervalMs`（テスト用の上書き）にも掛かる（#3535 と同じ）。
 */
export const MAX_ATTACHMENT_PRUNE_INTERVAL_MS = 2_147_483_647;

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
  /** `attachment_fetch` の写しの置き場（`attachmentCopiesDir(cwd)`）。無ければ写しは掃かない。 */
  readonly copiesDir?: string;
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
  const interval = Math.min(
    options.intervalMs ?? options.everyMinutes * 60_000,
    MAX_ATTACHMENT_PRUNE_INTERVAL_MS,
  );

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

  // 写しの掃除の失敗は、添付本体の掃除の結果を巻き込まない（逆も同じ。`runOnce` が両方を独立に走らせる）。
  const pruneCopies = async (): Promise<void> => {
    if (options.copiesDir === undefined) return;
    try {
      await pruneAttachmentCopies(options.stores, options.copiesDir, options.now?.() ?? new Date());
    } catch (error: unknown) {
      process.stderr.write(`alteroidd: 添付の写しの掃除に失敗しました: ${reasonOf(error)}\n`);
    }
  };

  const runOnce = (): Promise<number | null> => {
    // 重ねない。
    if (inFlight !== null) return inFlight;
    // 添付本体の prune の成否にかかわらず、写しの掃除も走らせる（本体が落ちている間も写しは溜めない）。
    inFlight = (async (): Promise<number | null> => {
      let pruned: number | null = null;
      try {
        pruned = await options.stores.attachments.prune(options.now?.() ?? new Date());
      } catch (error: unknown) {
        process.stderr.write(`alteroidd: 添付ファイルの掃除に失敗しました: ${reasonOf(error)}\n`);
      }
      await pruneCopies();
      if (pruned !== null) options.onResult?.(pruned);
      return pruned;
    })().finally(() => {
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
