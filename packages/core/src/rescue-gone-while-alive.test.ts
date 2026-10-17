import { describe, expect, it } from 'vitest';

import { markRescueGoneWhileAlive } from './rescue-cleanup.js';
import { mergeRescue } from './manager.js';
import type { LastRescue, LastUnpushedWorkObservation, RescueWorktree } from './schema.js';
import { workspaceCloneHintsFrom } from './workspace-swap-hints.js';

const RESCUED_AT = '2026-10-05T01:00:00.000Z';
const SEEN_AT = '2026-10-05T01:10:00.000Z';

function tree(overrides: Partial<RescueWorktree> = {}): RescueWorktree {
  return {
    relativePath: 'work/a',
    branch: 'feat/a',
    at: RESCUED_AT,
    instanceId: 'inst-A',
    pushed: {
      ref: 'refs/alteroid-rescue/mgr-1/a-1234abcd',
      commit: 'a'.repeat(40),
      at: RESCUED_AT,
    },
    ...overrides,
  };
}

function rescueOf(...worktrees: RescueWorktree[]): LastRescue {
  return { at: RESCUED_AT, worktrees };
}

// 全部を見た観測（途中で切れた印が無い）。作業ツリーは既定で 0 本
function observed(
  overrides: Partial<Extract<LastUnpushedWorkObservation, { kind: 'observed' }>> = {},
): LastUnpushedWorkObservation {
  return { kind: 'observed', at: SEEN_AT, cwd: '/work', worktrees: [], ...overrides };
}

describe('markRescueGoneWhileAlive（#4985）', () => {
  it('同じ器で、全部を見た観測にその作業ツリーが無ければ goneAt（観測の時刻）が付く', () => {
    const marked = markRescueGoneWhileAlive(rescueOf(tree()), observed(), 'inst-A');
    expect(marked?.worktrees[0]?.goneAt).toBe(SEEN_AT);
    expect(marked?.worktrees[0]?.pushed?.ref).toBe('refs/alteroid-rescue/mgr-1/a-1234abcd');
  });

  it('観測を返した器が別（入れ替えの後）なら付けない', () => {
    expect(markRescueGoneWhileAlive(rescueOf(tree()), observed(), 'inst-B')).toBeNull();
  });

  it.each([
    ['truncatedAtCount 付き', { truncatedAtCount: 50 }],
    ['stoppedEarly 付き', { stoppedEarly: true as const }],
    ['scratchRootsUnknown 付き', { scratchRootsUnknown: '/tmp を読めなかった' }],
    ['unreadableDirCount 付き', { unreadableDirCount: 2 }],
  ])('観測が途中で切れていた（%s）なら付けない', (_label, extra) => {
    expect(markRescueGoneWhileAlive(rescueOf(tree()), observed(extra), 'inst-A')).toBeNull();
  });

  it('unavailable の観測では付けない', () => {
    const unavailable: LastUnpushedWorkObservation = {
      kind: 'unavailable',
      at: SEEN_AT,
      reason: '取れなかった',
    };
    expect(markRescueGoneWhileAlive(rescueOf(tree()), unavailable, 'inst-A')).toBeNull();
  });

  it('観測が退避より古い（同時刻を含む）なら付けない', () => {
    expect(
      markRescueGoneWhileAlive(
        rescueOf(tree()),
        observed({ at: '2026-10-05T00:59:00.000Z' }),
        'inst-A',
      ),
    ).toBeNull();
    expect(
      markRescueGoneWhileAlive(rescueOf(tree()), observed({ at: RESCUED_AT }), 'inst-A'),
    ).toBeNull();
  });

  it('観測が退避より新しくても、時計のずれの余裕（60秒）の内側なら付けない', () => {
    expect(
      markRescueGoneWhileAlive(
        rescueOf(tree()),
        observed({ at: '2026-10-05T01:01:00.000Z' }),
        'inst-A',
      ),
    ).toBeNull();
    expect(
      markRescueGoneWhileAlive(
        rescueOf(tree()),
        observed({ at: '2026-10-05T01:01:00.001Z' }),
        'inst-A',
      )?.worktrees[0]?.goneAt,
    ).toBe('2026-10-05T01:01:00.001Z');
  });

  it('項目に instanceId が無ければ付けない（どの器で取った退避か分からない）', () => {
    const withoutInstance = tree();
    delete withoutInstance.instanceId;
    expect(markRescueGoneWhileAlive(rescueOf(withoutInstance), observed(), 'inst-A')).toBeNull();
  });

  it('観測者の instanceId が分からなければ付けない', () => {
    expect(markRescueGoneWhileAlive(rescueOf(tree()), observed(), undefined)).toBeNull();
  });

  it('観測に同じ relativePath の作業ツリーが在れば付けない（まだ在る）', () => {
    const still = observed({ worktrees: [{ relativePath: 'work/a', branch: 'feat/a' }] });
    expect(markRescueGoneWhileAlive(rescueOf(tree()), still, 'inst-A')).toBeNull();
  });

  it('既に goneAt が在る項目は上書きしない', () => {
    const already = tree({ goneAt: '2026-10-05T01:05:00.000Z' });
    expect(markRescueGoneWhileAlive(rescueOf(already), observed(), 'inst-A')).toBeNull();
  });

  it('条件を満たす項目だけに付き、他の項目はそのまま', () => {
    const gone = tree({ relativePath: 'work/gone' });
    const present = tree({ relativePath: 'work/present' });
    const marked = markRescueGoneWhileAlive(
      rescueOf(gone, present),
      observed({ worktrees: [{ relativePath: 'work/present', branch: 'feat/a' }] }),
      'inst-A',
    );
    expect(marked?.worktrees.map((w) => [w.relativePath, w.goneAt])).toEqual([
      ['work/gone', SEEN_AT],
      ['work/present', undefined],
    ]);
  });

  it('台帳が無ければ何もしない', () => {
    expect(markRescueGoneWhileAlive(undefined, observed(), 'inst-A')).toBeNull();
  });

  it('goneAt が付いた後に同じパスの退避が届くと（mergeRescue）goneAt が消える', () => {
    const marked = markRescueGoneWhileAlive(rescueOf(tree()), observed(), 'inst-A');
    if (marked === null) throw new Error('goneAt が付いていない');
    const merged = mergeRescue(
      marked,
      [tree({ at: '2026-10-05T01:20:00.000Z', instanceId: 'inst-A' })],
      '2026-10-05T01:20:00.000Z',
    );
    expect(merged.worktrees[0]?.goneAt).toBeUndefined();
  });
});

describe('workspaceCloneHintsFrom は goneAt の付いた退避を rescue-only に出さない（#4985）', () => {
  it('goneAt が無い退避は、観測に作業ツリーが無ければ rescue-only に出る', () => {
    const hints = workspaceCloneHintsFrom(observed(), rescueOf(tree()));
    expect(hints?.hints.map((h) => [h.kind, h.relativePath])).toEqual([['rescue-only', 'work/a']]);
  });

  it('goneAt が付いた退避は rescue-only に出ない', () => {
    const hints = workspaceCloneHintsFrom(observed(), rescueOf(tree({ goneAt: SEEN_AT })));
    expect(hints).toBeUndefined();
  });

  it('入れ替えの後の観測（instanceId が違う）では goneAt が付かず、rescue-only に出る', () => {
    const rescue = rescueOf(tree());
    const marked = markRescueGoneWhileAlive(rescue, observed(), 'inst-B') ?? rescue;
    const hints = workspaceCloneHintsFrom(observed(), marked);
    expect(hints?.hints.map((h) => h.kind)).toEqual(['rescue-only']);
  });
});
