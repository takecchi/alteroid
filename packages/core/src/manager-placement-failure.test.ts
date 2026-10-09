import type { Query, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { RunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

function controllableSdk(): {
  fn: typeof sdkQuery;
  /** 開いた順の n 番目を、エラーで落とす（→ closed.status: 'failed'）。 */
  failNth: (index: number, error: unknown) => void;
  /** 開いた順の n 番目を、正常に終わらせる（→ closed.status: 'done'）。 */
  finishNth: (index: number) => void;
} {
  const settlers: {
    resolve: (result: IteratorResult<never>) => void;
    reject: (error: unknown) => void;
  }[] = [];

  const fn = ((): Query => {
    let resolve!: (result: IteratorResult<never>) => void;
    let reject!: (error: unknown) => void;
    const held = new Promise<IteratorResult<never>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    settlers.push({ resolve, reject });
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

  const settlerOf = (index: number) => {
    const settler = settlers[index];
    if (settler === undefined) throw new Error('その番号のセッションは開いていない');
    return settler;
  };

  return {
    fn,
    failNth: (index, error) => settlerOf(index).reject(error),
    finishNth: (index) => settlerOf(index).resolve({ done: true, value: undefined }),
  };
}

/** `{ ...real }` では包めない: メソッドはプロトタイプにあり、スプレッドではコピーされない。 */
function watchNoteManagerFailed(real: RunnerRegistry): {
  registry: RunnerRegistry;
  /** `noteManagerFailed` が呼ばれた順の `runnerId`。 */
  noted: string[];
} {
  const noted: string[] = [];
  const registry: RunnerRegistry = {
    list: () => real.list(),
    get: (runnerId) => real.get(runnerId),
    select: (input) => real.select(input),
    register: (source) => real.register(source),
    unregister: (label) => real.unregister(label),
    vacate: (runnerId) => real.vacate(runnerId),
    noteManagerFailed: (runnerId) => {
      noted.push(runnerId);
      real.noteManagerFailed(runnerId);
    },
    entries: () => real.entries(),
    subscribe: (onOpen) => real.subscribe(onOpen),
    stop: () => real.stop(),
  };
  return { registry, noted };
}

const RUNNER_ID = 'runner-under-test';

function setup() {
  const sdk = controllableSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const real = createRunnerRegistry([
    createLocalRunner({
      runnerId: RUNNER_ID,
      workspacePath: '/work/project',
      queryFn: sdk.fn,
      env: { PATH: '/usr/bin' },
    }),
  ]);
  const { registry, noted } = watchNoteManagerFailed(real);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  return { pool, stores, sdk, noted, registry };
}

describe('manager.ts → RunnerRegistry#noteManagerFailed の配線（#712）', () => {
  it('failed で落ちた委譲は、その器の runnerId で noteManagerFailed が呼ばれる', async () => {
    const { pool, stores, sdk, noted, registry } = setup();
    const started = await pool.start({ request: '調べて' });

    sdk.failNth(0, new Error('合成した起動失敗（本物の資源枯渇は再現しない）'));

    const job = await vi.waitFor(async () => {
      const found = (await stores.jobs.listJobs()).find((j) => j.id === started.managerId);
      if (found?.status !== 'failed') throw new Error('まだ closed(failed) が届いていない');
      return found;
    });
    expect(job.runnerId).toBe(RUNNER_ID);

    // 待つ中身を expect にする: throw で待つと、赤が時間切れになり AssertionError が出ず原因が読めない。
    // runnerId の値まで見る: 呼ばれたことだけでは無関係な runnerId を渡す直しも緑になる。
    await vi.waitFor(() => {
      expect(noted).toEqual([RUNNER_ID]);
    });

    await pool.stop();
    await registry.stop();
  });

  it('done で正常に終わった委譲では呼ばれない（正当に速く終わった委譲を器の不調として数えない）', async () => {
    const { pool, stores, sdk, noted, registry } = setup();
    const started = await pool.start({ request: '調べて' });

    sdk.finishNth(0);

    // done になるのを待つ: 「まだ届いていない」を「呼ばれなかった」と取り違えないため。
    const job = await vi.waitFor(async () => {
      const found = (await stores.jobs.listJobs()).find((j) => j.id === started.managerId);
      if (found?.status !== 'done') throw new Error('まだ closed(done) が届いていない');
      return found;
    });
    expect(job.runnerId).toBe(RUNNER_ID);

    expect(noted).toEqual([]);

    await pool.stop();
    await registry.stop();
  });
});
