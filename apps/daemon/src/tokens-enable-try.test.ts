import {
  captureStderr,
  createManualTokenTry,
  createMemoryStores,
  createTokenPoolService,
  createTokenRotator,
  fakeCloneHost,
  type AgentToken,
  type Stores,
  type TokenCandidateVerdict,
} from '@alteroid/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

const OPERATOR = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
const T0 = Date.parse('2026-09-25T00:00:00.000Z');
const VALUE_COOLING = 'dummy-cooling-value-never-leak';
const VALUE_NEW = 'dummy-replaced-value-never-leak';

let nowMs = T0;
let stores: Stores;
let verdict: TokenCandidateVerdict | Error;
let trialCalls: string[];
let releaseTrial: (() => void) | undefined;
let holdTrial = false;

function row(overrides: Partial<AgentToken> & { id: string; order: number }): AgentToken {
  return { label: overrides.id, source: 'stored', value: `value-${overrides.id}`, ...overrides };
}

const DISABLED_AT = '2026-09-01T00:00:00.000Z';

async function seed(): Promise<void> {
  await stores.tokens.replace([
    row({ id: 'tok-live', order: 0 }),
    row({
      id: 'tok-cooling',
      order: 1,
      value: VALUE_COOLING,
      disabledAt: DISABLED_AT,
      cooldownUntil: T0 + 5 * 60 * 60 * 1000,
      cooldownSource: 'quota_reset',
      lastRejectedAt: new Date(T0).toISOString(),
      lastRejectedReason: '前に拒否された',
    }),
    row({ id: 'tok-ready-disabled', order: 2, disabledAt: DISABLED_AT }),
  ]);
  await stores.tokens.writeActive({
    tokenId: 'tok-live',
    generation: 4,
    rotatedAt: new Date(T0).toISOString(),
  });
}

// 回し手は本物、試し（実 SDK）だけを偽装する。手動の試し（`POST /tokens/:id/try`）と同じ `createManualTokenTry` を1本だけ渡す（5 分の最短間隔を共有する）。
function buildApp() {
  const rotator = createTokenRotator({
    stores,
    probe: { probe: () => Promise.reject(new Error('probe は呼ばれない')) },
    spread: { spread: () => Promise.reject(new Error('spread は呼ばれない')) },
    now: () => new Date(nowMs),
  });
  const tokenTry = createManualTokenTry({
    listTokens: () => stores.tokens.list(),
    trial: {
      trial: async (token) => {
        trialCalls.push(token.id);
        if (holdTrial) await new Promise<void>((resolve) => (releaseTrial = resolve));
        if (verdict instanceof Error) throw verdict;
        return verdict;
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
  });
}

type App = ReturnType<typeof buildApp>;
type RowInput = { id?: string; label: string; value?: string; disabled?: boolean };

async function put(app: App, tokens: RowInput[]): Promise<Response> {
  let response: Response | undefined;
  await captureStderr(async () => {
    response = await app.request('/tokens', {
      method: 'PUT',
      headers: OPERATOR,
      body: JSON.stringify({ tokens }),
    });
  });
  return response!;
}

// 今の姿から、指定の行の disabled だけを変えた入力を作る（値は省略＝据え置き）
function inputWith(disabled: Record<string, boolean>): RowInput[] {
  return [
    { id: 'tok-live', label: 'tok-live' },
    {
      id: 'tok-cooling',
      label: 'tok-cooling',
      disabled: disabled['tok-cooling'] ?? true,
    },
    {
      id: 'tok-ready-disabled',
      label: 'tok-ready-disabled',
      disabled: disabled['tok-ready-disabled'] ?? true,
    },
  ];
}

async function rowOf(id: string): Promise<AgentToken | undefined> {
  return (await stores.tokens.list()).find((token) => token.id === id);
}

async function journalText(): Promise<string> {
  return JSON.stringify(await stores.journal.list({ types: ['decision'], limit: 100 }));
}

// 裏で走る試しの日誌が書かれるまで待つ（PUT の応答は試しを待たない）
async function waitForTryJournal(fragment: string): Promise<string> {
  await vi.waitFor(async () => {
    expect(await journalText()).toContain(fragment);
  });
  return journalText();
}

beforeEach(async () => {
  nowMs = T0;
  stores = createMemoryStores();
  verdict = { verdict: 'usable' };
  trialCalls = [];
  holdTrial = false;
  releaseTrial = undefined;
  await seed();
});

describe('PUT /tokens: 無効 → 有効（戻す）でその場で試す', () => {
  it('戻した冷却中の鍵が試され、通れば冷却が消える。現役は奪わず世代も変わらない', async () => {
    const app = buildApp();

    const response = await put(app, inputWith({ 'tok-cooling': false }));

    expect(response.status).toBe(200);
    const journal = await waitForTryJournal('その場で試した');
    expect(trialCalls).toEqual(['tok-cooling']);
    const cooling = await rowOf('tok-cooling');
    expect(cooling?.cooldownUntil).toBeUndefined();
    expect(cooling?.lastRejectedAt).toBeUndefined();
    expect(await stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-live', generation: 4 });
    expect(journal).toContain('通った');
    expect(journal).toContain('冷却を解いた');
    expect(journal).toContain('人間が鍵を戻した契機');
    expect(journal).not.toContain('人間が手で試した。');
    expect(journal).not.toContain(VALUE_COOLING);
  });

  it('PUT の応答は試しの完了を待たない（試しが止まっていても返る）', async () => {
    holdTrial = true;
    const app = buildApp();

    const response = await put(app, inputWith({ 'tok-cooling': false }));

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(trialCalls).toEqual(['tok-cooling']);
    });
    expect((await rowOf('tok-cooling'))?.cooldownUntil).toBeDefined();
    releaseTrial?.();
    await waitForTryJournal('通った');
    expect((await rowOf('tok-cooling'))?.cooldownUntil).toBeUndefined();
  });

  it('拒否されたら冷却は残り、日誌に拒否が残る。PUT は失敗しない', async () => {
    verdict = { verdict: 'unusable', reason: '枠が尽きている' };
    const before = (await rowOf('tok-cooling'))?.cooldownUntil;
    const app = buildApp();

    const response = await put(app, inputWith({ 'tok-cooling': false }));

    expect(response.status).toBe(200);
    const journal = await waitForTryJournal('拒否された');
    expect(journal).toContain('枠が尽きている');
    expect((await rowOf('tok-cooling'))?.cooldownUntil).toBe(before);
  });

  it('試しが投げても PUT は失敗せず、未処理の拒否も出ない', async () => {
    verdict = new Error(`試しが壊れた ${VALUE_COOLING}`);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const response = await put(buildApp(), inputWith({ 'tok-cooling': false }));
      expect(response.status).toBe(200);
      const journal = await waitForTryJournal('判定できなかった');
      expect(journal).not.toContain(VALUE_COOLING);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('冷却中でない鍵を戻しても試すが、結果は冷却を変えない（回し手へ渡さない）', async () => {
    const app = buildApp();

    await put(app, inputWith({ 'tok-ready-disabled': false }));

    const journal = await waitForTryJournal('冷却中ではないので何も変えていない');
    expect(trialCalls).toEqual(['tok-ready-disabled']);
    expect(journal).toContain('その場で試した');
    expect(await stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-live', generation: 4 });
  });

  it('直前に手動で試した鍵は 5 分の最短間隔内なので試さず、間隔内で見送ったと日誌に残す', async () => {
    const app = buildApp();
    // 手動の試しは冷却中の鍵が disabled だと 409 になるので、先に戻して（試しが走る）から再び無効にして、もう一度戻す
    await put(app, inputWith({ 'tok-cooling': false }));
    await waitForTryJournal('通った');
    expect(trialCalls).toEqual(['tok-cooling']);
    await put(app, inputWith({ 'tok-cooling': true }));
    nowMs += 90_000;

    await put(app, inputWith({ 'tok-cooling': false }));

    const journal = await waitForTryJournal('間隔内なので見送った');
    expect(journal).toContain('あと210秒');
    expect(trialCalls).toEqual(['tok-cooling']);
  });

  it('5 分たてば、また戻したときに試す', async () => {
    const app = buildApp();
    await put(app, inputWith({ 'tok-cooling': false }));
    await waitForTryJournal('通った');
    await put(app, inputWith({ 'tok-cooling': true }));
    nowMs += 5 * 60 * 1000;

    await put(app, inputWith({ 'tok-cooling': false }));

    await vi.waitFor(() => {
      expect(trialCalls).toEqual(['tok-cooling', 'tok-cooling']);
    });
  });

  it('無効のままの行・無効にした行・改名だけ・新規の行は試さない', async () => {
    const app = buildApp();

    await put(app, [
      { id: 'tok-live', label: 'tok-live-renamed' },
      { id: 'tok-cooling', label: 'tok-cooling', disabled: true },
      { id: 'tok-ready-disabled', label: 'tok-ready-disabled', disabled: true },
      { label: 'brand-new', value: 'dummy-brand-new-value' },
    ]);
    await put(app, [
      { id: 'tok-live', label: 'tok-live-renamed', disabled: true },
      { id: 'tok-cooling', label: 'tok-cooling', disabled: true },
      { id: 'tok-ready-disabled', label: 'tok-ready-disabled', disabled: true },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(trialCalls).toEqual([]);
  });

  it('戻すと同時に値を差し替えた行は試さない', async () => {
    const app = buildApp();

    const response = await put(app, [
      { id: 'tok-live', label: 'tok-live' },
      { id: 'tok-cooling', label: 'tok-cooling', value: VALUE_NEW, disabled: false },
      { id: 'tok-ready-disabled', label: 'tok-ready-disabled', disabled: true },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(response.status).toBe(200);
    expect(trialCalls).toEqual([]);
  });

  it('保存できなかった PUT（版の食い違い）では試さない', async () => {
    const app = buildApp();

    const response = await captureStderr(async () => {
      await app.request('/tokens', {
        method: 'PUT',
        headers: OPERATOR,
        body: JSON.stringify({ tokens: inputWith({ 'tok-cooling': false }), ifMatch: 'stale' }),
      });
    });
    void response;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(trialCalls).toEqual([]);
    expect((await rowOf('tok-cooling'))?.disabledAt).toBe(DISABLED_AT);
  });
});
