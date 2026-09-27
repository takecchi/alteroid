import { describe, expect, it } from 'vitest';
import {
  AUTO_FOLD_PIDS_PRESSURE_RATIO,
  classifyAutoFoldUnpushedWorkProbe,
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

  // ⭐ #1765 段2 — `findManagerScratchRoots` が `tmpRootDir` を読めなかった
  // ときに空配列へ潰さず名乗るようになった「確かめられなかった」を、この
  // 安全弁がちゃんと `truncatedAtCount` / `stoppedEarly` と同じ強さで
  // 「blocked」へ倒すこと。ここを見落とすと、他マネージャー/作業者の
  // スクラッチディレクトリに残っていたかもしれない未 push の実装を
  // 検知しないまま自動で畳んでしまう。
  it('⭐ scratchRootsUnknown（/tmp を確かめられなかった）だけでも blocked——worktrees が全部 clean でも救われない', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }],
          scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった）',
        },
      }),
    ).toBe('blocked');
  });

  it('⭐ scratchRootsUnknown は worktrees が0本（見つからなかった）のときも blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [],
          scratchRootsUnknown: '確かめられなかった（/tmp を読めなかった）',
        },
      }),
    ).toBe('blocked');
  });

  /**
   * ⭐ Issue #1865 — `unreadableDirCount`（起点より下の子ディレクトリの
   * readdir 失敗）だけでも blocked——worktrees が全部 clean でも救われない。
   * `scratchRootsUnknown` / `truncatedAtCount` / `stoppedEarly` と同じ強さ。
   */
  it('⭐ unreadableDirCount（子ディレクトリの読み失敗）だけでも blocked——worktrees が全部 clean でも救われない', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }],
          unreadableDirCount: 1,
        },
      }),
    ).toBe('blocked');
  });

  it('⭐ unreadableDirCount は worktrees が0本（見つからなかった）のときも blocked', () => {
    expect(
      evaluateAutoFoldUnpushedWork({
        kind: 'ok',
        result: {
          worktrees: [],
          unreadableDirCount: 3,
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

  it('⭐ scratchRootsUnknown の理由を言う（#1765 段2）', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], scratchRootsUnknown: '確かめられなかった（テスト用の理由）' },
    });
    expect(text).toContain('/tmp');
    expect(text).toContain('確かめられなかった（テスト用の理由）');
  });

  it('⭐ unreadableDirCount の理由を件数付きで言う（Issue #1865）', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], unreadableDirCount: 5, unreadableDirSample: '/tmp/x: EACCES' },
    });
    expect(text).toContain('5');
    expect(text).toContain('子ディレクトリ');
    expect(text).toContain('/tmp/x: EACCES');
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

  /**
   * 「未 push（未コミット）がある」と「判定できない」を本文の中で分ける
   * （コーディネーターの追加指示）。以前は1本の文言に混ぜていた——
   * `evaluateAutoFoldUnpushedWorkProbe.test` 側の判定（'blocked'）は
   * 変えていないので、ここは表示だけを見る。
   */
  it('件数が0より大きい（未pushがある）作業ツリーだけなら、判定できない側の文言は出さない', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: {
        worktrees: [{ unpushedCommitCount: 3, uncommittedChangeCount: 0 }],
      },
    });
    expect(text).toContain('未pushの実装・未コミットの変更がある作業ツリーが1本');
    expect(text).not.toContain('判定できない');
  });

  it('件数が undefined（判定できない）作業ツリーだけなら、未pushがある側の文言は出さない', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: {
        worktrees: [{ unpushedCommitCount: undefined, uncommittedChangeCount: 0 }],
      },
    });
    expect(text).toContain('確認できなかった（判定できない）作業ツリーが1本');
    expect(text).not.toContain('未pushの実装・未コミットの変更がある作業ツリーが');
  });

  it('両方が混在するときは、両方の本数を分けて言う', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: {
        worktrees: [
          // 件数が取れていて正（未pushがある）。
          { unpushedCommitCount: 2, uncommittedChangeCount: 0 },
          // 件数が取れていない（判定できない）。
          { unpushedCommitCount: undefined, uncommittedChangeCount: 0 },
        ],
      },
    });
    expect(text).toContain('未pushの実装・未コミットの変更がある作業ツリーが1本');
    expect(text).toContain('確認できなかった（判定できない）作業ツリーが1本');
  });

  it('同じ作業ツリーが両方の数え方に該当することがある（片方は取れず、片方は正）', () => {
    const text = describeAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: {
        // unpushedCommitCount は取れていない（判定できない側）が、
        // uncommittedChangeCount は取れていて正（未pushがある側）。
        // 1本の作業ツリーが両方の数えに1ずつ入ることを確かめる。
        worktrees: [{ unpushedCommitCount: undefined, uncommittedChangeCount: 5 }],
      },
    });
    expect(text).toContain('未pushの実装・未コミットの変更がある作業ツリーが1本');
    expect(text).toContain('確認できなかった（判定できない）作業ツリーが1本');
  });
});

/**
 * Issue #1394 の留保 — `manager.ts` の `#autoFoldOne` が「同じ委譲・同じ理由の
 * 見送りを日誌へ積み続けない」ための鍵。`describeAutoFoldUnpushedWorkProbe`
 * の表示文言とは独立に、`probe` の構造だけで決まることを確かめる。
 */
describe('classifyAutoFoldUnpushedWorkProbe（Issue #1394 の留保 — 日誌の重複除去の鍵）', () => {
  it('同じ内容の probe は同じ鍵を返す（構造が同じなら安定）', () => {
    const a = classifyAutoFoldUnpushedWorkProbe(cleanProbe);
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }] },
    });
    expect(a).toBe(b);
  });

  it('unavailable はどんな result を持っていても同じ鍵になる', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({ kind: 'unavailable' });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'unavailable',
      // `AutoFoldUnpushedWorkProbe` の型上 `result` は `kind` に関わらず
      // optional で持てる——`kind: 'unavailable'` のときは中身を無視する
      // 実装（`describeAutoFoldUnpushedWorkProbe` と同じ判定）になっている
      // ことをここでも確かめる。
      result: { worktrees: [{ unpushedCommitCount: 9, uncommittedChangeCount: 9 }] },
    });
    expect(a).toBe(b);
  });

  it('未pushの件数が動けば鍵も変わる（迷ったら書く側に倒す）', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [{ unpushedCommitCount: 2, uncommittedChangeCount: 0 }] },
    });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [{ unpushedCommitCount: 5, uncommittedChangeCount: 0 }] },
    });
    expect(a).not.toBe(b);
  });

  it('未コミットの件数が動けば鍵も変わる', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 1 }] },
    });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 2 }] },
    });
    expect(a).not.toBe(b);
  });

  it('打ち切り件数（truncatedAtCount）が動けば鍵も変わる', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], truncatedAtCount: 10 },
    });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], truncatedAtCount: 20 },
    });
    expect(a).not.toBe(b);
  });

  it('stoppedEarly の有無が違えば鍵も変わる', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({ kind: 'ok', result: { worktrees: [] } });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], stoppedEarly: true },
    });
    expect(a).not.toBe(b);
  });

  it('⭐ scratchRootsUnknown の有無が違えば鍵も変わる（#1765 段2）', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({ kind: 'ok', result: { worktrees: [] } });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], scratchRootsUnknown: '確かめられなかった' },
    });
    expect(a).not.toBe(b);
  });

  it('⭐ unreadableDirCount の有無が違えば鍵も変わる（Issue #1865）', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({ kind: 'ok', result: { worktrees: [] } });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [], unreadableDirCount: 2 },
    });
    expect(a).not.toBe(b);
  });

  it('unavailable と ok（clean）は別の鍵になる', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({ kind: 'unavailable' });
    const b = classifyAutoFoldUnpushedWorkProbe(cleanProbe);
    expect(a).not.toBe(b);
  });

  it('作業ツリーの本数が違えば鍵も変わる（1本増えただけでも別扱い）', () => {
    const a = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: { worktrees: [{ unpushedCommitCount: 0, uncommittedChangeCount: 0 }] },
    });
    const b = classifyAutoFoldUnpushedWorkProbe({
      kind: 'ok',
      result: {
        worktrees: [
          { unpushedCommitCount: 0, uncommittedChangeCount: 0 },
          { unpushedCommitCount: 0, uncommittedChangeCount: 0 },
        ],
      },
    });
    expect(a).not.toBe(b);
  });
});
