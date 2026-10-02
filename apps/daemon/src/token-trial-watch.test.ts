import {
  TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  UnreadableActiveTokenError,
  createMemoryStores,
  createTokenRotator,
  usageTransitionOf,
  type AgentToken,
  type Stores,
  type TokenCandidateVerdict,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenTrialPort,
} from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRejectionForTrialBackoff, startTokenTrialWatch } from './token-trial-watch.js';

/**
 * ダメ元の試し（Issue #1501）の目盛り（`token-trial-watch.ts`）。
 *
 * **測るのは「いつ・どれを・結果をどう既存の経路へ乗せるか」である。** 対象の
 * 選び方そのもの（`selectTokenForTrial`）は core 側の純粋関数として別に固定して
 * ある（`packages/core/src/token-trial.test.ts`）。
 */

const AT = Date.parse('2026-09-25T00:00:00.000Z');

/**
 * 実時間を待たない（issue #2146）。
 *
 * ここより下のテストは、実時間の `setTimeout` で 20〜40ms 待ち、その間に
 * `tickMs: 5` の実時間の見張りが「十分な回数走った」ことを前提にして
 * `expect(...)` していた。器が混んでイベントループが遅れると、待ちの間に
 * 見張りが走りきらず、早すぎる `expect` が落ちうる（実測はまだ無いが、
 * 落ちうる形そのものが issue #2146 の指摘）。
 *
 * `vi.useFakeTimers()` を敷き、`settle()` / `tickFor()` を
 * `vi.advanceTimersByTimeAsync(ms)` に置き換える —— 見張りの内部の
 * `setTimeout` も同じ偽の時計に乗るので、指定した ms ぶんの目盛りが
 * 「実際に走ったこと」を保って進む（器の速さに依存しない）。論理時計
 * （`now: () => AT` / `nowMs` を手で進める形）はこれとは別物で、ここでは
 * 触っていない。
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedToken(
  stores: Stores,
  overrides: Partial<AgentToken> & { id: string; order: number },
): Promise<void> {
  const existing = await stores.tokens.list();
  await stores.tokens.replace([
    ...existing,
    { label: overrides.id, value: `value-${overrides.id}`, ...overrides },
  ]);
}

/**
 * 記録を書く口は**本物の回し手**のものを使う（`TokenRotator.recordTrialVerdict`）。
 * 見張りは記録を1行も書かない設計なので、偽物にすると「書き直した／書かなかった」の
 * 歯が見張りではなく偽物を測ることになる。probe / spread は呼ばれない。
 */
function realRecordTrialVerdict(stores: Stores): TokenRotator['recordTrialVerdict'] {
  const rotator = createTokenRotator({
    stores,
    probe: { probe: () => Promise.reject(new Error('probe は呼ばれない')) },
    spread: { spread: () => Promise.reject(new Error('spread は呼ばれない')) },
    now: () => new Date(AT),
  });
  return (input) => rotator.recordTrialVerdict(input);
}

/** 偽の時計を5ms進める（見張りの1目盛りぶん。マイクロタスクも一緒に流れる）。 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5);
}

const RECOVERED: TokenRotationOutcome = {
  kind: 'ignored',
  signal: 'none',
  why: '止まっていた現役が、また通ることを観測できた',
  recovered: { tokenId: 'a', label: 'a', source: 'turn_success' },
};

const ROTATED: TokenRotationOutcome = {
  kind: 'rotated',
  toTokenId: 'b',
  toLabel: 'b',
  generation: 2,
  signal: 'stranded',
  spread: [],
  why: '候補「b」は撒いて本番で確かめる',
};

interface FakeTrial {
  port: TokenTrialPort;
  calls: string[];
  respond: (verdict: TokenCandidateVerdict) => void;
}

function fakeTrial(initial: TokenCandidateVerdict): FakeTrial {
  const calls: string[] = [];
  let next = initial;
  return {
    calls,
    respond: (verdict) => {
      next = verdict;
    },
    port: {
      trial: (token) => {
        calls.push(token.id);
        return Promise.resolve(next);
      },
    },
  };
}

describe('token-trial-watch: 試す条件と対象', () => {
  it('現役が ready なら試さない', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'usable' });
    const outcomes: TokenRotationOutcome[] = [];
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(ROTATED),
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
      tickMs: 5,
      now: () => AT,
    });
    await vi.advanceTimersByTimeAsync(30);
    watch.stop();
    expect(trial.calls).toEqual([]);
  });

  it('現役が cooling で ready な候補が在れば試さない', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await seedToken(stores, { id: 'b', order: 1 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(ROTATED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    await vi.advanceTimersByTimeAsync(30);
    watch.stop();
    expect(trial.calls).toEqual([]);
  });

  it('現役が cooling で ready な候補も無ければ、現役自身を試す', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    await settle();
    watch.stop();
    expect(trial.calls).toEqual(['a']);
  });

  it('1回の目盛りで1本だけ（重ねない）', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    let resolveTrial: (() => void) | undefined;
    const port: TokenTrialPort = {
      trial: () =>
        new Promise((resolve) => {
          resolveTrial = () => resolve({ verdict: 'undecidable', reason: 'まだ判定できない' });
        }),
    };
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    // 何目盛りか進めても、走っている試しが終わるまで2本目は起きない。
    await vi.advanceTimersByTimeAsync(30);
    resolveTrial?.();
    await settle();
    watch.stop();
  });

  /**
   * issue #2146（実時間の待ちを偽の時計へ置き換えた側で見つけた歯の穴）。
   *
   * **経緯**: 実時間の `setTimeout` 待ちを使っていたころ、この見張りには
   * 「`stop()` の後は目盛りが止まる」ことを直接測る歯が無かった。それでも
   * 変異試験（`stop()` の中身を空にする変異）は「読めない間は試しを呼ばず
   * …」の歯を巻き込んで赤くなっていた——real timer では `stop()` が効かない
   * watch が次のテストの実行中も裏で鳴り続け、その回の `stderr` スパイへ
   * 紛れ込んでいたためである（**意図して測っていたのではなく、実時間だけが
   * 持っていた偶然の副作用**）。`vi.useFakeTimers()` に変えると、テストご
   * とに時計そのものが作り直されるため、この副作用は無くなる——つまり
   * **偶然当たっていた歯が、置き換えで静かに外れる**ところだった。ここに
   * 直接の歯を1本足すことで、外れた分を仕組みとして測り直す。
   */
  it('stop したら以降は目盛りが動かない', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    watch.stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(trial.calls).toEqual([]);
  });
});

describe('token-trial-watch: 通ったら', () => {
  it('現役自身が通ったら turn_succeeded で reconsider し、fold した why を渡す', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 24 * 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 3, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'unusable', reason: '駄目だった' });
    const reconsiderCalls: unknown[] = [];
    const outcomes: TokenRotationOutcome[] = [];
    const reconsider: TokenRotator['reconsider'] = (input) => {
      reconsiderCalls.push(input);
      return Promise.resolve(RECOVERED);
    };
    let nowMs = AT;
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider,
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
      tickMs: 5,
      now: () => nowMs,
    });
    // 1回目: 失敗（失敗の件数を数える）。
    await vi.advanceTimersByTimeAsync(20);
    expect(trial.calls).toEqual(['a']);
    // 間隔が経つまで時計を進めてから2回目: 成功。
    nowMs += TOKEN_TRIAL_INTERVAL_MS + 1_000;
    trial.respond({ verdict: 'usable' });
    await vi.advanceTimersByTimeAsync(40);
    watch.stop();

    expect(reconsiderCalls).toEqual([
      {
        reason: 'turn_succeeded',
        current: {
          verdict: { verdict: 'usable' },
          origin: { source: 'turn_success', observedBy: { tokenId: 'a', generation: 3 } },
        },
      },
    ]);
    expect(outcomes).toHaveLength(1);
    // **失敗の件数が、通った回の1行へ畳んで載る。**
    expect((outcomes[0] as { why: string }).why).toContain('1');
    expect((outcomes[0] as { why: string }).why).toContain('ダメ元');
  });

  it('現役以外の候補が通ったら markTokenUsable のうえで trial_succeeded を出す', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await seedToken(stores, { id: 'b', order: 1, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });

    // `a` は order 昇順で先に選ばれる（この対象選択そのものは core 側の歯が
    // 固定する）。ここでは「選んだ相手が試しの途中で現役ではなくなっていた」
    // という筋書きを作る —— `trial()` が呼ばれた時点で現役を差し替える。
    const reconsiderCalls: unknown[] = [];
    const outcomes: TokenRotationOutcome[] = [];
    const reconsider: TokenRotator['reconsider'] = (input) => {
      reconsiderCalls.push(input);
      return Promise.resolve(ROTATED);
    };
    const port: TokenTrialPort = {
      trial: async () => {
        await stores.tokens.writeActive({ tokenId: 'other', generation: 9, rotatedAt: '' });
        return { verdict: 'usable' };
      },
    };
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: port,
      reconsider,
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
      tickMs: 5,
      now: () => AT,
    });
    await settle();
    watch.stop();

    expect(reconsiderCalls).toEqual([{ reason: 'trial_succeeded' }]);
    const tokens = await stores.tokens.list();
    const row = tokens.find((t) => t.id === 'a');
    expect(row?.cooldownUntil).toBeUndefined();
    expect(outcomes).toHaveLength(1);
  });

  /**
   * issue #2125。試しが通った直後に「現役かどうか、いま読み直して決める」
   * （`handleSuccess` の doc）読み直しが `UnreadableActiveTokenError`
   * （issue #2053）を投げても、`tick()` の catch へ落とさず、「現役ではない」
   * 側の経路（`recordTrialVerdict` で usable を記録して
   * `reconsider({ reason: 'trial_succeeded' })`）へ進む —— 試しが通った事実
   * （そのトークンは使える）は、指名が読めなくても正しいので記録してよい。
   */
  it('読み直しが UnreadableActiveTokenError を投げても、trial_succeeded 側で usable を記録する', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });

    const reconsiderCalls: unknown[] = [];
    const outcomes: TokenRotationOutcome[] = [];
    const reconsider: TokenRotator['reconsider'] = (input) => {
      reconsiderCalls.push(input);
      return Promise.resolve(ROTATED);
    };
    // 試しの途中で、現役の読み直しが壊れる筋書き（`readActive` が投げるように
    // 差し替える）。「値をすり替える」ではなく「読めなくなる」を作る点が、
    // すぐ上の「現役以外の候補が通ったら」の歯（身元をすり替える）との違い。
    const port: TokenTrialPort = {
      trial: async () => {
        stores.tokens.readActive = () => {
          throw new UnreadableActiveTokenError('generation が数値でない（テスト用）');
        };
        return { verdict: 'usable' };
      },
    };
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: port,
      reconsider,
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
      tickMs: 5,
      now: () => AT,
    });
    await settle();
    watch.stop();

    // **`turn_succeeded`（現役自身が通った側）ではなく `trial_succeeded`
    // （現役ではない側）へ進んでいる。**
    expect(reconsiderCalls).toEqual([{ reason: 'trial_succeeded' }]);
    const tokens = await stores.tokens.list();
    const row = tokens.find((t) => t.id === 'a');
    expect(row?.cooldownUntil).toBeUndefined();
    expect(outcomes).toHaveLength(1);
  });
});

describe('token-trial-watch: 現役の指名が読めない（issue #2125）', () => {
  /** spy に積まれた呼び出しの1番目の引数を文字列化して並べる。 */
  function stderrLines(stderr: ReturnType<typeof vi.spyOn>): string[] {
    return stderr.mock.calls.map((call: unknown[]) => String(call[0]));
  }

  let stderr: ReturnType<typeof vi.spyOn>;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    stderr.mockRestore();
    process.off('unhandledRejection', onUnhandled);
  });

  it('読めない間は試しを呼ばず、tick() は reject しない。stderr の跡は変わり目にだけ出る', async () => {
    const stores = createMemoryStores();
    // 現役自身が cooldown 中で、他に ready な候補が無ければ通常は現役自身を
    // 試す形（すぐ上の「試す条件と対象」と同じ筋書き）。それでも `readActive`
    // が読めなければ、この回の試しは起きないはずである。
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    const REASON = 'generation が数値でない（テスト用）';
    stores.tokens.readActive = () => {
      throw new UnreadableActiveTokenError(REASON);
    };
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(ROTATED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    // 複数回の目盛りを回す（2回どころではなく、確実に何度も呼ばれるだけ待つ）。
    await vi.advanceTimersByTimeAsync(40);
    watch.stop();

    expect(trial.calls).toEqual([]);
    expect(unhandled).toEqual([]);
    const readableLines = stderrLines(stderr).filter((line) =>
      line.includes('現役の指名が読めない'),
    );
    expect(readableLines).toHaveLength(1);
    expect(readableLines[0]).toContain(REASON);
  });

  it('読めるように戻ると試しが再開し、戻った跡も1回だけ出る', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    let unreadable = true;
    stores.tokens.readActive = async () => {
      if (unreadable) throw new UnreadableActiveTokenError('generation が数値でない（テスト用）');
      return { tokenId: 'a', generation: 1, rotatedAt: '' };
    };
    const trial = fakeTrial({ verdict: 'undecidable', reason: 'まだ判定できない' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(ROTATED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    // 読めないあいだは呼ばれない。
    await vi.advanceTimersByTimeAsync(30);
    expect(trial.calls).toEqual([]);

    // 読めるようになる。
    unreadable = false;
    await vi.advanceTimersByTimeAsync(30);
    watch.stop();

    expect(trial.calls).toEqual(['a']);
    expect(unhandled).toEqual([]);
    const lines = stderrLines(stderr);
    expect(lines.filter((line) => line.includes('現役の指名が読めない'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('読めるようになった'))).toHaveLength(1);
  });
});

describe('token-trial-watch: 試しが投げた例外の文は伏せ字を通す（#2607）', () => {
  it('Bearer・URL の資格が stderr の跡に出ない', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const stores = createMemoryStores();
      await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
      await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
      const port: TokenTrialPort = {
        trial: () =>
          Promise.reject(
            new Error(
              'boom Authorization: Bearer sk-FAKE0123456789abcdefSECRET https://user:hunter2-FAKE-pass@example.com/x',
            ),
          ),
      };
      const watch = startTokenTrialWatch({
        stores,
        recordTrialVerdict: realRecordTrialVerdict(stores),
        trial: port,
        reconsider: () => Promise.resolve(RECOVERED),
        onOutcome: () => Promise.resolve(),
        tickMs: 5,
        now: () => AT,
      });
      await settle();
      watch.stop();
      const written = stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(written).toContain('判定できなかった');
      expect(written).toContain('boom');
      expect(written).not.toContain('sk-FAKE0123456789abcdefSECRET');
      expect(written).not.toContain('hunter2-FAKE-pass');
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('token-trial-watch: 失敗したら', () => {
  it('日誌にも受信箱にも積まない（onOutcome を呼ばない）', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'undecidable', reason: '通信断' });
    const outcomes: TokenRotationOutcome[] = [];
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
      },
      tickMs: 5,
      now: () => AT,
    });
    await settle();
    watch.stop();
    expect(outcomes).toEqual([]);
  });

  it('unusable で resetsAt が取れて記録と違えば、権威ある値で冷却を書き直す', async () => {
    const stores = createMemoryStores();
    const original = AT + 60 * 60 * 1000;
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: original });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const authoritative = AT + 3 * 60 * 60 * 1000;
    const trial = fakeTrial({
      verdict: 'unusable',
      reason: 'rate_limit_event が rejected を運んだ',
      retryAt: authoritative,
    });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    await settle();
    watch.stop();
    const tokens = await stores.tokens.list();
    expect(tokens.find((t) => t.id === 'a')?.cooldownUntil).toBe(authoritative);
  });

  it('書く必要が無ければストアを書かない（同じ値なら replace しない）', async () => {
    const stores = createMemoryStores();
    const cooldownUntil = AT + 60 * 60 * 1000;
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    let replaceCalls = 0;
    const realReplace = stores.tokens.replace.bind(stores.tokens);
    stores.tokens.replace = async (tokens) => {
      replaceCalls += 1;
      return realReplace(tokens);
    };
    const trial = fakeTrial({
      verdict: 'unusable',
      reason: 'まだ駄目',
      retryAt: cooldownUntil,
    });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
    await settle();
    watch.stop();
    expect(replaceCalls).toBe(0);
  });
});

describe('token-trial-watch: 偽陽性の退き方（設計点8）', () => {
  /** 論理時計は自前で進める（実時間の目盛りは「起こすきっかけ」でしかない）。 */
  async function tickFor(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('偽陽性を検知したら、既定の間隔では試さず、倍の間隔まで待つ', async () => {
    const stores = createMemoryStores();
    // **冷却をずっと先にしておく**（この試験の主眼は間隔であって、時計での
    // 明けではない）。現役自身が通り続けても `reconsider` は偽物なので、
    // 記憶ストアの `cooldownUntil` は動かない——`a` は試験のあいだずっと対象で
    // あり続ける。
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 24 * 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    let nowMs = AT;
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => nowMs,
    });

    await tickFor(20);
    expect(trial.calls).toEqual(['a']);

    // **偽陽性**: 通した直後の窓のあいだに、同じ鍵で本物の拒否が届いた。
    watch.noteRejection('a', nowMs + 1_000);

    // 既定の間隔ぶん進めても、倍にした間隔にはまだ届かないので試さない。
    nowMs += TOKEN_TRIAL_INTERVAL_MS + 1_000;
    await tickFor(20);
    expect(trial.calls).toEqual(['a']);

    // 倍の間隔まで進めると、もう一度試す。
    nowMs += TOKEN_TRIAL_INTERVAL_MS;
    await tickFor(20);
    watch.stop();
    expect(trial.calls).toEqual(['a', 'a']);
  });

  it('窓を過ぎても本物の拒否が来なければ、既定の間隔のまま次を試す', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 24 * 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });
    let nowMs = AT;
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial: trial.port,
      reconsider: () => Promise.resolve(RECOVERED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => nowMs,
    });

    await tickFor(20);
    expect(trial.calls).toEqual(['a']);

    // 偽陽性の窓を過ぎるまで進める（`noteRejection` は一度も呼ばない）。
    nowMs += TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS + 1_000;
    await tickFor(20);

    // 既定の間隔（倍ではない）まで進めれば、もう試してよい。
    nowMs += TOKEN_TRIAL_INTERVAL_MS - TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS + 1_000;
    await tickFor(20);
    watch.stop();
    expect(trial.calls).toEqual(['a', 'a']);
  });
});

describe('isRejectionForTrialBackoff（issue #1543）', () => {
  it('🔴 前に拒否されていた鍵がすぐまた拒否された回（transition 無し・statusNow: rejected）も本物の拒否と数える', () => {
    // マネージャーの記憶が rejected のまま、次の観測も rejected なら状態の変化は立たない。
    const transition = usageTransitionOf(
      { status: 'rejected', kind: 'five_hour' },
      { status: 'rejected', kind: 'five_hour' },
    );
    expect(transition).toBeUndefined();
    expect(
      isRejectionForTrialBackoff({
        transition,
        statusNow: 'rejected',
        observedBy: { tokenId: 'b' },
      }),
    ).toBe(true);
  });

  it('状態の変化として拒否が立った回も数える', () => {
    expect(
      isRejectionForTrialBackoff({ transition: 'rejected', observedBy: { tokenId: 'b' } }),
    ).toBe(true);
  });

  it('拒否でない観測・鍵の身元が無い観測は数えない', () => {
    expect(isRejectionForTrialBackoff({ statusNow: 'allowed', observedBy: { tokenId: 'b' } })).toBe(
      false,
    );
    expect(
      isRejectionForTrialBackoff({ transition: 'entered_overage', observedBy: { tokenId: 'b' } }),
    ).toBe(false);
    expect(isRejectionForTrialBackoff({ statusNow: 'rejected' })).toBe(false);
    expect(isRejectionForTrialBackoff({ statusNow: 'rejected', observedBy: {} })).toBe(false);
  });
});
