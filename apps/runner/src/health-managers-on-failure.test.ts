import { createHash } from 'node:crypto';

import { createRunnerHost, type RunnerEvent, type RunnerHost } from '@alteroid/core';
import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * **起動失敗が `/health` の `managers` を減らすことを、振る舞いで固定する（#712）。**
 *
 * #712 の輪は2つの半分から出来ている。
 *
 * 1. **落ちると `managers` が減る**（この歯が測る半分）
 * 2. **`managers` が減ると、その器の配置の点数が上がる**
 *    （`packages/core/src/runner-placement.test.ts` が測る半分）
 *
 * 2つ目は `chooseByResources` を呼べば測れるが、**1つ目はコードを読んだだけの
 * 状態で長く残っていた** —— Issue #712 の本文も、計測の投稿も、`#finish` から
 * `#sessions.delete` までの鎖を**逐語で読んだ**と書いてある。読みは正しくても、
 * 「読んだ」は「測った」ではない。**輪の片方が読みだけで支えられていると、
 * 直しの根拠そのものが未測定のまま残る。**
 *
 * **だからここは `/health` の応答を実際に読む。** `host.list().length` だけを見る
 * 形にしないのは、配置へ渡る値は `/health` が名乗る `managers` であって、
 * `list()` はその途中の1段にすぎないからである（`createRunnerApp` の `/health`
 * が返す `managers`）。途中で止めると、`/health` の側で欄が消える・別の値へ
 * すり替わるといった変更が緑のまま通る。
 *
 * **落とし方は合成である。** 本物の pids 枯渇も本物の spawn 失敗も再現しない
 * （走っている器を壊す操作である）。使うのは「最初の1件を読もうとしたところで
 * 止まったまま、こちらの合図で例外になる」偽 SDK だけで、`runner.ts` の
 * `#read()` の catch が `#finish('failed', …)` へ倒れる経路をそのまま通す。
 */

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

/**
 * **合図があるまで1件も出さず、合図で例外になる偽 SDK。**
 *
 * `runner-closed-system-error.test.ts` の `throwingSdk` は最初の `next()` で
 * 即座に reject する形だが、それでは**セッションが立っている状態を観測できない**
 * （`start()` が返る前に落ちていることがある）。`managers` が **1 から 0 へ**
 * 動くことを見たいので、落ちる時機をこちらが握る形にしてある。
 */
function heldSdk(): {
  fn: typeof sdkQuery;
  /** 開いている全セッションを落とす（`#read()` の catch へ倒す）。 */
  fail: (error: unknown) => void;
  /** 開いた順の n 番目のセッションだけを落とす。 */
  failNth: (index: number, error: unknown) => void;
} {
  const rejects: ((error: unknown) => void)[] = [];
  const fn = ((): Query => {
    let reject!: (error: unknown) => void;
    // **同じ promise を毎回返す。** 一度も resolve しないので `#read()` は最初の
    // 1件を待ったまま止まる ＝ セッションは立ったままになる。
    const held = new Promise<IteratorResult<never>>((_resolve, rejectHeld) => {
      reject = rejectHeld;
    });
    rejects.push(reject);
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<never>> => held,
      return: (): Promise<IteratorResult<never>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
    return Object.assign(stream, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return {
    fn,
    fail: (error) => {
      for (const reject of rejects) reject(error);
    },
    // **開いた順の n 番目だけを落とす。** `start()` を順に await しているので、
    // 開いた順はそのまま `managerId` の順である。
    failNth: (index, error) => {
      const reject = rejects[index];
      if (reject === undefined) throw new Error('その番号のセッションは開いていない');
      reject(error);
    },
  };
}

async function readHealth(
  app: ReturnType<typeof createRunnerApp>,
): Promise<Record<string, unknown>> {
  const response = await app.request('/health', {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function hostOf(runnerId: string, events: RunnerEvent[], queryFn: typeof sdkQuery): RunnerHost {
  return createRunnerHost({
    runnerId,
    workspacePath: '/workspace',
    emit: (event) => events.push(event),
    queryFn,
    env: { PATH: '/usr/bin' },
  });
}

/** `closed` が降りてくるまで待って、その1件を返す。 */
async function waitForClosed(
  events: RunnerEvent[],
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
  await vi.waitFor(() => {
    closed = events.find(
      (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
    );
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');
  });
  if (closed === undefined) throw new Error('closed がまだ降りてきていない');
  return closed;
}

describe('起動失敗が /health の managers を減らす（#712 の輪の後半）', () => {
  it('セッションが failed で落ちると、/health の managers が 1 から 0 へ減る', async () => {
    const events: RunnerEvent[] = [];
    const sdk = heldSdk();
    const host = hostOf('runner-712', events, sdk.fn);
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    // 何も置いていない器。
    expect((await readHealth(app)).managers).toBe(0);

    await host.start({ managerId: 'mgr-712', request: '最初の依頼', cwd: '/workspace' });
    // **1本立っている。** ここが 1 でなければ、この後の 0 は「減った」ではなく
    // 「最初から 0 だった」になる。
    expect((await readHealth(app)).managers).toBe(1);

    sdk.fail(new Error('合成した起動失敗（本物の資源枯渇は再現しない）'));

    const closed = await waitForClosed(events);
    // **`done` ではなく `failed` で落ちたことを言い切る。** 経路が違えば
    // `#finish` の呼び出し元も違い、輪の後半は別の話になる。
    expect(closed.status).toBe('failed');

    // **これが #712 の輪の後半である。** 落ちた1本が `#sessions` から消え、
    // `/health` が名乗る本数が減る ＝ 配置の点数の分母が縮む。
    expect((await readHealth(app)).managers).toBe(0);

    await host.shutdown();
  });

  it('2本のうち1本だけ落ちても、減るのは落ちた1本ぶんである（全部消えたのではない）', async () => {
    // **「0 になった」だけでは弱い。** 器ごと畳まれた・`list()` が常に空を返すように
    // なった、という別の理由でも 0 は出る。**落ちた本数ぶんだけ**減ることを見る。
    const events: RunnerEvent[] = [];
    const sdk = heldSdk();
    const host = hostOf('runner-712-pair', events, sdk.fn);
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    await host.start({ managerId: 'mgr-712-a', request: '依頼A', cwd: '/workspace' });
    await host.start({ managerId: 'mgr-712-b', request: '依頼B', cwd: '/workspace' });
    expect((await readHealth(app)).managers).toBe(2);

    // **1本目だけを落とす。** `host.stop()` は使わない —— あちらは `#finish` を
    // 通らない別の終わり口で（`runner.ts` の `#finish` の doc が名指ししている）、
    // #712 の輪が通る経路ではない。
    sdk.failNth(0, new Error('合成した起動失敗（1本目だけ）'));

    const closed = await waitForClosed(events);
    expect(closed.status).toBe('failed');
    expect(closed.managerId).toBe('mgr-712-a');

    expect((await readHealth(app)).managers).toBe(1);

    // **残りの1本も落としてから畳む。** 待ち続けている偽 SDK を抱えたまま
    // `shutdown()` を呼ぶと、そこで返らない（測りたいことの外側の詰まりである）。
    sdk.fail(new Error('後片付け'));
    await host.shutdown();
  });
});
