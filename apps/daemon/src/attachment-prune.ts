import { pruneAttachmentCopies, reasonOf, type Stores } from '@alteroid/core';

export const ATTACHMENT_PRUNE_EVERY_ENV = 'ALTEROID_ATTACHMENT_PRUNE_EVERY';

export const DEFAULT_ATTACHMENT_PRUNE_EVERY_MINUTES = 60;

// 上限は 2^31-1 ms: `setTimeout` はそれを超える遅延を 1ms へ倒し、掃除が休みなく回ってしまうため。
export const MAX_ATTACHMENT_PRUNE_INTERVAL_MS = 2_147_483_647;

// 下限は 1 分: これを許すと `0.00001` のような値で `setTimeout` が 1ms へ倒れ、DELETE と readdir が休みなく回るため。切り上げて採るのではなく既定へ倒す（添付の上限の読み取りと同じ作法）。
export const MIN_ATTACHMENT_PRUNE_EVERY_MINUTES = 1;

const OFF = new Set(['off', 'none', 'false', '0']);

export interface AttachmentPruneConfig {
  readonly everyMinutes: number | null;
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
      } else if (parsed < MIN_ATTACHMENT_PRUNE_EVERY_MINUTES) {
        notes.push(
          `${ATTACHMENT_PRUNE_EVERY_ENV}="${raw}" は下限 ${MIN_ATTACHMENT_PRUNE_EVERY_MINUTES} 分を下回っているので既定 ` +
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

  const pruneCopies = async (): Promise<void> => {
    if (options.copiesDir === undefined) return;
    try {
      await pruneAttachmentCopies(options.stores, options.copiesDir, options.now?.() ?? new Date());
    } catch (error: unknown) {
      process.stderr.write(`alteroidd: 添付の写しの掃除に失敗しました: ${reasonOf(error)}\n`);
    }
  };

  const runOnce = (): Promise<number | null> => {
    if (inFlight !== null) return inFlight;
    // 本体の prune の成否にかかわらず写しの掃除も走らせる: 本体が落ちている間も写しを溜めないため。
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

  void runOnce().then(() => schedule(interval));

  return { refresh: runOnce, stop };
}
