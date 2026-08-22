import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunnerFenceError } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

/**
 * fencing（世代番号）— roadmap M5 PR4「二重実行を止める fencing（貸し出し期限
 * lease）」の runner 側。**判定材料そのもの（誰が持ち主か）は `lease.ts` が持つ**
 * ので、ここで固定するのは runner が実際にその世代をどう扱うかだけである。
 *
 * ## 世代（fence）
 *
 * `start` / `resume` の `lease.fence` は世代番号。runner はセッションごとに最後に
 * 受け取った世代を覚え、**それより古い** `resume` を `RunnerFenceError` で拒む
 * （`runner-protocol.ts` の `runnerLeaseSchema` / `RunnerFenceError` の doc）。
 * `lease` は任意なので、省略すれば今までどおり動く（古いデーモンとの互換）。
 *
 * ## 自己失効（self-fence）
 *
 * `lease.ts` の doc が言う「引き取ってよいかを片側だけで言える」を成立させる歯。
 * デーモンと連絡が取れないまま `lease.ttlMs` を過ぎたら、runner は自分で
 * セッションを畳む。**明示的な opt-in**（`enforceLease`。既定 false）で、
 * コンテナで走る器（`apps/runner/src/index.ts`）だけが有効にする。
 *
 * **時計は手で進める**（`runner-swap.test.ts` と同じ理由 — 実時間待ちにしない）。
 */

/** このセッションが実際に消費した入力の本文（順序どおり）。 */
interface FakeSession {
  inputs: string[];
}

/**
 * 走行中のセッションを模す偽 SDK。**閉じられるまで開いたまま**
 * （`boundary.test.ts` の `fakeSdk` と同じ形）。
 */
function fakeSdk(): { fn: typeof sdkQuery; sessions: FakeSession[]; callCount: () => number } {
  const sessions: FakeSession[] = [];
  let calls = 0;

  const fn = ((params: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    calls += 1;
    const session: FakeSession = { inputs: [] };
    sessions.push(session);
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${sessions.length}`,
        uuid: `uuid-init-${sessions.length}`,
      } as unknown as SDKMessage;

      // 読み手は要る — 誰も読まないと runner 側の `#inputStream` が起きない
      // （`usage-flush.test.ts` の `fakeSdk` と同じ注記）。ここで消費した本文を
      // 覚えておき、「実際に届いたか」を後から確かめられるようにする。
      void (async () => {
        for await (const message of params.prompt) {
          session.inputs.push(String(message.message.content));
        }
      })();

      // 走行中のセッションを模す（閉じられるまで開いたまま）。
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }

    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions, callCount: () => calls };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(options: Pick<RunnerHostOptions, 'enforceLease'> = {}): {
  host: RunnerHost;
  events: RunnerEvent[];
  fake: ReturnType<typeof fakeSdk>;
} {
  const events: RunnerEvent[] = [];
  const fake = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-fence',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fake.fn,
    env: { PATH: '/usr/bin' },
    ...options,
  });
  hosts.push(host);
  return { host, events, fake };
}

function closedEvents(events: readonly RunnerEvent[]): Extract<RunnerEvent, { type: 'closed' }>[] {
  return events.filter((event): event is Extract<RunnerEvent, { type: 'closed' }> => {
    return event.type === 'closed';
  });
}

describe('resume の世代（fencing token）', () => {
  it('古い世代の resume は拒まれ、走っているセッションが1文字も影響を受けない', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });
    expect(fake.callCount()).toBe(1);

    const rejection = host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-old',
      cwd: '/work/project',
      request: '再開の依頼',
      message: '古い世代からの一言',
      lease: { fence: 3, ttlMs: 60_000 },
    });
    await expect(rejection).rejects.toBeInstanceOf(RunnerFenceError);
    await expect(rejection).rejects.toMatchObject({ managerId: 'mgr-1', expected: 5, given: 3 });

    // **セッションは作り直されていない**（queryFn が2回目を呼ばれていない）。
    expect(fake.callCount()).toBe(1);
    // **走っているセッションが1文字も影響を受けない** — 拒まれた一言は
    // 入力として届いていない。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sessions[0]?.inputs).not.toContain('古い世代からの一言');
    // 一覧からも消えていない（走り続けている）。
    expect(host.list()).toHaveLength(1);
    expect(host.list()[0]?.managerId).toBe('mgr-1');
  });

  it('同じ世代の resume は受ける（再送）', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-x',
      cwd: '/work/project',
      request: '再開の依頼',
      message: '再送の一言',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    // 同じ世代なので拒まれず、かつ作り直されない。
    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('再送の一言');
    });
  });

  it('新しい世代の resume は世代を更新し、走っているセッションを作り直さない', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-x',
      cwd: '/work/project',
      request: '再開の依頼',
      message: '新しい世代からの一言',
      lease: { fence: 6, ttlMs: 60_000 },
    });

    // **作り直されない**（queryFn は1回のまま）。世代だけが更新される。
    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('新しい世代からの一言');
    });

    // 世代は6へ更新済み。もとの5はもう古い世代として拒まれる。
    await expect(
      host.resume({
        managerId: 'mgr-1',
        sessionId: 'sess-x',
        cwd: '/work/project',
        request: '再開の依頼',
        lease: { fence: 5, ttlMs: 60_000 },
      }),
    ).rejects.toMatchObject({ expected: 6, given: 5 });
    expect(fake.callCount()).toBe(1);
  });

  it('lease を伴わない resume は今までどおり動く（lease を知らない古いデーモンとの互換）', async () => {
    const { host, fake } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 5, ttlMs: 60_000 },
    });

    // `lease` を省略——世代の検査そのものが起きない。
    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-x',
      cwd: '/work/project',
      request: '再開の依頼',
      message: 'lease 無しの一言',
    });

    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('lease 無しの一言');
    });
  });

  it('この Host インスタンスにとって初めての resume は、世代を覚えるだけで拒まない（器の入れ替え後）', async () => {
    // start を経ていない managerId への resume——器の入れ替え・デーモンの再起動後を模す。
    const { host, fake } = setup();

    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-y',
      cwd: '/work/project',
      request: '引き継ぎの依頼',
      lease: { fence: 9, ttlMs: 60_000 },
    });

    // 比べる前の世代が無いので、拒む判定は起きない。
    expect(fake.callCount()).toBe(1);
    expect(host.list()).toHaveLength(1);

    // ここで覚えた世代（9）は、以後この Host インスタンスの中で効く。
    await expect(
      host.resume({
        managerId: 'mgr-2',
        sessionId: 'sess-y',
        cwd: '/work/project',
        request: '引き継ぎの依頼',
        lease: { fence: 8, ttlMs: 60_000 },
      }),
    ).rejects.toMatchObject({ expected: 9, given: 8 });
  });
});

describe('貸し出し期限の自己失効（enforceLease）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('期限を過ぎたら畳まれ、closed が上がる', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });
    expect(host.list()).toHaveLength(1);

    // 見張りは10秒おき。3周目（30秒）で期限に達する。
    await vi.advanceTimersByTimeAsync(30_000);

    expect(host.list()).toHaveLength(0);
    const closed = closedEvents(events);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.managerId).toBe('mgr-1');
    // **理由の文言に「自己失効」の意味を必ず含める**（デーモンが後で拾えるため）。
    expect(closed[0]?.reason).toContain(
      'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）',
    );
    // **構造化された印が立つ。** 台帳側（`manager.ts`）はこの印だけを見て
    // 「引き取り直せる」と判定する——文言の一致では判定しない
    // （`runnerEventSchema` の `closed.selfFenced` の doc）。
    expect(closed[0]?.selfFenced).toBe(true);
    expect(closed[0]?.status).toBe('lost');
  });

  it('明示停止（`Host#stop`）では `selfFenced` が立たない', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });

    await host.stop('mgr-1');

    expect(host.list()).toHaveLength(0);
    // `stop()` はそもそも `closed` イベントを出さない（デーモンが `list()` で
    // 自分で確かめる形——`RunnerSession#selfFence` の doc）。
    expect(closedEvents(events)).toHaveLength(0);

    // 期限をとうに過ぎても、既に止まっているセッションを二重に畳もうとしない。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closedEvents(events)).toHaveLength(0);
  });

  it('器の `shutdown()` では `selfFenced` が立たない', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });

    await host.shutdown();

    expect(host.list()).toHaveLength(0);
    // `shutdown()` も同じ `stop()` の経路を通るので `closed` を出さない。
    expect(closedEvents(events)).toHaveLength(0);
  });

  it('接触があれば時計が戻る（`noteDaemonContact` が期限を延ばす）', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 20_000 },
    });

    // 1周目（10秒）。まだ期限（20秒）に届かない。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(1);

    // 接触があった——ここから新たに20秒の猶予が始まる。
    host.noteDaemonContact();

    // 接触から10秒しか経っていない（見張りの2周目）。まだ畳まれない。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);

    // 接触から20秒経った（見張りの3周目）。ここで期限が切れる。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(0);
    expect(closedEvents(events)).toHaveLength(1);
  });

  it('enforceLease が既定（false）なら、期限を過ぎても畳まれない', async () => {
    const { host, events } = setup();
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      lease: { fence: 1, ttlMs: 30_000 },
    });

    // 期限をとうに過ぎるまで進める。
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);
  });

  it('lease を伴わずに起こされたセッションは、enforceLease が true でも畳まれない', async () => {
    const { host, events } = setup({ enforceLease: true });
    await host.start({
      managerId: 'mgr-1',
      request: '最初の依頼',
      cwd: '/work/project',
      // `lease` を省略——自己失効の対象にならない。
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);
  });
});
