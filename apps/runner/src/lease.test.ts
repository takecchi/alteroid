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

  /**
   * **見張りの位相を、デーモンの計算に持ち込まない。**
   *
   * 一定間隔で期限を見に行く作りだと、最後の名乗りが「見た直後」に届いた場合、
   * 実際に畳み始めるのは最大で「間隔ぶん」遅れる。デーモンは最後の名乗りから
   * `ttlMs` を数えて安全な時刻を出すので、その遅れがそのまま**二重に走る窓**に
   * なる（TTL 30 秒・間隔 7.5 秒・余裕 5 秒なら、約 2.5 秒の窓）。
   *
   * だから見張りは名乗りのたびに張り直し、**`ttlMs` ちょうど**に起きるようにする。
   */
  it('最悪の位相でも、期限ちょうどに畳み始める（デーモンの計算とずれない）', async () => {
    const time = clock();
    const fenced: string[][] = [];
    // 手で進められる時計仕掛け（実時間を待たずに位相を作る）
    const pending: { at: number; run: () => void }[] = [];
    const lease = new SessionLease({
      ttlMs: 30_000,
      now: time.now,
      fence: () => ['mgr-1'],
      onFenced: (ids) => fenced.push(ids),
      timers: {
        set: (run, ms) => {
          const entry = { at: time.now() + ms, run };
          pending.push(entry);
          return entry;
        },
        clear: (handle) => {
          const index = pending.indexOf(handle as (typeof pending)[number]);
          if (index >= 0) pending.splice(index, 1);
        },
      },
    });

    /** 時計を進め、その時刻までに来ている見張りを起こす。 */
    const advance = async (ms: number) => {
      time.advance(ms);
      for (const entry of [...pending]) {
        if (entry.at > time.now()) continue;
        pending.splice(pending.indexOf(entry), 1);
        entry.run();
      }
      // 畳む処理は非同期なので、1ティック待つ
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    lease.start();

    // **見張りが起きる直前に名乗りが届く**（いちばん意地の悪い位相）
    await advance(29_999);
    lease.touch();
    expect(fenced).toEqual([]);

    // 名乗りから TTL に1ミリ足りない時点では、まだ畳まない
    await advance(29_999);
    expect(fenced).toEqual([]);

    // **名乗りから TTL ちょうどで畳み始める。** 見張りの間隔ぶん遅れない
    await advance(2);
    expect(fenced).toEqual([['mgr-1']]);
  });

  /**
   * **`graceMs` は見込みではなく、守らせる約束である。**
   *
   * デーモンは申告された `ttl + grace` が過ぎたことだけを根拠に別の器で開き直す。
   * SDK の子プロセスが固まる・アーカイブの送信が詰まるなどで畳み終わらないまま
   * 待ち続けると、**止まっていないのに二重に走る**。分断されている以上、畳めな
   * かったことをデーモンへ伝える経路も無いので、器の側で片を付けるしかない。
   */
  it('猶予の内に畳み終えられなければ、最後の手段へ落とす（器ごと降りる）', async () => {
    const time = clock();
    const pending: { at: number; run: () => void }[] = [];
    let exceeded = 0;
    let fenced = 0;

    const lease = new SessionLease({
      ttlMs: 30_000,
      graceMs: 5_000,
      now: time.now,
      // 畳もうとしたまま**永久に返らない**（子プロセスが固まった状態）
      fence: () =>
        new Promise<string[]>(() => {
          fenced += 1;
        }),
      onGraceExceeded: () => {
        exceeded += 1;
      },
      timers: {
        set: (run, ms) => {
          const entry = { at: time.now() + ms, run };
          pending.push(entry);
          return entry;
        },
        clear: (handle) => {
          const index = pending.indexOf(handle as (typeof pending)[number]);
          if (index >= 0) pending.splice(index, 1);
        },
      },
    });

    const advance = async (ms: number) => {
      time.advance(ms);
      for (const entry of [...pending]) {
        if (entry.at > time.now()) continue;
        pending.splice(pending.indexOf(entry), 1);
        entry.run();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    lease.start();

    // 期限が切れて畳み始めるが、返ってこない
    await advance(30_001);
    expect(fenced).toBe(1);
    expect(exceeded).toBe(0);

    // 猶予の内はまだ待つ
    await advance(4_000);
    expect(exceeded).toBe(0);

    // **申告した猶予を過ぎたら、待ち続けない。** デーモンはもう移送してよいと
    // 判断する時刻なので、ここで粘ると二重に走る。
    await advance(1_100);
    expect(exceeded).toBe(1);
  });

  it('畳むのに失敗したら、畳めたことにせず器ごと降りる（fail-closed）', async () => {
    const time = clock();
    let exceeded = 0;
    const fencedIds: string[][] = [];

    const lease = new SessionLease({
      ttlMs: 30_000,
      graceMs: 5_000,
      now: time.now,
      // 猶予の**内に**、はっきり失敗する（子プロセスの停止が例外になった等）
      fence: async () => {
        throw new Error('畳めなかった');
      },
      onFenced: (ids) => fencedIds.push(ids),
      onGraceExceeded: () => {
        exceeded += 1;
      },
    });

    time.advance(30_001);
    await expect(lease.check()).rejects.toThrow('畳めなかった');

    // **畳めたとは報告しない。** ここで報告すると、止まっていない仕事を
    // デーモンが「止まった」と読む
    expect(fencedIds).toEqual([]);
    // 猶予切れと同じく、器ごと降りる側へ落ちる。返らないより性質が悪いのは
    // 「失敗したのに生き続ける」ほうで、その間もデーモン側の期限は進む
    expect(exceeded).toBe(1);
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
    const lease = new SessionLease({
      ttlMs: 30_000,
      graceMs: 4_000,
      incarnation: 'inc-1',
      now: time.now,
      fence: () => [],
    });
    const { app } = rig(lease);

    const body = (await (await app.request('/health', auth)).json()) as {
      lease?: { ttlMs: number; graceMs?: number; incarnation?: string };
    };
    // 期限だけでは足りない。**畳み終わるまでの猶予**（デーモンはこのぶん余計に待つ）と、
    // **この起動を指す id**（同じ名前で作り直された器と区別する）まで名乗る。
    expect(body.lease).toEqual({ ttlMs: 30_000, graceMs: 4_000, incarnation: 'inc-1' });
  });

  it('起動ごとに違う id を名乗る（作り直された器を取り違えない）', () => {
    const make = () => new SessionLease({ ttlMs: 30_000, fence: () => [] });
    expect(make().incarnation).not.toBe(make().incarnation);
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

  /**
   * **「無かった」を成功にしない。** デーモンはこの応答を停止確認に使うので、
   * 一律 `ok` を返すと、同じ名前で作り直された新しい器が、古い器の抱えたままの
   * セッションについて「畳んだ」と答えることになる（＝二重実行へ踏み出す）。
   */
  it('DELETE /managers/:id は、実際に畳んだかどうかを返す', async () => {
    const { app } = rig();

    const response = await app.request('/managers/mgr-居ない', { method: 'DELETE', ...auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stopped: false });
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
