import { createMemoryStores, failingJournalAppend } from '@alteroid/core';
import type { StorageFootprint, TableSizeStats } from '@alteroid/storage-pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeBootFootprint,
  HEAP_SHARE_WARNING_RATIO,
  measureHeapSnapshot,
  reportBootFootprint,
  tablesExceedingHeapShare,
  type HeapSnapshot,
} from './boot-footprint.js';

/** 1表（区分）ぶんの「実測して0」。 */
function emptyStats(): TableSizeStats {
  return { rows: 0, storedBytes: 0, textBytes: 0, maxStoredBytes: 0, maxTextBytes: 0 };
}

/** 5表すべてが「実測して0」の、いちばん静かな状態。 */
function emptyFootprint(): StorageFootprint {
  return {
    jobs: emptyStats(),
    commitments: { open: emptyStats(), closed: emptyStats() },
    inboxEvents: { ...emptyStats(), maxDeliveries: 0 },
    journal: {
      all: { rows: 0, storedBytes: 0, textBytes: 0 },
      recent3d: { rows: 0, storedBytes: 0, textBytes: 0 },
    },
    archive: emptyStats(),
    measurementMs: 5,
  };
}

const heap: HeapSnapshot = {
  heapSizeLimitBytes: 1_000_000_000,
  heapUsedBytes: 100_000_000,
  rssBytes: 200_000_000,
};

describe('measureHeapSnapshot（本物の V8 から実測する）', () => {
  it('固定値ではなく、その場のプロセスから実測した正の数を返す', () => {
    const snapshot = measureHeapSnapshot();

    expect(snapshot.heapSizeLimitBytes).toBeGreaterThan(0);
    expect(snapshot.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.rssBytes).toBeGreaterThan(0);
    // used は limit を超えない（V8 が保証する側の関係——超えていたら既に OOM）。
    expect(snapshot.heapUsedBytes).toBeLessThan(snapshot.heapSizeLimitBytes);
  });
});

describe('tablesExceedingHeapShare（textBytes で判定する。storedBytes では判定しない）', () => {
  it('⭐ 何も超えていないのが正常な状態——発火しない', () => {
    expect(tablesExceedingHeapShare(emptyFootprint(), heap)).toEqual([]);
  });

  it('heap_size_limit の割合を超えた表だけを返す（textBytes 基準）', () => {
    const footprint = emptyFootprint();
    // ratio 既定 0.1 → 閾値 100,000,000。archive だけ超える。
    footprint.archive.textBytes = 200_000_000;
    footprint.jobs.textBytes = 50_000_000;

    const exceeding = tablesExceedingHeapShare(footprint, heap);

    expect(exceeding).toEqual([{ name: 'archive', textBytes: 200_000_000 }]);
  });

  /**
   * ⭐ **これが今回の欠陥そのものの回帰試験である。** `storedBytes`
   * （圧縮後。alteroid の実際の本文では実テキストの1/10〜1/80）だけを見て
   * いたら、この表は「小さい」と判定されて警告が出ない。**判定は
   * `textBytes` で行うので、`storedBytes` が小さくても `textBytes` が
   * 大きければ正しく発火する。**
   */
  it('storedBytes が小さくても textBytes が大きければ発火する（圧縮で危険度を見逃さない）', () => {
    const footprint = emptyFootprint();
    footprint.archive.storedBytes = 5_000; // 圧縮後は小さい（実際の観測どおり）
    footprint.archive.textBytes = 900_000_000; // 実テキストは heap の 90%

    const exceeding = tablesExceedingHeapShare(footprint, heap);

    expect(exceeding).toEqual([{ name: 'archive', textBytes: 900_000_000 }]);
  });

  it('同じ絶対バイト数でも、heap_size_limit が変われば超えるかどうかが変わる（固定バイト数の閾値ではない証拠）', () => {
    const footprint = emptyFootprint();
    footprint.archive.textBytes = 150_000_000;

    const smallHeap: HeapSnapshot = { ...heap, heapSizeLimitBytes: 1_000_000_000 }; // 閾値 100,000,000 → 超える
    const bigHeap: HeapSnapshot = { ...heap, heapSizeLimitBytes: 10_000_000_000 }; // 閾値 1,000,000,000 → 超えない

    expect(tablesExceedingHeapShare(footprint, smallHeap)).toHaveLength(1);
    expect(tablesExceedingHeapShare(footprint, bigHeap)).toHaveLength(0);
  });

  it('測れなかった（null）表は、どれだけ他が大きくても超過扱いにしない', () => {
    const footprint = emptyFootprint();
    footprint.archive.textBytes = null;
    footprint.archive.storedBytes = null;
    footprint.archive.rows = null;
    footprint.archive.maxStoredBytes = null;
    footprint.archive.maxTextBytes = null;

    expect(tablesExceedingHeapShare(footprint, heap)).toEqual([]);
  });

  it('割合は呼び出し側から指定できる（既定は HEAP_SHARE_WARNING_RATIO）', () => {
    const footprint = emptyFootprint();
    footprint.jobs.textBytes = 300_000_000; // heap の 30%

    expect(tablesExceedingHeapShare(footprint, heap, HEAP_SHARE_WARNING_RATIO)).toHaveLength(1);
    expect(tablesExceedingHeapShare(footprint, heap, 0.5)).toHaveLength(0);
  });
});

describe('describeBootFootprint（fs 構成 — null は「測れなかった」）', () => {
  it('pg 専用の SQL なので測れないと明記し、起動を止める内容にしない', () => {
    const report = describeBootFootprint(null, heap);

    expect(report.line).toContain('fs 構成のため測れない');
    expect(report.summary).toContain('fs 構成のため測れない');
    // ヒープはfs構成でも測れる情報なので出す。
    expect(report.line).toMatch(/heap\(limit=/);
  });
});

describe('describeBootFootprint（pg 構成）', () => {
  it('null（実測して0）と null（測れなかった）を混同しない表示になる（stored/text 両方）', () => {
    const footprint = emptyFootprint();
    footprint.archive.storedBytes = null;
    footprint.archive.textBytes = null;
    footprint.archive.rows = null;
    footprint.archive.maxStoredBytes = null;
    footprint.archive.maxTextBytes = null;

    const report = describeBootFootprint(footprint, heap);

    // 実測して0の表は数値として出る（stored/text 両方）。
    expect(report.summary).toMatch(
      /jobs\(rows=0 stored=0\.0MB text=0\.0MB maxStored=0\.0MB maxText=0\.0MB\)/,
    );
    // 測れなかった表は null と明記され、0MB のような数値にならない。
    expect(report.summary).toMatch(
      /archive\(rows=null stored=null text=null maxStored=null maxText=null\)/,
    );
    expect(report.summary).toContain(
      '測れなかった表（クエリが投げた・statement_timeout による打ち切りを含む）: archive',
    );
  });

  it('storedBytes と textBytes の両方が別欄として出る（片方に畳まない）', () => {
    const footprint = emptyFootprint();
    footprint.jobs.storedBytes = 5_000;
    footprint.jobs.textBytes = 456_000;

    const report = describeBootFootprint(footprint, heap);

    expect(report.summary).toContain(`stored=${(5_000 / 1024 / 1024).toFixed(1)}MB`);
    expect(report.summary).toContain(`text=${(456_000 / 1024 / 1024).toFixed(1)}MB`);
  });

  it('測定に掛かった時間（measurementMs）を標準出力と日誌の両方に出す', () => {
    const footprint = emptyFootprint();
    footprint.measurementMs = 1234;

    const report = describeBootFootprint(footprint, heap);

    expect(report.line).toContain('1234ms');
    expect(report.summary).toContain('1234ms');
  });

  it('⭐ 閾値を誰も超えていないのが正常——警告行は出ない', () => {
    const report = describeBootFootprint(emptyFootprint(), heap);

    expect(report.line).not.toContain('⚠');
    expect(report.summary).not.toContain('⚠');
  });

  it('閾値を超えた表があるときだけ、警告の1行が足される（門ではない——起動は止めない）', () => {
    const footprint = emptyFootprint();
    footprint.journal.all.textBytes = 900_000_000; // heap の 90%

    const report = describeBootFootprint(footprint, heap);

    expect(report.line).toContain('⚠');
    expect(report.line).toContain('journal.all');
    expect(report.summary).toContain('暫定値。オーナーが決めること');
    expect(report.summary).toContain('実テキストバイト基準');
  });

  it('標準出力用の1行は改行を含まない', () => {
    const footprint = emptyFootprint();
    footprint.journal.all.textBytes = 900_000_000;
    footprint.archive.rows = null;
    footprint.archive.storedBytes = null;
    footprint.archive.textBytes = null;
    footprint.archive.maxStoredBytes = null;
    footprint.archive.maxTextBytes = null;

    const report = describeBootFootprint(footprint, heap);

    expect(report.line).not.toContain('\n');
  });
});

describe('reportBootFootprint（標準出力と日誌の両方へ、起動を止めずに出す）', () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('標準出力に alteroidd: の1行を書く', async () => {
    const stores = createMemoryStores();

    await reportBootFootprint(stores, emptyFootprint());

    expect(stdout).toHaveBeenCalledTimes(1);
    const line = stdout.mock.calls[0]?.[0] as string;
    expect(line.startsWith('alteroidd: ')).toBe(true);
  });

  it('日誌に external_event（source=boot-storage-footprint）を起動1回につき1行残す', async () => {
    const stores = createMemoryStores();

    await reportBootFootprint(stores, emptyFootprint());

    const entries = await stores.journal.list();
    const footprintEntries = entries.filter(
      (entry) => entry.type === 'external_event' && entry.source === 'boot-storage-footprint',
    );
    expect(footprintEntries).toHaveLength(1);
  });

  it('fs 構成（footprint=null）でも同じ経路で1行ずつ残す', async () => {
    const stores = createMemoryStores();

    await reportBootFootprint(stores, null);

    expect(stdout).toHaveBeenCalledTimes(1);
    const entries = await stores.journal.list();
    expect(
      entries.filter(
        (entry) => entry.type === 'external_event' && entry.source === 'boot-storage-footprint',
      ),
    ).toHaveLength(1);
  });

  it('⛔ 日誌への追記が失敗しても投げない（起動を止めない）。標準出力へは既に書いている', async () => {
    const stores = failingJournalAppend(createMemoryStores(), '接続がまだ立ち上がっていない');

    await expect(reportBootFootprint(stores, emptyFootprint())).resolves.toBeUndefined();

    // 標準出力は日誌より先に書いているので、日誌が落ちても失われない。
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0] as string).toContain('日誌へ残せませんでした');
  });

  it('⛔ 測定・整形そのものが投げても、関数は投げない（外側の try/catch）', async () => {
    stdout.mockImplementation(() => {
      throw new Error('壊れた stdout（模擬）');
    });
    const stores = createMemoryStores();

    await expect(reportBootFootprint(stores, emptyFootprint())).resolves.toBeUndefined();

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0] as string).toContain('測定に失敗しました');
    // stdout が投げたので、この回に限っては日誌へも届いていない
    // （measureHeapSnapshot → 整形 → stdout.write → journal.append の順で
    // 外側の catch へ抜けるため）。それでも例外は外へ漏れていない——ここが
    // 主張したいことのすべてである。
    const entries = await stores.journal.list();
    expect(
      entries.filter(
        (entry) => entry.type === 'external_event' && entry.source === 'boot-storage-footprint',
      ),
    ).toHaveLength(0);
  });
});
