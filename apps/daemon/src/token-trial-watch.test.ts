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

const AT = Date.parse('2026-09-25T00:00:00.000Z');

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

// 記録を書く口は偽物にしない: 偽物にすると「書き直した／書かなかった」の歯が見張りではなく偽物を測るため。
function realRecordTrialVerdict(stores: Stores): TokenRotator['recordTrialVerdict'] {
  const rotator = createTokenRotator({
    stores,
    probe: { probe: () => Promise.reject(new Error('probe は呼ばれない')) },
    spread: { spread: () => Promise.reject(new Error('spread は呼ばれない')) },
    now: () => new Date(AT),
  });
  return (input) => rotator.recordTrialVerdict(input);
}

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
    await vi.advanceTimersByTimeAsync(30);
    resolveTrial?.();
    await settle();
    watch.stop();
  });

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
    await vi.advanceTimersByTimeAsync(20);
    expect(trial.calls).toEqual(['a']);
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
    expect((outcomes[0] as { why: string }).why).toContain('1');
    expect((outcomes[0] as { why: string }).why).toContain('ダメ元');
  });

  it('現役以外の候補が通ったら markTokenUsable のうえで trial_succeeded を出す', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    await seedToken(stores, { id: 'b', order: 1, cooldownUntil: AT + 60 * 60 * 1000 });
    await stores.tokens.writeActive({ tokenId: 'a', generation: 1, rotatedAt: '' });

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

    expect(reconsiderCalls).toEqual([{ reason: 'trial_succeeded' }]);
    const tokens = await stores.tokens.list();
    const row = tokens.find((t) => t.id === 'a');
    expect(row?.cooldownUntil).toBeUndefined();
    expect(outcomes).toHaveLength(1);
  });
});

describe('token-trial-watch: 現役の指名が読めない（issue #2125）', () => {
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
    await vi.advanceTimersByTimeAsync(30);
    expect(trial.calls).toEqual([]);

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

describe('token-trial-watch: tick 全体の失敗で未処理の拒否を出さない（#2747）', () => {
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

  function start(stores: Stores, trial: TokenTrialPort): ReturnType<typeof startTokenTrialWatch> {
    return startTokenTrialWatch({
      stores,
      recordTrialVerdict: realRecordTrialVerdict(stores),
      trial,
      reconsider: () => Promise.resolve(ROTATED),
      onOutcome: () => Promise.resolve(),
      tickMs: 5,
      now: () => AT,
    });
  }

  function fallenLines(): string[] {
    return stderr.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.includes('認証トークンの試しが落ちました'));
  }

  it('stores.tokens.list() が投げても未処理の拒否にならず、stderr へ1行出して次の周期へ進む', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    let broken = true;
    const realList = stores.tokens.list.bind(stores.tokens);
    stores.tokens.list = () =>
      broken ? Promise.reject(new Error('接続が切れた（テスト用）')) : realList();
    stores.tokens.readActive = () =>
      Promise.resolve({ tokenId: 'a', generation: 1, rotatedAt: '' });
    const trial = fakeTrial({ verdict: 'undecidable', reason: 'まだ判定できない' });
    const watch = start(stores, trial.port);

    await vi.advanceTimersByTimeAsync(30);
    expect(unhandled).toEqual([]);
    expect(fallenLines().length).toBeGreaterThanOrEqual(1);
    expect(fallenLines()[0]).toContain('接続が切れた（テスト用）');

    broken = false;
    await vi.advanceTimersByTimeAsync(30);
    watch.stop();
    expect(trial.calls).toEqual(['a']);
    expect(unhandled).toEqual([]);
  });

  it('readActive() が UnreadableActiveTokenError 以外で投げても未処理の拒否にならない', async () => {
    const stores = createMemoryStores();
    await seedToken(stores, { id: 'a', order: 0, cooldownUntil: AT + 60 * 60 * 1000 });
    stores.tokens.readActive = () => Promise.reject(new Error('読み取り失敗（テスト用）'));
    const trial = fakeTrial({ verdict: 'usable' });
    const watch = start(stores, trial.port);

    await vi.advanceTimersByTimeAsync(30);
    watch.stop();
    expect(unhandled).toEqual([]);
    expect(trial.calls).toEqual([]);
    expect(fallenLines().length).toBeGreaterThanOrEqual(1);
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
  async function tickFor(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('偽陽性を検知したら、既定の間隔では試さず、倍の間隔まで待つ', async () => {
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

    watch.noteRejection('a', nowMs + 1_000);

    nowMs += TOKEN_TRIAL_INTERVAL_MS + 1_000;
    await tickFor(20);
    expect(trial.calls).toEqual(['a']);

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

    nowMs += TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS + 1_000;
    await tickFor(20);

    nowMs += TOKEN_TRIAL_INTERVAL_MS - TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS + 1_000;
    await tickFor(20);
    watch.stop();
    expect(trial.calls).toEqual(['a', 'a']);
  });
});

describe('isRejectionForTrialBackoff（issue #1543）', () => {
  it('🔴 前に拒否されていた鍵がすぐまた拒否された回（transition 無し・statusNow: rejected）も本物の拒否と数える', () => {
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
