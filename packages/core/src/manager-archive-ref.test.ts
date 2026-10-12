import { afterEach, describe, expect, it, vi } from 'vitest';

import { setStderrSinkForTesting } from './dropped-record.js';
import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

// 退避の本文は参照で届き、デーモンが runner へ取りに行く（#4485）。
// 2026-10-12T03:20Z、6〜35MB の archive の出来事が SSE の1行で届き、デーモンのループが 1.2〜1.4 秒ずつ塞がった。

const ARCHIVE_ID = '0b5c6e1a-2f3d-4a7b-9c8d-1e2f3a4b5c6d';

const job: Job = {
  id: 'mgr-archive',
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  status: 'running',
  summary: '退避',
  request: '退避して',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-a',
};

interface Fake {
  runner: RunnerClient;
  emit(event: RunnerEvent): void;
  fetches: string[];
  deletes: string[];
}

function fakeRunner(stored: Map<string, string>): Fake {
  let onEvent: ((event: RunnerEvent) => void) | undefined;
  const fetches: string[] = [];
  const deletes: string[] = [];
  const runner = {
    runnerId: 'runner-a',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(listener: (event: RunnerEvent) => void) {
      onEvent = listener;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* 使わない */
    },
    async list() {
      return [
        {
          managerId: job.id,
          status: 'running' as const,
          cwd: '/work/project',
          request: '退避して',
          waiting: [],
          sessionId: 'sess-1',
        },
      ];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      /* 使わない */
    },
    async close() {
      /* 使わない */
    },
    async fetchArchive(managerId: string, archiveId: string) {
      fetches.push(`${managerId}/${archiveId}`);
      return stored.get(archiveId);
    },
    async deleteArchive(managerId: string, archiveId: string) {
      deletes.push(`${managerId}/${archiveId}`);
      stored.delete(archiveId);
    },
  } as unknown as RunnerClient;
  return {
    runner,
    emit: (event) => {
      if (onEvent === undefined) throw new Error('connect() がまだ呼ばれていない');
      onEvent(event);
    },
    fetches,
    deletes,
  };
}

let pool: ManagerPool | undefined;
afterEach(async () => {
  await pool?.stop();
  pool = undefined;
});

async function setup(stored: Map<string, string>): Promise<{ stores: Stores; fake: Fake }> {
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const fake = fakeRunner(stored);
  pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: createRunnerRegistry([fake.runner]),
  });
  await pool.restore();
  return { stores, fake };
}

async function archiveIdsOf(stores: Stores): Promise<readonly string[]> {
  return (await stores.jobs.listJobs()).find((entry) => entry.id === job.id)?.archiveIds ?? [];
}

describe('参照で届いた退避は、runner へ取りに行って置き場へ入れてから消させる（#4485）', () => {
  it('取りに行った本文を置き場へ入れ、台帳に id を残し、runner に消させる', async () => {
    const { stores, fake } = await setup(new Map([[ARCHIVE_ID, '大きな生ログ']]));
    fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 6 } });

    await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
    const [archiveId] = await archiveIdsOf(stores);
    const read = await stores.archive.read(archiveId!);
    expect(read).toEqual({ kind: 'body', body: '大きな生ログ' });
    expect(fake.fetches).toEqual([`${job.id}/${ARCHIVE_ID}`]);
    await vi.waitFor(() => expect(fake.deletes).toEqual([`${job.id}/${ARCHIVE_ID}`]));
  });

  it('runner に本文が無ければ置き場へ入れず、消させもせず、跡を残す', async () => {
    // 跡が出るまで待つ（実時間の待ちを置かない: #2146）
    const lines: string[] = [];
    setStderrSinkForTesting((line) => lines.push(line));
    try {
      const { stores, fake } = await setup(new Map());
      fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 6 } });
      await vi.waitFor(() =>
        expect(
          lines.some(
            (line) => line.includes('トランスクリプトの退避') && line.includes(ARCHIVE_ID),
          ),
        ).toBe(true),
      );
      expect(fake.fetches).toHaveLength(1);
      expect(await archiveIdsOf(stores)).toEqual([]);
      expect(fake.deletes).toEqual([]);
    } finally {
      setStderrSinkForTesting(null);
    }
  });

  it('本文つきで届いた退避（古い runner）は、これまでどおり置き場へ入れ、取りに行かない', async () => {
    const { stores, fake } = await setup(new Map());
    fake.emit({ type: 'archive', managerId: job.id, body: '古い形の本文' });

    await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
    const [archiveId] = await archiveIdsOf(stores);
    expect(await stores.archive.read(archiveId!)).toEqual({ kind: 'body', body: '古い形の本文' });
    expect(fake.fetches).toEqual([]);
  });
});
