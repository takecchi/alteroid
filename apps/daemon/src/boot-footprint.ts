import { getHeapStatistics } from 'node:v8';

import { reasonOf, type Stores } from '@alteroid/core';
import type { StorageFootprint, TableSizeStats } from '@alteroid/storage-pg';

export interface HeapSnapshot {
  heapSizeLimitBytes: number;
  heapUsedBytes: number;
  rssBytes: number;
}

export function measureHeapSnapshot(): HeapSnapshot {
  const heap = getHeapStatistics();
  const mem = process.memoryUsage();
  return {
    heapSizeLimitBytes: heap.heap_size_limit,
    heapUsedBytes: mem.heapUsed,
    rssBytes: mem.rss,
  };
}

// 固定バイト数ではなく `heap_size_limit` に対する割合にする: 天井が環境変数（`NODE_OPTIONS`）で変わるため。
// `storedBytes` ではなく `textBytes` で比べる: `storedBytes` は圧縮後で、いちばん危ない表をいちばん小さく報告することになるため。
export const HEAP_SHARE_WARNING_RATIO = 0.1;

interface NamedTextBytes {
  name: string;
  textBytes: number | null;
}

function namedTextBytesOf(footprint: StorageFootprint): NamedTextBytes[] {
  return [
    { name: 'jobs', textBytes: footprint.jobs.textBytes },
    { name: 'commitments.open', textBytes: footprint.commitments.open.textBytes },
    { name: 'commitments.closed', textBytes: footprint.commitments.closed.textBytes },
    { name: 'inbox_events', textBytes: footprint.inboxEvents.textBytes },
    { name: 'journal.all', textBytes: footprint.journal.all.textBytes },
    { name: 'archive', textBytes: footprint.archive.textBytes },
  ];
}

export function tablesExceedingHeapShare(
  footprint: StorageFootprint,
  heap: HeapSnapshot,
  ratio: number = HEAP_SHARE_WARNING_RATIO,
): { name: string; textBytes: number }[] {
  const threshold = heap.heapSizeLimitBytes * ratio;
  const result: { name: string; textBytes: number }[] = [];
  for (const { name, textBytes } of namedTextBytesOf(footprint)) {
    if (textBytes !== null && textBytes > threshold) result.push({ name, textBytes });
  }
  return result;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function statOrNull(value: number | null): string {
  return value === null ? 'null' : mb(value);
}

function rowsOrNull(value: number | null): string {
  return value === null ? 'null' : String(value);
}

// `stored=` と `text=` を並べて出す: どちらか片方に畳まないため。
function describeStat(label: string, stat: TableSizeStats): string {
  return (
    `${label}(rows=${rowsOrNull(stat.rows)} ` +
    `stored=${statOrNull(stat.storedBytes)} text=${statOrNull(stat.textBytes)} ` +
    `maxStored=${statOrNull(stat.maxStoredBytes)} maxText=${statOrNull(stat.maxTextBytes)})`
  );
}

function describeJournalWindow(
  label: string,
  window: { rows: number | null; storedBytes: number | null; textBytes: number | null },
): string {
  return (
    `${label}(rows=${rowsOrNull(window.rows)} ` +
    `stored=${statOrNull(window.storedBytes)} text=${statOrNull(window.textBytes)})`
  );
}

function describeHeap(heap: HeapSnapshot): string {
  return `heap(limit=${mb(heap.heapSizeLimitBytes)} used=${mb(heap.heapUsedBytes)} rss=${mb(heap.rssBytes)})`;
}

export interface BootFootprintReport {
  line: string;
  summary: string;
}

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

  const measurementPart = `measurement(${footprint.measurementMs}ms)`;

  const tableParts = [
    describeStat('jobs', footprint.jobs),
    describeStat('commitments.open', footprint.commitments.open),
    describeStat('commitments.closed', footprint.commitments.closed),
    `inbox_events(rows=${rowsOrNull(footprint.inboxEvents.rows)} ` +
      `stored=${statOrNull(footprint.inboxEvents.storedBytes)} text=${statOrNull(footprint.inboxEvents.textBytes)} ` +
      `maxStored=${statOrNull(footprint.inboxEvents.maxStoredBytes)} maxText=${statOrNull(footprint.inboxEvents.maxTextBytes)} ` +
      `maxDeliveries=${rowsOrNull(footprint.inboxEvents.maxDeliveries)})`,
    describeJournalWindow('journal.all', footprint.journal.all),
    describeJournalWindow('journal.recent3d', footprint.journal.recent3d),
    describeStat('archive', footprint.archive),
  ];

  const exceeding = tablesExceedingHeapShare(footprint, heap, ratio);
  const warningLine =
    exceeding.length === 0
      ? undefined
      : `⚠ heap_size_limit の ${(ratio * 100).toFixed(0)}%（実テキストバイト基準。暫定値。オーナーが決めること）を超えた表: ` +
        exceeding.map((t) => `${t.name}=${mb(t.textBytes)}`).join(', ');

  const unmeasurable = namedTextBytesOf(footprint)
    .filter((t) => t.textBytes === null)
    .map((t) => t.name);
  const unmeasurableLine =
    unmeasurable.length === 0
      ? undefined
      : `測れなかった表（クエリが投げた・statement_timeout による打ち切りを含む）: ${unmeasurable.join(', ')}`;

  return {
    line:
      `起動時の器の実寸: ${heapPart} ${measurementPart}; ${tableParts.join('; ')}` +
      (warningLine === undefined ? '' : `; ${warningLine}`) +
      (unmeasurableLine === undefined ? '' : `; ${unmeasurableLine}`),
    summary: [
      '起動時の器の実寸とヒープ（#1283 の続き。段2。検知のみ・何も直していない）',
      heapPart,
      measurementPart,
      ...tableParts,
      ...(warningLine === undefined ? [] : [warningLine]),
      ...(unmeasurableLine === undefined ? [] : [unmeasurableLine]),
    ].join('\n'),
  };
}

// 標準出力と日誌の両方に出す: クローンは標準出力を読めず、落ちた後に表のサイズを読み返せるのは日誌だけのため。
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
          `alteroidd: 起動時の器の実寸を日誌へ残せませんでした: ${reasonOf(error)}\n`,
        );
      });
  } catch (error) {
    process.stderr.write(`alteroidd: 起動時の器の実寸の測定に失敗しました: ${reasonOf(error)}\n`);
  }
}
