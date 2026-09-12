import { describe, expect, it } from 'vitest';

import {
  compareManagerPosition,
  decodeManagerCursor,
  encodeManagerCursor,
  normalizeManagerCursorStatus,
  resolveManagerCursor,
  type ManagerPosition,
} from './manager-cursor.js';
import type { ManagerSummary } from './manager.js';
import type { JobStatus } from './schema.js';

/**
 * `resolveManagerCursor`（`manager_list` 絞った先の継続点）の分岐対応表。
 *
 * `commitment-cursor.test.ts` / `schedule-cursor.test.ts` と同じ形。
 *
 * | 分岐 | 内容 | 歯 |
 * | --- | --- | --- |
 * | B1 | `cursorRaw === undefined` → 絞らない（先頭から） | `B1: cursor 未指定は先頭から（絞らない）` |
 * | B2 | 壊れた cursor | `B2: 壊れた cursor は malformed` |
 * | B3 | `status` が食い違う | `B3: status が食い違う cursor は status-mismatch` |
 * | B4 | 有効な cursor | `B4: 有効な cursor はそれより後ろ（compareManagerPosition > 0）だけを残す` |
 * | B5 | cursor が末尾を指す | `B5: cursor が最後の行を指していれば view は空（最後の頁）` |
 * | B6 | 錨が指す行が別の群へ移っていても keyset で続きが決まる | `B6: 錨の行が消えていても比較だけで続きが決まる（実在検査をしない）` |
 */
function summary(
  managerId: string,
  status: JobStatus,
  startedAt: string,
  live = status === 'running' || status === 'waiting_human',
): ManagerSummary {
  return {
    managerId,
    status,
    live,
    cwd: '/workspace/repo',
    request: `依頼 ${managerId}`,
    startedAt,
    updatedAt: startedAt,
    waiting: [],
  };
}

/** テストの `positionOf`。rank は status からそのまま決める簡略版。 */
function positionOf(entry: ManagerSummary): ManagerPosition {
  const rank: 0 | 1 | 2 =
    entry.status === 'running' || entry.status === 'waiting_human'
      ? 0
      : entry.status === 'lost'
        ? 1
        : 2;
  // **副順位はこの足場では常に同値にする（Issue #857）。** ここで測っているのは
  // `rank` / `startedAt` / `managerId` の3つの比較であって、副順位ではない
  // ——同値にしておけば `compareManagerPosition` は次のキーへ落ちるので、
  // この節の測定条件は1バイトも変わらない。
  return { rank, judgementRank: 0, startedAt: entry.startedAt, managerId: entry.managerId };
}

describe('compareManagerPosition（部品）', () => {
  it('rank が違えば rank の昇順（0 が先）', () => {
    const a: ManagerPosition = {
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'z',
    };
    const b: ManagerPosition = {
      rank: 2,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'a',
    };
    expect(compareManagerPosition(a, b)).toBeLessThan(0);
    expect(compareManagerPosition(b, a)).toBeGreaterThan(0);
  });

  it('rank が同じなら startedAt の降順（新しいほうが先）', () => {
    const newer: ManagerPosition = {
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-02-01T00:00:00.000Z',
      managerId: 'x',
    };
    const older: ManagerPosition = {
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'x',
    };
    expect(compareManagerPosition(newer, older)).toBeLessThan(0);
    expect(compareManagerPosition(older, newer)).toBeGreaterThan(0);
  });

  it('rank と startedAt が同値なら managerId の昇順（破れ役）', () => {
    const a: ManagerPosition = {
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'a',
    };
    const b: ManagerPosition = {
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'b',
    };
    expect(compareManagerPosition(a, b)).toBeLessThan(0);
    expect(compareManagerPosition(b, a)).toBeGreaterThan(0);
    expect(compareManagerPosition(a, a)).toBe(0);
  });
});

describe('normalizeManagerCursorStatus（部品）', () => {
  it('未指定は null', () => {
    expect(normalizeManagerCursorStatus(undefined)).toBeNull();
  });

  it('空配列は null（manager_list の [] = 絞らない、に揃える）', () => {
    expect(normalizeManagerCursorStatus([])).toBeNull();
  });

  it('渡す順序が違っても、ソート済みの同じ配列になる', () => {
    expect(normalizeManagerCursorStatus(['waiting_human', 'running'])).toEqual([
      'running',
      'waiting_human',
    ]);
    expect(normalizeManagerCursorStatus(['running', 'waiting_human'])).toEqual([
      'running',
      'waiting_human',
    ]);
  });
});

describe('encodeManagerCursor / decodeManagerCursor（部品）', () => {
  it('符号化・復号の往復で中身が保たれる', () => {
    const cursor = {
      rank: 0 as const,
      judgementRank: 0 as const,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'mgr-1',
      status: null,
    };
    expect(decodeManagerCursor(encodeManagerCursor(cursor))).toEqual({ ok: true, cursor });
  });

  it('B2: 壊れた cursor は malformed', () => {
    expect(decodeManagerCursor('not-a-real-cursor')).toEqual({ ok: false });
  });

  it('schema に合わない cursor は malformed（rank が範囲外）', () => {
    const raw = Buffer.from(
      JSON.stringify({ rank: 9, startedAt: 'x', managerId: 'y', status: null }),
      'utf8',
    ).toString('base64url');
    expect(decodeManagerCursor(raw)).toEqual({ ok: false });
  });
});

describe('resolveManagerCursor（分岐）', () => {
  it('B1: cursor 未指定は先頭から（絞らない）', () => {
    const entries = [summary('a', 'running', '2026-01-03T00:00:00.000Z')];
    expect(resolveManagerCursor(entries, positionOf, null, undefined)).toEqual({
      kind: 'ok',
      view: entries,
    });
  });

  it('B2: 壊れた cursor は malformed', () => {
    const entries = [summary('a', 'running', '2026-01-03T00:00:00.000Z')];
    expect(resolveManagerCursor(entries, positionOf, null, 'garbage')).toEqual({
      kind: 'malformed',
    });
  });

  it('B3: status が食い違う cursor は status-mismatch', () => {
    const entries = [summary('a', 'running', '2026-01-03T00:00:00.000Z')];
    const cursor = encodeManagerCursor({
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'seed',
      status: ['running'],
    });

    const result = resolveManagerCursor(entries, positionOf, null, cursor);

    expect(result).toEqual({ kind: 'status-mismatch', cursorStatus: ['running'] });
  });

  it('B3（往復）: 同じ status で発行された cursor は食い違わない', () => {
    const entries = [summary('a', 'running', '2026-01-03T00:00:00.000Z')];
    const cursor = encodeManagerCursor({
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      managerId: 'seed',
      status: ['running'],
    });

    const result = resolveManagerCursor(entries, positionOf, ['running'], cursor);

    expect(result.kind).toBe('ok');
  });

  it('B4: 有効な cursor はそれより後ろ（compareManagerPosition > 0）だけを残す', () => {
    // 3群・startedAt 降順で既に並んでいる前提（tools.ts の attention と同じ並び）。
    const entries = [
      summary('mgr-run-new', 'running', '2026-01-05T00:00:00.000Z'),
      summary('mgr-run-old', 'running', '2026-01-04T00:00:00.000Z'),
      summary('mgr-lost', 'lost', '2026-01-03T00:00:00.000Z'),
      summary('mgr-done', 'done', '2026-01-02T00:00:00.000Z'),
    ];
    const cursor = encodeManagerCursor({
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-04T00:00:00.000Z',
      managerId: 'mgr-run-old',
      status: null,
    });

    const result = resolveManagerCursor(entries, positionOf, null, cursor);

    expect(result).toEqual({
      kind: 'ok',
      view: [entries[2], entries[3]],
    });
  });

  it('B5: cursor が最後の行を指していれば view は空（最後の頁）', () => {
    const entries = [summary('mgr-done', 'done', '2026-01-02T00:00:00.000Z')];
    const cursor = encodeManagerCursor({
      rank: 2,
      judgementRank: 0,
      startedAt: '2026-01-02T00:00:00.000Z',
      managerId: 'mgr-done',
      status: null,
    });

    expect(resolveManagerCursor(entries, positionOf, null, cursor)).toEqual({
      kind: 'ok',
      view: [],
    });
  });

  it('B6: 錨の行が消えていても比較だけで続きが決まる（実在検査をしない）', () => {
    // 錨（mgr-run-old）が一覧から消えた後（manager_stop 等）の状態を模す。
    const entries = [
      summary('mgr-lost', 'lost', '2026-01-03T00:00:00.000Z'),
      summary('mgr-done', 'done', '2026-01-02T00:00:00.000Z'),
    ];
    const cursor = encodeManagerCursor({
      rank: 0,
      judgementRank: 0,
      startedAt: '2026-01-04T00:00:00.000Z',
      managerId: 'mgr-run-old',
      status: null,
    });

    const result = resolveManagerCursor(entries, positionOf, null, cursor);

    expect(result).toEqual({ kind: 'ok', view: entries });
  });
});
