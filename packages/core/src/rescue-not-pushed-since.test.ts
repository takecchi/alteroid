import { describe, expect, it } from 'vitest';

import { mergeRescue } from './manager.js';
import type { LastRescue, RescueWorktree } from './schema.js';
import { describeRescue } from './tools.js';

const tooLarge = (at: string, extra: Partial<RescueWorktree> = {}): RescueWorktree => ({
  relativePath: 'repo',
  branch: 'feat/twintail',
  at,
  instanceId: 'inst-1',
  notPushed: { reason: 'too-large' },
  ...extra,
});

const summaryOf = (lastRescue: LastRescue) =>
  ({ lastRescue }) as unknown as Parameters<typeof describeRescue>[0];

describe('退避できていない理由の起点（notPushed.since。#5117）', () => {
  it('⭐ 同じ器で同じ理由が続く間は、最初に見た時刻を起点に引き継ぐ（運び直しで行の at が進んでも）', () => {
    const first = mergeRescue(
      undefined,
      [tooLarge('2026-10-20T22:02:27.000Z')],
      '2026-10-20T22:02:28.000Z',
    );
    const resent = mergeRescue(
      first,
      [tooLarge('2026-10-20T22:32:27.000Z')],
      '2026-10-20T22:32:28.000Z',
    );

    expect(resent.worktrees[0]?.at).toBe('2026-10-20T22:32:27.000Z');
    expect(resent.worktrees[0]?.notPushed?.since).toBe('2026-10-20T22:02:27.000Z');
  });

  it('理由が変われば起点を取り直す', () => {
    const first = mergeRescue(
      undefined,
      [tooLarge('2026-10-20T22:02:27.000Z')],
      '2026-10-20T22:02:28.000Z',
    );
    const changed = mergeRescue(
      first,
      [
        tooLarge('2026-10-20T22:10:00.000Z', {
          notPushed: { reason: 'push-failed', failureKind: 'network' },
        }),
      ],
      '2026-10-20T22:10:01.000Z',
    );

    expect(changed.worktrees[0]?.notPushed?.since).toBe('2026-10-20T22:10:00.000Z');
  });

  it('器が替われば同じ理由でも起点を取り直す（前の器の分とは別の出来事）', () => {
    const first = mergeRescue(
      undefined,
      [tooLarge('2026-10-20T22:02:27.000Z')],
      '2026-10-20T22:02:28.000Z',
    );
    const swapped = mergeRescue(
      first,
      [tooLarge('2026-10-20T22:40:00.000Z', { instanceId: 'inst-2' })],
      '2026-10-20T22:40:01.000Z',
    );

    expect(swapped.worktrees[0]?.notPushed?.since).toBe('2026-10-20T22:40:00.000Z');
  });

  it('送れた回は起点を消し、また送れなくなったらその回から数え直す', () => {
    const first = mergeRescue(
      undefined,
      [tooLarge('2026-10-20T22:02:27.000Z')],
      '2026-10-20T22:02:28.000Z',
    );
    const pushed = mergeRescue(
      first,
      [
        {
          relativePath: 'repo',
          branch: 'feat/twintail',
          at: '2026-10-20T22:10:00.000Z',
          instanceId: 'inst-1',
          pushed: {
            ref: 'refs/alteroid-rescue/x/repo',
            commit: 'abc',
            at: '2026-10-20T22:10:00.000Z',
          },
        },
      ],
      '2026-10-20T22:10:01.000Z',
    );
    expect(pushed.worktrees[0]?.notPushed).toBeUndefined();

    const again = mergeRescue(
      pushed,
      [tooLarge('2026-10-20T22:20:00.000Z')],
      '2026-10-20T22:20:01.000Z',
    );
    expect(again.worktrees[0]?.notPushed?.since).toBe('2026-10-20T22:20:00.000Z');
  });
});

describe('manager_list の退避の行に、送れていない理由と続いている時間を出す（#5117）', () => {
  const now = new Date('2026-10-20T22:25:27.000Z');

  it('⭐ too-large が続いている作業ツリーを、起点の時刻と続いている分・取れる手つきで出す', () => {
    const rescue = mergeRescue(
      undefined,
      [tooLarge('2026-10-20T22:02:27.000Z')],
      '2026-10-20T22:02:28.000Z',
    );

    const line = describeRescue(summaryOf(rescue), 'brief', now);

    expect(line).toContain(
      '退避できていない: repo（too-large。2026-10-20T22:02:27.000Z から・23分続いている）。担当が push すれば消えずに済む',
    );
  });

  it('いちばん長く続いている1本と、残りの本数だけを出す', () => {
    const rescue = mergeRescue(
      undefined,
      [
        tooLarge('2026-10-20T22:20:00.000Z', { relativePath: 'legs' }),
        tooLarge('2026-10-20T22:02:27.000Z'),
        tooLarge('2026-10-20T22:15:00.000Z', {
          relativePath: 'play-boy',
          notPushed: { reason: 'push-failed', failureKind: 'network' },
        }),
      ],
      '2026-10-20T22:20:01.000Z',
    );

    const line = describeRescue(summaryOf(rescue), 'brief', now) ?? '';

    expect(line).toContain(
      '退避できていない: repo（too-large。2026-10-20T22:02:27.000Z から・23分続いている） ほか 2 本',
    );
    expect(line).not.toContain('legs（');
  });

  it('送るものが無い（nothing-tracked）・生きている間に消えた・前の器の行は数えない', () => {
    const rescue: LastRescue = {
      at: '2026-10-20T22:20:01.000Z',
      worktrees: [
        tooLarge('2026-10-20T22:20:00.000Z', {
          relativePath: 'clean',
          notPushed: { reason: 'nothing-tracked' },
        }),
        tooLarge('2026-10-20T22:10:00.000Z', {
          relativePath: 'gone',
          goneAt: '2026-10-20T22:15:00.000Z',
        }),
        tooLarge('2026-10-20T20:00:00.000Z', { relativePath: 'old-box', instanceId: 'inst-0' }),
      ],
    };

    expect(describeRescue(summaryOf(rescue), 'brief', now)).not.toContain('退避できていない');
  });

  it('full の各行にも、起点の時刻を添える', () => {
    const rescue = mergeRescue(
      undefined,
      [tooLarge('2026-10-20T22:02:27.000Z')],
      '2026-10-20T22:02:28.000Z',
    );

    expect(describeRescue(summaryOf(rescue), 'full')).toContain(
      '（2026-10-20T22:02:27.000Z から続いている）',
    );
  });
});
