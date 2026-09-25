import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CgroupEventCounters } from './runner-resources.js';
import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';

/**
 * **runner が委譲のセッションを開いたときと `closed` のときに cgroup の
 * イベントカウンタを読み、差分を `closed` へ添えること（Issue #1517
 * 「最小の形」1）。**
 *
 * `runner-closed-system-error.test.ts` を `systemError` の代わりに
 * `cgroupEvents` で複製した形——足場（`throwingSdk` / `hostThatThrows` /
 * `throughDaemonBoundary`）は同じものを、この歯専用に複製してある（同ファイルの
 * doc と同じ理由——duplicated on purpose）。
 *
 * **測るのは「読む場所」ではなく「差分の配線」である。** `readCgroupEventCounters`
 * 自体（cgroup ファイルの読み方）は `runner-resources.test.ts` が、差分の計算
 * （`cgroupEventsDeltaOf`）は `cgroup-events.test.ts` が持つ。ここは
 * `RunnerSession` が「開いたとき」に読んだ値と「畳んだとき」に読んだ値を、
 * 実際に2点として使っていることを固定する——`readCgroupEventCountersFn` を
 * 呼び出し回数で切り替える偽物を挿して、1回目（コンストラクタ＝開いたとき）と
 * 2回目（`#finish`＝畳んだとき）が別の値を返すことを確かめる。
 */

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

/** 呼ぶたびに配列の次の値を返す偽の `readCgroupEventCountersFn`。 */
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

/** runner → daemon の境界を実際に通す（`runner-closed-system-error.test.ts` と同じ形）。 */
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
      // 1回目（開いたとき）= { pidsMax: 1, oomKill: 0 }、
      // 2回目（畳んだとき）= { pidsMax: 4, oomKill: 2 }。
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
    // 既定（`readCgroupEventCountersFn` を渡さない）の実体は本物の
    // `readCgroupEventCounters()` で、実在しないパスを読むわけではないが、
    // CI のコンテナに cgroup v2 が無い／読めない構成でも、この機能が無かった
    // ころの runner とまったく同じ形（`cgroupEvents` 抜きの `closed`）に
    // 収束することを固定する。
    const events: RunnerEvent[] = [];
    const host = createRunnerHost({
      runnerId: 'runner-1517-legacy',
      workspacePath: '/work/project',
      emit: (event) => events.push(event),
      queryFn: throwingSdk(new Error('何か')),
      env: { PATH: '/usr/bin' },
      // `readCgroupEventCountersFn` を渡さない——既定のまま。
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

    // **境界を通しても壊れない**——`cgroupEvents` の有無に関わらず、`status` /
    // `reason` は今までどおり届く。
    const delivered = throughDaemonBoundary(closed);
    expect(delivered.status).toBe('failed');
    expect(delivered.reason).toContain('何か');
  });
});
