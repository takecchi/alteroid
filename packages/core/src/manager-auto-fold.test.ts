import { describe, expect, it } from 'vitest';
import {
  AUTO_FOLD_PIDS_PRESSURE_RATIO,
  describeAutoFoldUnpushedWorkProbe,
  evaluateAutoFoldUnpushedWork,
  isPidsUnderPressure,
  type AutoFoldUnpushedWorkProbe,
} from './manager-auto-fold.js';

describe('isPidsUnderPressure（#1394 段④ 契機の門）', () => {
  it('閾値ちょうど（80%）は逼迫とみなす（境界は含む側）', () => {
    expect(isPidsUnderPressure({ current: 800, max: 1000 })).toBe(true);
  });

  it('閾値の1つ下（799/1000）は逼迫とみなさない', () => {
    expect(isPidsUnderPressure({ current: 799, max: 1000 })).toBe(false);
  });

  it('余裕がある（低い比率）は逼迫とみなさない', () => {
    expect(isPidsUnderPressure({ current: 10, max: 1000 })).toBe(false);
  });

  it('現在値が上限を超えていても比率だけで判定する（跳ねた値でも壊れない）', () => {
    expect(isPidsUnderPressure({ current: 1200, max: 1000 })).toBe(true);
  });

  it('max が 0 なら判定できない——逼迫していない側（畳まない側）へ倒す', () => {
    expect(isPidsUnderPressure({ current: 0, max: 0 })).toBe(false);
  });

  it('max が負なら同じく判定できない側へ倒す', () => {
    expect(isPidsUnderPressure({ current: 5, max: -1 })).toBe(false);
  });

  it('定数そのものが0.8であることを固定する（閾値を変えたらこのテストで気づく）', () => {
    expect(AUTO_FOLD_PIDS_PRESSURE_RATIO).toBe(0.8);
  });
});

const cleanProbe: AutoFoldUnpushedWorkProbe = {
  kind: 'ok',
  result: {
    worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }],
  },
};

describe('evaluateAutoFoldUnpushedWork（#1394 段⑥ 安全弁）', () => {
  it('未pushのコミットも未コミットの変更も無い作業ツリーだけなら clear', () => {
    expect(evaluateAutoFoldUnpushedWork(cleanProbe)).toBe('clear');
  });

  it('作業ツリーが0本（見つからなかった）でも clear', () => {
    expect(evaluateAutoFoldUnpushedWork({ kind: 'ok', result: { worktrees: [] } })).toBe('clear');
  });

  it('unavailable（確かめられなかった）は blocked——取れないを無かったへ倒さない', () => {
    expect(evaluateAutoFoldUnpushedWork({ kind: 'unavailable' })).toBe('blocked');
  });

  it('未 push のコミットが1本でもあれば blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: { worktrees: [{ unpushedCommitCount: 1, uncommittedChangeCount: 0 }] },
      }),
    ).toBe('blocked');
  });

  it('未コミットの変更が1件でもあれば blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: { worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 1 }] },
      }),
    ).toBe('blocked');
  });

  it('unpushedCommitCount が取れていない（undefined）だけでも blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: { worktrees: [{ uncommittedChangeCount: 0 }] },
      }),
    ).toBe('blocked');
  });

  it('uncommittedChangeCount が取れていない（undefined）だけでも blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: { worktrees: [{ unpushedCommitCount: 0 }] },
      }),
    ).toBe('blocked');
  });

  it('複数の作業ツリーのうち1本でも汚れていれば blocked（他が clean でも救われない）', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [
            { unpushedCommitCount: 0, uncommittedChangeCount: 0 },
            { unpushedCommitCount: 3, uncommittedChangeCount: 0 },
          ],
        },
      }),
    ).toBe('blocked');
  });

  it('件数の上限で打ち切っていたら、全部 clean に見えても blocked（見えていない分がある）', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }],
          truncatedAtCount: 200,
        },
      }),
    ).toBe('blocked');
  });

  it('期限切れで一部を調べる前に打ち切っていたら blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }],
          stoppedEarly: true,
        },
      }),
    ).toBe('blocked');
  });
});

describe('describeAutoFoldUnpushedWorkProbe（表示専用。判定のコピーを作らない）', () => {
  it('unavailable の理由を言う', () => {
    expect(describeAutoFoldUnpushedWorkProbe({ kind: 'unavailable' })).toContain(
      '確かめられなかった',
    );
  });

  it('打ち切り（truncatedAtCount）の理由を件数付きで言う', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], truncatedAtCount: 42 },
    });
    expect(text).toContain('42');
    expect(text).toContain('打ち切っ');
  });

  it('stoppedEarly の理由を言う', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], stoppedEarly: true },
    });
    expect(text).toContain('期限切れ');
  });

  it('汚れた作業ツリーの本数を言う', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: {
        worktrees: [
          { unpushedCommitCount: 0, uncommittedChangeCount: 0 },
          { unpushedCommitCount: 2, uncommittedChangeCount: 0 },
        ],
      },
    });
    expect(text).toContain('1本');
  });
});
