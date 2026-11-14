import {
  captureStderr,
  createAuthProviderRegistry,
  createAuthService,
  createManualTokenTry,
  createMemoryStores,
  createTokenPoolService,
  createTokenRotator,
  fakeCloneHost,
  type AgentToken,
  type Stores,
  type TokenCandidateVerdict,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token' };
const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const VALUE_COOLING = 'dummy-cooling-value-never-leak';
const VALUE_READY = 'dummy-ready-value-never-leak';
const ALL_VALUES = [VALUE_COOLING, VALUE_READY, 'dummy-disabled-value'];

let nowMs = T0;
let stores: Stores;
let verdict: TokenCandidateVerdict | Error;
let trialCalls: string[];

function row(overrides: Partial<AgentToken> & { id: string; order: number }): AgentToken {
  return { label: overrides.id, source: 'stored', value: `value-${overrides.id}`, ...overrides };
}

async function seed(): Promise<void> {
  await stores.tokens.replace([
    row({ id: 'tok-live', order: 0, value: VALUE_READY }),
    row({
      id: 'tok-cooling',
      order: 1,
      value: VALUE_COOLING,
      cooldownUntil: T0 + 5 * 60 * 60 * 1000,
      cooldownSource: 'quota_reset',
      lastRejectedAt: new Date(T0).toISOString(),
      lastRejectedReason: '前に拒否された',
    }),
    row({
      id: 'tok-disabled',
      order: 2,
      value: 'dummy-disabled-value',
      disabledAt: '2026-09-01T00:00:00.000Z',
    }),
    row({ id: 'tok-invalidated', order: 3, invalidatedAt: '2026-09-01T00:00:00.000Z' }),
  ]);
  await stores.tokens.writeActive({
    tokenId: 'tok-live',
    generation: 1,
    rotatedAt: new Date(T0).toISOString(),
  });
}

// 回し手は本物にする: 偽物にすると「冷却が消えた／残った」の歯が見張りではなく偽物を測るため。試し（実 SDK）だけを偽装する。
function buildApp(options: { authEnabled?: boolean } = {}) {
  const rotator = createTokenRotator({
    stores,
    probe: { probe: () => Promise.reject(new Error('probe は呼ばれない')) },
    spread: { spread: () => Promise.resolve({ placed: [], failed: [] }) as never },
    now: () => new Date(nowMs),
  });
  const tokenTry = createManualTokenTry({
    listTokens: () => stores.tokens.list(),
    trial: {
      trial: (token) => {
        trialCalls.push(token.id);
        if (verdict instanceof Error) return Promise.reject(verdict);
        return Promise.resolve(verdict);
      },
    },
    recordTrialVerdict: (input) => rotator.recordTrialVerdict(input),
    recordTrialSuccess: (input) => rotator.recordTrialSuccess(input),
    onOutcome: () => Promise.resolve(),
    now: () => nowMs,
  });
  return createApp({
    clone: fakeCloneHost({}),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    now: () => new Date(nowMs),
    tokens: createTokenPoolService({ stores }),
    tokenTry,
    ...(options.authEnabled === true
      ? {
          auth: {
            plan: {
              enabled: true,
              providers: [],
              publicBaseUrl: 'http://127.0.0.1:4517',
              tokenTtlDays: 30,
              description: 'テスト',
            },
            service: createAuthService({
              store: stores.auth,
              providers: createAuthProviderRegistry([]),
            }),
          },
        }
      : {}),
  });
}

type App = ReturnType<typeof buildApp>;

async function tryToken(app: App, id: string, headers: Record<string, string> = OPERATOR) {
  let response: Response | undefined;
  await captureStderr(async () => {
    response = await app.request(`/tokens/${id}/try`, { method: 'POST', headers });
  });
  return response!;
}

async function cooldownOf(id: string): Promise<number | undefined> {
  return (await stores.tokens.list()).find((token) => token.id === id)?.cooldownUntil;
}

async function journalText(): Promise<string> {
  return JSON.stringify(await stores.journal.list({ types: ['decision'], limit: 100 }));
}

beforeEach(async () => {
  nowMs = T0;
  stores = createMemoryStores();
  verdict = { verdict: 'usable' };
  trialCalls = [];
  await seed();
});

describe('POST /tokens/:id/try（人間が手でいま試す）', () => {
  it('通ったら冷却が消える', async () => {
    const response = await tryToken(buildApp(), 'tok-cooling');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'passed', cooldownCleared: true });
    expect(await cooldownOf('tok-cooling')).toBeUndefined();
  });

  it('拒否されたら冷却が残る（期限を運ぶ拒否は自動の試しと同じく期限を書く）', async () => {
    const before = await cooldownOf('tok-cooling');
    verdict = { verdict: 'unusable', reason: '枠が尽きている' };

    const response = await tryToken(buildApp(), 'tok-cooling');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: 'rejected',
      reason: '枠が尽きている',
      cooldownKept: true,
    });
    expect(await cooldownOf('tok-cooling')).toBe(before);
  });

  it('判定できなければ何も書かない', async () => {
    verdict = { verdict: 'undecidable', reason: '締め切りに間に合わなかった' };
    const before = JSON.stringify(await stores.tokens.list());

    const response = await tryToken(buildApp(), 'tok-cooling');

    expect(await response.json()).toMatchObject({ result: 'undecidable' });
    expect(JSON.stringify(await stores.tokens.list())).toBe(before);
  });

  it('直前に試した鍵は間隔内として断り、あと何秒かを返す。試しは走らない', async () => {
    const app = buildApp();
    await tryToken(app, 'tok-cooling');
    nowMs += 90_000;

    const response = await tryToken(app, 'tok-cooling');

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('210');
    expect(await response.json()).toMatchObject({ result: 'too_soon', retryAfterSeconds: 210 });
    expect(trialCalls).toEqual(['tok-cooling']);
  });

  it('5 分たてばもう一度試せる。別の鍵は間隔に巻き込まれない', async () => {
    const app = buildApp();
    await tryToken(app, 'tok-cooling');
    expect((await tryToken(app, 'tok-live')).status).toBe(200);
    nowMs += 5 * 60 * 1000;

    expect((await tryToken(app, 'tok-cooling')).status).toBe(200);
    expect(trialCalls).toEqual(['tok-cooling', 'tok-live', 'tok-cooling']);
  });

  it('同じ鍵への同時の試しは重ならない（2本目は間隔内として断る）', async () => {
    const app = buildApp();

    const [first, second] = await Promise.all([
      tryToken(app, 'tok-cooling'),
      tryToken(app, 'tok-cooling'),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 429]);
    expect(trialCalls).toEqual(['tok-cooling']);
  });

  it('外した鍵・失効した鍵は試さずに 409', async () => {
    const app = buildApp();

    const disabled = await tryToken(app, 'tok-disabled');
    const invalidated = await tryToken(app, 'tok-invalidated');

    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ result: 'not_tryable', cause: 'disabled' });
    expect(invalidated.status).toBe(409);
    expect(await invalidated.json()).toMatchObject({ cause: 'invalidated' });
    expect(trialCalls).toEqual([]);
  });

  it('id が無い鍵は 404', async () => {
    const response = await tryToken(buildApp(), 'nope');

    expect(response.status).toBe(404);
    expect(trialCalls).toEqual([]);
  });

  it('冷却中でない鍵は、通っても拒否されても冷却も行も変えない', async () => {
    const app = buildApp();
    const before = JSON.stringify(await stores.tokens.list());

    const passed = await tryToken(app, 'tok-live');
    expect(await passed.json()).toMatchObject({ result: 'passed', cooldownCleared: false });

    nowMs += 5 * 60 * 1000;
    verdict = { verdict: 'unusable', reason: '枠が尽きている', retryAt: T0 + 3_600_000 };
    const rejected = await tryToken(app, 'tok-live');
    expect(await rejected.json()).toMatchObject({ result: 'rejected', cooldownKept: false });

    expect(JSON.stringify(await stores.tokens.list())).toBe(before);
  });

  it('連携の鍵（integration）の資格は 403 で、試しは走らない', async () => {
    const app = buildApp({ authEnabled: true });
    const issued = await app.request('/integration-keys', {
      method: 'POST',
      headers: { ...OPERATOR, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ci', source: 'ci.main' }),
    });
    const { value } = (await issued.json()) as { value: string };

    const response = await tryToken(app, 'tok-cooling', { authorization: `Bearer ${value}` });

    expect(response.status).toBe(403);
    expect(trialCalls).toEqual([]);
    expect(await cooldownOf('tok-cooling')).toBeDefined();
  });

  it('結果を日誌に残し、応答・日誌・エラーのどこにも鍵の値を出さない', async () => {
    const app = buildApp();
    verdict = new Error(`boom ${VALUE_COOLING}`);

    const response = await tryToken(app, 'tok-cooling');
    const body = await response.text();
    nowMs += 5 * 60 * 1000;
    verdict = { verdict: 'usable' };
    await tryToken(app, 'tok-cooling');
    await tryToken(app, 'tok-cooling');

    const journal = await journalText();
    expect(journal).toContain('手で試した');
    expect(journal).toContain('判定できなかった');
    expect(journal).toContain('通った');
    expect(journal).toContain('間隔内');
    for (const value of ALL_VALUES) {
      expect(body).not.toContain(value);
      expect(journal).not.toContain(value);
    }
  });
});
