import { getHeapStatistics } from 'node:v8';

import type { Stores } from '@alteroid/core';
import type { StorageFootprint, TableSizeStats } from '@alteroid/storage-pg';

/**
 * 起動時の器の実寸とヒープの検知（#1283、段2。呼び出し元は `storage.ts` の
 * `openStorage()`——`apps/daemon/src/index.ts` の `main()` が最初に呼ぶので、
 * 重い読み（`jobs.listJobs()` / `commitments.list()` 等）より必ず前に走る）。
 *
 * ## これは何のためにあるか
 *
 * 本番の clone が起動から約35秒で V8 のヒープを使い切って落ちた（#1283）。
 * #1284 が原因になりうる口を1つ（`session_entries`）塞いだが、**原因そのものは
 * 特定できていない**——落ちたスタックトレースに JS のフレームが1行も無い。
 * 調査で、起動経路から上限なしで `jsonb` 本文を全行読む口が、#1283
 * のリストの外にさらに2つ見つかっている（`jobs.listJobs()` の段2、
 * `commitments.list({ includeClosed: true })`）——`storage-pg` の
 * `footprint.ts` の doc に詳細がある。⟹ **問題は口の個数ではなく、単調に
 * 伸び続け・削除経路を持たず・全件を本文ごと読む表が複数あるという構造**
 * である。
 *
 * **この構造そのものはここでは塞がない。** ここが足すのは検知だけ——起動の
 * たびに「そのとき表は実際に何バイトだったか」「ヒープの天井と使用量は
 * いくつだったか」を、標準出力（落ちる瞬間のログに残る）と日誌（落ちた後でも
 * クローンが読み返せる、起動1回につき1行）の両方に残す。
 *
 * ## この検知が答えられないこと（⚠️ 読み違えないこと）
 *
 * - **どの表が実際に OOM を起こした JSON.parse を呼んだかは、この検知からは
 *   言えない。** ここは起動の入口で1回スナップショットを取るだけで、その後の
 *   読み込みと結び付けてはいない。
 * - **`openStorage()` より前に落ちたら、ここには何も残らない。** V8 の
 *   ヒープ初期化や依存モジュールの読み込みそのものが重ければ、この関数へ
 *   到達する前に落ちうる。
 * - **これは何も直していない。** #1283 が挙げた口も、ここで新しく見つかった
 *   2つの口も、1つも塞いでいない——閾値の警告も含めて、すべて既存の挙動を
 *   変えずに「見えるようにする」だけである。
 */

/** ヒープの実測（`node:v8` / `process.memoryUsage()`）。**実行時に取る。固定値は書かない。** */
export interface HeapSnapshot {
  /** V8 の old space の上限（バイト）。`--max-old-space-size` / `NODE_OPTIONS` / 既定で変わる。 */
  heapSizeLimitBytes: number;
  /** いま実際に使っているヒープ（バイト）。 */
  heapUsedBytes: number;
  /** プロセス全体の常駐サイズ（バイト）。ヒープの外（Buffer 等）も含む。 */
  rssBytes: number;
}

/** その場のプロセスから実測する。固定値・環境変数の決め打ちは一切しない。 */
export function measureHeapSnapshot(): HeapSnapshot {
  const heap = getHeapStatistics();
  const mem = process.memoryUsage();
  return {
    heapSizeLimitBytes: heap.heap_size_limit,
    heapUsedBytes: mem.heapUsed,
    rssBytes: mem.rss,
  };
}

/**
 * 表の合計バイトが `heap_size_limit` のこの割合を超えたら警告する。
 *
 * 🔴 **暫定値。オーナーが決めること。** ここは門ではない——超えても起動は
 * 止めない。1本の警告行が増えるだけである（下の `describeBootFootprint`）。
 *
 * 算術（#1284 が 512 MiB を決めた形をそのまま踏襲——固定バイト数ではなく
 * `heap_size_limit` に対する割合にしてあるのは、天井が環境変数
 * （`NODE_OPTIONS`）で変わるため。#1284 の直前まで実際に 4144 MB だった）:
 * 起動時にこの表を `LIMIT` 無しで全行読む口が実在する
 * （`jobs.listJobs()` の段2 / `commitments.list({ includeClosed: true })`）
 * → 読めば本文がそのまま JS のメモリへ載る → `JSON.parse` の展開倍率
 * （#1284 と同じ経験則で 2〜4倍。**プロファイラでは測っていない**）を掛けると、
 * 表の合計バイトの**10%**が heap_size_limit を超えている状態は、フルに
 * 読まれた瞬間に heap_size_limit の 20〜40% を1表だけで持っていくおそれが
 * ある、という大まかな安全域として選んだ。**⭐ 発火しないのが正常**
 * （#1284 の同じ思想）——発火したら、それは「危険域に入った」であって
 * 「もう落ちた」ではない。
 */
export const HEAP_SHARE_WARNING_RATIO = 0.1;

interface NamedTableBytes {
  name: string;
  bytes: number | null;
}

function namedBytesOf(footprint: StorageFootprint): NamedTableBytes[] {
  return [
    { name: 'jobs', bytes: footprint.jobs.bytes },
    { name: 'commitments.open', bytes: footprint.commitments.open.bytes },
    { name: 'commitments.closed', bytes: footprint.commitments.closed.bytes },
    { name: 'inbox_events', bytes: footprint.inboxEvents.bytes },
    { name: 'journal.all', bytes: footprint.journal.all.bytes },
    { name: 'archive', bytes: footprint.archive.bytes },
  ];
}

/** `heap_size_limit` に対する割合で超過している表の名前とバイト数。 */
export function tablesExceedingHeapShare(
  footprint: StorageFootprint,
  heap: HeapSnapshot,
  ratio: number = HEAP_SHARE_WARNING_RATIO,
): { name: string; bytes: number }[] {
  const threshold = heap.heapSizeLimitBytes * ratio;
  const result: { name: string; bytes: number }[] = [];
  for (const { name, bytes } of namedBytesOf(footprint)) {
    if (bytes !== null && bytes > threshold) result.push({ name, bytes });
  }
  return result;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** `null`（測れなかった）と数値（実測。0 を含む）を取り違えない表示。 */
function statOrNull(value: number | null): string {
  return value === null ? 'null' : mb(value);
}

function rowsOrNull(value: number | null): string {
  return value === null ? 'null' : String(value);
}

function describeStat(label: string, stat: TableSizeStats): string {
  return `${label}(rows=${rowsOrNull(stat.rows)} bytes=${statOrNull(stat.bytes)} maxBytes=${statOrNull(stat.maxBytes)})`;
}

function describeHeap(heap: HeapSnapshot): string {
  return `heap(limit=${mb(heap.heapSizeLimitBytes)} used=${mb(heap.heapUsedBytes)} rss=${mb(heap.rssBytes)})`;
}

/** 標準出力用の1行と、日誌用の詳しい要旨。 */
export interface BootFootprintReport {
  /** `alteroidd: ` の後ろに続ける、1行ぶんの要約。改行を含まない。 */
  line: string;
  /** 日誌（`external_event.summary`）へそのまま渡す、複数行の詳しい記録。 */
  summary: string;
}

/**
 * 起動時の器の実寸とヒープの報告を組み立てる（副作用なし。純粋に文字列を作る）。
 *
 * `footprint` が `null` なのは fs 構成（pg 専用の SQL なので測れない）。
 * `StorageFootprint` の中の個々の欄が `null` なのは、その表（区分）の測定
 * そのものが投げた場合——`storage-pg` の `measureStorageFootprint` の doc。
 */
export function describeBootFootprint(
  footprint: StorageFootprint | null,
  heap: HeapSnapshot,
  ratio: number = HEAP_SHARE_WARNING_RATIO,
): BootFootprintReport {
  const heapPart = describeHeap(heap);

  if (footprint === null) {
    return {
      line: `起動時の器の実寸: ${heapPart}; pg 表は fs 構成のため測れない`,
      summary: [
        '起動時の器の実寸とヒープ（#1283 の続き。段2。検知のみ・何も直していない）',
        heapPart,
        '表の実寸: fs 構成のため測れない（pg 専用の SQL。能力を削らず、測れなかったとして起動を続けた）',
      ].join('\n'),
    };
  }

  const tableParts = [
    describeStat('jobs', footprint.jobs),
    describeStat('commitments.open', footprint.commitments.open),
    describeStat('commitments.closed', footprint.commitments.closed),
    `inbox_events(rows=${rowsOrNull(footprint.inboxEvents.rows)} bytes=${statOrNull(
      footprint.inboxEvents.bytes,
    )} maxBytes=${statOrNull(footprint.inboxEvents.maxBytes)} maxDeliveries=${rowsOrNull(
      footprint.inboxEvents.maxDeliveries,
    )})`,
    `journal.all(rows=${rowsOrNull(footprint.journal.all.rows)} bytes=${statOrNull(footprint.journal.all.bytes)})`,
    `journal.recent3d(rows=${rowsOrNull(footprint.journal.recent3d.rows)} bytes=${statOrNull(
      footprint.journal.recent3d.bytes,
    )})`,
    describeStat('archive', footprint.archive),
  ];

  const exceeding = tablesExceedingHeapShare(footprint, heap, ratio);
  const warningLine =
    exceeding.length === 0
      ? undefined
      : `⚠ heap_size_limit の ${(ratio * 100).toFixed(0)}%（暫定値。オーナーが決めること）を超えた表: ` +
        exceeding.map((t) => `${t.name}=${mb(t.bytes)}`).join(', ');

  const unmeasurable = namedBytesOf(footprint)
    .filter((t) => t.bytes === null)
    .map((t) => t.name);
  const unmeasurableLine =
    unmeasurable.length === 0
      ? undefined
      : `測れなかった表（クエリが投げた）: ${unmeasurable.join(', ')}`;

  return {
    line:
      `起動時の器の実寸: ${heapPart}; ${tableParts.join('; ')}` +
      (warningLine === undefined ? '' : `; ${warningLine}`) +
      (unmeasurableLine === undefined ? '' : `; ${unmeasurableLine}`),
    summary: [
      '起動時の器の実寸とヒープ（#1283 の続き。段2。検知のみ・何も直していない）',
      heapPart,
      ...tableParts,
      ...(warningLine === undefined ? [] : [warningLine]),
      ...(unmeasurableLine === undefined ? [] : [unmeasurableLine]),
    ].join('\n'),
  };
}

/**
 * 標準出力と日誌の両方へ出す（呼び出し元は `storage.ts` の `openStorage()`）。
 *
 * ⛔ **これは起動を止めない。** 日誌への追記が失敗しても（記憶ストアが
 * 接続直後で不安定、等）、それを stderr へ書くだけで投げ直さない——測定・
 * 報告のどちらも失敗しても起動処理はそのまま続く。
 *
 * **標準出力と日誌の両方に出すのは意図である。** 標準出力は「落ちる瞬間の
 * ログ」に残るが、クローン自身はそれを読めない（`journal_read` のような
 * 道具が無い）。**落ちた後に「どの表が何 MB だったか」を読み返せるのは
 * 日誌だけ**——だから日誌には起動1回につき1行、必ず残す（既存の
 * `stores.journal.append` の口に足すだけで、日誌の行を消す・書き換える
 * 配線には一切触れない）。
 */
export async function reportBootFootprint(
  stores: Stores,
  footprint: StorageFootprint | null,
): Promise<void> {
  try {
    const heap = measureHeapSnapshot();
    const report = describeBootFootprint(footprint, heap);

    process.stdout.write(`alteroidd: ${report.line}\n`);

    await stores.journal
      .append({ type: 'external_event', source: 'boot-storage-footprint', summary: report.summary })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: 起動時の器の実寸を日誌へ残せませんでした: ${String(error)}\n`,
        );
      });
  } catch (error) {
    // 測定そのもの（heap の取得・文字列の組み立て）が投げても起動は続ける。
    process.stderr.write(`alteroidd: 起動時の器の実寸の測定に失敗しました: ${String(error)}\n`);
  }
}
