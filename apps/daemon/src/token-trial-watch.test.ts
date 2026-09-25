import {
  TOKEN_TRIAL_FALSE_POSITIVE_WINDOW_MS,
  TOKEN_TRIAL_INTERVAL_MS,
  createMemoryStores,
  createTokenRotator,
  type AgentToken,
  type Stores,
  type TokenCandidateVerdict,
  type TokenRotationOutcome,
  type TokenRotator,
  type TokenTrialPort,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { startTokenTrialWatch } from './token-trial-watch.js';

/**
 * ダメ元の試し（Issue #1501）の目盛り（`token-trial-watch.ts`）。
 *
 * **測るのは「いつ・どれを・結果をどう既存の経路へ乗せるか」である。** 対象の
 * 選び方そのもの（`selectTokenForTrial`）は core 側の純粋関数として別に固定して
 * ある（`packages/core/src/token-trial.test.ts`）。
 */

const AT = Date.parse('2026-09-25T00:00:00.000Z');

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

/** マイクロタスクを回し切る。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    await new Promise((resolve) => setTimeout(resolve, 30));
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
    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveTrial?.();
    await settle();
    watch.stop();
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trial.calls).toEqual(['a']);
    // 間隔が経つまで時計を進めてから2回目: 成功。
    nowMs += TOKEN_TRIAL_INTERVAL_MS + 1_000;
    trial.respond({ verdict: 'usable' });
    await new Promise((resolve) => setTimeout(resolve, 40));
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
    await new Promise((resolve) => setTimeout(resolve, ms));
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
