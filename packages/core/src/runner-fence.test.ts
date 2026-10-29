import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunnerFenceError } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost, type RunnerHostOptions } from './runner.js';

interface FakeSession {
  inputs: string[];
}

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

      void (async () => {
        for await (const message of params.prompt) {
          session.inputs.push(String(message.message.content));
        }
      })();

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

function setup(options: Pick<RunnerHostOptions, 'enforceLease' | 'fenceMemoryMax'> = {}): {
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
    // 実 I/O をさせない: fake timer では実 I/O が進まず、`#finish()` が assertion より遅れて解決する
    readCgroupEventCountersFn: async () => ({}),
    finishUnpushedWorkFn: async () => ({ cwd: '/work/project', worktrees: [] }),
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

    expect(fake.callCount()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sessions[0]?.inputs).not.toContain('古い世代からの一言');
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

    expect(fake.callCount()).toBe(1);
    await vi.waitFor(() => {
      expect(fake.sessions[0]?.inputs).toContain('新しい世代からの一言');
    });

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
    const { host, fake } = setup();

    await host.resume({
      managerId: 'mgr-2',
      sessionId: 'sess-y',
      cwd: '/work/project',
      request: '引き継ぎの依頼',
      lease: { fence: 9, ttlMs: 60_000 },
    });

    expect(fake.callCount()).toBe(1);
    expect(host.list()).toHaveLength(1);

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

// 閉じたセッションが最後に受けた世代を、同じ managerId の次の start / resume へ持ち越す（#5507）。外から見える結果（reject・queryFn の呼び出し回数・list）で測る
describe('閉じた後の resume の世代（持ち越し）', () => {
  const resumeWith = (managerId: string, fence: number) => ({
    managerId,
    sessionId: 'sess-old',
    cwd: '/work/project',
    request: '再開の依頼',
    lease: { fence, ttlMs: 60_000 },
  });
  const startWith = (managerId: string, fence: number) => ({
    managerId,
    request: '最初の依頼',
    cwd: '/work/project',
    lease: { fence, ttlMs: 60_000 },
  });

  it('閉じた後の古い世代の resume は拒まれ、新しいセッションを開かない', async () => {
    const { host, fake } = setup();
    await host.start(startWith('mgr-1', 5));
    await host.stop('mgr-1');
    expect(host.list()).toHaveLength(0);

    const rejection = host.resume(resumeWith('mgr-1', 4));
    await expect(rejection).rejects.toBeInstanceOf(RunnerFenceError);
    await expect(rejection).rejects.toMatchObject({ managerId: 'mgr-1', expected: 5, given: 4 });
    expect(fake.callCount()).toBe(1);
    expect(host.list()).toHaveLength(0);
  });

  it('閉じた後の古い世代の start も拒まれる', async () => {
    const { host, fake } = setup();
    await host.start(startWith('mgr-1', 5));
    await host.stop('mgr-1');

    await expect(host.start(startWith('mgr-1', 2))).rejects.toMatchObject({
      expected: 5,
      given: 2,
    });
    expect(fake.callCount()).toBe(1);
    expect(host.list()).toHaveLength(0);
  });

  it('対照: 閉じた後でも、同じ世代・大きい世代の resume は受ける', async () => {
    const { host, fake } = setup();
    await host.start(startWith('mgr-1', 5));
    await host.stop('mgr-1');
    await host.resume(resumeWith('mgr-1', 5));
    expect(fake.callCount()).toBe(2);
    await host.stop('mgr-1');
    await host.resume(resumeWith('mgr-1', 6));
    expect(fake.callCount()).toBe(3);
    await host.stop('mgr-1');
    await expect(host.resume(resumeWith('mgr-1', 5))).rejects.toMatchObject({
      expected: 6,
      given: 5,
    });
  });

  it('対照: 別の managerId の世代には影響されない', async () => {
    const { host } = setup();
    await host.start(startWith('mgr-1', 5));
    await host.stop('mgr-1');
    await host.resume(resumeWith('mgr-2', 1));
    expect(host.list().map((state) => state.managerId)).toEqual(['mgr-2']);
  });

  it('生きたセッションへ合流した resume の世代も覚える', async () => {
    const { host } = setup();
    await host.start(startWith('mgr-1', 1));
    await host.resume(resumeWith('mgr-1', 7));
    await host.stop('mgr-1');
    await expect(host.resume(resumeWith('mgr-1', 6))).rejects.toMatchObject({
      expected: 7,
      given: 6,
    });
  });

  it('lease を伴わない resume は、覚えた世代があっても今までどおり動く', async () => {
    const { host, fake } = setup();
    await host.start(startWith('mgr-1', 5));
    await host.stop('mgr-1');
    await host.resume({
      managerId: 'mgr-1',
      sessionId: 'sess-old',
      cwd: '/work/project',
      request: '再開の依頼',
    });
    expect(fake.callCount()).toBe(2);
  });

  it('覚える数を超えたら、最も古いものから忘れる', async () => {
    const { host } = setup({ fenceMemoryMax: 2 });
    for (const id of ['mgr-a', 'mgr-b', 'mgr-c']) {
      await host.start(startWith(id, 5));
      await host.stop(id);
    }
    // mgr-a は押し出された（受ける）。mgr-b・mgr-c は覚えている
    await expect(host.resume(resumeWith('mgr-b', 1))).rejects.toBeInstanceOf(RunnerFenceError);
    await expect(host.resume(resumeWith('mgr-c', 1))).rejects.toBeInstanceOf(RunnerFenceError);
    await host.resume(resumeWith('mgr-a', 1));
    expect(host.list().map((state) => state.managerId)).toEqual(['mgr-a']);
  });

  // 比べるのは Host の1か所だけ（#5514）: 生きたセッションの担当を忘れると、合流する経路で古い世代を通してしまう
  it('覚える数を超えても、生きたセッションの担当の世代は忘れない', async () => {
    const { host, fake } = setup({ fenceMemoryMax: 2 });
    await host.start(startWith('mgr-a', 5));
    for (const id of ['mgr-b', 'mgr-c']) {
      await host.start(startWith(id, 5));
      await host.stop(id);
    }
    // mgr-a が最も古いが生きているので残り、代わりに生きていない mgr-b が落ちる
    const rejection = host.resume(resumeWith('mgr-a', 1));
    await expect(rejection).rejects.toBeInstanceOf(RunnerFenceError);
    await expect(rejection).rejects.toMatchObject({ managerId: 'mgr-a', expected: 5, given: 1 });
    await expect(host.resume(resumeWith('mgr-c', 1))).rejects.toBeInstanceOf(RunnerFenceError);
    await host.resume(resumeWith('mgr-b', 1));
    expect(fake.callCount()).toBe(4);
  });

  it('全員が生きているときは、上限を一時的に超えても誰の世代も忘れない', async () => {
    const { host } = setup({ fenceMemoryMax: 2 });
    for (const id of ['mgr-a', 'mgr-b', 'mgr-c']) {
      await host.start(startWith(id, 5));
    }
    for (const id of ['mgr-a', 'mgr-b', 'mgr-c']) {
      await expect(host.resume(resumeWith(id, 1))).rejects.toMatchObject({ expected: 5, given: 1 });
    }
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

    await vi.advanceTimersByTimeAsync(30_000);

    expect(host.list()).toHaveLength(0);
    const closed = closedEvents(events);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.managerId).toBe('mgr-1');
    expect(closed[0]?.reason).toContain(
      'デーモンと連絡が取れないので貸し出し期限が切れた（自己失効）',
    );
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
    expect(closedEvents(events)).toHaveLength(0);

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

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(1);

    host.noteDaemonContact();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);

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
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(host.list()).toHaveLength(1);
    expect(closedEvents(events)).toHaveLength(0);
  });
});
