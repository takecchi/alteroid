import { createHash } from 'node:crypto';

import { createRunnerHost } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';
import { leaseTtlMsOf, SessionLease } from './lease.js';

/**
 * 貸し出し期限（fencing lease / roadmap M5）。
 *
 * ここで固定するのは1つだけである。**デーモンから見えなくなった器は、走行中の
 * セッションを持ち続けない。** これが無いと、通信が切れただけの器で走り続けて
 * いる仕事を、デーモンが別の器で開き直してしまう（同じ workspace への二重書き、
 * PR やメッセージの二重送信）。
 */
const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe('SessionLease — 器が自分で降りる', () => {
  it('期限を過ぎたらセッションを畳む', async () => {
    const time = clock();
    const fenced: string[][] = [];
    const lease = new SessionLease({
      ttlMs: 30_000,
      now: time.now,
      fence: () => ['mgr-1', 'mgr-2'],
      onFenced: (ids) => fenced.push(ids),
    });

    // まだ期限の内側
    time.advance(29_000);
    expect(await lease.check()).toEqual([]);

    time.advance(2_000);
    expect(lease.expired()).toBe(true);
    expect(await lease.check()).toEqual(['mgr-1', 'mgr-2']);
    expect(fenced).toEqual([['mgr-1', 'mgr-2']]);
  });

  it('名乗りを聞かれている間は畳まない（生きている器から仕事を殺さない）', async () => {
    const time = clock();
    const lease = new SessionLease({ ttlMs: 30_000, now: time.now, fence: () => ['mgr-1'] });

    for (let i = 0; i < 5; i += 1) {
      time.advance(20_000);
      lease.touch();
      expect(await lease.check()).toEqual([]);
    }
  });

  it('畳んでいる最中に重ねて呼ばれても、二重には畳まない', async () => {
    const time = clock();
    let calls = 0;
    const lease = new SessionLease({
      ttlMs: 1_000,
      now: time.now,
      fence: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ['mgr-1'];
      },
    });

    time.advance(5_000);
    const [first, second] = await Promise.all([lease.check(), lease.check()]);
    expect(first).toEqual(['mgr-1']);
    expect(second).toEqual(['mgr-1']);
    expect(calls).toBe(1);
  });

  it('期限は秒で設定でき、off で外せる（外した器は自動移送の対象外になる）', () => {
    expect(leaseTtlMsOf({})).toBe(30_000);
    expect(leaseTtlMsOf({ ALTEROID_RUNNER_LEASE_TTL: '45' })).toBe(45_000);
    expect(leaseTtlMsOf({ ALTEROID_RUNNER_LEASE_TTL: 'off' })).toBeNull();
    // 読めない値を黙って既定に落とさない（落とすと、設定したつもりの器ができる）
    expect(() => leaseTtlMsOf({ ALTEROID_RUNNER_LEASE_TTL: 'いつまでも' })).toThrow();
    expect(() => leaseTtlMsOf({ ALTEROID_RUNNER_LEASE_TTL: '-1' })).toThrow();
  });
});

describe('GET /health — 名乗りと期限の更新', () => {
  function rig(lease?: SessionLease) {
    const outbox = new Outbox();
    const host = createRunnerHost({
      runnerId: 'runner-a',
      workspacePath: '/workspace',
      emit: (event) => outbox.push(event),
      env: { PATH: '/usr/bin' },
    });
    const app = createRunnerApp({
      host,
      outbox,
      tokenSha256: TOKEN_SHA256,
      ...(lease === undefined ? {} : { lease }),
    });
    return { app, host };
  }

  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

  it('期限を名乗る（デーモンはこれを根拠に移送してよいかを決める）', async () => {
    const time = clock();
    const lease = new SessionLease({ ttlMs: 30_000, now: time.now, fence: () => [] });
    const { app } = rig(lease);

    const body = (await (await app.request('/health', auth)).json()) as {
      lease?: { ttlMs: number };
    };
    expect(body.lease).toEqual({ ttlMs: 30_000 });
  });

  it('期限を報告しない器もそのまま動く（報告が無いことは能力の欠落ではない）', async () => {
    const { app } = rig();
    const body = (await (await app.request('/health', auth)).json()) as { lease?: unknown };
    expect(body.lease).toBeUndefined();
  });

  it('名乗りを聞かれると期限が延びる（更新の口はここだけ）', async () => {
    const time = clock();
    const lease = new SessionLease({ ttlMs: 30_000, now: time.now, fence: () => ['mgr-1'] });
    const { app } = rig(lease);

    time.advance(20_000);
    await app.request('/health', auth);
    time.advance(20_000);
    // 名乗りで延びているので、まだ畳まない
    expect(await lease.check()).toEqual([]);

    // **他の口では延びない。** 延ばすと、器の期限がデーモンの見立て（最後に名乗りが
    // 返った時刻から数える）より後ろへずれ、まだ走っている仕事を移されることになる。
    time.advance(20_000);
    await app.request('/managers', auth);
    expect(await lease.check()).toEqual(['mgr-1']);
  });

  it('鍵の無い呼び出しでは期限が延びない（延ばせるのはデーモンだけ）', async () => {
    const time = clock();
    const lease = new SessionLease({ ttlMs: 30_000, now: time.now, fence: () => ['mgr-1'] });
    const { app } = rig(lease);

    time.advance(40_000);
    const denied = await app.request('/health');
    expect(denied.status).toBe(401);
    expect(await lease.check()).toEqual(['mgr-1']);
  });
});
