import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CgroupEventCounters } from './runner-resources.js';
import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

function throwingSdk(error: unknown): typeof sdkQuery {
  return ((): Query => {
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: (): Promise<IteratorResult<never>> => Promise.reject(error),
      return: (): Promise<IteratorResult<never>> =>
        Promise.resolve({ done: true, value: undefined }),
    };
    return Object.assign(stream, {
      close: () => undefined,
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

let hosts: RunnerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
  hosts = [];
});

function sequencedCounters(...values: CgroupEventCounters[]): () => Promise<CgroupEventCounters> {
  let i = 0;
  return async () => {
    const value = values[Math.min(i, values.length - 1)] ?? {};
    i += 1;
    return value;
  };
}

function hostThatThrows(
  error: unknown,
  readCgroupEventCountersFn: () => Promise<CgroupEventCounters>,
): {
  host: RunnerHost;
  waitForClosed: () => Promise<Extract<RunnerEvent, { type: 'closed' }>>;
} {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-1517',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: throwingSdk(error),
    env: { PATH: '/usr/bin' },
    readCgroupEventCountersFn,
  });
  hosts.push(host);
  const waitForClosed = async (): Promise<Extract<RunnerEvent, { type: 'closed' }>> => {
    let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
    await vi.waitFor(() => {
      closed = events.find(
        (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
      );
      if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    });
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    return closed;
  };
  return { host, waitForClosed };
}

async function closedAfterThrowing(
  error: unknown,
  readCgroupEventCountersFn: () => Promise<CgroupEventCounters>,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const { host, waitForClosed } = hostThatThrows(error, readCgroupEventCountersFn);
  await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });
  return waitForClosed();
}

function throughDaemonBoundary(event: RunnerEvent): Extract<RunnerEvent, { type: 'closed' }> {
  const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
  if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
  if (parsed.data.type !== 'closed') throw new Error(`closed ではない: ${parsed.data.type}`);
  return parsed.data;
}

describe('cgroup イベントの差分が closed に載る（#1517「最小の形」1）', () => {
  it('1. 差分が出る（開いたときと畳んだときの2点から増分を計算する）', async () => {
    const closed = await closedAfterThrowing(
      new Error('SIGABRT'),
      sequencedCounters({ pidsMax: 1, oomKill: 0 }, { pidsMax: 4, oomKill: 2 }),
    );
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.cgroupEvents).toEqual({ pidsMaxDelta: 3, oomKillDelta: 2 });
  });

  it('2. 読めない（両方 {} のまま）ときは、欄そのものが付かない', async () => {
    const closed = await closedAfterThrowing(new Error('何か'), sequencedCounters({}, {}));

    expect(Object.hasOwn(closed, 'cgroupEvents')).toBe(false);
    expect(closed.cgroupEvents).toBeUndefined();

    const delivered = throughDaemonBoundary(closed);
    expect(Object.hasOwn(delivered, 'cgroupEvents')).toBe(false);
  });

  it('2. 開いたときの値が無い（runner の再起動をまたいだ等）なら、畳んだときに読めても欄が付かない', async () => {
    const closed = await closedAfterThrowing(
      new Error('何か'),
      sequencedCounters({}, { pidsMax: 9, oomKill: 9 }),
    );

    expect(closed.cgroupEvents).toBeUndefined();
  });

  it('3. 古い runner（cgroup を一切読まない構成）でも closed は変わらず届く（version-skew 耐性）', async () => {
    const events: RunnerEvent[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-1517-legacy',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: throwingSdk(new Error('何か')),
      env: { PATH: '/usr/bin' },
    });
    hosts.push(host);
    await host.start({ managerId: 'mgr-legacy', request: '最初の依頼', cwd: '/work/project' });

    let closed: Extract<RunnerEvent, { type: 'closed' }> | undefined;
    await vi.waitFor(() => {
      closed = events.find(
        (event): event is Extract<RunnerEvent, { type: 'closed' }> => event.type === 'closed',
      );
      if (closed === undefined) throw new Error('closed がまだ降りてきていない');
    });
    if (closed === undefined) throw new Error('closed がまだ降りてきていない');

    const delivered = throughDaemonBoundary(closed);
    expect(delivered.status).toBe('failed');
    expect(delivered.reason).toContain('何か');
  });
});
