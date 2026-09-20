import {
  ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
  chunkIdsByChars,
  guardArchiveRemoval,
  selectArchiveRemovalTargets,
  type ArchiveEntry,
  type ManagerPool,
  type Stores,
} from '@alteroid/core';

/**
 * 退避済み生ログ（`archive`）の古い写しを、デーモンが定期的に自動で畳む
 * （tombstone する）（issue #698）。
 *
 * ## なぜ要るか
 *
 * `#onPreCompact` は compaction のたびに生ログ**全文**を積み直すので、k 回目の
 * 退避は (k-1) 回目を丸ごと含む（O(N²)）。畳んでよいかどうかを積む瞬間に判定して
 * 記録する門（`packages/core/src/archive-continuity.ts` の `classifyArchiveContinuity`）
 * と、実際に畳む純関数（`packages/core/src/archive-prune.ts` の
 * `selectArchiveRemovalTargets`）、人間の入口（`POST /archive/remove`）、
 * クローンの道具（`archive_remove_many`）はすでに揃っているが、**どれも
 * 「誰かが呼ばないと動かない」**——書き側（`#onPreCompact`）は無条件に積み続ける
 * ので、自動で刈る側が1つも無いことが残っている穴だった。この PR がそれを塞ぐ。
 *
 * ## 判断のロジックは1行も書かない
 *
 * 選定は `selectArchiveRemovalTargets`、走行中の委譲の保護は
 * `guardArchiveRemoval`（`packages/core/src/manager.ts`）に**そのまま**委ねる——
 * ここで新しい選定ロジックは書かない。手本は `apps/daemon/src/app.ts` の
 * `POST /archive/remove` ハンドラで、guard を dryRun 分岐（＝ここには無い）より
 * 前で回す理由・一括 UPDATE にしない理由・塊ごとに「消す→日誌」を交互にする
 * 理由は、すべてあちらのコメントがそのまま当てはまる。
 *
 * ## `requireContainment: true` を固定する
 *
 * 自動の口に `false` を開ける道は作らない——`POST /archive/remove` ですら
 * `false` は `sessionIds` を名指ししたときだけである。⟹ 畳むのは「新しい行が
 * 古い行を先頭から丸ごと含むと証明できた行」だけであり、**読めるものは
 * 1バイトも減らない。**
 */

/** `ALTEROID_ARCHIVE_FOLD_EVERY` を読む。値は分。 */
export const ARCHIVE_FOLD_EVERY_ENV = 'ALTEROID_ARCHIVE_FOLD_EVERY';

/**
 * 自動で畳む周期の既定値（分）。
 *
 * **暫定値である。** `DEFAULT_MEMORY_TIDY_AT`（`apps/daemon/src/schedule.ts`）と
 * 同じ立場で、`60` という数そのものに根拠は無い。選び方の制約は「頻繁すぎて
 * `archive.list()` の全件走査を無駄に繰り返さない」ことだけで、それ以上の
 * 最適化は行っていない。**足りなければここを短くする**（環境変数
 * `ALTEROID_ARCHIVE_FOLD_EVERY` で人間が動かせる）。
 */
export const DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES = 60;

/**
 * 猶予（grace）——積まれた直後の行を掃除の対象にしない。
 *
 * `before` にこの猶予を引いた時刻を渡すことで、書き込み（`#onPreCompact` が
 * `archive()` を呼ぶ瞬間）と掃除（この一周が `list()` を読む瞬間）が競らない
 * ようにする。**この値そのものにも根拠は無い**——「1周期（既定60分）よりは
 * 十分短く、かつ人間が体感で『ついさっき』と思う幅よりは長い」という感覚以上の
 * 検証はしていない。
 */
export const ARCHIVE_FOLD_GRACE_MS = 10 * 60_000;

/**
 * `off` / `none` / `false` / `0` で止められる。**綴りは
 * `apps/daemon/src/schedule.ts` の `OFF` と揃えてある**（同じ集合を作り直して
 * いるだけで、あちらを import はしていない——`schedule.ts` の `OFF` は
 * export されておらず、この定期処理は `ScheduleStore` の一員でもないため、
 * 別の集合として持つのが素直である。綴りが割れると人間が覚えることが増える
 * ので、値だけは必ず揃えること）。
 */
const OFF = new Set(['off', 'none', 'false', '0']);

function value(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

export interface ArchiveFoldConfig {
  /** `null` なら周期を仕込まない。 */
  readonly everyMinutes: number | null;
  /** 読めなかった設定値についての注意（呼び出し元が人間に見せる）。 */
  readonly notes: string[];
}

/**
 * `ALTEROID_ARCHIVE_FOLD_EVERY` を読む。**`apps/daemon/src/schedule.ts` の
 * `readScheduleConfig` と同じ作法**（`OFF` で外せる／読めない値は `notes` へ
 * 落として既定へ倒す）。
 */
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
      } else {
        everyMinutes = parsed;
      }
    }
  }
  return { everyMinutes, notes };
}

/**
 * `foldArchiveOnce` の戻り値。
 *
 * **`skipped` は0件でも欄を省かない**（`ArchiveRemovalSelection` の doc と同じ
 * 理由。逐語: `grep -Fn -- '`skipped` は0件でも欄を省かない' packages/core/src/archive-prune.ts`）。
 *
 * **不変条件（歯で撃つこと）:**
 * ```
 * matched === folded + remaining + skipped.newest + skipped.alreadyRemoved
 *            + skipped.notContained + skipped.protected + skipped.inUse + raced
 * ```
 * 理由は `POST /archive/remove` の同じ不変条件と同じ——`folded` は guard を
 * 通った後・実際に `remove()` が効いた件数であって `selection.targets.length`
 * ではない。guard で飛ばした行を `skipped.inUse` にも `folded` にも二重に
 * 数えないこと。`raced` は guard までは通ったが `remove()` するまでの間に
 * 他経路が先に消していた行（0件でも欄を省かない）。
 */
export interface FoldArchiveOnceResult {
  /** `archive.list()` の総行数（絞り込み前）。 */
  readonly totalRows: number;
  /** `before` の絞り込みに当たった行数。 */
  readonly matched: number;
  /** 実際に畳んだ（tombstone した）件数。 */
  readonly folded: number;
  /** 畳んだ行の `removedBytes` の合計。 */
  readonly foldedBytes: number;
  /** `matched` のうち `limit` に溢れて対象に入らなかった件数。 */
  readonly remaining: number;
  readonly skipped: {
    readonly newest: number;
    readonly alreadyRemoved: number;
    readonly notContained: number;
    readonly protected: number;
    /** 走行中のマネージャーが抱えていたので飛ばした件数（`guardArchiveRemoval`）。 */
    readonly inUse: number;
  };
  /**
   * guard までは通ったが、実際に `remove()` するまでの間に他経路が先に
   * 消していた件数（`POST /archive/remove` の欠陥3と同じ形）。0件でも欄を
   * 省かない。
   */
  readonly raced: number;
}

export interface FoldArchiveOnceOptions {
  readonly stores: Pick<Stores, 'archive' | 'sessions' | 'journal'>;
  /**
   * 走行中の委譲が抱える行を落とすための判定所（`guardArchiveRemoval`）が
   * 読む像。**判定所は1箇所だけ**——ここで新しい保護ロジックを書かない。
   * `undefined` なら安全側に倒して全件を保護扱いにする（`guardArchiveRemoval`
   * の `kind: 'unknown'` 分岐）。
   */
  readonly managers: Pick<ManagerPool, 'runningManagerOwning'> | undefined;
  /** テスト用。既定は `() => new Date()`。 */
  readonly now?: () => Date;
  /** テスト用。既定は {@link ARCHIVE_FOLD_GRACE_MS}。 */
  readonly graceMs?: number;
  /** テスト用。既定は `ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT`。 */
  readonly limit?: number;
}

/**
 * 1周ぶんの処理。テストから直接呼べる（`startArchiveFolding` はこれを
 * 定期的に呼ぶ薄いラッパーでしかない）。
 *
 * ```
 * entries   = await archive.list()
 * grave     = await sessions.getTranscriptGrave()
 * selection = selectArchiveRemovalTargets(entries, { before: <now - grace> }, {
 *               requireContainment: true,
 *               limit: ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
 *               protectedIds: grave === null ? [] : [grave.archiveId],
 *             })
 * ```
 *
 * **走行中の委譲が抱える行を落とす（判定所は1箇所だけ）。** guard は
 * `selectArchiveRemovalTargets` の直後、実際に `remove()` する前に回す
 * （`POST /archive/remove` が dryRun 分岐より前で回すのと同じ理由——ここには
 * dryRun という分岐自体が無いが、「選定してから guard、guard の後で初めて
 * 副作用を起こす」という順序そのものは変わらない）。
 *
 * **塊ごとに「消す→その塊の id を日誌へ書く」を交互に回す**
 * （`POST /archive/remove` と同じ理由——まとめて消してから日誌を書くと、その
 * 間にデーモンが落ちたとき「消えたのに記録が無い行」ができる）。
 *
 * **1件も畳まなかった周は、日誌へ1行も書かない。** Issue #903 の教訓——
 * 「捨てると決めた合図」について万単位の行を日誌へ足す形で同じ DB を太らせた
 * 反省を踏まえ、この定期処理は「何もしなかった」ことを日誌に記録しない
 * （何もしなかったことは `refresh()` の戻り値と、次の観測用の口が知っていれば
 * 足りる。日誌は「起きたこと」の記録であって「起きなかったことの記録」の
 * 置き場ではない）。
 *
 * **冪等**——`removedAt` が付いた行は `selection.skipped.alreadyRemoved` に
 * 落ちるので、2周目は同じ行を消しにいかない。
 */
export async function foldArchiveOnce(
  options: FoldArchiveOnceOptions,
): Promise<FoldArchiveOnceResult> {
  const now = options.now?.() ?? new Date();
  const graceMs = options.graceMs ?? ARCHIVE_FOLD_GRACE_MS;
  const before = new Date(now.getTime() - graceMs).toISOString();

  const entries = await options.stores.archive.list();
  // **墓標を守る**（issue #698 追補3。`POST /archive/remove` と同じ理由）。
  const grave = await options.stores.sessions.getTranscriptGrave();
  const protectedIds = grave === null ? [] : [grave.archiveId];

  // **絞りと選定は `selectArchiveRemovalTargets` に閉じる**——ここで独自の
  // 判定を書かない（`matchesArchiveRemoveManyFilter` の doc と同じ境界線）。
  const selection = selectArchiveRemovalTargets(
    entries,
    { before },
    {
      requireContainment: true,
      limit: options.limit ?? ARCHIVE_REMOVE_MANY_LIMIT_DEFAULT,
      protectedIds,
    },
  );

  // **走行中の委譲が抱えている行は自動では畳まない。** `denied` / `unknown` は
  // どちらも安全側に倒して飛ばす。`overrideReason` は渡さない——自動の口に
  // override を開ける道は作らない（`guardArchiveRemoval` の doc「一括の口で
  // 理由を1本だけ書いて全件を開けると、『どの1件をなぜ開けたか』が記録から
  // 消える」がここにも当てはまる。自動実行にはそもそも「理由」の主体が無い）。
  const foldableTargets: ArchiveEntry[] = [];
  let skippedInUse = 0;
  for (const target of selection.targets) {
    const guard = guardArchiveRemoval(options.managers, target.id, undefined);
    if (guard.kind === 'denied' || guard.kind === 'unknown') {
      skippedInUse += 1;
      continue;
    }
    foldableTargets.push(target);
  }

  // 塊ごとに「消す → その塊の id を日誌へ書く」を交互に回す（`POST /archive/remove`
  // と同じ理由）。実行は `stores.archive.remove(id)` を1件ずつ——一括 UPDATE には
  // しない（`packages/storage-pg` / `packages/storage-fs` を1文字も変えない）。
  const chunks = chunkIdsByChars(
    foldableTargets.map((row) => row.id),
    ARCHIVE_REMOVE_MANY_JOURNAL_ID_CHARS,
  );
  const foldedIds: string[] = [];
  let foldedBytes = 0;
  let raced = 0;
  for (const [index, chunk] of chunks.entries()) {
    const chunkIds = new Set(chunk);
    const chunkTargets = foldableTargets.filter((row) => chunkIds.has(row.id));
    const foldedThisChunk: string[] = [];
    for (const target of chunkTargets) {
      const result = await options.stores.archive.remove(target.id);
      if (result.kind === 'missing') {
        // list() で見つかり guard も通ったのに、実際に remove() するまでの間に
        // 他経路が先に消していた（#698 欠陥3と同じ形）。隠さず raced へ数える。
        raced += 1;
        continue;
      }
      foldedThisChunk.push(target.id);
      // `already`（冪等な再実行）はバイト数を二重に数えない。
      if (result.kind === 'removed') foldedBytes += result.bytes;
    }
    foldedIds.push(...foldedThisChunk);
    // **1件も畳まなかった塊は日誌へ書かない。** 1周まるごと0件だった場合は
    // このループ自体が0回（`chunks` が空）なので、`chunks.entries()` が1周
    // 回ってしまう心配は無い（`chunkIdsByChars([], …)` は空配列を返す）。
    if (foldedThisChunk.length === 0) continue;
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
  }

  return {
    totalRows: selection.totalRows,
    matched: selection.matched,
    folded: foldedIds.length,
    foldedBytes,
    remaining: selection.remaining,
    skipped: { ...selection.skipped, inUse: skippedInUse },
    raced,
  };
}

export interface ArchiveFolderOptions {
  readonly stores: Pick<Stores, 'archive' | 'sessions' | 'journal'>;
  readonly managers: Pick<ManagerPool, 'runningManagerOwning'> | undefined;
  /** `readArchiveFoldConfig().everyMinutes`。`null` なら周期を仕込まない。 */
  readonly everyMinutes: number | null;
  /** テスト用。指定すると `everyMinutes` から求めた間隔を上書きする。 */
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly graceMs?: number;
  readonly limit?: number;
  /** 外から畳む（デーモンの終了時）。 */
  readonly signal?: AbortSignal;
  /** 1周終わるたびに呼ぶ（主にログ・テスト用）。畳まなかった周にも呼ぶ。 */
  readonly onResult?: (result: FoldArchiveOnceResult) => void;
}

export interface ArchiveFolder {
  /**
   * いま1周走らせる（テスト用。本番はタイマーが自動で回す）。**`off` のときは
   * 何もせず `null` を返す**——1周走らせた結果、失敗して測れなかったときも
   * 同じく `null` を返す（`usage-poller.ts` の「取れなかったことで、取れていた
   * 値を捨てない」とは違い、ここは周ごとに独立した処理なので前回の値を持ち
   * 越さない）。
   */
  refresh(): Promise<FoldArchiveOnceResult | null>;
  stop(): void;
}

/**
 * `usage-poller.ts` の `startUsagePolling` / `manager-poller.ts` の
 * `startManagerPolling` と同じ形——`setTimeout` チェーン・前の回が終わる前に
 * 次を始めない・`stop()` を持つ。
 *
 * **`everyMinutes === null`（`off`）なら、タイマーを1つも仕込まない。**
 * `stop()` は常に安全に呼べる形にしてある——配線側（`index.ts`）が on/off を
 * 気にせず一律に `archiveFolder.stop()` を呼べるようにするため。
 *
 * **例外でプロセスを落とさない。** `foldArchiveOnce` が投げても `.catch()` で
 * 握り、stderr へ1行出して次の周期へ進む——1周の失敗でこのポーラーごと
 * 止まらない。
 */
export function startArchiveFolding(options: ArchiveFolderOptions): ArchiveFolder {
  if (options.everyMinutes === null) {
    return {
      refresh: async () => null,
      stop: () => {},
    };
  }
  const interval = options.intervalMs ?? options.everyMinutes * 60_000;

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
    // 重ねない。前の回がまだ回っている間は次を始めない。
    if (inFlight !== null) return inFlight;
    inFlight = foldArchiveOnce({
      stores: options.stores,
      managers: options.managers,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    })
      .then((result) => {
        options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: 退避済み生ログの自動畳み込みに失敗しました: ${String(error)}\n`,
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
    // 観測が終了を引き止めないように。
    timer.unref?.();
  };

  // 起動直後に1回。**待たない**——デーモンの起動をこの周期に縛らない。
  void runOnce().then(() => schedule(interval));

  return {
    refresh: runOnce,
    stop,
  };
}
