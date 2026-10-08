import {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  chunkIdsByChars,
  guardArchiveRemoval,
  noteDroppedRecord,
  reasonOf,
  selectArchiveRemovalTargets,
  type ArchiveEntry,
  type ManagerPool,
  type Stores,
} from '@alteroid/core';

export const ARCHIVE_FOLD_EVERY_ENV = 'ALTEROID_ARCHIVE_FOLD_EVERY';

export const DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES = 60;

// `before` から猶予を引く: 書き込み（`#onPreCompact` の `archive()`）と掃除（この一周の `list()`）が競らないようにするため。
export const ARCHIVE_FOLD_GRACE_MS = 10 * 60_000;

// 上限は 2^31-1 ms: `setTimeout` はそれを超える遅延を 1ms へ倒し、畳み込みが全行走査を休みなく回してしまうため。
export const MAX_ARCHIVE_FOLD_INTERVAL_MS = 2_147_483_647;

// 下限は 1 分: これを許すと `0.00001` のような値で `setTimeout` が 1ms へ倒れ、畳み込みが全行走査を休みなく回すため。切り上げて採るのではなく既定へ倒す（添付の掃除の読み取りと同じ作法）。
export const MIN_ARCHIVE_FOLD_EVERY_MINUTES = 1;

// 綴りは `schedule.ts` の `OFF` と揃える: 綴りが割れると人間が覚えることが増えるため。
const OFF = new Set(['off', 'none', 'false', '0']);

function value(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

export interface ArchiveFoldConfig {
  readonly everyMinutes: number | null;
  readonly notes: string[];
}

export function readArchiveFoldConfig(env: NodeJS.ProcessEnv = process.env): ArchiveFoldConfig {
  const notes: string[] = [];
  const raw = value(env[ARCHIVE_FOLD_EVERY_ENV]);
  let everyMinutes: number | null = DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES;
  if (raw !== undefined) {
    if (OFF.has(raw.toLowerCase())) {
      everyMinutes = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        notes.push(
          `${ARCHIVE_FOLD_EVERY_ENV}="${raw}" は分数として読めないので既定 ` +
            `${DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES} を使う`,
        );
      } else if (parsed < MIN_ARCHIVE_FOLD_EVERY_MINUTES) {
        notes.push(
          `${ARCHIVE_FOLD_EVERY_ENV}="${raw}" は下限 ${MIN_ARCHIVE_FOLD_EVERY_MINUTES} 分を下回っているので既定 ` +
            `${DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES} を使う`,
        );
      } else {
        everyMinutes = parsed;
      }
    }
  }
  return { everyMinutes, notes };
}

export interface FoldArchiveOnceResult {
  readonly totalRows: number;
  readonly matched: number;
  readonly folded: number;
  readonly foldedBytes: number;
  readonly remaining: number;
  readonly skipped: {
    readonly newest: number;
    readonly alreadyRemoved: number;
    readonly notContained: number;
    readonly protected: number;
    readonly inUse: number;
  };
  readonly raced: number;
  readonly journalDroppedIds: readonly string[];
}

export interface FoldArchiveOnceOptions {
  readonly stores: Pick<Stores, 'archive' | 'sessions' | 'journal'>;
  // 判定所は `guardArchiveRemoval` の1箇所だけにする: ここで新しい保護ロジックを書かない。
  readonly managers:
    Pick<ManagerPool, 'runningManagerOwning' | 'runningManagerPinning'> | undefined;
  readonly now?: () => Date;
  readonly graceMs?: number;
  readonly limit?: number;
}

// 1件も畳まなかった周は日誌へ書かない: 「何もしなかった」ことの記録で DB を太らせないため。
export async function foldArchiveOnce(
  options: FoldArchiveOnceOptions,
): Promise<FoldArchiveOnceResult> {
  const now = options.now?.() ?? new Date();
  const graceMs = options.graceMs ?? ARCHIVE_FOLD_GRACE_MS;
  const before = new Date(now.getTime() - graceMs).toISOString();

  const entries = await options.stores.archive.list();
  const grave = await options.stores.sessions.getTranscriptGrave();
  const protectedIds = grave === null ? [] : [grave.archiveId];

  const selection = selectArchiveRemovalTargets(
    entries,
    { before },
    {
      requireContainment: true,
      limit: options.limit ?? ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
      protectedIds,
    },
  );

  // `overrideReason` は渡さない: 自動の口に override を開ける道は作らないため。
  // `requireContainment` は常に `true`: 含有が証明済みの行だけが対象で、保護を `archiveIds` の末尾1本へ狭めないと、走行中の委譲の写しが1本残らず保護され自動畳みが1件も進まないため。
  const foldableTargets: ArchiveEntry[] = [];
  let skippedInUse = 0;
  for (const target of selection.targets) {
    const guard = guardArchiveRemoval(options.managers, target.id, undefined, true);
    if (guard.kind === 'denied' || guard.kind === 'unknown') {
      skippedInUse += 1;
      continue;
    }
    foldableTargets.push(target);
  }

  // 塊ごとに「消す → 日誌」を交互に回す: まとめて消してから日誌を書くと、その間にデーモンが落ちたとき、消えたのに記録が無い行ができるため。
  const chunks = chunkIdsByChars(
    foldableTargets.map((row) => row.id),
    ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  );
  const foldedIds: string[] = [];
  let foldedBytes = 0;
  let raced = 0;
  const journalDroppedIds: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const chunkIds = new Set(chunk);
    const chunkTargets = foldableTargets.filter((row) => chunkIds.has(row.id));
    const foldedThisChunk: string[] = [];
    for (const target of chunkTargets) {
      const result = await options.stores.archive.remove(target.id);
      if (result.kind === 'missing' || result.kind === 'already') {
        // `already` も raced に数える: 選んだ後に他経路が消した回で、この呼びが消したことにしない（触っていない id を応答・日誌に載せない）。
        raced += 1;
        continue;
      }
      foldedThisChunk.push(target.id);
      foldedBytes += result.bytes;
    }
    foldedIds.push(...foldedThisChunk);
    if (foldedThisChunk.length === 0) continue;
    // 日誌が落ちても残りの塊へ進む: この塊の本文はもう消えていて（不可逆）、やり直せないため。
    try {
      await options.stores.journal.append({
        type: 'decision',
        decision:
          'デーモンが退避済み生ログの古い写しを自動で畳んだ（issue #698。' +
          `${index + 1}/${chunks.length} 塊目、この塊は ${foldedThisChunk.length} 件）\n` +
          `絞り込み: before=${before}\n` +
          `畳んだ id: ${foldedThisChunk.join(' ')}`,
        grounds:
          `${ARCHIVE_FOLD_EVERY_ENV} による定期実行。requireContainment: true ` +
          '（新しい行が古い行を先頭から丸ごと含むと証明できた行だけを畳んだ。' +
          '読めるものは1バイトも減っていない）。',
      });
    } catch (error) {
      journalDroppedIds.push(...foldedThisChunk);
      noteDroppedRecord(
        '退避済み生ログの自動畳みの日誌',
        `chunk=${index + 1}/${chunks.length} count=${foldedThisChunk.length}`,
        error,
      );
    }
  }

  return {
    totalRows: selection.totalRows,
    matched: selection.matched,
    folded: foldedIds.length,
    foldedBytes,
    remaining: selection.remaining,
    skipped: { ...selection.skipped, inUse: skippedInUse },
    raced,
    journalDroppedIds,
  };
}

export interface ArchiveFolderOptions {
  readonly stores: Pick<Stores, 'archive' | 'sessions' | 'journal'>;
  readonly managers:
    Pick<ManagerPool, 'runningManagerOwning' | 'runningManagerPinning'> | undefined;
  readonly everyMinutes: number | null;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly graceMs?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly onResult?: (result: FoldArchiveOnceResult) => void;
}

export interface ArchiveFolder {
  refresh(): Promise<FoldArchiveOnceResult | null>;
  stop(): void;
}

// `off` でも `stop()` を常に安全に呼べる形にする: 配線側が on/off を気にせず一律に呼べるようにするため。
export function startArchiveFolding(options: ArchiveFolderOptions): ArchiveFolder {
  if (options.everyMinutes === null) {
    return {
      refresh: async () => null,
      stop: () => {},
    };
  }
  const interval = Math.min(
    options.intervalMs ?? options.everyMinutes * 60_000,
    MAX_ARCHIVE_FOLD_INTERVAL_MS,
  );

  let inFlight: Promise<FoldArchiveOnceResult | null> | null = null;
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

  const runOnce = (): Promise<FoldArchiveOnceResult | null> => {
    if (inFlight !== null) return inFlight;
    inFlight = foldArchiveOnce({
      stores: options.stores,
      managers: options.managers,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
      .then((result) => {
        if (result.journalDroppedIds.length > 0) {
          process.stderr.write(
            `alteroidd: 退避済み生ログを ${result.folded} 件畳んだが、うち ${result.journalDroppedIds.length} 件は日誌に書けなかった\n`,
          );
        }
        options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: 退避済み生ログの自動畳み込みに失敗しました: ${reasonOf(error)}\n`,
        );
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

  void runOnce().then(() => schedule(interval));

  return {
    refresh: runOnce,
    stop,
  };
}
