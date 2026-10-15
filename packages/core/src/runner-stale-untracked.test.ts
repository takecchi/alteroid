import { describe, expect, it } from 'vitest';

import {
  describeStaleUntracked,
  STALE_UNTRACKED_NOTICE_INTERVAL_MS,
  StaleUntrackedNotices,
} from './runner-stale-untracked.js';

const tree = (over: Partial<Parameters<typeof describeStaleUntracked>[0][number]> = {}) => ({
  relativePath: 'repo',
  count: 2,
  paths: ['a.png', 'b.png'],
  oldestSinceMs: 0,
  ...over,
});

describe('describeStaleUntracked', () => {
  it('作業ツリーの相対パス・件数・パスと「止める指示ではない」を添える', () => {
    const text = describeStaleUntracked([tree()]);
    expect(text).toContain('（repo の 2 件: a.png, b.png）');
    expect(text).toContain('$ALTEROID_OUTBOX');
    expect(text).toContain('止める指示ではない');
  });

  it('パスが 5 件を超えるときは「ほか N 件」、相対パスが空なら . と出す', () => {
    const text = describeStaleUntracked([
      tree({ relativePath: '', count: 8, paths: ['1', '2', '3', '4', '5'] }),
    ]);
    expect(text).toContain('（. の 8 件: 1, 2, 3, 4, 5 ほか 3 件）');
  });

  it('作業ツリーは「、」で並べ、3 本を超えたら「ほか N 本」', () => {
    const text = describeStaleUntracked(
      ['a', 'b', 'c', 'd', 'e'].map((relativePath) => tree({ relativePath })),
    );
    expect(text).toContain('a の 2 件: a.png, b.png、b の 2 件: a.png, b.png、c の 2 件');
    expect(text).toContain('、ほか 2 本）');
    expect(text).not.toContain('d の');
  });
});

describe('StaleUntrackedNotices', () => {
  it('同じ相手へは 30 分に 1 回まで。相手が違えば別に数える', () => {
    const notices = new StaleUntrackedNotices();
    expect(notices.next('manager', [tree()], 0)).not.toBeNull();
    expect(notices.next('manager', [tree()], STALE_UNTRACKED_NOTICE_INTERVAL_MS - 1)).toBeNull();
    expect(notices.next('agent-1', [tree()], 1)).not.toBeNull();
    expect(notices.next('manager', [tree()], STALE_UNTRACKED_NOTICE_INTERVAL_MS)).not.toBeNull();
  });

  it('古いものが無くなったら覚えを捨て、次に生じたときは間隔を待たずに添える', () => {
    const notices = new StaleUntrackedNotices();
    expect(notices.next('manager', [tree()], 0)).not.toBeNull();
    expect(notices.next('manager', [], 1_000)).toBeNull();
    expect(notices.next('manager', [tree()], 2_000)).not.toBeNull();
  });
});
