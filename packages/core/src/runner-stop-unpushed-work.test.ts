import type { Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent, UnpushedWorkResult } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

function fakeSdk(): { fn: typeof sdkQuery } {
  const fn = ((params: { prompt: AsyncIterable<unknown> }) => {
    let finish: (() => void) | null = null;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      // 読み手は要る: 誰も読まないと runner 側の `#inputStream` が起きない。
      void (async () => {
        for await (const message of params.prompt) void message;
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

  return { fn };
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function setup(
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>,
): { host: RunnerHost; events: RunnerEvent[] } {
  const events: RunnerEvent[] = [];
  const { fn } = fakeSdk();
  const host = createRunnerHost({
    runnerId: 'runner-1266c',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
    // cgroup の実ファイルを読ませない: この一式は cgroup を検証しない。
    readCgroupEventCountersFn: async () => ({}),
    ...(finishUnpushedWorkFn === undefined ? {} : { finishUnpushedWorkFn }),
  });
  hosts.push(host);
  return { host, events };
}

function shutdownUnpushedWorkEvents(
  events: readonly RunnerEvent[],
): Extract<RunnerEvent, { type: 'shutdown_unpushed_work' }>[] {
  return events.filter(
    (event): event is Extract<RunnerEvent, { type: 'shutdown_unpushed_work' }> =>
      event.type === 'shutdown_unpushed_work',
  );
}

function throughDaemonBoundary(
  event: RunnerEvent,
): Extract<RunnerEvent, { type: 'shutdown_unpushed_work' }> {
  const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
  if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
  if (parsed.data.type !== 'shutdown_unpushed_work') {
    throw new Error(`shutdown_unpushed_work ではない: ${parsed.data.type}`);
  }
  return parsed.data;
}

describe('未 push の観測が shutdown_unpushed_work として運ばれる（Issue #1266 候補(C)）', () => {
  it('1. Host#shutdown() 経由（日常の redeploy）: kind:ok + result が載る（境界を通っても壊れない）', async () => {
    const result: UnpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1266-shutdown-observation' }],
    };
    const { host, events } = setup(async () => result);
    await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });

    await host.shutdown();

    const found = shutdownUnpushedWorkEvents(events);
    expect(found).toHaveLength(1);
    const first = found[0];
    if (first === undefined) throw new Error('見つからない');
    const delivered = throughDaemonBoundary(first);
    expect(delivered.managerId).toBe('mgr-1');
    expect(delivered.unpushedWork).toEqual({ kind: 'ok', result });
  });

  it('2. Host#stop(managerId) 経由（デーモンの明示停止・manager_stop force:true 相当）: shutdown_unpushed_work は出ない', async () => {
    const { host, events } = setup(async () => ({ cwd: '/work/project', worktrees: [] }));
    await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });

    await host.stop('mgr-1');

    expect(shutdownUnpushedWorkEvents(events)).toHaveLength(0);
    expect(events.some((event) => event.type === 'closed')).toBe(false);
  });

  it('3. 取れなかったとき: finishUnpushedWorkFn が失敗しても畳み自体は完了し、kind:unavailable + reason が載る', async () => {
    const { host, events } = setup(() => Promise.reject(new Error('runner が答えなかった')));
    await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });

    await host.shutdown();

    const found = shutdownUnpushedWorkEvents(events);
    expect(found).toHaveLength(1);
    const first = found[0];
    if (first === undefined) throw new Error('見つからない');
    const delivered = throughDaemonBoundary(first);
    expect(delivered.unpushedWork).toMatchObject({ kind: 'unavailable' });
    if (delivered.unpushedWork.kind !== 'unavailable') throw new Error('unavailable ではない');
    expect(delivered.unpushedWork.reason).toContain('runner が答えなかった');
  });

  it('4. 既定（差し替えなし）: 本物の this.unpushedWork() を呼び、cwd（探索の起点）が読めなければ kind:unavailable になる', async () => {
    const { host, events } = setup();
    await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });

    await host.shutdown();

    const found = shutdownUnpushedWorkEvents(events);
    expect(found).toHaveLength(1);
    expect(found[0]?.unpushedWork).toMatchObject({ kind: 'unavailable' });
    const unpushedWork = found[0]?.unpushedWork;
    if (unpushedWork?.kind !== 'unavailable') throw new Error('unavailable ではない');
    expect(unpushedWork.reason).toContain('/work/project');
  });

  it('5. 複数セッション: Host#shutdown() は全セッションぶん、それぞれ1本ずつ運ぶ', async () => {
    const { host, events } = setup(async () => ({ cwd: '/work/project', worktrees: [] }));
    await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });
    await host.start({ managerId: 'mgr-2', request: '別の依頼', cwd: '/work/project' });

    await host.shutdown();

    const found = shutdownUnpushedWorkEvents(events);
    expect(found.map((event) => event.managerId).sort()).toEqual(['mgr-1', 'mgr-2']);
  });

  it('6. スキーマ: unpushedWork 欄は必須（closed とは違い .optional() ではない）——欄を省いた形は境界で落ちる', () => {
    const invalid = { type: 'shutdown_unpushed_work', managerId: 'mgr-x' };
    const parsed = runnerEventSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});
