import { describe, expect, it } from 'vitest';

import type { Stores, TokenPoolStore } from './store.js';
import { createMemoryStores } from './testing.js';
import { createTokenPoolService } from './token-pool-service.js';
import { createTokenPoolWriteLock } from './token-pool-write-lock.js';
import { createTokenRotator, type TokenProbePort, type TokenSpreadPort } from './token-rotator.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayedList(base: TokenPoolStore, delayMs: number): TokenPoolStore {
  return {
    ...base,
    list: async () => {
      const snapshot = await base.list();
      await sleep(delayMs);
      return snapshot;
    },
  };
}

describe('token-pool-service と token-rotator の共有書き込み鍵（Issue #2200）', () => {
  it('(a) 回し手が候補を probe している間に完了した PUT /tokens は、回し手の冷却と両方残る', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'first', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'second', value: 'value-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    const probe: TokenProbePort = {
      async probe() {
        await sleep(30);
        return { verdict: 'unusable', reason: 'probe が拒否した' };
      },
    };
    const spread: TokenSpreadPort = {
      async spread() {
        return [{ target: 'runner-primary', ok: true }];
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread,
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
      newId: () => 'tok-c',
    });

    const observePromise = rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    await sleep(10);
    const replacePromise = poolService.replace([
      { id: 'tok-a', label: 'first', value: 'value-a' },
      { id: 'tok-b', label: 'second', value: 'value-b' },
      { label: 'third (added by human)', value: 'value-c' },
    ]);

    const [replaceResult, observeResult] = await Promise.all([replacePromise, observePromise]);
    const finalTokens = await stores.tokens.list();

    const hasThird = finalTokens.some((token) => token.id === 'tok-c');
    const aCooling = finalTokens.find((token) => token.id === 'tok-a')?.cooldownUntil !== undefined;
    const bUnusable =
      finalTokens.find((token) => token.id === 'tok-b')?.lastRejectedAt !== undefined;

    process.stderr.write(
      `[tooth a] replaceResult.kind=${replaceResult.kind} ` +
        `replaceResult.tokens.length=${String(replaceResult.kind === 'replaced' ? replaceResult.view.tokens.length : -1)} ` +
        `observeResult.kind=${observeResult.kind} ` +
        `hasThird=${String(hasThird)} aCooling=${String(aCooling)} bUnusable=${String(bUnusable)} ` +
        `finalTokens=${JSON.stringify(
          finalTokens.map((t) => ({
            id: t.id,
            cooldownUntil: t.cooldownUntil,
            lastRejectedAt: t.lastRejectedAt,
          })),
        )}\n`,
    );

    expect({ hasThird, aCooling, bUnusable }).toEqual({
      hasThird: true,
      aCooling: true,
      bUnusable: true,
    });
  });

  it('(b) noteUnusable（writeOne 経由）と回し手の recordTrialVerdict が重なっても両方残る', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'b', value: 'value-b', order: 1 },
    ]);

    const writeLock = createTokenPoolWriteLock();
    const slowStores: Stores = { ...stores, tokens: delayedList(stores.tokens, 30) };

    const poolService = createTokenPoolService({
      stores: slowStores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
    });
    const rotator = createTokenRotator({
      stores,
      probe: {
        async probe() {
          return { verdict: 'usable' };
        },
      },
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });

    const notePromise = poolService.noteUnusable({
      id: 'tok-b',
      message: '人間 / probe が観測した拒否',
    });
    await sleep(5);
    const trialPromise = rotator.recordTrialVerdict({
      tokenId: 'tok-a',
      verdict: { verdict: 'unusable', reason: 'trial が拒否した', retryAt: 1_800_000_000_000 },
    });

    const [noteResult, trialResult] = await Promise.all([notePromise, trialPromise]);
    const finalTokens = await stores.tokens.list();

    const aHasCooldown =
      finalTokens.find((token) => token.id === 'tok-a')?.cooldownUntil !== undefined;
    const bUnusable =
      finalTokens.find((token) => token.id === 'tok-b')?.lastRejectedAt !== undefined;

    process.stderr.write(
      `[tooth b] noteResult.id=${noteResult?.id ?? '(undefined)'} trialResult=${trialResult} ` +
        `aHasCooldown=${String(aHasCooldown)} bUnusable=${String(bUnusable)} ` +
        `finalTokens=${JSON.stringify(
          finalTokens.map((t) => ({
            id: t.id,
            cooldownUntil: t.cooldownUntil,
            lastRejectedAt: t.lastRejectedAt,
          })),
        )}\n`,
    );

    expect({ aHasCooldown, bUnusable }).toEqual({ aHasCooldown: true, bUnusable: true });
  });

  it('(c) 回し手が冷却を付けようとした行を、読み直しの時点で人間が消していたら作り直さない', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'b', value: 'value-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
    });
    const rotator = createTokenRotator({
      stores,
      probe: {
        async probe() {
          return { verdict: 'usable' };
        },
      },
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });

    await poolService.replace([{ id: 'tok-b', label: 'b', value: 'value-b' }]);

    const observeResult = await rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });
    const finalTokens = await stores.tokens.list();
    const tokAResurrected = finalTokens.some((token) => token.id === 'tok-a');

    process.stderr.write(
      `[tooth c] observeResult.kind=${observeResult.kind} tokAResurrected=${String(tokAResurrected)} ` +
        `finalTokens=${JSON.stringify(finalTokens.map((t) => t.id))}\n`,
    );

    expect(tokAResurrected).toBe(false);
    expect(finalTokens.map((token) => token.id)).toEqual(['tok-b']);
  });

  it('(d) probe のあいだは鍵を握っていない（PUT /tokens が probe を待たない）', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'b', value: 'value-b', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    const PROBE_DELAY_MS = 300;
    const probe: TokenProbePort = {
      async probe() {
        await sleep(PROBE_DELAY_MS);
        return { verdict: 'usable' };
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
      newId: () => 'tok-c',
    });

    const observePromise = rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    await sleep(20);

    const replaceStartedAt = Date.now();
    await poolService.replace([
      { id: 'tok-a', label: 'a', value: 'value-a' },
      { id: 'tok-b', label: 'b', value: 'value-b' },
      { label: 'third (added by human)', value: 'value-c' },
    ]);
    const replaceElapsedMs = Date.now() - replaceStartedAt;

    process.stderr.write(
      `[tooth d] replaceElapsedMs=${String(replaceElapsedMs)} (probe delay=${String(PROBE_DELAY_MS)}ms)\n`,
    );

    expect(replaceElapsedMs).toBeLessThan(PROBE_DELAY_MS / 2);

    await observePromise;
  });

  it('(e) probe の間に PUT /tokens で同じ行の value / label を変えても、回し手はそれを古い値へ戻さない', async () => {
    const stores = createMemoryStores();
    await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'value-a', order: 0 },
      { id: 'tok-b', label: 'old-label', value: 'old-value', order: 1 },
    ]);
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });

    const writeLock = createTokenPoolWriteLock();
    const probe: TokenProbePort = {
      async probe() {
        await sleep(30);
        return { verdict: 'unusable', reason: 'probe が拒否した' };
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread: {
        async spread() {
          return [{ target: 'runner-primary', ok: true }];
        },
      },
      writeLock,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });
    const poolService = createTokenPoolService({
      stores,
      writeLock,
      now: () => new Date('2026-08-25T03:00:01.000Z'),
    });

    const observePromise = rotator.observe({
      facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
      statusNow: 'rejected',
      observedBy: { tokenId: 'tok-a', generation: 1 },
    });

    await sleep(10);
    await poolService.replace([
      { id: 'tok-a', label: 'a', value: 'value-a' },
      { id: 'tok-b', label: 'new-label (rotated by human)', value: 'new-value (rotated by human)' },
    ]);

    const observeResult = await observePromise;
    const finalTokens = await stores.tokens.list();
    const b = finalTokens.find((token) => token.id === 'tok-b');

    process.stderr.write(
      `[tooth e] observeResult.kind=${observeResult.kind} ` +
        `b.value=${b?.value ?? '(undefined)'} b.label=${b?.label ?? '(undefined)'} ` +
        `b.lastRejectedAt=${b?.lastRejectedAt ?? '(undefined)'}\n`,
    );

    expect({
      value: b?.value,
      label: b?.label,
      cooling: b?.lastRejectedAt !== undefined,
    }).toEqual({
      value: 'new-value (rotated by human)',
      label: 'new-label (rotated by human)',
      cooling: true,
    });
  });
});
