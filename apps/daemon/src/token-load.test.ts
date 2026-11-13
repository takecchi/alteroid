import type { AgentToken, UsageProbeHandle, UsageProbeQuery } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { createTokenLoadBook, startTokenLoadSampling, type TokenLoad } from './token-load.js';

// 鍵ごとに違う使用率を返す probe。どの鍵で起こされたかを env から読む
function probeByToken(utilizationOf: Record<string, number>): {
  queryFn: UsageProbeQuery;
  probedTokens: string[];
} {
  const probedTokens: string[] = [];
  const queryFn: UsageProbeQuery = ({ options }) => {
    const token = options.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '(無し)';
    probedTokens.push(token);
    const utilization = utilizationOf[token];
    const handle: UsageProbeHandle = {
      async *[Symbol.asyncIterator]() {
        /* 何も流れない */
      },
      accountInfo: async () => ({ subscriptionType: 'Claude Max', apiProvider: 'firstParty' }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () =>
        utilization === undefined
          ? { rate_limits_available: false, rate_limits: null }
          : {
              rate_limits_available: true,
              rate_limits: { five_hour: { utilization, resets_at: '2026-11-09T15:00:00.000Z' } },
            },
    };
    return handle;
  };
  return { queryFn, probedTokens };
}

function token(id: string, value: string, extra: Partial<AgentToken> = {}): AgentToken {
  return { id, label: id, value, order: 0, ...extra };
}

const HOUR = 60 * 60_000;

function sampler(
  tokens: AgentToken[],
  utilizationOf: Record<string, number>,
  activeTokenId?: string,
) {
  const book = createTokenLoadBook();
  const probe = probeByToken(utilizationOf);
  const controller = new AbortController();
  const handle = startTokenLoadSampling({
    queryFn: probe.queryFn,
    cwd: '/work',
    withheldEnvKeys: [],
    tokens: async () => tokens,
    activeTokenId: () => activeTokenId,
    book,
    intervalMs: HOUR,
    signal: controller.signal,
  });
  return { book, probe, handle, stop: () => controller.abort() };
}

function fiveHourOf(load: TokenLoad | undefined): number | undefined {
  if (load?.state.state !== 'ok') return undefined;
  return load.state.usage.windows.find((window) => window.kind === 'five_hour')?.utilization;
}

describe('鍵ごとの枠の観測（#6633）', () => {
  it('現役以外の使いうる鍵を1本ずつ、その鍵の env で測り、鍵ごとの使用率を帳面に残す', async () => {
    const s = sampler(
      [token('a', 'tok-fake-a'), token('b', 'tok-fake-b'), token('c', 'tok-fake-c')],
      { 'tok-fake-a': 10, 'tok-fake-b': 55, 'tok-fake-c': 80 },
      'a',
    );
    await s.handle.sampleOnce();
    s.stop();

    expect(new Set(s.probe.probedTokens)).toEqual(new Set(['tok-fake-b', 'tok-fake-c']));
    const loads = s.book.snapshot();
    expect(fiveHourOf(loads.find((load) => load.tokenId === 'b'))).toBe(55);
    expect(fiveHourOf(loads.find((load) => load.tokenId === 'c'))).toBe(80);
    // 現役は既存の probe が測る。ここで測らないので行も無い（0% の行を作らない）
    expect(loads.find((load) => load.tokenId === 'a')).toBeUndefined();
  });

  it('人間が外した鍵・失効した鍵は測らない。冷却中の鍵は測る', async () => {
    const s = sampler(
      [
        token('off', 'tok-fake-off', { disabledAt: '2026-11-09T00:00:00Z' }),
        token('dead', 'tok-fake-dead', { invalidatedAt: '2026-11-09T00:00:00Z' }),
        token('cool', 'tok-fake-cool', { cooldownUntil: Date.now() + HOUR }),
      ],
      { 'tok-fake-off': 1, 'tok-fake-dead': 1, 'tok-fake-cool': 100 },
    );
    await s.handle.sampleOnce();
    s.stop();

    expect(s.probe.probedTokens).toEqual(['tok-fake-cool']);
  });

  it('プールから消えた鍵の行は次の周回で落ちる', async () => {
    const tokens = [token('a', 'tok-fake-a'), token('b', 'tok-fake-b')];
    const s = sampler(tokens, { 'tok-fake-a': 10, 'tok-fake-b': 20 });
    await s.handle.sampleOnce();
    expect(
      s.book
        .snapshot()
        .map((load) => load.tokenId)
        .sort(),
    ).toEqual(['a', 'b']);

    tokens.splice(1, 1);
    await s.handle.sampleOnce();
    s.stop();
    expect(s.book.snapshot().map((load) => load.tokenId)).toEqual(['a']);
  });

  it('枠が取れない鍵は「取れない」として残る（0% にしない）', async () => {
    const s = sampler([token('a', 'tok-fake-a')], {});
    await s.handle.sampleOnce();
    s.stop();

    const [load] = s.book.snapshot();
    expect(load?.tokenId).toBe('a');
    expect(fiveHourOf(load)).toBeUndefined();
    expect(load?.state).toMatchObject({
      state: 'ok',
      usage: { limitsAvailable: false, windows: [] },
    });
  });
});

describe('鍵ごとの枠の観測の周期（移行前後で変えない）', () => {
  function periodic(tokens: () => Promise<AgentToken[]>, intervalMs = 1000) {
    const probe = probeByToken({});
    const controller = new AbortController();
    const handle = startTokenLoadSampling({
      queryFn: probe.queryFn,
      cwd: '/work',
      withheldEnvKeys: [],
      tokens,
      activeTokenId: () => undefined,
      book: createTokenLoadBook(),
      intervalMs,
      signal: controller.signal,
    });
    return { handle, controller };
  }

  it('起動時にすぐ1回測り、終わってから間隔を置いて次を測る', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const p = periodic(async () => {
        calls += 1;
        return [];
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
      p.handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('走っている回の間は重ならない（sampleOnce は同じ回を返す）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const p = periodic(async () => {
        calls += 1;
        await gate;
        return [];
      });
      await vi.advanceTimersByTimeAsync(5000);
      const again = p.handle.sampleOnce();
      expect(calls).toBe(1);
      release();
      await again;
      p.handle.stop();
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('止めた後は次が走らない（signal の abort でも、stop でも）', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = periodic(async () => {
        calls += 1;
        return [];
      });
      await vi.advanceTimersByTimeAsync(0);
      a.controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(1);

      const b = periodic(async () => {
        calls += 1;
        return [];
      });
      await vi.advanceTimersByTimeAsync(0);
      b.handle.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('走っている回の最中に止めても、その回の後に次を予約しない', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const p = periodic(async () => {
        calls += 1;
        await gate;
        return [];
      });
      await vi.advanceTimersByTimeAsync(0);
      p.handle.stop();
      release();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('1周が失敗しても次の周期は来る。sampleOnce の呼び手には拒否で返る', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let failNow = true;
      const p = periodic(async () => {
        calls += 1;
        if (failNow) throw new Error('pool unreadable');
        return [];
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);

      await expect(p.handle.sampleOnce()).rejects.toThrow('pool unreadable');
      failNow = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(4);
      p.handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('帳面（#6633）', () => {
  it('`unknown` は観測として書かない（前の観測を消さない）', () => {
    const book = createTokenLoadBook();
    book.record('a', { state: 'failed', at: '2026-11-09T00:00:00Z', reason: 'r' });
    book.record('a', { state: 'unknown' });
    expect(book.snapshot()).toEqual([
      { tokenId: 'a', state: { state: 'failed', at: '2026-11-09T00:00:00Z', reason: 'r' } },
    ]);
  });
});
