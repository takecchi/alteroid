import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';
import {
  createTokenRotator,
  describeTokenRestore,
  describeTokenRotation,
  tokenRestoreEntry,
  tokenRotationEntry,
  type TokenProbePort,
  type TokenSpreadPort,
  type TokenSpreadResult,
} from './token-rotator.js';
import { UnreadableActiveTokenError, UnreadableTokenSettingsError, type Stores } from './store.js';
import type { UsageLimitNotice } from './usage-limits.js';
import type { TokenCredential } from './token-pool.js';

const AT = '2026-08-25T03:00:00.000Z';
const reached: UsageLimitNotice = {
  kind: 'reached',
  text: "You've hit your org's monthly spend limit",
};

interface Harness {
  stores: Stores;
  spreadCalls: ({ id?: string; generation?: number } & TokenCredential)[];
  probeCalls: ({ id: string } & TokenCredential)[];
  replaceCalls: () => number;
  rotator: ReturnType<typeof createTokenRotator>;
}

type Verdict = TokenProbePort['probe'] extends (t: never) => Promise<infer V> ? V : never;

function harness(
  options: {
    verdict?: Verdict;
    verdictOf?: (id: string) => Verdict;
    probeTakesMs?: number;
    spreadResults?: TokenSpreadResult[];
  } = {},
): Harness {
  const stores = createMemoryStores();
  const spreadCalls: ({ id?: string; generation?: number } & TokenCredential)[] = [];
  const probeCalls: ({ id: string } & TokenCredential)[] = [];

  let nowMs = Date.parse(AT);

  let replaceCount = 0;
  const realReplace = stores.tokens.replace.bind(stores.tokens);
  stores.tokens.replace = async (tokens) => {
    replaceCount += 1;
    return await realReplace(tokens);
  };

  const probe: TokenProbePort = {
    async probe(token) {
      probeCalls.push(token);
      nowMs += options.probeTakesMs ?? 0;
      return options.verdictOf?.(token.id) ?? options.verdict ?? { verdict: 'usable' };
    },
  };
  const spread: TokenSpreadPort = {
    async spread(token) {
      spreadCalls.push(token);
      return options.spreadResults ?? [{ target: 'runner-primary', ok: true }];
    },
  };

  const rotator = createTokenRotator({
    stores,
    probe,
    spread,
    now: () => new Date(nowMs),
  });
  return { stores, spreadCalls, probeCalls, replaceCalls: () => replaceCount, rotator };
}

async function seedFour(h: Harness): Promise<void> {
  await h.stores.tokens.replace([
    { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
    { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    { id: 'tok-c', label: 'third', value: 'value-c', order: 2 },
    { id: 'tok-d', label: 'fourth', value: 'value-d', order: 3 },
  ]);
  await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
}

async function isCooling(h: Harness, id: string): Promise<boolean> {
  const row = (await h.stores.tokens.list()).find((token) => token.id === id);
  return row?.cooldownUntil !== undefined;
}

async function seedTwo(h: Harness): Promise<void> {
  await h.stores.tokens.replace([
    { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
    { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
  ]);
  await h.stores.tokens.writeActive({
    tokenId: 'tok-a',
    generation: 1,
    rotatedAt: '2026-08-25T00:00:00.000Z',
  });
}

function breakActiveToken(h: Harness, reason = 'active.generation が数値ではない'): void {
  const store = h.stores.tokens;
  const realReadActive = store.readActive.bind(store);
  const realWriteActive = store.writeActive.bind(store);
  let broken = true;
  store.readActive = async () => {
    if (broken) throw new UnreadableActiveTokenError(reason);
    return await realReadActive();
  };
  store.writeActive = async (active) => {
    broken = false;
    return await realWriteActive(active);
  };
}

describe('受け入れ基準7: プールが空の既定の構成を1文字も変えない', () => {
  it('プールが空なら、止まった文言が来ても何も書かず何も撒かない', async () => {
    const h = harness();

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(h.probeCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toBeNull();
    expect(await h.stores.tokens.list()).toEqual([]);
  });
});

describe('#668 / #667: 状態だけを運ぶ観測', () => {
  it('いまの世代を名乗る観測なら、遷移が無くても冷却を書いて回る', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await isCooling(h, 'tok-a')).toBe(true);
    expect(await h.stores.tokens.readActive()).toEqual({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: AT,
    });
  });

  it('回した後は自動で黙る（世代が上がるので、同じセッションの続きは stale になる）', async () => {
    const h = harness();
    await seedTwo(h);
    const observation = {
      facts: { kind: 'five_hour', status: 'rejected' },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    } as const;

    await h.rotator.observe(observation);
    const again = await h.rotator.observe(observation);

    expect(again.kind).toBe('ignored');
    if (again.kind === 'ignored') expect(again.freshness).toBe('stale');
    expect(await isCooling(h, 'tok-b')).toBe(false);
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('⚠️ 世代の合わない観測では、降りる鍵の冷却も書かない（#667 の候補1を採らない）', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected' },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 0 },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind === 'ignored') expect(outcome.freshness).toBe('stale');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls).toEqual([]);
    if (outcome.kind === 'ignored') expect(outcome.staleRun).toBe(1);
  });

  it('身元を運ばない観測では、状態だけでは回らない', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected' },
      statusNow: 'rejected',
    });

    expect(outcome.kind).toBe('ignored');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls).toEqual([]);
  });
});

describe('#680: 文言だけの拒否でも、覚えている枠の事実から期限を採る', () => {
  const GUESS = Date.parse(AT) + 5 * 60 * 60_000;
  const RESETS_AT = Date.parse(AT) + 90 * 60_000;

  async function remember(h: Harness, facts: Parameters<typeof h.rotator.observe>[0]['facts']) {
    const outcome = await h.rotator.observe({ facts, statusNow: 'rejected' });
    expect(outcome.kind).toBe('ignored');
    expect(await isCooling(h, 'tok-a')).toBe(false);
  }

  async function cooldownOf(h: Harness, id: string): Promise<number | undefined> {
    return (await h.stores.tokens.list()).find((token) => token.id === id)?.cooldownUntil;
  }

  it('覚えている resetsAt を使う（5時間の推測へ倒れない）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await cooldownOf(h, 'tok-a')).toBe(RESETS_AT);
    expect(await cooldownOf(h, 'tok-a')).not.toBe(GUESS);
  });

  it('この回の観測が事実を運んでいれば、そちらが勝つ（覚えている側は古い）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT });

    const fresh = Date.parse(AT) + 30 * 60_000;
    const outcome = await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: fresh },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await cooldownOf(h, 'tok-a')).toBe(fresh);
  });

  it('別のトークンについて覚えた事実は使わない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 1, rotatedAt: AT });
    await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT },
      statusNow: 'rejected',
    });
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 2 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('拒否を名乗っていない事実は覚えない（重ねた形の status を見ない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT },
    });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('覚えている期限が過ぎていたら使わない（既定へ倒れる）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, {
      kind: 'five_hour',
      status: 'rejected',
      resetsAt: Date.parse(AT) - 60_000,
    });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('⚠️ 開いたと言う観測が届いたら、その枠の記憶を消す', async () => {
    const h = harness();
    await seedTwo(h);
    const threeDays = Date.parse(AT) + 72 * 60 * 60_000;
    await remember(h, { kind: 'seven_day', status: 'rejected', resetsAt: threeDays });
    await h.rotator.observe({
      facts: { kind: 'seven_day', status: 'allowed', resetsAt: threeDays },
      statusNow: 'allowed',
    });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('⚠️ probe が通ると観測したら、覚えている拒否も忘れる', async () => {
    const h = harness({ verdict: { verdict: 'usable' } });
    await seedTwo(h);
    const threeDays = Date.parse(AT) + 72 * 60 * 60_000;
    await remember(h, { kind: 'seven_day', status: 'rejected', resetsAt: threeDays });
    const rows = await h.stores.tokens.list();
    await h.stores.tokens.replace(
      rows.map((token) =>
        token.id === 'tok-a' ? { ...token, cooldownUntil: Date.parse(AT) + 60_000 } : token,
      ),
    );
    const recovered = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });
    expect(recovered.kind).toBe('ignored');

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
  });

  it('status を運んでいない観測では記憶を消さない（省略は「何も言っていない」）', async () => {
    const h = harness();
    await seedTwo(h);
    await remember(h, { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT });
    await h.rotator.observe({ facts: { kind: 'five_hour', utilization: 90 } });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(RESETS_AT);
  });

  it('週の枠が閉じたままなら、既定（5時間）より後ろの期限を書く', async () => {
    const h = harness();
    await seedTwo(h);
    const threeDays = Date.parse(AT) + 72 * 60 * 60_000;
    await remember(h, { kind: 'seven_day', status: 'rejected', resetsAt: threeDays });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toBe(threeDays);
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.cooldownSource).toBe('quota_reset');
  });

  it('⚠️ 覚えた事実を判定へ混ぜない（signal も倒れ先も動かさない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'overage_exhausted', cooldownMs: 18_000_000 });
    await remember(h, {
      kind: 'five_hour',
      status: 'rejected',
      overageStatus: 'rejected',
      resetsAt: RESETS_AT,
    });

    const outcome = await h.rotator.observe({
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('ignored');
    expect(outcome.signal).not.toBe('overage_closed');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls).toEqual([]);
  });
});

describe('#682: 文言に書かれている時刻を使う', () => {
  const OBSERVED = "You've hit your session limit · resets 10:10pm (Asia/Tokyo)";

  function harnessAt(at: string): Harness {
    const h = harness();
    const stores = h.stores;
    const rotator = createTokenRotator({
      stores,
      probe: { probe: async () => ({ verdict: 'usable' }) },
      spread: { spread: async () => [{ target: 'runner-primary', ok: true }] },
      now: () => new Date(Date.parse(at)),
    });
    return { ...h, rotator };
  }

  async function seedAt(h: Harness, at: string): Promise<void> {
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: at });
  }

  async function cooldownOf(h: Harness, id: string) {
    const row = (await h.stores.tokens.list()).find((token) => token.id === id);
    return { until: row?.cooldownUntil, source: row?.cooldownSource };
  }

  it('文言の時刻を採り、出所を notice_text と記録する', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);

    const outcome = await h.rotator.observe({
      notice: { kind: 'reached', text: OBSERVED },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await cooldownOf(h, 'tok-a')).toEqual({
      until: Date.parse('2026-09-07T13:10:00.000Z'),
      source: 'notice_text',
    });
  });

  it('文言に時刻が無ければ既定へ倒れる（今日の振る舞い）', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);

    await h.rotator.observe({
      notice: { kind: 'reached', text: "You've hit your usage limit" },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toEqual({
      until: Date.parse(at) + 5 * 60 * 60_000,
      source: 'default',
    });
  });

  it('覚えている枠の事実が在れば、そちらが勝つ（#680 が先）', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);
    const remembered = Date.parse('2026-09-07T12:30:00.000Z');
    await h.rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: remembered },
      statusNow: 'rejected',
    });

    await h.rotator.observe({
      notice: { kind: 'reached', text: OBSERVED },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(await cooldownOf(h, 'tok-a')).toEqual({ until: remembered, source: 'quota_reset' });
  });

  it('文言（原文）は1文字も書き換えない（受け入れ基準8）', async () => {
    const at = '2026-09-07T11:42:22.701Z';
    const h = harnessAt(at);
    await seedAt(h, at);

    await h.rotator.observe({
      notice: { kind: 'reached', text: OBSERVED },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.lastRejectedReason).toBe(OBSERVED);
  });
});

describe('受け入れ基準1: 1本目が止まったら2本目へ回る', () => {
  it('回して、正本を書き換えて、撒く', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.fromTokenId).toBe('tok-a');
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.generation).toBe(2);

    expect(await h.stores.tokens.readActive()).toEqual({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: AT,
    });
    expect(h.spreadCalls).toEqual([
      { id: 'tok-b', generation: 2, kind: 'stored', value: 'value-b' },
    ]);
  });

  it('降りたトークンに、止まった文言と冷却の期限が記録される', async () => {
    const h = harness();
    await seedTwo(h);

    await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing?.lastRejectedReason).toBe("You've hit your org's monthly spend limit");
    expect(outgoing?.lastRejectedAt).toBe(AT);
    expect(outgoing?.cooldownUntil).toBe(1_800_000_000_000);
  });

  it('resetsAt が取れなければ設定の既定で冷やす（関数の中に既定を持たない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'free_exhausted', cooldownMs: 60_000 });

    await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing?.cooldownUntil).toBe(Date.parse(AT) + 60_000);
  });

  it('⚠️ 既定へ倒した回が、前に入っていた権威ある期限を後ろへ動かさない', async () => {
    const h = harness();
    const authoritative = Date.parse(AT) + 90 * 60 * 1000;
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, cooldownUntil: authoritative },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing?.cooldownUntil).toBe(authoritative);
    expect(outgoing?.lastRejectedAt).toBe(AT);
  });

  it('撒く前に正本を書く（保存が落ちたら撒かない）', async () => {
    const h = harness();
    await seedTwo(h);
    h.stores.tokens.writeActive = () => Promise.reject(new Error('保存できない'));

    await expect(
      h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } }),
    ).rejects.toThrow('保存できない');
    expect(h.spreadCalls).toEqual([]);
  });
});

describe('候補を試し切る', () => {
  it('1本目が使えなければ次の候補へ進む（1本で打ち切らない）', async () => {
    const h = harness({
      verdictOf: (id) =>
        id === 'tok-b' ? { verdict: 'unusable', reason: '枠が尽きている' } : { verdict: 'usable' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-c' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    expect(await isCooling(h, 'tok-b')).toBe(true);
    expect(await isCooling(h, 'tok-d')).toBe(false);
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('全部使えなければ exhausted。**試した分だけ**冷却へ入り、保存は1回きり', async () => {
    const h = harness({ verdict: { verdict: 'unusable', reason: '枠が尽きている' } });
    await seedFour(h);
    const beforeObserve = h.replaceCalls();

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(outcome).not.toHaveProperty('stoppedBy');
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c', 'tok-d']);
    for (const id of ['tok-b', 'tok-c', 'tok-d']) expect(await isCooling(h, id)).toBe(true);
    expect(h.spreadCalls).toEqual([]);
    expect(outcome.why).not.toContain('プールが空');
    expect(outcome.why).toContain('試した候補「second」「third」「fourth」');
    expect(h.replaceCalls() - beforeObserve).toBe(2);
  });

  it('持ち時間を使い切ったら打ち切り、その事実を出力に残す', async () => {
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠が尽きている' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'exhausted', stoppedBy: 'budget' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    expect(await isCooling(h, 'tok-d')).toBe(false);
    expect(outcome.why).toContain('持ち時間');
  });

  it('打ち切った回に「戻る見込みが1本も無い」と言わない', async () => {
    const line = describeTokenRotation({
      kind: 'exhausted',
      stoppedBy: 'budget',
      signal: 'reached',
      freshness: 'current',
      why: '候補を試す持ち時間（60000ms）を使い切った',
    });
    expect(line).toContain('まだ試していない候補が残っている');
    expect(line).not.toContain('戻る見込みの立っている候補が1本も無い');
  });

  it('試し切ったときは、いちばん早く戻る候補が出る（撒いて待つ）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      {
        id: 'tok-b',
        label: 'second',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 60 * 60 * 1000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({
      kind: 'parked',
      tokenId: 'tok-b',
      cooldownUntil: Date.parse(AT) + 60 * 60 * 1000,
      fromTokenId: 'tok-a',
    });
    expect(h.probeCalls).toEqual([]);
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-b',
      generation: 2,
    });
  });
});

describe('usable を undecidable より先に選ぶ', () => {
  it('先頭が判定できなくても、後ろの確かめられた候補を選ぶ', async () => {
    const h = harness({
      verdictOf: (id) =>
        id === 'tok-b'
          ? { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' }
          : { verdict: 'usable' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-c' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    expect(await isCooling(h, 'tok-b')).toBe(false);
    expect(outcome.why).toContain('観測できた');
  });

  it('全部が判定できなければ、order のいちばん小さいものを撒く（前と同じ結果）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-b' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c', 'tok-d']);
    for (const id of ['tok-b', 'tok-c', 'tok-d']) expect(await isCooling(h, id)).toBe(false);
  });

  it('倒したことを言い分ける（「選んだ」と「妥協した」を同じ顔にしない）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' },
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.why).toContain('確かめられた候補は見つからなかった');
    expect(outcome.why).toContain('へ倒した');
    expect(outcome.why).not.toContain('は観測できた');
  });

  it('持ち時間を使い切っても、見つけてあった候補へ倒す（手元に在るのに何もしない、を作らない）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'この認証では原理的に枠が取れない' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'rotated', toTokenId: 'tok-b' });
    expect(h.probeCalls.map((call) => call.id)).toEqual(['tok-b', 'tok-c']);
    expect(outcome.why).toContain('持ち時間');
    expect(tokenRotationEntry(outcome)?.event).toBe('rotated');
  });

  it('倒せる先が1本も無ければ、これまでどおり打ち切りとして残る', async () => {
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠が尽きている' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome).toMatchObject({ kind: 'exhausted', stoppedBy: 'budget' });
    expect(tokenRotationEntry(outcome)?.event).toBe('sweep_stopped');
  });
});

describe('世代の照合（受け入れ基準: 同時に届いても回るのは1回だけ）', () => {
  it('捨てた回数を数え、日誌へ出す側へ渡す（0件では届かなかったのと見分けが付かない）', async () => {
    const h = harness();
    await seedTwo(h);

    const first = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(first.kind).toBe('rotated');

    const stale1 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const stale2 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(stale1).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    expect(stale2).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 2 });
    expect(h.spreadCalls).toHaveLength(1);

    expect(tokenRotationEntry(stale1)?.event).toBe('not_rotated');
    expect(tokenRotationEntry(stale2)).toBeNull();
  });

  it('もう回した後の通知は捨てる', async () => {
    const h = harness();
    await seedTwo(h);

    const first = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(first.kind).toBe('rotated');

    const second = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(second.kind).toBe('ignored');
    expect(second.freshness).toBe('stale');
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('身元の無い観測は効かせる側へ倒し、その事実を結果に残す', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('rotated');
    expect(outcome.freshness).toBe('unknown');
  });
});

describe('staleRun の連なりの終わり（#1384）', () => {
  it('同じ鍵の stale を5件捨てたあと、別の鍵の stale が来たら「計5件」の終わりの一文が出る（2〜5件目は行を出さない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 2, rotatedAt: AT });

    const staleObservation = {
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    } as const;

    const first = await h.rotator.observe(staleObservation);
    expect(first).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    expect(tokenRotationEntry(first)?.event).toBe('not_rotated');

    for (let i = 2; i <= 5; i++) {
      const outcome = await h.rotator.observe(staleObservation);
      expect(outcome).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: i });
      expect(tokenRotationEntry(outcome)).toBeNull();
    }

    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const afterKeyChange = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-b', generation: 2 },
    });
    expect(afterKeyChange).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    const entry = tokenRotationEntry(afterKeyChange);
    expect(entry).not.toBeNull();
    expect(entry?.text).toContain('計5件');
    expect(entry?.text).toContain('終わった');
    expect(entry?.text).toContain('second');
    expect(entry?.text).toContain('プロセスが落ちた');
  });

  it('stale が5件続いたあと回すと、「計5件」の終わりの一文が出る', async () => {
    const h = harness();
    await seedFour(h);

    const rotate1 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(rotate1).toMatchObject({ kind: 'rotated', toTokenId: 'tok-b' });

    for (let i = 0; i < 5; i++) {
      const outcome = await h.rotator.observe({
        notice: reached,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });
      expect(outcome).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: i + 1 });
    }

    const rotate2 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-b', generation: 2 },
    });
    expect(rotate2.kind).toBe('rotated');
    const entry = tokenRotationEntry(rotate2);
    expect(entry?.text).toContain('計5件');
    expect(entry?.text).toContain('終わった');
    expect(entry?.text).toContain('second');
  });

  it('回した瞬間に staleRun をリセットするので、次の stale で同じ連なりの終わりを二重に出さない', async () => {
    const h = harness();
    await seedFour(h);

    const rotate1 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(rotate1).toMatchObject({ kind: 'rotated', toTokenId: 'tok-b' });

    for (let i = 0; i < 5; i++) {
      const outcome = await h.rotator.observe({
        notice: reached,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });
      expect(outcome).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: i + 1 });
    }

    const rotate2 = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-b', generation: 2 },
    });
    if (rotate2.kind !== 'rotated') throw new Error('rotate2 は rotated のはず');
    expect(tokenRotationEntry(rotate2)?.text).toContain('計5件');

    const afterRotate = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: rotate2.toTokenId, generation: rotate2.generation - 1 },
    });
    expect(afterRotate).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    const afterRotateEntry = tokenRotationEntry(afterRotate);
    expect(afterRotateEntry?.text).toContain('1件目');
    expect(afterRotateEntry?.text).not.toContain('計5件');
    expect(afterRotateEntry?.text).not.toContain('終わった');
  });

  it('parked にした瞬間も staleRun をリセットするので、次の stale で同じ連なりの終わりを二重に出さない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      {
        id: 'tok-b',
        label: 'second',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 5_000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    for (let i = 0; i < 5; i++) {
      const outcome = await h.rotator.observe({
        notice: reached,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });
      expect(outcome).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: i + 1 });
    }

    const parked = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 2 },
    });
    expect(parked.kind).toBe('parked');
    if (parked.kind !== 'parked') return;
    expect(tokenRotationEntry(parked)?.text).toContain('計5件');

    const afterPark = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 2 },
    });
    expect(afterPark).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    const afterParkEntry = tokenRotationEntry(afterPark);
    expect(afterParkEntry?.text).toContain('1件目');
    expect(afterParkEntry?.text).not.toContain('計5件');
    expect(afterParkEntry?.text).not.toContain('終わった');
  });

  it('陽性対照: 連なりが1件だけで終わっても、1件目の行と「計1件」の終わりの一文の両方が出る', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 2, rotatedAt: AT });

    const first = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    expect(first).toMatchObject({ kind: 'ignored', freshness: 'stale', staleRun: 1 });
    const firstEntry = tokenRotationEntry(first);
    expect(firstEntry?.text).toContain('1件目');

    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
    const second = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-b', generation: 2 },
    });
    const secondEntry = tokenRotationEntry(second);
    expect(secondEntry?.text).toContain('計1件');
    expect(secondEntry?.text).toContain('終わった');
  });
});

describe('受け入れ基準4: 全部冷却中なら先頭へ黙って戻らない', () => {
  it('いちばん早く戻るものとその時刻を出す（そしてそれを撒いて待つ）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      {
        id: 'tok-b',
        label: 'second',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 5_000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-b');
    expect(outcome.label).toBe('second');
    expect(outcome.cooldownUntil).toBe(Date.parse(AT) + 5_000);
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-b',
      generation: 2,
    });
    expect(describeTokenRotation(outcome)).toContain('まで通らない');
  });

  it('1本しか無くてそれが現役なら、同じ出口へ倒れる（自分自身へ回さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'only', value: 'value-a', order: 0 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 1 });
  });
});

describe('候補を本番の仕事で試さない（probe の3値）', () => {
  it('usable なら撒く', async () => {
    const h = harness({ verdict: { verdict: 'usable' } });
    await seedTwo(h);
    await h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } });
    expect(h.probeCalls).toEqual([{ id: 'tok-b', kind: 'stored', value: 'value-b' }]);
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('unusable なら撒かず、その候補も冷却へ入れる（probe を毎回焼かない）', async () => {
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠を使い切っている', retryAt: 1_800_000_000_000 },
    });
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    const candidate = (await h.stores.tokens.list()).find((t) => t.id === 'tok-b');
    expect(candidate?.cooldownUntil).toBe(1_800_000_000_000);
    expect(candidate?.lastRejectedReason).toBe('枠を使い切っている');
  });

  it('undecidable なら撒く側へ倒す（判定できないことを理由に候補を捨てない）', async () => {
    const h = harness({
      verdict: { verdict: 'undecidable', reason: 'rate_limits が埋まらない構成' },
    });
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    expect(h.spreadCalls).toHaveLength(1);
    if (outcome.kind === 'rotated') {
      expect(outcome.why).toContain('本番で確かめる');
    }
  });
});

describe('設定を読むのは判定側だけ（off なら1本も回らない）', () => {
  it('off なら回さず、撒かず、冷却も入れない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 1_000 });

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    const outgoing = (await h.stores.tokens.list()).find((t) => t.id === 'tok-a');
    expect(outgoing).not.toHaveProperty('cooldownUntil');
  });

  it('overage_exhausted は rejected だけでは回らない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'overage_exhausted', cooldownMs: 1_000 });

    const outcome = await h.rotator.observe({
      transition: 'rejected',
      facts: { kind: 'five_hour', status: 'rejected' },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
  });
});

describe('受け入れ基準5: 値がどこにも出ない', () => {
  it('結果を JSON 化してもトークンの値が現れない', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain('value-a');
    expect(serialized).not.toContain('value-b');
  });

  it('撒くのに失敗した理由も結果に載るが、値は載らない', async () => {
    const h = harness({
      spreadResults: [{ target: 'runner-primary', ok: false, error: 'runner が応答しない' }],
    });
    await seedTwo(h);

    const outcome = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.spread).toEqual([
      { target: 'runner-primary', ok: false, error: 'runner が応答しない' },
    ]);
    expect(JSON.stringify(outcome)).not.toContain('value-b');
  });
});

describe('直列化（同時に2本来てもプールを食い潰さない）', () => {
  it('身元の無い観測が2本同時に来ても、2本目は世代で捨てられる', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
      { id: 'tok-c', label: 'third', value: 'value-c', order: 2 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const [first, second] = await Promise.all([
      h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } }),
      h.rotator.observe({ notice: reached, observedBy: { tokenId: 'tok-a', generation: 1 } }),
    ]);

    expect(first.kind).toBe('rotated');
    expect(second.kind).toBe('ignored');
    expect(second.freshness).toBe('stale');
    expect(h.spreadCalls).toHaveLength(1);
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-b', generation: 2 });
  });
});

describe('降りた本人へ「回す」を作らない（resetsAt が過去で来る形）', () => {
  it('resetsAt が過去でも、降りた本人は選ばれない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: Date.parse(AT) - 1 },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    expect(h.spreadCalls).toEqual([
      { id: 'tok-b', generation: 2, kind: 'stored', value: 'value-b' },
    ]);
  });

  it('resetsAt が過去で、他に候補が無ければ「候補が無い」へ倒れる（自分へ戻らない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'only', value: 'value-a', order: 0 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: Date.parse(AT) - 1 },
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 1 });
  });
});

describe('restore（起動時の引き取り）', () => {
  it('一度も回していなければ none。何も撒かない', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('none');
    expect(await h.stores.tokens.readActive()).toBeNull();
    expect(h.spreadCalls).toEqual([]);
  });

  it('プールが本当に空でも none。何も撒かない', async () => {
    const h = harness();

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('none');
    expect(await h.stores.tokens.list()).toEqual([]);
    expect(h.spreadCalls).toEqual([]);
  });

  it('現役として記録された行を撒き直す', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') return;
    expect(outcome.tokenId).toBe('tok-b');
    expect(outcome.cooling).toBe(false);
    expect(h.spreadCalls).toEqual([
      { id: 'tok-b', generation: 5, kind: 'stored', value: 'value-b' },
    ]);
  });

  it('世代を増やさない（引き取りは回転ではない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });

    await h.rotator.restore();

    expect(h.spreadCalls[0]?.generation).toBe(5);
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 5 });
  });

  it('記憶ストアへ書かない（updatedAt を動かさない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });
    const before = await h.stores.tokens.list();

    await h.rotator.restore();

    expect(await h.stores.tokens.list()).toEqual(before);
  });

  it('冷却中でも撒き直す。ただし冷却中だったことを返す', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 5_000,
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('restored');
    if (outcome.kind !== 'restored') return;
    expect(outcome.cooling).toBe(true);
    expect(h.spreadCalls).toEqual([
      { id: 'tok-a', generation: 2, kind: 'stored', value: 'value-a' },
    ]);
    expect(outcome.why).toContain('冷却中');
  });

  it('指名の先の行が消えていたら dangling。何も撒かない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'ghost', generation: 3, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('dangling');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'ghost' });
  });

  it('人間が外した行なら withheld。何も撒かない（人間の判断を実装が覆さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, disabledAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('withheld');
    expect(h.spreadCalls).toEqual([]);
  });

  it('失効している行も withheld。何も撒かない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, invalidatedAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    expect((await h.rotator.restore()).kind).toBe('withheld');
    expect(h.spreadCalls).toEqual([]);
  });

  it('値が結果のどこにも出ない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 5, rotatedAt: AT });

    const outcome = await h.rotator.restore();

    expect(JSON.stringify(outcome)).not.toContain('value-b');
  });

  it('引き取った後は、走ってもいないトークンを冷却へ入れない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
      { id: 'tok-c', label: 'third', value: 'value-c', order: 2 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-b', generation: 2, rotatedAt: AT });

    await h.rotator.restore();
    await h.rotator.observe({
      notice: { kind: 'reached', text: "You've hit your org's monthly spend limit" },
      observedBy: { tokenId: 'tok-b', generation: 2 },
    });

    const tokens = await h.stores.tokens.list();
    expect(tokens.find((t) => t.id === 'tok-b')?.cooldownUntil).toBeDefined();
    expect(tokens.find((t) => t.id === 'tok-a')).not.toHaveProperty('cooldownUntil');
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 3 });
  });

  it('#2128: 現役の指名が読めなくても reject しない。指名なしと同じく何も撒かない', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakActiveToken(h, '現役の指名の generation 欄が壊れている');

    const outcome = await h.rotator.restore();

    expect(outcome.kind).toBe('unreadable');
    if (outcome.kind !== 'unreadable') return;
    expect(outcome.reason).toBe('現役の指名の generation 欄が壊れている');
    expect(h.spreadCalls).toEqual([]);
    await expect(h.stores.tokens.readActive()).rejects.toThrow(UnreadableActiveTokenError);
  });
});

describe('issue #2128: 現役の指名が読めない（UnreadableActiveTokenError）', () => {
  it('(a) observe: 読めなくても reject せず、指名なしと同じ経路で候補へ撒く', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakActiveToken(h);

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-a');
    expect(h.spreadCalls).toEqual([
      { id: 'tok-a', generation: outcome.generation, kind: 'stored', value: 'value-a' },
    ]);
  });

  it('(a) reconsider: 読めなくても reject せず、指名なしと同じ経路で候補へ撒く', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakActiveToken(h);

    const outcome = await h.rotator.reconsider({ reason: 'startup' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-a');
    expect(outcome.signal).toBe('stranded');
  });

  it('(b) 上書きした世代は Date.now() 由来で、過去の小さな世代（1〜5）とは重ならない', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakActiveToken(h);

    const outcome = await h.rotator.reconsider({ reason: 'startup' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.generation).toBe(Date.parse(AT));
    expect([1, 2, 3, 4, 5]).not.toContain(outcome.generation);
  });

  it('(c) 上書きした後は readActive() が読め、次の撒き直しは +1 で増える（2周目）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    breakActiveToken(h);

    const first = await h.rotator.reconsider({ reason: 'startup' });
    expect(first.kind).toBe('rotated');
    if (first.kind !== 'rotated') return;
    const firstGeneration = first.generation;
    expect(firstGeneration).toBe(Date.parse(AT));

    await expect(h.stores.tokens.readActive()).resolves.toMatchObject({
      tokenId: first.toTokenId,
      generation: firstGeneration,
    });

    const second = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: first.toTokenId, generation: firstGeneration },
    });

    expect(second.kind).toBe('rotated');
    if (second.kind !== 'rotated') return;
    expect(second.generation).toBe(firstGeneration + 1);
  });

  it('(d) 古い世代を名乗る観測は、上書きの後は stale に落ちる', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakActiveToken(h);

    const outcome = await h.rotator.reconsider({ reason: 'startup' });
    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;

    const stale = await h.rotator.observe({
      notice: reached,
      observedBy: { tokenId: outcome.toTokenId, generation: 3 },
    });

    expect(stale.kind).toBe('ignored');
    if (stale.kind !== 'ignored') return;
    expect(stale.freshness).toBe('stale');
    expect(h.spreadCalls).toHaveLength(1);
  });

  it('(e) 日誌に上書きの行が1行在り、読めない指名の値を含まない', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakActiveToken(h, '現役の指名の generation 欄が壊れている');

    const outcome = await h.rotator.reconsider({ reason: 'startup' });
    expect(outcome.kind).toBe('rotated');

    const entry = tokenRotationEntry(outcome);
    expect(entry).not.toBeNull();
    expect(entry?.text).toContain('現役の指名が読めなかったので');
    expect(entry?.text).toContain(`世代 ${String(Date.parse(AT))}`);
    expect(entry?.text).toContain('現役の指名の generation 欄が壊れている');
    expect(entry?.text).not.toContain('value-a');
  });
});

function breakTokenSettings(h: Harness, reason = 'rotateOn が enum の外'): void {
  const store = h.stores.tokens;
  const realReadSettings = store.readSettings.bind(store);
  const realWriteSettings = store.writeSettings.bind(store);
  let broken = true;
  store.readSettings = async () => {
    if (broken) throw new UnreadableTokenSettingsError(reason);
    return await realReadSettings();
  };
  store.writeSettings = async (settings) => {
    broken = false;
    return await realWriteSettings(settings);
  };
}

describe('issue #2147: 回転の設定が読めない（UnreadableTokenSettingsError）', () => {
  it('(a) observe: 読めなくても reject しない', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h);

    await expect(h.rotator.observe({ notice: reached })).resolves.toBeDefined();
  });

  it('(a) reconsider: 読めなくても reject しない', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h);

    await expect(h.rotator.reconsider({ reason: 'tick' })).resolves.toBeDefined();
  });

  it('(b) observe: 回すかどうかを判定できないので、この回は回さない（撒かない・現役も動かさない）', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h);

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    await expect(h.stores.tokens.readActive()).resolves.toEqual({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });
  });

  it('(b) reconsider: まだ一度も指名していない状態からも、この回は選ばない（撒かない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakTokenSettings(h);

    const outcome = await h.rotator.reconsider({ reason: 'startup' });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    await expect(h.stores.tokens.readActive()).resolves.toBeNull();
  });

  it('(b) reconsider: 記録の上で現役が通らなくても（dangling）、次の候補へは回さない', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 0 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
    breakTokenSettings(h);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    await expect(h.stores.tokens.readActive()).resolves.toMatchObject({ tokenId: 'tok-a' });
  });

  it('(c) reconsider: probe の観測が resetsAt（retryAt）を運んでいれば、設定が読めなくても冷却を書く', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h);
    const retryAt = Date.parse(AT) + 6 * 60 * 60 * 1000;

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'unusable', reason: '枠が尽きた', retryAt },
        origin: { source: 'account_probe' },
      },
    });

    expect(outcome.kind).toBe('ignored');
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.cooldownUntil).toBe(retryAt);
    expect(row?.lastRejectedReason).toBe('枠が尽きた');
    expect(await isCooling(h, 'tok-a')).toBe(true);
  });

  it('(c) reconsider: resetsAt（retryAt）を運んでいなければ、設定が読めない回は冷却を書かない', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h);

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'unusable', reason: '枠が尽きた' },
        origin: { source: 'account_probe' },
      },
    });

    expect(outcome.kind).toBe('ignored');
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.cooldownUntil).toBeUndefined();
    expect(row?.lastRejectedAt).toBeUndefined();
    expect(row?.lastRejectedReason).toBeUndefined();
    expect(await isCooling(h, 'tok-a')).toBe(false);
  });

  it('(c) reconsider: 冷却を書けなかった回も、signal は settings_unreadable で、probe の観測と読めない理由の両方が why に残る', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h, 'cooldownMs が負の数');
    const before = JSON.stringify(await h.stores.tokens.list());
    const writes = h.replaceCalls();

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'unusable', reason: '枠が尽きた' },
        origin: { source: 'account_probe' },
      },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.signal).toBe('settings_unreadable');
    expect(outcome.why).toContain('probe で通らないことを観測した');
    expect(outcome.why).toContain('枠が尽きた');
    expect(outcome.why).toContain('回転の設定が読めなかった');
    expect(outcome.why).toContain('cooldownMs が負の数');
    expect(JSON.stringify(await h.stores.tokens.list())).toBe(before);
    expect(h.replaceCalls()).toBe(writes);
    const entry = tokenRotationEntry(outcome);
    expect(entry).not.toBeNull();
    expect(entry?.text).toContain('枠が尽きた');
  });

  it('(d) 読めなかったことが why / 日誌に残り、既定値の文言（free_exhausted 等）を名乗らない', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h, 'rotateOn が enum の外');

    const outcome = await h.rotator.observe({ notice: reached });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.signal).toBe('settings_unreadable');
    expect(outcome.why).toContain('rotateOn が enum の外');
    expect(outcome.why).not.toContain('free_exhausted');

    const entry = tokenRotationEntry(outcome);
    expect(entry).not.toBeNull();
    expect(entry?.text).toContain('rotateOn が enum の外');
    expect(entry?.text).not.toContain('free_exhausted');
  });

  it('(d) reconsider 側でも、読めなかったことが why / 日誌に残る', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    breakTokenSettings(h, 'cooldownMs が負の数');

    const outcome = await h.rotator.reconsider({ reason: 'startup' });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.signal).toBe('settings_unreadable');
    expect(outcome.why).toContain('cooldownMs が負の数');

    const entry = tokenRotationEntry(outcome);
    expect(entry).not.toBeNull();
    expect(entry?.text).toContain('cooldownMs が負の数');
    expect(entry?.text).not.toContain('free_exhausted');
  });

  describe('#2403: 設定が読めないあいだも、枠の拒否の事実は覚える（#680）', () => {
    const GUESS = Date.parse(AT) + 5 * 60 * 60_000;
    const RESETS_AT = Date.parse(AT) + 90 * 60_000;
    const settingsBack = { rotateOn: 'free_exhausted', cooldownMs: 5 * 60 * 60_000 } as const;

    async function cooldownOf(h: Harness, id: string): Promise<number | undefined> {
      return (await h.stores.tokens.list()).find((token) => token.id === id)?.cooldownUntil;
    }

    it('(a) 読めないあいだに届いた期限の事実を、設定が戻った後の文言だけの拒否で使う', async () => {
      const h = harness();
      await seedTwo(h);
      breakTokenSettings(h);

      const first = await h.rotator.observe({
        facts: { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT },
        statusNow: 'rejected',
      });
      expect(first.kind).toBe('ignored');
      if (first.kind !== 'ignored') return;
      expect(first.signal).toBe('settings_unreadable');

      await h.stores.tokens.writeSettings(settingsBack);
      const outcome = await h.rotator.observe({
        notice: reached,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });

      expect(outcome.kind).toBe('rotated');
      expect(await cooldownOf(h, 'tok-a')).toBe(RESETS_AT);
      expect(await cooldownOf(h, 'tok-a')).not.toBe(GUESS);
    });

    it('(b) 覚えた後、読めないあいだに allowed が届けば、古い期限は使わない', async () => {
      const h = harness();
      await seedTwo(h);
      breakTokenSettings(h);

      await h.rotator.observe({
        facts: { kind: 'five_hour', status: 'rejected', resetsAt: RESETS_AT },
        statusNow: 'rejected',
      });
      await h.rotator.observe({
        facts: { kind: 'five_hour', status: 'allowed', resetsAt: RESETS_AT },
        statusNow: 'allowed',
      });

      await h.stores.tokens.writeSettings(settingsBack);
      const outcome = await h.rotator.observe({
        notice: reached,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });

      expect(outcome.kind).toBe('rotated');
      expect(await cooldownOf(h, 'tok-a')).toBe(GUESS);
    });
  });

  it('(e) UnreadableTokenSettingsError 以外はそのまま投げる（observe）', async () => {
    const h = harness();
    await seedTwo(h);
    h.stores.tokens.readSettings = async () => {
      throw new Error('記憶ストアの接続断');
    };

    await expect(h.rotator.observe({ notice: reached })).rejects.toThrow('記憶ストアの接続断');
  });

  it('(e) UnreadableTokenSettingsError 以外はそのまま投げる（reconsider）', async () => {
    const h = harness();
    await seedTwo(h);
    h.stores.tokens.readSettings = async () => {
      throw new Error('記憶ストアの接続断');
    };

    await expect(h.rotator.reconsider({ reason: 'tick' })).rejects.toThrow('記憶ストアの接続断');
  });
});

describe('describeTokenRotation', () => {
  const spread = [
    { target: 'runner-primary', ok: true },
    { target: 'clone', ok: true },
  ];

  it('回したら、どこからどこへ・何を根拠に・撒いた先を出す', () => {
    const line = describeTokenRotation({
      kind: 'rotated',
      fromTokenId: 'env-1',
      toTokenId: 'tok-b',
      toLabel: 'spare1',
      generation: 2,
      signal: 'reached',
      freshness: 'current',
      spread,
      why: '仕事が止まった文言が出た（設定に関わらず回す）',
    });

    expect(line).toContain('回した');
    expect(line).toContain('env-1 → 「spare1」');
    expect(line).toContain('世代 2');
    expect(line).toContain('置けた: runner-primary, clone');
  });

  it('⚠️「撒いた」を「回った」と読ませない断りが入る', () => {
    const line = describeTokenRotation({
      kind: 'rotated',
      toTokenId: 'tok-b',
      toLabel: 'spare1',
      generation: 2,
      signal: 'reached',
      freshness: 'current',
      spread,
      why: 'x',
    });
    expect(line).toContain('撒いたのであって、回ったのではない');
  });

  it('当たった文言をそのまま添える（言い換えない）', () => {
    const text = "You've hit your org's monthly spend limit";
    const line = describeTokenRotation(
      {
        kind: 'rotated',
        toTokenId: 'tok-b',
        toLabel: 'spare1',
        generation: 2,
        signal: 'reached',
        freshness: 'current',
        spread,
        why: 'x',
      },
      { noticeText: text },
    );
    expect(line).toContain(text);
  });

  it('撒けなかった先を落とさない（成功だけ数えて 2/3 と書かない）', () => {
    const line = describeTokenRotation({
      kind: 'rotated',
      toTokenId: 'tok-b',
      toLabel: 'spare1',
      generation: 2,
      signal: 'reached',
      freshness: 'current',
      spread: [
        { target: 'runner-primary', ok: true },
        { target: 'runner-2', ok: false, error: 'runner が応答しない' },
      ],
      why: 'x',
    });
    expect(line).toContain('置けなかった: runner-2');
    expect(line).toContain('runner が応答しない');
  });

  it('回せなかったら、いちばん早く戻る時刻を出す', () => {
    const line = describeTokenRotation({
      kind: 'exhausted',
      earliest: { tokenId: 'tok-b', label: 'spare1', cooldownUntil: Date.parse(AT) },
      signal: 'reached',
      freshness: 'current',
      why: '候補が全部冷却中である',
    });
    expect(line).toContain('回せなかった');
    expect(line).toContain('spare1');
    expect(line).toContain(AT);
  });

  it('戻る見込みが取れないときは、それを言う（時刻を作らない）', () => {
    const line = describeTokenRotation({
      kind: 'exhausted',
      signal: 'reached',
      freshness: 'current',
      why: '試せる候補が1本も無い',
    });
    expect(line).toContain('戻る見込みの立っている候補が1本も無い');
  });

  it('回さないと決めたことも記録する（受け入れ基準8）', () => {
    const line = describeTokenRotation({
      kind: 'ignored',
      signal: 'reached',
      freshness: 'current',
      why: '回す契機の設定が off（記録だけする）',
    });
    expect(line).toContain('回さなかった');
    expect(line).toContain('off');
  });

  it('世代の合わない通知は、数を持たなければ出さない', () => {
    expect(
      describeTokenRotation({
        kind: 'ignored',
        signal: 'reached',
        freshness: 'stale',
        why: 'もう回した後の通知',
      }),
    ).toBeNull();
  });

  it('世代の合わない通知は、初出と10の冪だけ出す（全件でも0件でもない）', () => {
    const at = (staleRun: number): string | null =>
      describeTokenRotation({
        kind: 'ignored',
        signal: 'reached',
        freshness: 'stale',
        staleRun,
        why: 'もう回した後の通知',
      });

    expect(at(1)).toContain('1件目');
    for (const quiet of [2, 3, 9, 11, 99, 101]) expect(at(quiet)).toBeNull();
    expect(at(10)).toContain('10件目');
    expect(at(100)).toContain('100件目');
    expect(at(1000)).toContain('1000件目');
  });

  it('間引いていることを出力に書く（連番だと読ませない）', () => {
    const line = describeTokenRotation({
      kind: 'ignored',
      signal: 'reached',
      freshness: 'stale',
      staleRun: 10,
      why: 'もう回した後の通知',
    });
    expect(line).toContain('連番ではない');
  });

  it('材料が何も無い観測は出さない（毎ターン届くので日誌が埋まる）', () => {
    expect(
      describeTokenRotation({
        kind: 'ignored',
        signal: 'none',
        freshness: 'unknown',
        why: '回す契機に当たる観測が無い',
      }),
    ).toBeNull();
  });
});

describe('describeTokenRestore', () => {
  it('一度も回していなければ出さない（毎回の起動で出ると意味のある行が埋もれる）', () => {
    expect(describeTokenRestore({ kind: 'none', why: 'x' })).toBeNull();
  });

  it('撒き直したら、世代を増やしていないことを明記する', () => {
    const line = describeTokenRestore({
      kind: 'restored',
      tokenId: 'tok-b',
      label: 'spare1',
      generation: 5,
      cooling: false,
      spread: [{ target: 'clone', ok: true }],
      why: 'x',
    });
    expect(line).toContain('世代 5、増やしていない');
    expect(line).toContain('spare1');
  });

  it('冷却中だったことを出す', () => {
    const line = describeTokenRestore({
      kind: 'restored',
      tokenId: 'tok-b',
      label: 'spare1',
      generation: 5,
      cooling: true,
      spread: [],
      why: 'x',
    });
    expect(line).toContain('冷却中である');
  });

  it('撒き直さなかった理由を出す（dangling / withheld）', () => {
    expect(describeTokenRestore({ kind: 'dangling', tokenId: 'ghost', why: '行が無い' })).toContain(
      '行が無い',
    );
    expect(
      describeTokenRestore({ kind: 'withheld', tokenId: 'x', label: 'y', why: '人間が外している' }),
    ).toContain('人間が外している');
  });

  it('#1383: 配布そのものの失敗と、相手が居ないだけ（自己修復する）失敗を同じ文言にしない', () => {
    const line = describeTokenRestore({
      kind: 'restored',
      tokenId: 'tok-b',
      label: 'spare1',
      generation: 5,
      cooling: false,
      spread: [
        { target: 'runner-2', ok: false, error: 'runner が応答しない' },
        {
          target: 'runner',
          ok: false,
          error: '繋がっている runner が1台も無い（これから起こすマネージャーには届かない）',
          selfHealing: true,
        },
      ],
      why: 'x',
    });
    expect(line).not.toBeNull();
    const spreadLine = (line ?? '').split('\n')[1] ?? '';
    expect(spreadLine).toContain('置けなかった: runner-2');
    expect(spreadLine).toContain('相手が居ないだけ: runner');
    expect(spreadLine).toContain('自己修復する');
    expect(spreadLine).not.toContain('置けなかった: runner**（');
    expect(spreadLine.split(' / ')).toHaveLength(2);
  });
});

/**
 * 日誌の1件にする側（`tokenRotationEntry` / `tokenRestoreEntry`）。
 *
 * **ここが固定するのは「専用の種別に何が載るか」だけである。** 文言そのものは
 * 上の describe が持ち、種別が `exchange` と分かれていることの意味（絞れる）は
 * `schema.ts` の doc に在る。
 */
describe('tokenRotationEntry / tokenRestoreEntry', () => {
  it('出す・出さないの判定を二重に持たない（describe が null なら null）', () => {
    // **これが要点である。** 判定をここでもう一度書くと、stderr には出るのに
    // 日誌には出ない（あるいは逆）という食い違いが静かに生まれる。
    const stale = {
      kind: 'ignored' as const,
      signal: 'reached' as const,
      freshness: 'stale' as const,
      why: '前のトークンの通知',
    };
    expect(describeTokenRotation(stale)).toBeNull();
    expect(tokenRotationEntry(stale)).toBeNull();

    const none = { kind: 'none' as const, why: '一度も回していない' };
    expect(describeTokenRestore(none)).toBeNull();
    expect(tokenRestoreEntry(none)).toBeNull();
  });

  it('打ち切りは exhausted ではなく sweep_stopped として載る', () => {
    // **潰すと「候補が無い」と「まだ試していない候補が在る」が同じ顔になる。**
    // 読む側は前者だと思って待つが、実際には次の観測で回りうる。
    const stopped = tokenRotationEntry({
      kind: 'exhausted',
      stoppedBy: 'budget',
      signal: 'reached',
      freshness: 'current',
      why: '候補を試す持ち時間（60000ms）を使い切った',
    });
    expect(stopped?.event).toBe('sweep_stopped');
    // **打ち切りに `earliestAt` を付けない**（戻る見込みを測っていない）。
    expect(stopped).not.toHaveProperty('earliestAt');

    // 試し切ったほうは今までどおり `exhausted`。
    const exhausted = tokenRotationEntry({
      kind: 'exhausted',
      signal: 'reached',
      freshness: 'current',
      why: '試せる候補を使い切った',
    });
    expect(exhausted?.event).toBe('exhausted');
  });

  it('回ったら rotated として、移った先と世代と契機が載る', () => {
    const entry = tokenRotationEntry(
      {
        kind: 'rotated',
        fromTokenId: 'tok-a',
        toTokenId: 'tok-b',
        toLabel: '予備1',
        generation: 4,
        signal: 'quota_rejected',
        freshness: 'current',
        spread: [],
        why: '枠に当たった',
      },
      { noticeText: "You've hit your usage limit" },
    );

    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('token_rotation');
    expect(entry?.event).toBe('rotated');
    expect(entry?.fromTokenId).toBe('tok-a');
    expect(entry?.tokenId).toBe('tok-b');
    expect(entry?.label).toBe('予備1');
    expect(entry?.generation).toBe(4);
    expect(entry?.signal).toBe('quota_rejected');
    expect(entry?.freshness).toBe('current');
    // **当たった文言が構造の側にも残る**（受け入れ基準8）。整形の言い方が
    // 変わっても、原文は `text` の中だけに居ないようにしてある。
    expect(entry?.noticeText).toBe("You've hit your usage limit");
    expect(entry?.text).toContain("You've hit your usage limit");
  });

  it('回さなかった（not_rotated）と回せなかった（exhausted）を潰さない', () => {
    // **2値へ潰すと、いちばん重い状態がいちばん普通の状態と同じ顔になる。**
    const notRotated = tokenRotationEntry({
      kind: 'ignored',
      signal: 'warning',
      freshness: 'current',
      why: '警告は契機ではない',
    });
    const exhausted = tokenRotationEntry({
      kind: 'exhausted',
      earliest: { tokenId: 'tok-a', label: '予備1', cooldownUntil: 1_800_000_000_000 },
      signal: 'reached',
      freshness: 'current',
      why: '全部冷却中',
    });

    expect(notRotated?.event).toBe('not_rotated');
    expect(exhausted?.event).toBe('exhausted');
    expect(exhausted?.earliestAt).toBe(new Date(1_800_000_000_000).toISOString());
  });

  /**
   * **#683**: `earliestAt` の出所を日誌が覚える。
   *
   * 日誌には既に `earliestAt` が在ったが**出所は無かった** ⟹ 行を見ても
   * 「その時刻が本物か、5時間足しただけか」が言えなかった。
   */
  describe('#683: earliestAt の出所', () => {
    it('parked の行に出所が載る', () => {
      const entry = tokenRotationEntry({
        kind: 'parked',
        fromTokenId: 'tok-a',
        tokenId: 'tok-b',
        label: '予備1',
        generation: 5,
        cooldownUntil: 1_800_000_000_000,
        cooldownSource: 'quota_reset',
        signal: 'reached',
        freshness: 'current',
        spread: [{ target: 'runner-primary', ok: true }],
        why: 'いま通る鍵が無い',
      });

      expect(entry?.event).toBe('parked');
      expect(entry?.cooldownSource).toBe('quota_reset');
      // **人間が読む1行にも出す**（構造だけだと画面と CLI で言い方が割れる）。
      expect(entry?.text).toContain('出所は枠の resetsAt');
    });

    it('exhausted の earliest にも載る', () => {
      const entry = tokenRotationEntry({
        kind: 'exhausted',
        earliest: {
          tokenId: 'tok-a',
          label: '予備1',
          cooldownUntil: 1_800_000_000_000,
          cooldownSource: 'default',
        },
        signal: 'reached',
        freshness: 'current',
        why: '全部冷却中',
      });

      expect(entry?.cooldownSource).toBe('default');
      // **推測であることを、推測の回にだけ黙らない形で言う。**
      expect(entry?.text).toContain('ただの推測');
    });

    it('⚠️ 出所を持たない行では欄を作らない（既定で埋めない）', () => {
      // **無いのは「言えなかった」である。** `default` で埋めると「推測だと
      // 観測した」という嘘になり、読む側は本物の値を推測として捨てうる。
      const entry = tokenRotationEntry({
        kind: 'parked',
        tokenId: 'tok-b',
        label: '予備1',
        generation: 5,
        cooldownUntil: 1_800_000_000_000,
        signal: 'reached',
        freshness: 'current',
        spread: [{ target: 'runner-primary', ok: true }],
        why: 'いま通る鍵が無い',
      });

      expect(entry?.event).toBe('parked');
      expect(entry).not.toHaveProperty('cooldownSource');
      expect(entry?.text).not.toContain('出所は');
    });
  });

  it('戻る見込みの候補が1本も無いとき earliestAt を埋めない（「すぐ戻る」と混ぜない）', () => {
    const entry = tokenRotationEntry({
      kind: 'exhausted',
      signal: 'reached',
      freshness: 'current',
      why: 'プールが空',
    });

    expect(entry?.event).toBe('exhausted');
    // **無いことを作らない。** 埋めると「その時刻に戻る」と読める。
    expect(entry?.earliestAt).toBeUndefined();
    expect(entry?.tokenId).toBeUndefined();
  });

  it('起動時の撒き直しは restored（世代を増やさない）', () => {
    const entry = tokenRestoreEntry({
      kind: 'restored',
      tokenId: 'tok-a',
      label: '予備1',
      generation: 7,
      cooling: false,
      spread: [],
      why: '起動時',
    });

    expect(entry?.event).toBe('restored');
    expect(entry?.tokenId).toBe('tok-a');
    expect(entry?.generation).toBe(7);
    // 契機は無い（撒き直しは枠の観測ではない）。
    expect(entry?.signal).toBeUndefined();
  });

  it('撒き直せなかったときも、どの指名だったかは載せる', () => {
    const dangling = tokenRestoreEntry({
      kind: 'dangling',
      tokenId: 'tok-gone',
      why: '指名された行がもう無い',
    });
    expect(dangling?.event).toBe('restore_failed');
    expect(dangling?.tokenId).toBe('tok-gone');
    // `dangling` は label を持たない。**無いものを埋めない。**
    expect(dangling?.label).toBeUndefined();

    const withheld = tokenRestoreEntry({
      kind: 'withheld',
      tokenId: 'tok-off',
      label: '外した分',
      why: '人間が外している',
    });
    expect(withheld?.event).toBe('restore_failed');
    expect(withheld?.label).toBe('外した分');
  });

  it('トークンの値をどのフィールドにも載せない（受け入れ基準5）', () => {
    // **値が載る経路がそもそも無いことを、型ではなく実物で確かめる。**
    // `TokenRotationOutcome` は値を持たないが、将来ここへ何かを足すときに
    // 「値を混ぜた」が黙って通らないようにする歯である。
    const entry = tokenRotationEntry(
      {
        kind: 'rotated',
        toTokenId: 'tok-b',
        toLabel: '予備1',
        generation: 1,
        signal: 'reached',
        freshness: 'current',
        spread: [],
        why: '枠',
      },
      { noticeText: '上限です' },
    );

    expect(JSON.stringify(entry)).not.toContain('sk-ant');
    expect(Object.keys(entry ?? {})).not.toContain('value');
  });
});

/**
 * **観測を待たずに、記録の状態だけを見て回す**（`reconsider`。人間の決定 2026-09-07）。
 *
 * ## この歯の集合が固定している穴
 *
 * `observe` の6つの検知点は**すべてセッション由来**である ⟹ **全層が枠で止まった
 * 状態は、観測を上げる主体が1つも居ない状態でもある。** そこから抜けるには誰かが
 * もう一度本番で失敗して観測を上げるしかなく、**プールに通る鍵が残っていても
 * 何も起きない**時間ができた（人間の報告: 「枠塞がってないトークンがあるのに
 * 何故何もしてないことがある」）。
 *
 * **⚠️ ここは「回るようになった」を測る歯であって、「本番で通った」を測る歯では
 * ない。** 本物のトークンを扱わない枷があるので、そちらは実装側からは測れない。
 */
/**
 * **現役の冷却が明けたら、止まっていた層を起こす契機を出す**（#833）。
 *
 * ## なぜこの歯が要るか —— `parked` の出口が probe 1本に依存していた
 *
 * `TokenRotationOutcome.recovered` の doc は「`parked` の側は放置ではない ——
 * 冷却が明ければ枠の probe（5分ごと）が `usable` を観測し、`recovered` として
 * ここへ戻ってくる」と約束していた。**probe が判定を1つも返さない器では、その
 * 出口が閉じている**（`apps/daemon/src/token-watch.ts` の「probe が1つも判定を
 * 返さない器が在る（本番がそれだった）」）。
 *
 * 実測（2026-09-11 の本番）: 現役の冷却が 13:20:00Z に明けたのに、日誌もログも
 * 13:19:30Z を最後に1行も出ず、次の自発ターン（13:57:49Z）まで**約38分**何も
 * 動かなかった。
 *
 * ## ⚠️ ここは「起こす契機が出るか」を測る歯であって、「本番で通った」の歯ではない
 *
 * 冷却が明けたことは時計で言えるが、その鍵が実際に通るかは観測しないと分から
 * ない（`tokenAvailabilityAt` の doc:「`ready` は『通る』ではない」）。**起こした
 * 後で結局枠なら、その失敗が新しい観測として上がってくる。**
 */
describe('reconsider: 現役の冷却が明けたら、止まっていた層を起こす（#833）', () => {
  /** 現役（`tok-a`）の冷却が `AT` の1時間前に明けている状態を作る。 */
  async function seedElapsed(h: Harness): Promise<number> {
    const elapsed = Date.parse(AT) - 60 * 60 * 1000;
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: elapsed,
        cooldownSource: 'quota_reset',
        lastRejectedAt: '2026-08-25T00:00:00.000Z',
        lastRejectedReason: "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
      },
      // **候補は置かない。** 置くと「回った」と区別が付かなくなる —— この歯が
      // 測るのは「回さずに起こす」ほうである。
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 3, rotatedAt: AT });
    return elapsed;
  }

  it('明けた回に reopened が立ち、日誌は recovered とは別の event で残る', async () => {
    const h = harness();
    const elapsed = await seedElapsed(h);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.reopened).toEqual({
      tokenId: 'tok-a',
      label: 'first',
      cooldownUntil: new Date(elapsed).toISOString(),
    });
    // **`recovered` を名乗らない。** あちらは「通ることを観測できた」で、ここには
    // 観測が1つも無い（`markTokenUsable` の doc が禁じている混同そのもの）。
    expect(outcome.recovered).toBeUndefined();
    // **回していない。撒いてもいない。** 出すのは「明けた」という事実だけである。
    expect(h.spreadCalls).toEqual([]);
    expect(h.probeCalls).toEqual([]);

    const entry = tokenRotationEntry(outcome);
    expect(entry?.event).toBe('reopened');
    expect(entry?.tokenId).toBe('tok-a');
    // **観測していないので、どちらの生産者かを名乗る欄は付かない。**
    expect(entry?.recoveredSource).toBeUndefined();
  });

  it('同じ冷却では2回目は立たない（目盛りは60秒ごとに来る）', async () => {
    const h = harness();
    await seedElapsed(h);

    const first = await h.rotator.reconsider({ reason: 'tick' });
    const second = await h.rotator.reconsider({ reason: 'tick' });

    expect(first.kind === 'ignored' && first.reopened !== undefined).toBe(true);
    // **これがこの歯の本体である。** 立ちっぱなしにすると
    // `resumeStoppedByUsage()` が毎分走る。
    expect(second.kind === 'ignored' && second.reopened === undefined).toBe(true);
    // 2回目は日誌にも出ない（`signal: 'none'` の `not_rotated` は黙る）。
    expect(describeTokenRotation(second)).toBeNull();
  });

  it('記録を1文字も消さない（markTokenUsable を呼ばない）', async () => {
    const h = harness();
    const elapsed = await seedElapsed(h);
    const before = h.replaceCalls();

    await h.rotator.reconsider({ reason: 'tick' });

    // **記憶ストアへ1回も書いていない。** 「明けたかどうかは `cooldownUntil` を
    // 読めば分かるので、消す必要が無い」（`markTokenUsable` の doc の逐語）。
    expect(h.replaceCalls()).toBe(before);
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.cooldownUntil).toBe(elapsed);
    expect(row?.cooldownSource).toBe('quota_reset');
    expect(row?.lastRejectedAt).toBe('2026-08-25T00:00:00.000Z');
    expect(row?.lastRejectedReason).toBe(
      "You've hit your session limit · resets 10:20pm (Asia/Tokyo)",
    );
  });

  it('冷却を持たない健全な現役では立たない（毎分の目盛りで何も起きない）', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('ignored');
    expect(outcome.kind === 'ignored' ? outcome.reopened : undefined).toBeUndefined();
    expect(describeTokenRotation(outcome)).toBeNull();
  });

  it('もう一度冷やされて明けたら、また立つ（(id, cooldownUntil) の組で数える）', async () => {
    const h = harness();
    await seedElapsed(h);
    await h.rotator.reconsider({ reason: 'tick' });

    // 2度目の冷却。**別の期限**なので、明けたらもう一度起こす必要がある。
    const again = Date.parse(AT) - 60 * 1000;
    const pool = await h.stores.tokens.list();
    await h.stores.tokens.replace(
      pool.map((token) => (token.id === 'tok-a' ? { ...token, cooldownUntil: again } : token)),
    );

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind === 'ignored' && outcome.reopened?.cooldownUntil).toBe(
      new Date(again).toISOString(),
    );
  });

  it('rotateOn が off でも立つ（off は「鍵を移すな」であって「止まったままにしておけ」ではない）', async () => {
    const h = harness();
    await seedElapsed(h);
    await h.stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 18_000_000, updatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind === 'ignored' && outcome.reopened?.tokenId).toBe('tok-a');
  });

  it('probe で通らないと観測したのに設定が読めない回は settings_unreadable で、reopened を出さず記録もしない。次に通る回で1回だけ立つ（#2391）', async () => {
    const h = harness();
    const elapsed = await seedElapsed(h);
    breakTokenSettings(h, 'cooldownMs が負の数');

    const blocked = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'unusable', reason: '枠が尽きた' },
        origin: { source: 'account_probe' },
      },
    });

    // (a) 門が先に返る。「明けた」の合図は出ない。
    expect(blocked.kind).toBe('ignored');
    if (blocked.kind !== 'ignored') return;
    expect(blocked.signal).toBe('settings_unreadable');
    expect(blocked.reopened).toBeUndefined();
    expect(blocked.why).toContain('枠が尽きた');
    expect(blocked.why).toContain('cooldownMs が負の数');

    // (b) 記録していないので、設定が読めて probe も無い次の回で1回だけ立つ。
    await h.stores.tokens.writeSettings({ rotateOn: 'free_exhausted', cooldownMs: 18_000_000 });
    const next = await h.rotator.reconsider({ reason: 'tick' });
    expect(next.kind === 'ignored' && next.reopened?.cooldownUntil).toBe(
      new Date(elapsed).toISOString(),
    );
    const again = await h.rotator.reconsider({ reason: 'tick' });
    expect(again.kind === 'ignored' && again.reopened === undefined).toBe(true);
  });

  it('冷却がまだ明けていなければ立たない（park の途中では起こさない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 60 * 60 * 1000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    // 現役は `cooling` なので `ready` の門にすら来ない（候補も無いので `exhausted`）。
    expect(outcome.kind).toBe('exhausted');
    expect(outcome.kind === 'ignored' ? outcome.reopened : undefined).toBeUndefined();
  });
});

describe('reconsider: 動く鍵が残っているのに諦めない', () => {
  it('記録の上で現役が冷却中で、通る候補が在れば回す（観測は1つも無い）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        // 既に冷却へ入っている＝「止まった」ことは記録済み。
        cooldownUntil: Date.parse(AT) + 5 * 60 * 60 * 1000,
        lastRejectedAt: AT,
        lastRejectedReason: "You've hit your org's monthly spend limit",
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 3, rotatedAt: AT });

    // **観測を1つも渡さない。** これが `observe` との違いそのものである。
    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.fromTokenId).toBe('tok-a');
    expect(outcome.generation).toBe(4);
    // **印は `stranded`。** 枠の観測ではなく記録からそう言っている。
    expect(outcome.signal).toBe('stranded');
    expect(outcome.reason).toBe('tick');
    // **`freshness` は付かない。** 照合する観測が無いので、`unknown` で埋めない。
    expect(outcome.freshness).toBeUndefined();
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
  });

  it('現役が記録の上で通るなら、健全な鍵から勝手に移らない', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('ignored');
    expect(outcome.signal).toBe('none');
    // **probe を1本も焼いていない。** ふつうの状態の目盛りが安いことの本体である。
    expect(h.probeCalls).toEqual([]);
    expect(h.spreadCalls).toEqual([]);
  });

  it('候補が全部冷却中なら probe を1本も焼かない（目盛りで回しても安い）', async () => {
    const h = harness();
    const cooling = Date.parse(AT) + 60 * 60 * 1000;
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, cooldownUntil: cooling },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1, cooldownUntil: cooling },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    // **これがこの歯の本体である。** 候補選び（`selectNextToken`）は記録だけを
    // 見る純粋関数なので、`ready` な行が1本も無ければ probe の前に打ち切る ⟹
    // 目盛りで何度呼んでもサブプロセスは起きない。
    expect(h.probeCalls).toEqual([]);
    // **同着なので撒き直さない**（`parkImprovesOn`。同じ時刻に戻る鍵へ移すのは
    // 改善ではなく、増えた世代が走行中の観測を `stale` にするだけである）。
    // 撒く側の判定そのものは下の describe（「park し直すのは…」）が測る。
    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
  });

  it('プールが空なら1文字も変えない（受け入れ基準7）', async () => {
    const h = harness();

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(h.probeCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toBeNull();
    // **日誌にも出さない。** 既定の構成で目盛りごとに1行増えると、意味のある行が埋もれる。
    expect(tokenRotationEntry(outcome)).toBeNull();
  });

  it('設定が off なら回さない（記録はする）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 1,
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
    await h.stores.tokens.writeSettings({
      rotateOn: 'off',
      cooldownMs: 18_000_000,
      updatedAt: AT,
    });

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('ignored');
    // **`none` へ潰さない。** 「止まっていることは分かっていた」が記録に残る。
    expect(outcome.signal).toBe('stranded');
    expect(h.spreadCalls).toEqual([]);
    // `stranded` は日誌に出る（`signal: 'none'` の目盛りだけが黙る）。
    expect(tokenRotationEntry(outcome)?.event).toBe('not_rotated');
  });

  it('指名の先の行が消えていたら（dangling）、通る候補へ移す', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 1 }]);
    // 人間が `tok-a` を消した後の状態。
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 2, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.why).toContain('プールに無い');
  });

  /**
   * **⚠️ 2026-09-14 に期待を反転した。** 元の題は「指名が無い器では、環境変数の
   * 行を現役として見る」——器の環境変数を指す行（`source: 'env'`）が「実質の
   * 現役」として扱われ、その行が冷却中なら状態からでも回っていた。その概念
   * （`isEnvToken` によるフォールバック）ごと廃止したので、**指名が一度も無い
   * （`active === null`）状態からは、状態だけでは何も決めない。**
   *
   * **⚠️ 2026-09-15 にもう一度反転した。** 「状態だけでは何も決めない」を貫くと、
   * プールが空のままデーモンが起動し、あとから初めてトークンを登録した器では
   * 永久に最初の現役が選ばれなかった——`observe` は `classifyUsageNotice` に
   * 一致する文言（利用上限系）でしか呼ばれず、それに当たらない失敗（実例:
   * `Not logged in · Please run /login`）では一度も呼ばれない。実運用
   * （2026-09-14）でこの形を踏み、トークンを5本登録しても回復しなかった。
   * ⟹ **「現役が一度も無い」は「現役が通らない」の最も極端な形として扱い、
   * 候補が在れば選ぶ側へ倒す。**
   */
  it('指名が一度も無い器でも、候補が在れば選ぶ', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 0 }]);
    // `writeActive` を一度も呼んでいない ⟹ `active` は `null`。

    const outcome = await h.rotator.reconsider({ reason: 'account_probe' });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    expect(outcome.signal).toBe('stranded');
  });

  it('指名が一度も無い器で、成功の観測だけでは回さない', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 0 }]);
    // `writeActive` を一度も呼んでいない ⟹ `active` は `null`。

    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-b', generation: 1 } },
      },
    });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
  });

  it('指名が一度も無い器で、設定が off なら選ばない（記録だけする）', async () => {
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 0 }]);
    await h.stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 1 });
    // `writeActive` を一度も呼んでいない ⟹ `active` は `null`。

    const outcome = await h.rotator.reconsider({ reason: 'account_probe' });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.signal).toBe('stranded');
    expect(h.spreadCalls).toEqual([]);
  });
});

/**
 * **セッションを1本も使わない観測（`current.verdict` / `origin: { source: 'account_probe' }`）で回す / 戻す。**
 *
 * `apps/daemon/src/usage-poller.ts` が5分ごとに取っているものを
 * `judgeTokenCandidate` へ通した値がここへ来る。**全層が止まっていても届く
 * 唯一の観測である。**
 */
describe('reconsider: 現役の probe 結果を効かせる', () => {
  it('記録が ready でも、probe が unusable なら冷却へ入れて回す', async () => {
    const h = harness();
    await seedTwo(h); // tok-a が現役、どちらも `ready`

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: {
          verdict: 'unusable',
          reason: '取れた枠がすべて使い切られており、課金枠も使えない',
        },
        origin: { source: 'account_probe' },
      },
    });

    expect(outcome.kind).toBe('rotated');
    if (outcome.kind !== 'rotated') return;
    expect(outcome.toTokenId).toBe('tok-b');
    // **文言をそのまま残す**（言い換えない）。
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.lastRejectedReason).toBe('取れた枠がすべて使い切られており、課金枠も使えない');
    expect(await isCooling(h, 'tok-a')).toBe(true);
  });

  it('probe が usable なら、止まった記録を消して「いつ開いたか」を残す', async () => {
    // **冷却が既定の5時間で入っていて、実際には枠がもっと早く開いていた回。**
    // 消さないと、その鍵は「使えるのに候補から外れている」状態で残り続ける。
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 4 * 60 * 60 * 1000,
        lastRejectedAt: AT,
        lastRejectedReason: "You've hit your usage limit",
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    // **回していない。** 鍵は1文字も変わっていない。
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 1 });
    // **止まった記録は消えている。**
    expect(await isCooling(h, 'tok-a')).toBe(false);
    // **「いつ開いたか」を残す材料が返る**（受信箱へは入れない。理由は
    // `settleTokenOutcome` の逐語）。**`source` は出所をそのまま引き継ぐ**（#681 (1)）。
    expect(outcome.recovered).toEqual({
      tokenId: 'tok-a',
      label: 'first',
      source: 'account_probe',
    });
    // **日誌に出る（`signal: 'none'` でも黙らない）。** 止まった側と対になる唯一の行。
    expect(tokenRotationEntry(outcome)?.event).toBe('recovered');
    // **`recoveredSource` も潰さず出る**（#681 (1)。`account_probe` と区別できる）。
    expect(tokenRotationEntry(outcome)?.recoveredSource).toBe('account_probe');
  });

  it('人間が外した行には触らない（probe が通っても戻さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        disabledAt: AT,
        lastRejectedAt: AT,
        lastRejectedReason: '上限',
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });

    // 記録は消していない（人間の判断を実装が黙って覆さない）。
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    expect(row?.disabledAt).toBe(AT);
    expect(row?.lastRejectedAt).toBe(AT);
    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.recovered).toBeUndefined();
  });

  it('probe が undecidable なら記録だけで判定する（unusable へ丸めない）', async () => {
    const h = harness();
    await seedTwo(h); // どちらも `ready`

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'undecidable', reason: 'probe が失敗した' },
        origin: { source: 'account_probe' },
      },
    });

    // 記録の上では現役が通るので、回さない。
    expect(outcome.kind).toBe('ignored');
    expect(outcome.signal).toBe('none');
    expect(h.spreadCalls).toEqual([]);
    expect(await isCooling(h, 'tok-a')).toBe(false);
  });
});

/**
 * **`usable` の2本目の生産者（#681 (1)）——あるトークンで層のターンが実際に
 * 成功した、という観測。** `account_probe` が見ていないセッション単位の上限に
 * 効く。マネージャーが下した3つの設計判断をそれぞれ固定する。
 */
describe('reconsider: ターンの成功（#681 (1)。usable の2本目の生産者）', () => {
  it('冷却中の記録が、ターンの成功で消える（recovered が turn_success で出る。本筋）', async () => {
    const h = harness();
    await seedTwo(h); // tok-a が現役、generation 1
    await h.stores.tokens.replace(
      (await h.stores.tokens.list()).map((token) =>
        token.id === 'tok-a'
          ? {
              ...token,
              cooldownUntil: Date.parse(AT) + 60 * 60_000,
              lastRejectedAt: AT,
              lastRejectedReason: '上限',
            }
          : token,
      ),
    );

    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-a', generation: 1 } },
      },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    // **回していない。** 消したのは止まった記録だけである。
    expect(h.spreadCalls).toEqual([]);
    expect(await isCooling(h, 'tok-a')).toBe(false);
    // **`account_probe` とは区別できる出所を持つ。**
    expect(outcome.recovered).toEqual({ tokenId: 'tok-a', label: 'first', source: 'turn_success' });
    expect(tokenRotationEntry(outcome)?.event).toBe('recovered');
    expect(tokenRotationEntry(outcome)?.recoveredSource).toBe('turn_success');
  });

  it('⚠️ 判断1の歯: 世代がずれた成功は捨てる（markTokenUsable を呼ばない）', async () => {
    const h = harness();
    await seedTwo(h); // tok-a が現役、generation 1
    await h.stores.tokens.replace(
      (await h.stores.tokens.list()).map((token) =>
        token.id === 'tok-a' ? { ...token, cooldownUntil: Date.parse(AT) + 60 * 60_000 } : token,
      ),
    );

    // **現役の世代は 1 だが、観測は世代 2 を名乗る**（もう回した後、あるいは
    // まだ試していない現役についての、遅れて届いた成功）。
    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-a', generation: 2 } },
      },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.recovered).toBeUndefined();
    // **記録は1文字も動いていない。** `markTokenUsable` は呼ばれていない。
    expect(await isCooling(h, 'tok-a')).toBe(true);
  });

  it('⚠️ 判断3の歯: 通る候補が在ってもターンの成功では回さない（usable 分岐に入れなかった場合も含む）', async () => {
    const h = harness();
    // **`tok-b` は通る候補として存在する**（`ready`）。記録の上でも現役
    // （`tok-missing`）はプールに行が無いので「通らない」——`account_probe` /
    // `tick` ならここから `stranded` 経由で `tok-b` へ回りうる状態である。
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 1 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-missing', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({
      reason: 'turn_succeeded',
      current: {
        verdict: { verdict: 'usable' },
        origin: { source: 'turn_success', observedBy: { tokenId: 'tok-missing', generation: 1 } },
      },
    });

    // **回っていない。** 成功は「いまの現役が通る」証拠であって「回すべき」
    // 証拠ではないので、通常の回転判定（`stranded` 経由の `sweepCandidates`）
    // へは絶対に落ちない。
    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-missing',
      generation: 1,
    });
  });

  it('⚠️ 判定の落ちた turn_succeeded（current 無し）でも回さない —— 見るのは reason である', async () => {
    // **`apps/daemon/src/token-watch.ts` の `pending` は
    // `TokenReconsiderReason` しか運べない。** ⟹ 契機だけを溜める形にすると、
    // `current` の落ちた `'turn_succeeded'` が実在しうる（実際に一度そう
    // 書いてあった）。あちら側でも溜めないようにしてあるが、**この関数が
    // `reason` を見ておけば、呼ぶ側が何をしても「成功では回らない」が成り立つ。**
    const h = harness();
    await h.stores.tokens.replace([{ id: 'tok-b', label: 'second', value: 'value-b', order: 1 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-missing', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'turn_succeeded' });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-missing',
      generation: 1,
    });
  });

  it('⚠️ #2738: 回す前の鍵を測った probe の unusable は、回した後の現役へ当てない', async () => {
    // probe は tok-a を測り始め、実行中に tok-b（世代 2）へ回った。遅れて届いた
    // tok-a の「枠切れ」を現役 tok-b の判定として適用してはいけない。
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: '2026-08-25T00:01:00.000Z',
    });

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'unusable', reason: '5時間枠を使い切っている' },
        origin: {
          source: 'account_probe',
          observedBy: { tokenId: 'tok-a', generation: 1 },
        },
      },
    });

    expect(outcome.kind).toBe('ignored');
    expect(h.spreadCalls).toEqual([]);
    expect(await isCooling(h, 'tok-b')).toBe(false);
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-b', generation: 2 });
  });

  it('#2738: 測った鍵が現役のままなら、probe の unusable は従来どおり効く', async () => {
    const h = harness();
    await seedTwo(h);

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: {
        verdict: { verdict: 'unusable', reason: '5時間枠を使い切っている' },
        origin: {
          source: 'account_probe',
          observedBy: { tokenId: 'tok-a', generation: 1 },
        },
      },
    });

    expect(outcome.kind).toBe('rotated');
    expect(await isCooling(h, 'tok-a')).toBe(true);
  });

  it('account_probe の既存の挙動は1ミリも変わっていない（回帰）', async () => {
    // **身元（`observedBy`）を運ばない `account_probe` には世代の門は掛からない**
    // （#2738 は運んできた probe にだけ門を掛ける）。従来どおり効く。
    const h = harness();
    await seedTwo(h);
    await h.stores.tokens.replace(
      (await h.stores.tokens.list()).map((token) =>
        token.id === 'tok-a' ? { ...token, cooldownUntil: Date.parse(AT) + 60 * 60_000 } : token,
      ),
    );

    const outcome = await h.rotator.reconsider({
      reason: 'account_probe',
      current: { verdict: { verdict: 'usable' }, origin: { source: 'account_probe' } },
    });

    expect(outcome.kind).toBe('ignored');
    if (outcome.kind !== 'ignored') return;
    expect(outcome.recovered).toEqual({
      tokenId: 'tok-a',
      label: 'first',
      source: 'account_probe',
    });
    expect(await isCooling(h, 'tok-a')).toBe(false);
  });
});

/**
 * **park し直すのは改善のときだけ**（`parkImprovesOn`）。
 *
 * ここが無いと、**待っているあいだに世代が延々と増える** —— 見張りは目盛り
 * （60秒）ごとに同じ状態を見るので、現役（前に park した鍵）が冷却中である
 * かぎり毎回「通らない」と判定され、候補の中でいちばん早いものがもっと遅い鍵
 * でもそちらへ移してしまう。**増えた世代は走行中の観測を全部 `stale` にする** ⟹
 * 待っているだけで、本物の当たりを飲み込む側が強くなる。
 */
describe('park し直すのは、より早く戻る鍵のときだけ', () => {
  /** 現役 `tok-a` が `activeUntil` まで、候補 `tok-b` が `candidateUntil` まで冷却中。 */
  async function parked(h: Harness, activeUntil: number, candidateUntil: number): Promise<void> {
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'parked-key', value: 'value-a', order: 0, cooldownUntil: activeUntil },
      {
        id: 'tok-b',
        label: 'later-key',
        value: 'value-b',
        order: 1,
        cooldownUntil: candidateUntil,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 7, rotatedAt: AT });
  }

  it('候補のほうが遅いなら撒き直さない（世代を増やさない）', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 10 * 60_000, Date.parse(AT) + 60 * 60_000);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({
      tokenId: 'tok-a',
      generation: 7,
    });
    // **「候補が無い」と書かない。** 読む側が次に確かめるものが違う。
    if (outcome.kind !== 'exhausted') return;
    expect(outcome.why).toContain('遅い鍵へ移すのは改善ではない');
  });

  it('現役のほうが早いとき、候補を「いちばん早く戻る」と書かない（現役を名指す）', async () => {
    // 実測 2026-09-24: 現役が 10:50Z に戻るのに、日誌の末尾は 12:40Z の候補を
    // 「いちばん早く戻るのは」と書いていた（候補の中の最速を全体の最速に見せていた）。
    const h = harness();
    const activeUntil = Date.parse(AT) + 10 * 60_000;
    const candidateUntil = Date.parse(AT) + 60 * 60_000;
    await parked(h, activeUntil, candidateUntil);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    if (outcome.kind !== 'exhausted') throw new Error(`exhausted ではない: ${outcome.kind}`);
    expect(outcome.current).toMatchObject({ tokenId: 'tok-a', cooldownUntil: activeUntil });
    expect(outcome.why).toContain('いま撒いてある「parked-key」のほうが早く戻る');
    expect(outcome.why).toContain('現役を除いた候補の中でいちばん早い「later-key」');
    const line = describeTokenRotation(outcome);
    expect(line).toContain(
      `いちばん早く戻るのは現役の「parked-key」（${new Date(activeUntil).toISOString()}`,
    );
    expect(line).not.toContain('いちばん早く戻るのは「later-key」');
  });

  it('目盛りを何回回しても世代は動かない（延々と増える形が塞がっている）', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 10 * 60_000, Date.parse(AT) + 60 * 60_000);

    for (let i = 0; i < 5; i++) await h.rotator.reconsider({ reason: 'tick' });

    expect(await h.stores.tokens.readActive()).toMatchObject({ generation: 7 });
    expect(h.spreadCalls).toEqual([]);
  });

  it('候補のほうが早いなら撒き直す（改善なので移す）', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 60 * 60_000, Date.parse(AT) + 10 * 60_000);

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-b');
    expect(outcome.generation).toBe(8);
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
  });

  /**
   * **トークンの追加・削除（`pool_changed`）も同じ判定を通る**（人間の要望
   * 2026-09-24「必ず最後にはリセットが一番早いトークンをセットして待機させる。
   * 追加・削除された場合も同様の関数を叩いて確認する」）。`PUT /tokens` は
   * `tokenWatch.poke('pool_changed')` →`reconsider` を呼ぶ（`apps/daemon/src/index.ts`）。
   */
  it('より早く戻る鍵が追加されたら（pool_changed）、そちらを撒いて待つ', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 60 * 60_000, Date.parse(AT) + 10 * 60_000);

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-b');
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-b']);
  });

  it('いちばん早く戻るのが現役自身なら、追加されても（pool_changed）現役のまま待つ', async () => {
    const h = harness();
    await parked(h, Date.parse(AT) + 10 * 60_000, Date.parse(AT) + 60 * 60_000);

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-a' });
  });

  it('待っていた現役が削除されたら（pool_changed）、残りでいちばん早く戻る鍵を撒いて待つ', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-b',
        label: 'later-key',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 60 * 60_000,
      },
      {
        id: 'tok-c',
        label: 'sooner-key',
        value: 'value-c',
        order: 2,
        cooldownUntil: Date.parse(AT) + 20 * 60_000,
      },
    ]);
    // 人間が `tok-a`（待っていた現役）を消した後の状態。
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 7, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'pool_changed' });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-c');
    expect(h.spreadCalls.map((call) => call.id)).toEqual(['tok-c']);
  });

  it('現役が冷却中ではない（人間が外した）なら、戻る見込みの立つ鍵へ移す', async () => {
    // **待っても戻らない側に居る**ので、冷却中の候補でも改善である。
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'disabled-key', value: 'value-a', order: 0, disabledAt: AT },
      {
        id: 'tok-b',
        label: 'cooling-key',
        value: 'value-b',
        order: 1,
        cooldownUntil: Date.parse(AT) + 60 * 60_000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('parked');
    if (outcome.kind !== 'parked') return;
    expect(outcome.tokenId).toBe('tok-b');
  });
});

/**
 * **文言が届かなかった回の冷却の記録に、観測できた事実を残す**
 * （人間の決定 2026-09-07）。
 *
 * ## なぜ要るか —— 「なぜ1日冷えているのか」が誰にも言えなかった
 *
 * 本番のプール（2026-09-07 の実測）は4本すべてが固定文言
 * `枠から追い返された（文言は届いていない）` を持ち、**うち1本だけ冷却が +34時間**
 * だった（他は1〜3時間）。⟹ `five_hour` で止まったのに長い枠のリセットを拾ったのか、
 * 本当に週の枠が尽きたのかを**判定する材料が記録の側に1つも無い。**
 *
 * **⚠️ 冷却の長さは変えていない。** `cooldownUntilFrom` の優先順は1文字も触って
 * いない —— 週の枠が尽きているなら1日冷やすのは正しく、どちらだったかは記録に
 * 無かった。**先に「言えるようにする」だけを入れる。**
 */
describe('冷却の記録に、期限の出所を残す', () => {
  async function coolWith(facts: Record<string, unknown> | undefined) {
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({
      // **文言を渡さない。** 渡した回はこの経路を通らない（SDK の文言をそのまま残す）。
      ...(facts === undefined ? {} : { facts: facts as never }),
      transition: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');
    return { row, h };
  }

  it('枠の resetsAt から採ったなら、そう書く', async () => {
    const at = Date.parse('2026-09-08T09:00:00.000Z');
    const { row } = await coolWith({ kind: 'seven_day_opus', status: 'rejected', resetsAt: at });

    expect(row?.cooldownUntil).toBe(at);
    // **どの枠で止まったか。** これが無いと +34時間が長すぎるのか判定できない。
    expect(row?.lastRejectedReason).toContain('枠: seven_day_opus');
    expect(row?.lastRejectedReason).toContain('status: rejected');
    expect(row?.lastRejectedReason).toContain('冷却の期限は枠の resetsAt から');
    expect(row?.lastRejectedReason).toContain('2026-09-08T09:00:00.000Z');
  });

  it('課金枠の overageResetsAt から採ったなら、そう書く', async () => {
    const at = Date.parse('2026-09-07T12:00:00.000Z');
    const { row } = await coolWith({ kind: 'five_hour', overageResetsAt: at });

    expect(row?.cooldownUntil).toBe(at);
    expect(row?.lastRejectedReason).toContain('冷却の期限は課金枠の overageResetsAt から');
  });

  it('どちらも届いていないなら「設定の既定から」と書く', async () => {
    // **「取れなかった」を値で埋めない。** 既定へ倒したこと自体を書く。
    const { row } = await coolWith({ kind: 'five_hour', status: 'rejected' });

    expect(row?.lastRejectedReason).toContain('冷却の期限は設定の既定から');
    expect(row?.lastRejectedReason).not.toContain('resetsAt から');
  });

  it('事実そのものが届いていないなら、そう書く', async () => {
    const { row } = await coolWith(undefined);

    expect(row?.lastRejectedReason).toContain('枠の事実も届いていない');
  });

  it('取れなかった欄は書かない（「不明」で埋めない）', async () => {
    // 埋めると、取れなかったことと「そういう値だった」が同じ顔になる。
    const { row } = await coolWith({ status: 'rejected' });

    expect(row?.lastRejectedReason).not.toContain('枠: ');
    expect(row?.lastRejectedReason).toContain('status: rejected');
  });

  it('文言が届いた回は、この経路を通らない（言い換えない）', async () => {
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({
      notice: reached,
      facts: { kind: 'five_hour', status: 'rejected' } as never,
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-a');

    // **SDK が出した文言そのまま。** 事実の写しを混ぜない。
    expect(row?.lastRejectedReason).toBe(reached.text);
    expect(row?.lastRejectedReason).not.toContain('枠: five_hour');
  });
});

/**
 * **起動*後*に現役が「待っても戻らない」状態になった回。**
 *
 * **⚠️ 2026-09-14 に、器の環境変数へのフォールバックを完全に廃止した。**
 * 2026-09-12〜2026-09-14（#869）のあいだは、通る候補が無く現役が待っても
 * 戻らない（消された / 外された / 失効した）回だけ、器の環境変数
 * （`CLAUDE_CODE_OAUTH_TOKEN`）の値を代わりに撒く手当てが入っていたが、その
 * 手当てごと撤去した——トークンプールは100% DB 駆動にする、という人間の決定
 * による。⟹ `exhausted` はいま、どの理由であっても**何も撒かない。**
 *
 * ⭐ **ここで測るのは「関数が呼ばれたか」ではなく「撒く口に資格が渡ったか」である。**
 * `spreadCalls` は {@link TokenSpreadPort} が受け取った引数そのもの ——
 * `apps/daemon/src/token-spread.ts` がこれを `RunnerClient#setCredentials` へ渡し、
 * runner の資格箱が `Host#childEnv()` で**これから起こす子プロセスの env** へ重ねる。
 * ⟹ **この配列が空である回は、その後に起こる子プロセスに資格が1本も無い回である。**
 */
describe('exhausted は何も撒かない（器の環境変数へのフォールバックは廃止した）', () => {
  it('指名の先の行が消えた（人間が消した）まま通る候補が無ければ exhausted。何も撒かない', async () => {
    const h = harness();
    // 残っている行は人間が外してあるので、候補は1本も立たない。
    await h.stores.tokens.replace([
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1, disabledAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'ghost', generation: 3, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
    // **プールの記録は1バイトも動かさない。**
    expect(await h.stores.tokens.readActive()).toMatchObject({ tokenId: 'ghost', generation: 3 });
  });

  it('人間が外した行が現役のまま通る候補が無ければ exhausted。何も撒かない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, disabledAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
  });

  it('失効した行が現役のままでも exhausted。何も撒かない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, invalidatedAt: AT },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    expect((await h.rotator.reconsider({ reason: 'tick' })).kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
  });

  it('現役が冷却中なだけなら撒かない（待てば戻る。プールの選択を覆さない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        cooldownUntil: Date.parse(AT) + 60_000,
      },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
  });

  it('持ち時間で打ち切った回は、現役が消えていても撒かない（まだ試していない候補が在る）', async () => {
    const h = harness({
      verdict: { verdict: 'unusable', reason: '枠が尽きている' },
      probeTakesMs: 40_000,
    });
    await seedFour(h);
    await h.stores.tokens.writeActive({ tokenId: 'ghost', generation: 9, rotatedAt: AT });

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome).toMatchObject({ kind: 'exhausted', stoppedBy: 'budget' });
    expect(h.spreadCalls).toEqual([]);
  });

  /**
   * **⚠️ 2026-09-15 に期待を反転した。** 元は「まだ一度も指名していない器では、
   * 状態からは決めない（撒く先の身元が無い）」——`active === null` を無条件で
   * `ignored` にしていた。いまは候補を探す側へ倒したので、**この行（人間が
   * 外した1本しか無い）では候補が見つからず `exhausted` になる**——「選ぶ側へ
   * 倒した」ことと「選べる候補が無い」ことは別で、後者は従来どおり何も撒かない。
   */
  it('まだ一度も指名していない器で、通る候補も無ければ exhausted。何も撒かない', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0, disabledAt: AT },
    ]);
    // `writeActive` を一度も呼んでいない ⟹ `active` は `null`。

    const outcome = await h.rotator.reconsider({ reason: 'tick' });

    expect(outcome.kind).toBe('exhausted');
    expect(h.spreadCalls).toEqual([]);
  });
});

/**
 * **`recovered` は記録に対してはエッジだが、通知の層から見るとレベルである**
 * （Issue #1051）。
 *
 * ## 何を測っているか —— 「なぜ同じ本文が数千件出たか」の機構そのもの
 *
 * 実運用で「認証トークンが通る状態に戻った」の**完全に同一の本文**が 35 ミリ秒に
 * 3件、24時間で 3297 件積まれた。起票時の推測は「回復の検出がポーリングで、
 * 回復状態が続く限り毎回発行している」だったが、**それは外れている** —— 下の
 * 1本目が示すとおり、同じ回復は1回しか立たない。
 *
 * **本当の機構は往復である。** `recovered` が立つ条件は `hasRejection`
 * （`lastRejectedAt` か `cooldownUntil` が在る）で、立った回にその記録は
 * `markTokenUsable` が消す。⟹ **記録に対してはエッジ。** ところが枠に当たって
 * いる間は、**別の層が 429 を踏むたびにその記録がまた書かれる** —— 次に
 * どこかのターンが成功した瞬間、また1件立つ。層が何本も走っていれば、この
 * 往復はミリ秒間隔で回る。
 *
 * ## ⚠️ ここは「直すべき欠陥」を固定しているのではない
 *
 * **回し手の側は正しい。** 往復が起きている間、記録の上では回復が本当に N 回
 * 起きており、`recovered` の日誌行はその N 回を残すべきものである（隣の
 * describe「recovered の日誌行は、受信箱へ配ったかどうかと無関係に必ず出る」
 * ——`apps/daemon/src/index.test.ts`——と同じ立場）。**減らすのは日誌でも母数でも
 * なく、クローンへ配る回数だけである。**
 *
 * ⟹ **この2本が固定しているのは「畳み込みをここへ置かない」という判断のほうで
 * ある。** ここが黙って畳み始めたら、日誌から往復が消える。畳むのは
 * `apps/daemon/src/index.ts` の門（`worthDeliveringNow`）で、その歯は
 * `apps/daemon/src/index.test.ts` に在る。
 */
describe('#1051: recovered は記録に対してエッジだが、429 が記録を撃ち直すと何度でも立つ', () => {
  /** 現役が「止まった記録」を持っている状態から始める（プールは2本）。 */
  async function seedBlockedActive(h: Harness): Promise<void> {
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        lastRejectedAt: '2026-08-25T02:00:00.000Z',
        lastRejectedReason: 'reached',
        cooldownUntil: Date.parse('2026-08-25T08:00:00.000Z'),
        cooldownSource: 'default',
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });
  }

  /** いまの世代を名乗る「ターンが成功した」の観測。 */
  const turnSucceeded = {
    reason: 'turn_succeeded' as const,
    current: {
      verdict: { verdict: 'usable' as const },
      origin: {
        source: 'turn_success' as const,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      },
    },
  };

  it('記録が撃ち直されなければ、同じ回復は1回しか立たない（＝記録に対してはエッジ）', async () => {
    const h = harness();
    await seedBlockedActive(h);

    const first = await h.rotator.reconsider(turnSucceeded);
    const second = await h.rotator.reconsider(turnSucceeded);
    const third = await h.rotator.reconsider(turnSucceeded);

    // 1本目だけが「戻った」を運ぶ。
    expect(first).toMatchObject({
      kind: 'ignored',
      recovered: { tokenId: 'tok-a', label: 'first', source: 'turn_success' },
    });
    // **`recovered` の欄そのものが無いことを見る。** `toMatchObject` は
    // 「無い」を測れないので、欄を直接読む。
    expect('recovered' in second ? second.recovered : undefined).toBeUndefined();
    expect('recovered' in third ? third.recovered : undefined).toBeUndefined();
    // 記録は1本目で消えている（2本目以降が立たない理由がこれである）。
    expect(await isCooling(h, 'tok-a')).toBe(false);
  });

  it('🔴 429 の観測とターンの成功が交互に届くと、「戻った」は届いた回数だけ立つ', async () => {
    const h = harness();
    // **プールは1本だけにする。** 候補が在ると `observe` が回してしまい、
    // 現役が入れ替わって往復にならない（実運用で同じ本文が並んだのは、
    // 回らずに同じ鍵のまま往復していたからである）。
    await h.stores.tokens.replace([{ id: 'tok-a', label: 'first', value: 'value-a', order: 0 }]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const recovered: unknown[] = [];
    for (let round = 0; round < 3; round += 1) {
      // どこかの層が 429 を踏んだ ⟹ 現役の行にまた冷却が書かれる。
      const rejected = await h.rotator.observe({
        notice: reached,
        observedBy: { tokenId: 'tok-a', generation: 1 },
      });
      expect(rejected.kind).toBe('exhausted');
      expect(await isCooling(h, 'tok-a')).toBe(true);

      // 別の層のターンが成功した ⟹ 記録が消え、「戻った」が立つ。
      const outcome = await h.rotator.reconsider(turnSucceeded);
      recovered.push('recovered' in outcome ? outcome.recovered : undefined);
    }

    // **3周とも立つ。** これが「同一本文が数千件」の機構である。
    //
    // **⚠️ 2026-09-24 追記: 実運用で「成功」を運んでいたのは別の層ではなかった。**
    // 枠で落ちたマネージャーのターン自身（`subtype: 'success'` / `is_error: true`）
    // が `usage` を降ろし、`manager.ts` の `case 'usage'` がそれを成功として
    // 渡していた ⟹ 起こした委譲が枠で落ちるたびに `recovered` が立ち、また
    // 起こす、の無限の往復になった。**塞いだのは生産者の側**（`runner-protocol.ts`
    // の `answered`）で、回し手のこの性質（記録に対してエッジ）は変えていない。
    expect(recovered).toEqual([
      { tokenId: 'tok-a', label: 'first', source: 'turn_success' },
      { tokenId: 'tok-a', label: 'first', source: 'turn_success' },
      { tokenId: 'tok-a', label: 'first', source: 'turn_success' },
    ]);
  });

  it('冷却明け（#833 の reopened）も記録に対してエッジである（毎分の目盛りで撃ち続けない）', async () => {
    const h = harness();
    await h.stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'first',
        value: 'value-a',
        order: 0,
        lastRejectedAt: '2026-08-24T20:00:00.000Z',
        // `AT`（2026-08-25T03:00:00Z）より前 ＝ 既に明けている。
        cooldownUntil: Date.parse('2026-08-25T01:00:00.000Z'),
        cooldownSource: 'default',
      },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await h.stores.tokens.writeActive({ tokenId: 'tok-a', generation: 1, rotatedAt: AT });

    const first = await h.rotator.reconsider({ reason: 'tick' });
    const second = await h.rotator.reconsider({ reason: 'tick' });

    expect(first).toMatchObject({ kind: 'ignored', reopened: { tokenId: 'tok-a' } });
    expect('reopened' in second ? second.reopened : undefined).toBeUndefined();
  });
});

describe('recordTrialVerdict（Issue #1501: ダメ元の試しの結果を記録へ写す）', () => {
  it('usable なら冷却の記録を消す。回さない・撒かない', async () => {
    const h = harness();
    await seedTwo(h);
    await h.rotator.observe({ notice: reached });
    expect(await isCooling(h, 'tok-a')).toBe(true);
    const spreadBefore = h.spreadCalls.length;

    expect(
      await h.rotator.recordTrialVerdict({ tokenId: 'tok-a', verdict: { verdict: 'usable' } }),
    ).toBe('written');
    expect(await isCooling(h, 'tok-a')).toBe(false);
    expect(h.spreadCalls.length).toBe(spreadBefore);
  });

  it('unusable で retryAt が記録と違えば、その期限で書き直す。同じなら書かない', async () => {
    const h = harness();
    await seedTwo(h);
    const retryAt = Date.parse('2026-09-30T00:00:00.000Z');
    expect(
      await h.rotator.recordTrialVerdict({
        tokenId: 'tok-b',
        verdict: { verdict: 'unusable', reason: 'rejected', retryAt },
      }),
    ).toBe('written');
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-b');
    expect(row?.cooldownUntil).toBe(retryAt);
    expect(row?.cooldownSource).toBe('quota_reset');

    const writes = h.replaceCalls();
    expect(
      await h.rotator.recordTrialVerdict({
        tokenId: 'tok-b',
        verdict: { verdict: 'unusable', reason: 'rejected', retryAt },
      }),
    ).toBe('unchanged');
    expect(h.replaceCalls()).toBe(writes);
  });

  it('回転の設定が読めなくても、retryAt の在る unusable はその期限で書く（issue #2147）', async () => {
    const h = harness();
    await seedTwo(h);
    breakTokenSettings(h);
    const retryAt = Date.parse('2026-09-30T00:00:00.000Z');
    expect(
      await h.rotator.recordTrialVerdict({
        tokenId: 'tok-b',
        verdict: { verdict: 'unusable', reason: 'rejected', retryAt },
      }),
    ).toBe('written');
    const row = (await h.stores.tokens.list()).find((token) => token.id === 'tok-b');
    expect(row?.cooldownUntil).toBe(retryAt);
    expect(row?.cooldownSource).toBe('quota_reset');
  });

  it('retryAt の無い unusable と undecidable は何も書かない。行が無ければ missing', async () => {
    const h = harness();
    await seedTwo(h);
    const writes = h.replaceCalls();
    expect(
      await h.rotator.recordTrialVerdict({
        tokenId: 'tok-b',
        verdict: { verdict: 'unusable', reason: 'HTTP 429' },
      }),
    ).toBe('unchanged');
    expect(
      await h.rotator.recordTrialVerdict({
        tokenId: 'tok-b',
        verdict: { verdict: 'undecidable', reason: '締め切り' },
      }),
    ).toBe('unchanged');
    expect(h.replaceCalls()).toBe(writes);
    expect(
      await h.rotator.recordTrialVerdict({ tokenId: 'nope', verdict: { verdict: 'usable' } }),
    ).toBe('missing');
  });

  it('🔴 同時に走った observe の書き込みを踏み消さない（回し手の列を通る）', async () => {
    const h = harness({ verdict: { verdict: 'unusable', reason: '候補も枠' } });
    await seedTwo(h);
    // tok-b を冷却中にしておき、試しで通ったことにして消すのと、tok-a が枠に
    // 当たった観測（tok-a を冷却へ入れる）を**同時に**走らせる。
    await h.rotator.recordTrialVerdict({
      tokenId: 'tok-b',
      verdict: {
        verdict: 'unusable',
        reason: 'rejected',
        retryAt: Date.parse('2026-09-30T00:00:00.000Z'),
      },
    });
    await Promise.all([
      h.rotator.observe({ notice: reached }),
      h.rotator.recordTrialVerdict({ tokenId: 'tok-b', verdict: { verdict: 'usable' } }),
    ]);
    // 両方の書き込みが残っている: tok-a は冷却に入り、tok-b の冷却は消えている。
    expect(await isCooling(h, 'tok-a')).toBe(true);
    expect(await isCooling(h, 'tok-b')).toBe(false);
  });
});
