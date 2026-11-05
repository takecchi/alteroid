import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import type {
  RunnerClient,
  RunnerEntry,
  RunnerEvent,
  RunnerManagerState,
  RunnerRegistry,
} from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('resume の応答より先に届いた確認待ちを、resume 受理後の status 書き込みが上書きしない', () => {
  function createFakeRegistry(client: RunnerClient): RunnerRegistry {
    const entries: RunnerEntry[] = [
      {
        label: client.runnerId,
        state: 'connected',
        runnerId: client.runnerId,
        since: '2026-08-01T00:00:00.000Z',
        revision: { status: 'unheard' },
      },
    ];
    return fakeRunnerRegistry({
      async list() {
        return [client];
      },
      async get(runnerId) {
        return runnerId === client.runnerId ? client : null;
      },
      async select() {
        throw new Error('この試験群では使わない（配置は検証対象ではない）');
      },
      async register() {
        /* この試験群では使わない。 */
      },
      async unregister() {
        /* この試験群では使わない。 */
      },
      vacate() {
        /* この試験群では使わない。 */
      },
      entries() {
        return entries.map((entry) => ({ ...entry }));
      },
      noteManagerFailed() {
        /* この試験群では使わない。 */
      },
      subscribe() {
        return () => {};
      },
      async stop() {},
    });
  }

  /** `resume` が、応答を返す前に `ask` を流す runner（新しいセッションの最初の確認が応答より先に届く並び）。 */
  function askingRunner(runnerId: string): RunnerClient {
    const sessions = new Map<string, RunnerManagerState>();
    let emit: ((event: RunnerEvent) => void) | undefined;
    return fakeRunnerClient({
      runnerId,
      async connect(onEvent) {
        emit = onEvent;
      },
      async resume(command): Promise<{ cwd: string }> {
        sessions.set(command.managerId, {
          liveBackgroundTasks: 0,
          managerId: command.managerId,
          status: 'waiting_human',
          cwd: command.cwd,
          request: command.request,
          waiting: [],
          sessionId: command.sessionId,
        });
        emit?.({
          type: 'ask',
          managerId: command.managerId,
          requestId: 'ask-before-resume-response',
          kind: 'permission',
          summary: 'Bash の実行許可（resume の応答より先の確認）',
        } as RunnerEvent);
        // ask の処理（await を挟む）が先に済むよう、応答を少し遅らせる。
        for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
        return { cwd: command.cwd };
      },
      async send(managerId) {
        // セッションが無ければ届かない（`#send` が resume へ入る）。
        return sessions.has(managerId);
      },
      async stop(managerId) {
        sessions.delete(managerId);
      },
      async list() {
        return [...sessions.values()];
      },
    });
  }

  function runningJob(): Job {
    return {
      id: 'mgr-same',
      managerId: 'mgr-same',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '走行中の委譲',
      request: '続きをやって',
      cwd: '/work/project',
      sessionId: 'sess-before',
      lastReport: '途中まで進めた',
      runnerId: 'runner-a',
    };
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it('同じ runner への復帰（#reattach）: resume の応答より先に ask が届いたら、受理の後も waiting_human のまま待ちが1件残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob());
    const runner = askingRunner('runner-a');
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createFakeRegistry(runner),
    });
    await pool.abort('mgr-does-not-exist');
    await pool.reattachRunner('runner-a');
    await settle();
    const row = (await pool.list()).find((manager) => manager.managerId === 'mgr-same');
    expect({ status: row?.status, waiting: row?.waiting.length }).toEqual({
      status: 'waiting_human',
      waiting: 1,
    });
    await pool.stop();
  });

  it('伝言での起こし直し（#send）: resume の応答より先に ask が届いたら、受理の後も waiting_human のまま待ちが1件残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob());
    const runner = askingRunner('runner-a');
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createFakeRegistry(runner),
    });
    const sent = await pool.send('mgr-same', '続きをお願い');
    await settle();
    const row = (await pool.list()).find((manager) => manager.managerId === 'mgr-same');
    expect({ outcome: sent.outcome, status: row?.status, waiting: row?.waiting.length }).toEqual({
      outcome: 'delivered',
      status: 'waiting_human',
      waiting: 1,
    });
    await pool.stop();
  });

  it('再起動後の復元（#restoreJobs）: resume の応答より先に ask が届いたら、受理の後も waiting_human のまま待ちが1件残る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(runningJob());
    const runner = askingRunner('runner-a');
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createFakeRegistry(runner),
    });
    await pool.restore();
    await settle();
    const row = (await pool.list()).find((manager) => manager.managerId === 'mgr-same');
    expect({ status: row?.status, waiting: row?.waiting.length }).toEqual({
      status: 'waiting_human',
      waiting: 1,
    });
    await pool.stop();
  });
});
