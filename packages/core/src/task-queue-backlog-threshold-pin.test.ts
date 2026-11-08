import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Task } from './schema.js';
import type { TaskList } from './store.js';
import { describeTaskBacklogAge } from './task-tools.js';

// 滞留の行（describeTaskBacklogAge）の「今の仕様」を固定する pin。今の作りで通る。
// 今の仕様: waiting は古さによらず 1 件でもあれば数える（しきい値なし）。needs_decision も古さによらず数える。
// 次のコミット（waiting は 24 時間を超えたものだけ数える）で、反転する箇所と変わらない箇所を分ける:
//   - 反転する（コメントに「反転」と書いた）: waiting が新しい／ちょうど 24 時間／updatedAt が読めない、のとき今は数える。次は数えない。
//   - 変わらない（コメントに「不変」と書いた）: needs_decision は古さによらず出る・読めない行も件数に入る・24 時間を超えた waiting は数える。
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

describe('滞留の行の今の仕様（pin。今の作りで通る）', () => {
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

  it('反転: 新しい waiting（1 時間前）を、今は数える', () => {
    expect(describeTaskBacklogAge(list([task('w', 'waiting', ago(HOUR))]), NOW)).toEqual([
      '- 滞留: waiting 1 件（最も古いのは 1時間0分前）',
    ]);
  });

  it('反転: ちょうど 24 時間の waiting を、今は数える', () => {
    expect(describeTaskBacklogAge(list([task('w', 'waiting', ago(DAY))]), NOW)).toEqual([
      '- 滞留: waiting 1 件（最も古いのは 1日0時間前）',
    ]);
  });

  it('反転: updatedAt が読めない waiting を、今は数える', () => {
    expect(describeTaskBacklogAge(list([task('w', 'waiting', 'not-a-date')]), NOW)).toEqual([
      '- 滞留: waiting 1 件（経過不明）',
    ]);
  });

  it('反転: 混在（needs_decision 3 件・waiting 5 件のうち 2 件が 24 時間超）で、今の waiting は 5 件', () => {
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
      '- 滞留: needs_decision 3 件（最も古いのは 3日0時間前） / waiting 5 件（最も古いのは 2日0時間前）',
    ]);
  });
});
