import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runnerEventSchema } from './runner-protocol.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { UnpushedWorkResult } from './runner-protocol.js';

/**
 * **`RunnerSession#finish()` が `closed` を emit する直前に未 push の観測を
 * 1回取り、`closed` イベントの `unpushedWork` 欄として運ぶこと（Issue #1266
 * 候補(2)）。**
 *
 * `runner-closed-cgroup-events.test.ts` を `cgroupEvents` の代わりに
 * `unpushedWork` で複製した形——足場（`throwingSdk` / `hosts` の後始末 /
 * `throughDaemonBoundary`）は同じものを、この歯専用に複製してある（同ファイル
 * の doc と同じ理由——duplicated on purpose）。
 *
 * **測るのは「取る場所」ではなく「`closed` への配線」である。** `computeUnpushedWork`
 * 自体（`cwd` の下を実際にどう調べるか）は `unpushed-work.test.ts` が持つ。
 * ここは `RunnerSession` が `closed` を emit する直前にこの観測を1回取り、
 * ワイヤーの形（`kind: 'ok' | 'unavailable'`）で運ぶことと、取れなかったとき
 * ・古い runner（この口自体が無い構成）でも `closed` そのものは壊れないこと
 * を固定する——`finishUnpushedWorkFn`（テスト用の差し替え口。既定は本物の
 * `this.unpushedWork()`）を使って、runner との実 I/O を挟まずに固定する。
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

function hostThatThrows(
  error: unknown,
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>,
): {
  host: RunnerHost;
  waitForClosed: () => Promise<Extract<RunnerEvent, { type: 'closed' }>>;
} {
  const events: RunnerEvent[] = [];
  const host = createRunnerHost({
    runnerId: 'runner-1266',
    workspacePath: '/work/project',
    emit: (event) => events.push(event),
    queryFn: throwingSdk(error),
    env: { PATH: '/usr/bin' },
    // **同じ理由で cgroup の実ファイルも読ませない**（`runner-closed-cgroup-events.test.ts`
    // と同じ注記）。この一式は cgroup を検証しないので、即座に解決する空の値で十分。
    readCgroupEventCountersFn: async () => ({}),
    ...(finishUnpushedWorkFn === undefined ? {} : { finishUnpushedWorkFn }),
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
  finishUnpushedWorkFn?: (options?: { signal?: AbortSignal }) => Promise<UnpushedWorkResult>,
): Promise<Extract<RunnerEvent, { type: 'closed' }>> {
  const { host, waitForClosed } = hostThatThrows(error, finishUnpushedWorkFn);
  await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });
  return waitForClosed();
}

/** runner → daemon の境界を実際に通す（`runner-closed-cgroup-events.test.ts` と同じ形）。 */
function throughDaemonBoundary(event: RunnerEvent): Extract<RunnerEvent, { type: 'closed' }> {
  const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(event)) as unknown);
  if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
  if (parsed.data.type !== 'closed') throw new Error(`closed ではない: ${parsed.data.type}`);
  return parsed.data;
}

describe('未 push の観測が closed に載る（Issue #1266 候補(2)）', () => {
  it('1. 取れたとき: kind:ok + result が closed に載る（境界を通っても壊れない）', async () => {
    const result: UnpushedWorkResult = {
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/1266-runner-closed-observation' }],
    };
    const closed = await closedAfterThrowing(new Error('EAGAIN'), async () => result);
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.unpushedWork).toEqual({ kind: 'ok', result });
  });

  it('2. 取れなかったとき: finishUnpushedWorkFn が失敗しても closed 自体は届き、kind:unavailable + reason が載る', async () => {
    const closed = await closedAfterThrowing(new Error('何か'), () =>
      Promise.reject(new Error('runner が答えなかった')),
    );
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.status).toBe('failed');
    expect(delivered.unpushedWork).toMatchObject({ kind: 'unavailable' });
    if (delivered.unpushedWork?.kind !== 'unavailable') {
      throw new Error('unavailable ではない');
    }
    expect(delivered.unpushedWork.reason).toContain('runner が答えなかった');
  });

  it('3. 既定（差し替えなし）: 本物の this.unpushedWork() を呼び、cwd が無くても kind:ok（0本）で載る', async () => {
    // `finishUnpushedWorkFn` を渡さない——既定のまま（本物の
    // `computeUnpushedWork`）。`/work/project` は実在しないので `worktrees: []`
    // で解決するはず（`computeUnpushedWork` は cwd が読めないだけでは例外を
    // 投げない設計）。
    const closed = await closedAfterThrowing(new Error('何か'));
    const delivered = throughDaemonBoundary(closed);

    expect(delivered.unpushedWork).toMatchObject({
      kind: 'ok',
      result: { cwd: '/work/project', worktrees: [] },
    });
  });

  it('4. 古い runner 相当（構造上は常に載る欄だが、値が省ける版との互換を境界側で確かめる）: unpushedWork 欄を持たない closed も境界を通る', () => {
    // **`runnerEventSchema` は `.optional()` にしてある**——この版の runner
    // （このファイルの他の歯）は必ず `unpushedWork` を送るが、古い runner が
    // この欄自体を送らない場合でも `closed` の境界が壊れないことを、生の
    // オブジェクトを直接 parse して固定する（`runner-closed-cgroup-events.test.ts`
    // の「3. 古い runner」と同じ形）。
    const legacy = {
      type: 'closed',
      managerId: 'mgr-legacy',
      status: 'failed',
      reason: '古い runner が落ちた',
      // `unpushedWork` を欄ごと持たない。
    };
    const parsed = runnerEventSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.type !== 'closed') {
      throw new Error('境界で落ちたか、closed ではない');
    }
    expect(parsed.data.unpushedWork).toBeUndefined();
    expect(Object.hasOwn(parsed.data, 'unpushedWork')).toBe(false);
    // **他の欄は今までどおり届く**——`unpushedWork` の追加が既存の欄を壊さない。
    expect(parsed.data.status).toBe('failed');
    expect(parsed.data.reason).toBe('古い runner が落ちた');
  });
});
