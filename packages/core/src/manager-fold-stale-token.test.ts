import { describe, expect, it } from 'vitest';
import { HELD_FORCE_FOLD_AFTER_MS } from './held-messages.js';
import {
  earliestMs,
  foldNoticeOf,
  heldWaitReachedForceFold,
  heldWaitStartedAt,
  isBackgroundOnlyStuck,
  rotationFoldDueAtOf,
  staleTokenFoldOptionsOf,
} from './manager-fold-stale-token.js';
import { FOLD_NOTICE_COMMANDS_MAX } from './manager-notices.js';

/*
 * 切り出した純関数（`Pool#foldStaleTokenBeforeDelivery` の同期の部分）を、入力 → 出力で縛る。
 * 期待値は切り出した後の出力を実際に確かめて書いたもの（仕様を先に書いたものではない）。
 * 呼び元（`Pool`）の側の縛り（時計の読みの回数・順序、周回数）は manager-fold-stale-token-pin.test.ts が持つ。
 */

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('earliestMs / heldWaitStartedAt', () => {
  it('読めない時刻と無い時刻は数えず、早いほうの epoch ms を返す', () => {
    expect(earliestMs([iso(T0 + 5), iso(T0)])).toBe(T0);
    expect(earliestMs([undefined, iso(T0 + 5)])).toBe(T0 + 5);
    expect(earliestMs(['not a date', iso(T0 + 5)])).toBe(T0 + 5);
    expect(earliestMs([undefined, 'not a date'])).toBeUndefined();
    expect(earliestMs([])).toBeUndefined();
  });

  it('heldWaitStartedAt: 預かりと背景処理待ちの早いほう。どちらも無ければ undefined', () => {
    expect(heldWaitStartedAt(iso(T0 + 10), iso(T0))).toBe(T0);
    expect(heldWaitStartedAt(iso(T0), iso(T0 + 10))).toBe(T0);
    expect(heldWaitStartedAt(iso(T0), undefined)).toBe(T0);
    expect(heldWaitStartedAt(undefined, iso(T0))).toBe(T0);
    expect(heldWaitStartedAt(undefined, undefined)).toBeUndefined();
  });
});

describe('heldWaitReachedForceFold', () => {
  it('ちょうど上限は届いた（>=）。1ms 前は届かない・1ms 後は届いた', () => {
    expect(heldWaitReachedForceFold(T0 + HELD_FORCE_FOLD_AFTER_MS - 1, T0)).toBe(false);
    expect(heldWaitReachedForceFold(T0 + HELD_FORCE_FOLD_AFTER_MS, T0)).toBe(true);
    expect(heldWaitReachedForceFold(T0 + HELD_FORCE_FOLD_AFTER_MS + 1, T0)).toBe(true);
  });

  it('now が NaN なら届かない（比較が偽）', () => {
    expect(heldWaitReachedForceFold(Number.NaN, T0)).toBe(false);
  });
});

describe('rotationFoldDueAtOf', () => {
  it('usage-rotation: 枠で止まった時刻と背景処理待ちの早いほうに上限を足す', () => {
    expect(rotationFoldDueAtOf('usage-rotation', iso(T0 + 10), iso(T0))).toBe(
      T0 + HELD_FORCE_FOLD_AFTER_MS,
    );
    expect(rotationFoldDueAtOf('usage-rotation', iso(T0), iso(T0 + 10))).toBe(
      T0 + HELD_FORCE_FOLD_AFTER_MS,
    );
    expect(rotationFoldDueAtOf('usage-rotation', iso(T0 + 7), undefined)).toBe(
      T0 + 7 + HELD_FORCE_FOLD_AFTER_MS,
    );
    expect(rotationFoldDueAtOf('usage-rotation', undefined, iso(T0 + 3))).toBe(
      T0 + 3 + HELD_FORCE_FOLD_AFTER_MS,
    );
  });

  it('どちらも分からなければ undefined（待たない）', () => {
    expect(rotationFoldDueAtOf('usage-rotation', undefined, undefined)).toBeUndefined();
    expect(rotationFoldDueAtOf('usage-rotation', 'not a date', undefined)).toBeUndefined();
  });

  it('usage-rotation 以外の mode は、時刻があっても undefined', () => {
    expect(rotationFoldDueAtOf('caller', iso(T0), iso(T0))).toBeUndefined();
    expect(rotationFoldDueAtOf('held-delivery', iso(T0), iso(T0))).toBeUndefined();
  });
});

describe('staleTokenFoldOptionsOf', () => {
  const base = {
    waitedLongEnough: false,
    mode: 'caller' as const,
    pollRetry: false,
    rotationFoldDueAt: undefined,
    now: undefined,
  };

  it('caller: 全欄が偽で、rotationFoldDueAt は欄ごと無い', () => {
    const options = staleTokenFoldOptionsOf(base);
    expect(options).toEqual({
      foldBackgroundAfterWait: false,
      foldBackgroundIfHeldTokenNotReady: false,
      skipUnchangedDeclineRecord: false,
    });
    expect('rotationFoldDueAt' in options).toBe(false);
  });

  it('foldBackgroundAfterWait は waitedLongEnough を素通しにする', () => {
    expect(
      staleTokenFoldOptionsOf({ ...base, waitedLongEnough: true }).foldBackgroundAfterWait,
    ).toBe(true);
  });

  it('foldBackgroundIfHeldTokenNotReady は usage-rotation だけ真', () => {
    expect(
      staleTokenFoldOptionsOf({ ...base, mode: 'usage-rotation' })
        .foldBackgroundIfHeldTokenNotReady,
    ).toBe(true);
    expect(
      staleTokenFoldOptionsOf({ ...base, mode: 'held-delivery' }).foldBackgroundIfHeldTokenNotReady,
    ).toBe(false);
  });

  it('skipUnchangedDeclineRecord は held-delivery かつ pollRetry のときだけ真', () => {
    const skip = (mode: 'caller' | 'held-delivery' | 'usage-rotation', pollRetry: boolean) =>
      staleTokenFoldOptionsOf({ ...base, mode, pollRetry }).skipUnchangedDeclineRecord;
    expect(skip('held-delivery', true)).toBe(true);
    expect(skip('held-delivery', false)).toBe(false);
    expect(skip('caller', true)).toBe(false);
    expect(skip('usage-rotation', true)).toBe(false);
  });

  it('rotationFoldDueAt: now が上限より前なら値を渡し、ちょうど上限・以後なら欄ごと無い（>=）', () => {
    const due = T0 + 1000;
    const at = (now: number) =>
      staleTokenFoldOptionsOf({ ...base, mode: 'usage-rotation', rotationFoldDueAt: due, now });
    expect(at(due - 1)).toEqual({
      foldBackgroundAfterWait: false,
      foldBackgroundIfHeldTokenNotReady: true,
      rotationFoldDueAt: due,
      skipUnchangedDeclineRecord: false,
    });
    expect('rotationFoldDueAt' in at(due)).toBe(false);
    expect('rotationFoldDueAt' in at(due + 1)).toBe(false);
  });

  it('rotationFoldDueAt が undefined なら now があっても欄ごと無い', () => {
    const options = staleTokenFoldOptionsOf({ ...base, now: T0 });
    expect('rotationFoldDueAt' in options).toBe(false);
  });
});

describe('isBackgroundOnlyStuck', () => {
  const stuck = (blockers: string[], backgroundTasks?: number) => ({
    blockers,
    ...(backgroundTasks === undefined ? {} : { backgroundTasks }),
  });

  it('stuck が無ければ偽', () => {
    expect(isBackgroundOnlyStuck(undefined)).toBe(false);
  });

  it('止まりどころが 1 つで背景処理が 1 本以上のときだけ真', () => {
    expect(isBackgroundOnlyStuck(stuck(['a'], 1) as never)).toBe(true);
    expect(isBackgroundOnlyStuck(stuck(['a'], 3) as never)).toBe(true);
  });

  it('背景処理が 0 本・欄が無い・止まりどころが 0 か 2 つ以上なら偽', () => {
    expect(isBackgroundOnlyStuck(stuck(['a'], 0) as never)).toBe(false);
    expect(isBackgroundOnlyStuck(stuck(['a']) as never)).toBe(false);
    expect(isBackgroundOnlyStuck(stuck([], 1) as never)).toBe(false);
    expect(isBackgroundOnlyStuck(stuck(['a', 'b'], 1) as never)).toBe(false);
  });
});

describe('foldNoticeOf', () => {
  const AT = '2026-01-01T00:00:01.000Z';

  it('前の知らせが無い: 畳んだ本数・peer・コマンドをそのまま。at は渡した値', () => {
    expect(
      foldNoticeOf(
        { foldedBackground: 2, foldedPeers: 1, foldedBackgroundCommands: ['x', 'y'] },
        undefined,
        AT,
      ),
    ).toEqual({ backgroundTasks: 2, peers: 1, commands: ['x', 'y'], at: AT });
  });

  it('peers が 0 なら欄ごと無く、コマンドが両方 undefined なら commands も欄ごと無い', () => {
    const notice = foldNoticeOf({ foldedBackground: 1 }, undefined, AT);
    expect(notice).toEqual({ backgroundTasks: 1, at: AT });
    expect('peers' in notice).toBe(false);
    expect('commands' in notice).toBe(false);
  });

  it('畳んだ分を 0 本と数えるときも backgroundTasks は 0 で残る（peer だけ畳んだ回）', () => {
    expect(foldNoticeOf({ foldedPeers: 2 }, undefined, AT)).toEqual({
      backgroundTasks: 0,
      peers: 2,
      at: AT,
    });
  });

  it('前の知らせへ加算し、commands は前 → 今回の順に連結する', () => {
    expect(
      foldNoticeOf(
        { foldedBackground: 2, foldedPeers: 3, foldedBackgroundCommands: ['n1'] },
        { backgroundTasks: 4, peers: 5, commands: ['o1', 'o2'], at: '2025-01-01T00:00:00.000Z' },
        AT,
      ),
    ).toEqual({ backgroundTasks: 6, peers: 8, commands: ['o1', 'o2', 'n1'], at: AT });
  });

  it('今回の peer が無くても前の peers が残れば peers を出す', () => {
    expect(
      foldNoticeOf({ foldedBackground: 1 }, { backgroundTasks: 1, peers: 2, at: AT }, AT),
    ).toEqual({ backgroundTasks: 2, peers: 2, at: AT });
  });

  it('今回のコマンドが無くても前の commands が残れば commands を出す。前のコマンドだけの回', () => {
    expect(
      foldNoticeOf({ foldedBackground: 1 }, { backgroundTasks: 1, commands: ['o1'], at: AT }, AT),
    ).toEqual({ backgroundTasks: 2, commands: ['o1'], at: AT });
  });

  it('今回のコマンドが空配列でも、commands の欄は出る（undefined でないため）', () => {
    expect(
      foldNoticeOf({ foldedBackground: 1, foldedBackgroundCommands: [] }, undefined, AT),
    ).toEqual({
      backgroundTasks: 1,
      commands: [],
      at: AT,
    });
  });

  it('commands は FOLD_NOTICE_COMMANDS_MAX 本で切る。ちょうど・1 本超過・前が先に詰まる', () => {
    const cmds = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const max = FOLD_NOTICE_COMMANDS_MAX;
    expect(
      foldNoticeOf({ foldedBackgroundCommands: cmds(max, 'n') }, undefined, AT).commands,
    ).toEqual(cmds(max, 'n'));
    expect(
      foldNoticeOf({ foldedBackgroundCommands: cmds(max + 1, 'n') }, undefined, AT).commands,
    ).toEqual(cmds(max, 'n'));
    expect(
      foldNoticeOf(
        { foldedBackgroundCommands: cmds(3, 'n') },
        { backgroundTasks: 0, commands: cmds(max - 1, 'o'), at: AT },
        AT,
      ).commands,
    ).toEqual([...cmds(max - 1, 'o'), 'n0']);
  });

  it('引数を書き換えない', () => {
    const previous = { backgroundTasks: 1, commands: ['o1'], at: AT };
    const folded = { foldedBackground: 1, foldedBackgroundCommands: ['n1'] };
    foldNoticeOf(folded, previous, AT);
    expect(previous).toEqual({ backgroundTasks: 1, commands: ['o1'], at: AT });
    expect(folded).toEqual({ foldedBackground: 1, foldedBackgroundCommands: ['n1'] });
  });
});

describe('同期の関数が throw したときの伝わり方', () => {
  it('包み直さず、そのまま同期に throw する（Promise にならない）', () => {
    const boom = new Error('boom');
    const folded = {
      get foldedBackground(): number {
        throw boom;
      },
    };
    let thrown: unknown;
    try {
      foldNoticeOf(folded, undefined, '2026-01-01T00:00:00.000Z');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(boom);
  });
});
