import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from './schema.js';
import type { TaskList } from './store.js';
import { BACKLOG_WAITING_STALE_MS, describeTaskBacklogAge } from './task-tools.js';

// 滞留の行（describeTaskBacklogAge）の waiting のしきい値の試験。
// 前のコミットは「今の仕様」（waiting は古さによらず 1 件でもあれば数える）を pin として置いた。このコミットで次のように動いた:
//   - 反転した（試験名に「反転」と書いた）: waiting が新しい／ちょうど 24 時間／updatedAt が読めない、のとき、前は数えた。いまは数えない。
//     混在の例（needs_decision 3 件・waiting 5 件）も、waiting は 5 件ではなく 24 時間を超えた 2 件になる。
//   - 変わらない（試験名に「不変」と書いた）: needs_decision は古さによらず出る・読めない行も件数に入る・24 時間を超えた waiting は数える。
// 時刻は `Date` だけを止める（実時間の待ちは足さない）。

const NOW = Date.parse('2026-11-01T09:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

function task(id: string, status: Task['status'], updatedAt: string): Task {
  return {
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    status,
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
  };
}

const list = (entries: Task[]): Pick<TaskList, 'entries'> => ({ entries });

describe('滞留の行: waiting は最後の更新から 24 時間を超えたものだけ数える', () => {
  it('不変: needs_decision は新しくても出る', () => {
    expect(
      describeTaskBacklogAge(list([task('n', 'needs_decision', ago(30 * 1000))]), NOW),
    ).toEqual(['- 滞留: needs_decision 1 件（最も古いのは 1分未満前）']);
  });

  it('不変: 24 時間を超えた waiting は数える（24 時間 + 1 分）', () => {
    expect(describeTaskBacklogAge(list([task('w', 'waiting', ago(DAY + MIN))]), NOW)).toEqual([
      '- 滞留: waiting 1 件（最も古いのは 1日0時間前）',
    ]);
  });

  it('不変: needs_decision の updatedAt が読めない行は件数に入る', () => {
    expect(describeTaskBacklogAge(list([task('n', 'needs_decision', 'xx')]), NOW)).toEqual([
      '- 滞留: needs_decision 1 件（経過不明）',
    ]);
  });

  it('反転: 新しい waiting（1 時間前）は数えない。needs_decision が無ければ行ごと出ない', () => {
    expect(describeTaskBacklogAge(list([task('w', 'waiting', ago(HOUR))]), NOW)).toEqual([]);
  });

  it('反転: 新しい waiting だけが並んでも出ない（全部 24 時間以内）', () => {
    const entries = [
      task('w1', 'waiting', ago(1 * MIN)),
      task('w2', 'waiting', ago(12 * HOUR)),
      task('w3', 'waiting', ago(23 * HOUR + 59 * MIN)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([]);
  });

  it('反転: ちょうど 24 時間の waiting は数えない（「超えた」ものだけ）', () => {
    expect(describeTaskBacklogAge(list([task('w', 'waiting', ago(DAY))]), NOW)).toEqual([]);
  });

  it('反転: ちょうど 24 時間の waiting は数えず、needs_decision だけが出る', () => {
    const entries = [task('n', 'needs_decision', ago(HOUR)), task('w', 'waiting', ago(DAY))];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: needs_decision 1 件（最も古いのは 1時間0分前）',
    ]);
  });

  it('反転: updatedAt が読めない waiting は数えない（確かめられないものを雑音にしない）', () => {
    const entries = [
      task('w1', 'waiting', 'not-a-date'),
      task('w2', 'waiting', ''),
      task('w3', 'waiting', ago(DAY + MIN)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: waiting 1 件（最も古いのは 1日0時間前）',
    ]);
  });

  it('反転: waiting が全部読めなければ行は出ない（「経過不明」の waiting も出さない）', () => {
    const entries = [task('w1', 'waiting', 'not-a-date'), task('w2', 'waiting', 'xx')];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([]);
  });

  it('不変: needs_decision の読めない行は件数に入り、waiting の読めない行は入らない（同じ並びで）', () => {
    const entries = [task('n', 'needs_decision', 'xx'), task('w', 'waiting', 'xx')];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: needs_decision 1 件（経過不明）',
    ]);
  });

  it('反転: 混在（needs_decision 3 件・waiting 5 件のうち 2 件が 24 時間超）で、waiting は 2 件・古さもその 2 件の最古', () => {
    const entries = [
      task('n1', 'needs_decision', ago(10 * MIN)),
      task('n2', 'needs_decision', ago(3 * DAY)),
      task('n3', 'needs_decision', ago(2 * HOUR)),
      task('w1', 'waiting', ago(5 * MIN)),
      task('w2', 'waiting', ago(2 * HOUR)),
      task('w3', 'waiting', ago(23 * HOUR)),
      task('w4', 'waiting', ago(2 * DAY)),
      task('w5', 'waiting', ago(DAY + 3 * HOUR)),
    ];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: needs_decision 3 件（最も古いのは 3日0時間前） / waiting 2 件（最も古いのは 2日0時間前）',
    ]);
  });

  it('waiting の最も古いのは、数えた waiting だけで言う（数えなかった新しい行は古さに入らない）', () => {
    const entries = [task('w-new', 'waiting', ago(MIN)), task('w-old', 'waiting', ago(DAY + HOUR))];
    expect(describeTaskBacklogAge(list(entries), NOW)).toEqual([
      '- 滞留: waiting 1 件（最も古いのは 1日1時間前）',
    ]);
  });

  describe('境目の描き分け（24 時間 + 経過）', () => {
    it.each([
      [1 * MIN, '1日0時間前'],
      [59 * MIN, '1日0時間前'],
      [1 * HOUR, '1日1時間前'],
      [3 * DAY, '4日0時間前'],
    ])('24 時間 + %i ms の waiting は「%s」', (extra, label) => {
      expect(describeTaskBacklogAge(list([task('w', 'waiting', ago(DAY + extra))]), NOW)).toEqual([
        `- 滞留: waiting 1 件（最も古いのは ${label}）`,
      ]);
    });
  });
});

describe('しきい値の定数（1 か所）', () => {
  it('値は 24 時間', () => {
    expect(BACKLOG_WAITING_STALE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('境目は定数に従う: 定数ちょうどは数えず、定数 + 1 分は数える（定数を変えれば境目が動く）', () => {
    const at = (elapsed: number) => list([task('w', 'waiting', ago(elapsed))]);
    expect(describeTaskBacklogAge(at(BACKLOG_WAITING_STALE_MS), NOW)).toEqual([]);
    expect(describeTaskBacklogAge(at(BACKLOG_WAITING_STALE_MS + MIN), NOW)).toHaveLength(1);
    expect(describeTaskBacklogAge(at(BACKLOG_WAITING_STALE_MS - MIN), NOW)).toEqual([]);
  });

  it('needs_decision には定数を掛けない（定数より新しくても出る）', () => {
    const entries = [task('n', 'needs_decision', ago(BACKLOG_WAITING_STALE_MS - HOUR))];
    expect(describeTaskBacklogAge(list(entries), NOW)).toHaveLength(1);
  });
});
