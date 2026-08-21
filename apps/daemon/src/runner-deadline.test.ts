import { PROFILE_EVAL_TIMEOUT_MS } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { RUNNER_CALL_DEADLINE_MS, RunnerUnknownError, settleWithinDeadline } from './deadline.js';
import { createHttpRunner, describeRunnerUnknown, RunnerHttpError } from './runner-client.js';
import type { RunnerUnknownReport } from './runner-client.js';

/**
 * 応答を返さない runner を無期限に待たないこと（＝期限切れを「不明」として掴むこと）。
 *
 * **確かめたい仮説が真のときに、計器が本当にそう出るか**を軸に組んである。
 * だから `fetchFn` は「決して解決しない Promise」を返す — 「abort を投げる偽物」
 * ではない。後者を期限切れとして数える計器は、**runner が黙ったときには何も
 * 言わないまま緑になる**（分類だけを試して、期限そのものを試していない）。
 *
 * **型で守られる性質はここで測らない。** `Settled<T>` は判別可能ユニオンなので、
 * `outcome` を絞らずに `.value` を読むコードは `tsc` が落とす（実行時試験では
 * 「書けるふりの偽テスト」になる）。ここが測るのは型で言えないことだけである。
 */

const TOKEN = 'test-runner-token';

/** 決して解決しない Promise（黙った runner そのもの）。 */
function silent(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function pathOf(input: string | URL | Request): string {
  return new URL(typeof input === 'string' ? input : input.toString()).pathname;
}

function healthOk(): Response {
  return Response.json({ runnerId: 'runner-silent', workspacePath: '/workspace' });
}

/**
 * `/health` にだけ答える runner。**それ以外の口は黙る。**
 *
 * `hello()` も期限付きの経路を通るので、名乗りだけは返させる（返さないと
 * `createHttpRunner` が期限切れで落ちて、測りたいところへ入れない）。
 */
function silentExcept(): {
  fetchFn: typeof fetch;
  signals: () => (AbortSignal | null | undefined)[];
} {
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    if (pathOf(input) === '/health') return healthOk();
    return silent();
  }) as typeof fetch;
  return { fetchFn, signals: () => signals };
}

describe('期限の値（deadline.ts）', () => {
  /**
   * **数を2か所に書かないための検査である。** 期限が runner 側の待ちより短いと、
   * 長くかかるが正当な操作が「不明」に見える（＝追加制限）。だから比較する相手を
   * リテラルで書き写さず、持ち主から取って比べる。
   */
  it('runner の handler が内側で待つ最長（プロファイル評価）より長い', () => {
    expect(RUNNER_CALL_DEADLINE_MS).toBeGreaterThan(PROFILE_EVAL_TIMEOUT_MS);
  });

  it('応答が返らなければ「不明」を返す（失敗にしない）', async () => {
    const settled = await settleWithinDeadline(silent(), 10);
    expect(settled.outcome).toBe('unknown');
  });

  it('例外は「明確な失敗」として返す（不明に混ぜない）', async () => {
    const boom = new Error('繋げない');
    const settled = await settleWithinDeadline(Promise.reject(boom), 10_000);
    expect(settled).toEqual({ outcome: 'failed', error: boom });
  });

  /**
   * **この計器がいちばん嘘をつく形。** タイマーと応答が同じ回で揃ったときに
   * 「不明」を先に主張すると、返っていた応答を捨てて「分からない」と言う。
   * `ms: 0` は必ずその競争になる（マイクロタスク対マクロタスク）。
   */
  it('期限が 0 でも、既に返っている応答を「不明」に化けさせない', async () => {
    const settled = await settleWithinDeadline(Promise.resolve('返った'), 0);
    expect(settled).toEqual({ outcome: 'settled', value: '返った' });
  });

  it('期限切れのあと遅れて返ってきたら、それを知らせる（不明を残したままにしない）', async () => {
    let resolve: (value: string) => void = () => undefined;
    const slow = new Promise<string>((r) => {
      resolve = r;
    });
    const late = new Promise<{ ok: boolean }>((done) => {
      void settleWithinDeadline(slow, 10, (result) => done({ ok: result.ok })).then((settled) => {
        expect(settled.outcome).toBe('unknown');
      });
    });

    await new Promise((r) => setTimeout(r, 40));
    resolve('遅れて返った');

    expect(await late).toEqual({ ok: true });
  });

  /**
   * **期限は相手を止めるものではない。** 止める形にすると、届いている操作を
   * こちらの都合で畳むことになる（north_star 禁止2）。
   */
  it('期限が切れても、待っていた Promise を捨てない（相手は走り続ける）', async () => {
    let settledLater = false;
    const slow = new Promise<string>((r) => setTimeout(() => r('done'), 30));
    void slow.then(() => {
      settledLater = true;
    });

    expect((await settleWithinDeadline(slow, 5)).outcome).toBe('unknown');
    await new Promise((r) => setTimeout(r, 60));

    expect(settledLater).toBe(true);
  });
});

describe('制御面の期限（runner-client.ts）', () => {
  it('黙った runner への send は「不明」で返る（無期限に待たない）', async () => {
    const { fetchFn } = silentExcept();
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 20,
    });

    await expect(client.send('mgr-1', 'ping')).rejects.toBeInstanceOf(RunnerUnknownError);
  });

  it('黙った runner への stop / list / setProfile も「不明」で返る', async () => {
    const { fetchFn } = silentExcept();
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 20,
    });

    await expect(client.stop('mgr-1')).rejects.toBeInstanceOf(RunnerUnknownError);
    await expect(client.list()).rejects.toBeInstanceOf(RunnerUnknownError);
    await expect(client.setProfile('true')).rejects.toBeInstanceOf(RunnerUnknownError);
  });

  /**
   * **「期限切れ」と「明確な失敗」を混ぜない。** status を持つ失敗は「相手が
   * 答えた」の証拠なので、不明へ落とすと再挑戦の判断（`isRetryableRunnerError`）
   * まで狂う。
   */
  it('runner が status を返した失敗は RunnerHttpError のまま（不明にしない）', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      if (pathOf(input) === '/health') return healthOk();
      return new Response('だめ', { status: 503 });
    }) as typeof fetch;
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 10_000,
    });

    const error = await client.stop('mgr-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunnerHttpError);
    expect(error).not.toBeInstanceOf(RunnerUnknownError);
  });

  /**
   * **反対側の嘘も測る。** 遅いだけの正当な操作を「不明」と言い出す計器は、
   * 期限を付けた意味を反転させる（追加制限になる）。
   */
  it('遅いが返ってくる操作は成功のまま（不明にしない）', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      if (pathOf(input) === '/health') return healthOk();
      await new Promise((r) => setTimeout(r, 30));
      return Response.json({ ok: true });
    }) as typeof fetch;
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 2_000,
    });

    await expect(client.send('mgr-1', 'ping')).resolves.toBeUndefined();
  });

  /**
   * **期限で相手を kill しない。** ここが `AbortController` を作っていたら、
   * 届いている `stop` や `send` をこちらの都合で畳むことになる。
   * 「作っていない」を、渡した `init.signal` が1つも無いことで示す。
   */
  it('期限切れでも要求を abort しない（signal を1つも渡していない）', async () => {
    const { fetchFn, signals } = silentExcept();
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 20,
    });

    await client.send('mgr-1', 'ping').catch(() => undefined);

    // `hello()` と `send()` の2回ぶん。どちらも signal を渡していない。
    expect(signals().length).toBe(2);
    for (const signal of signals()) {
      expect(signal?.aborted ?? false).toBe(false);
    }
  });

  it('不明になったことを onUnknown で1回だけ知らせる（宛先と待った時間つき）', async () => {
    const { fetchFn } = silentExcept();
    const reports: RunnerUnknownReport[] = [];
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 20,
      onUnknown: (report) => reports.push(report),
    });

    await client.stop('mgr-7').catch(() => undefined);

    expect(reports).toEqual([
      { method: 'DELETE', path: '/managers/mgr-7', waitedMs: 20, phase: 'expired' },
    ]);
  });

  it('遅れて返ってきたら late として知らせ、本文を読み捨てる（繋ぎを畳む）', async () => {
    let drained = false;
    const fetchFn = (async (input: string | URL | Request) => {
      if (pathOf(input) === '/health') return healthOk();
      await new Promise((r) => setTimeout(r, 40));
      return new Response(
        new ReadableStream({
          pull: (controller) => {
            drained = true;
            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const reports: RunnerUnknownReport[] = [];
    let notify: () => void = () => undefined;
    const gotLate = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 10,
      onUnknown: (report) => {
        reports.push(report);
        if (report.phase === 'late') notify();
      },
    });

    await expect(client.send('mgr-2', 'ping')).rejects.toBeInstanceOf(RunnerUnknownError);
    await gotLate;

    expect(reports.map((report) => report.phase)).toEqual(['expired', 'late']);
    expect(reports[1]?.ok).toBe(true);
    expect(drained).toBe(true);
  });

  /**
   * **`start` にだけ期限が無いことを、忘れないように固定する。**
   *
   * 期限を付けると、期限切れ（＝不明）が `packages/core` の `Pool.start` で
   * `#records.delete()` に化け、走り出しているかもしれない委譲が `manager_list`
   * から消える（`start()` の doc）。**この試験は「待つのが正しい」と言っている
   * のではなく、待つ方を選んだことを見える形にしている。** 呼ぶ側が「不明」を
   * 運べるようになったら、この試験ごと差し替えること。
   */
  it('start だけは期限を持たない（呼ぶ側が「不明」を運べないため）', async () => {
    const { fetchFn } = silentExcept();
    const client = await createHttpRunner({
      baseUrl: 'http://runner.test',
      token: TOKEN,
      fetchFn,
      deadlineMs: 20,
    });

    const started = client
      .start({ managerId: 'mgr-3', request: 'やって', cwd: '/workspace' })
      .then(() => 'settled' as const)
      .catch(() => 'settled' as const);
    const waited = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200));

    expect(await Promise.race([started, waited])).toBe('pending');
  });
});

describe('日誌へ残る文面', () => {
  /**
   * **この行を読む人はこの PR を読んでいない。** だから行の中に「言えないこと」が
   * 入っていなければならない。断定へ畳んだ読み手は、再送で二重に実行するか、
   * 引き取りで同じマネージャーを2台走らせる。
   */
  it('期限切れの行は「分かっていない」ことを明示する', () => {
    const line = describeRunnerUnknown({
      method: 'DELETE',
      path: '/managers/mgr-9',
      waitedMs: 60_000,
      phase: 'expired',
    });

    expect(line).toContain('/managers/mgr-9');
    expect(line).toContain('60000ms');
    expect(line).toContain('届いたかどうかは分かっていない');
    expect(line).toContain('二重に実行');
    expect(line).toContain('2台で走る');
  });

  it('遅れて返ってきた行は「不明が解けた」と言う（不明のまま残さない）', () => {
    const line = describeRunnerUnknown({
      method: 'POST',
      path: '/managers/mgr-9/messages',
      waitedMs: 60_000,
      phase: 'late',
      ok: true,
    });

    expect(line).toContain('不明は解けた');
  });
});
