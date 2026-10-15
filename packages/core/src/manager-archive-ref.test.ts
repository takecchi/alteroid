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

  // 器の入れ替えの前後か（#4896）。参照を受けた時と取りに行った時の instanceId を比べた結果を、日誌の文に添える
  it('runner に本文が無かったとき、日誌の文に器の入れ替えかどうかの材料を添える', async () => {
    for (const [instanceId, expected] of [
      [undefined, '入れ替えの前後かは判定できない'],
      ['boot-1', '入れ替わっていない（instanceId=boot-1）'],
    ] as const) {
      const lines: string[] = [];
      setStderrSinkForTesting((line) => lines.push(line));
      try {
        const stores = createMemoryStores();
        await stores.jobs.putJob(job);
        const fake = fakeRunner(new Map());
        if (instanceId !== undefined) {
          Object.assign(fake.runner, {
            instanceId,
            identity: async () => ({ runnerId: 'runner-a', instanceId }),
          });
        }
        // 名簿は開けた瞬間に名乗りを聞く（`register`）。静的な配列で渡すと名乗りを採らない
        const registry = createRunnerRegistry();
        await registry.register({ label: 'http://runner-a:4518', open: async () => fake.runner });
        const local = createManagerPool({ stores, post: () => undefined, runners: registry });
        pool = local;
        await local.restore();
        fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 6 } });
        await vi.waitFor(() => expect(lines.join('')).toContain(ARCHIVE_ID));
        expect(lines.join('')).toContain(expected);
      } finally {
        setStderrSinkForTesting(null);
        await pool?.stop();
        pool = undefined;
      }
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

describe('送り直しの本文と参照の取り寄せが同じ id で競っても、二重に入れず、落とした扱いにしない（#4899）', () => {
  const BODY = '同じ退避の本文';

  // 取り寄せを手で止める: 送り直しの本文が届く時点を決めるため
  function gatedFetch(fake: Fake, outcome: () => string | undefined) {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.runner.fetchArchive = async (managerId, archiveId) => {
      fake.fetches.push(`${managerId}/${archiveId}`);
      await gate;
      return outcome();
    };
    return () => release?.();
  }

  // 終わりの印にする別の退避: 先に流した本文の処理が済んだことを、実時間の待ちなしで確かめるため
  async function settle(stores: Stores, fake: Fake): Promise<readonly string[]> {
    fake.emit({ type: 'archive', managerId: job.id, body: '終わりの印' });
    let ids: readonly string[] = [];
    await vi.waitFor(async () => {
      ids = await archiveIdsOf(stores);
      const last = ids.at(-1);
      expect(last).toBeDefined();
      expect(await stores.archive.read(last!)).toEqual({ kind: 'body', body: '終わりの印' });
    });
    return ids;
  }

  it('取り寄せ中に同じ id の本文が届き、取り寄せが成功したら、置き場へ入れるのは1回だけ', async () => {
    const lines: string[] = [];
    setStderrSinkForTesting((line) => lines.push(line));
    try {
      const { stores, fake } = await setup(new Map());
      const release = gatedFetch(fake, () => BODY);
      fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 6 } });
      await vi.waitFor(() => expect(fake.fetches).toHaveLength(1));
      fake.emit({ type: 'archive', managerId: job.id, id: ARCHIVE_ID, body: BODY });
      release();
      await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
      const ids = await settle(stores, fake);
      expect(ids).toHaveLength(2);
      expect(lines.join('')).not.toContain('トランスクリプトの退避');
    } finally {
      setStderrSinkForTesting(null);
    }
  });

  it('取り寄せ中に同じ id の本文が届き、取り寄せが「無い」で落ちたら、本文を1回だけ入れ、落とした日誌を出さない', async () => {
    const lines: string[] = [];
    setStderrSinkForTesting((line) => lines.push(line));
    try {
      const { stores, fake } = await setup(new Map());
      const release = gatedFetch(fake, () => undefined);
      fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 6 } });
      await vi.waitFor(() => expect(fake.fetches).toHaveLength(1));
      fake.emit({ type: 'archive', managerId: job.id, id: ARCHIVE_ID, body: BODY });
      release();
      await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
      const ids = await settle(stores, fake);
      expect(ids).toHaveLength(2);
      expect(await stores.archive.read(ids[0]!)).toEqual({ kind: 'body', body: BODY });
      expect(lines.join('')).not.toContain('トランスクリプトの退避');
      expect(fake.deletes).toEqual([]);
    } finally {
      setStderrSinkForTesting(null);
    }
  });

  it('参照で取り終えた後に同じ id の本文が届いても、置き場へ入れない', async () => {
    const { stores, fake } = await setup(new Map([[ARCHIVE_ID, BODY]]));
    fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 6 } });
    await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
    fake.emit({ type: 'archive', managerId: job.id, id: ARCHIVE_ID, body: BODY });
    const ids = await settle(stores, fake);
    expect(ids).toHaveLength(2);
  });

  it('参照の取り寄せが無い（runner が送り直して消した）まま本文が先に届いても、本文を入れ、id の無い本文は従来どおり入れる', async () => {
    const { stores, fake } = await setup(new Map());
    fake.emit({ type: 'archive', managerId: job.id, id: ARCHIVE_ID, body: BODY });
    await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
    expect(fake.fetches).toEqual([]);
  });
});

describe('預けた退避を取りに行く呼び出しが落ちても、やり直して本文を置き場へ入れる', () => {
  it('⭐ fetchArchive() が2回投げても、3回目で取れた本文を置き場へ入れ、runner に消させる', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = fakeRunner(new Map([[ARCHIVE_ID, '一時的に取れなかった生ログ']]));
    const fetchOnce = fake.runner.fetchArchive!.bind(fake.runner);
    let attempts = 0;
    fake.runner.fetchArchive = async (managerId, archiveId) => {
      attempts += 1;
      if (attempts <= 2) throw new Error(`fetch failed（${String(attempts)} 回目）`);
      return fetchOnce(managerId, archiveId);
    };
    pool = createManagerPool({
      stores,
      post: () => undefined,
      runners: createRunnerRegistry([fake.runner]),
      archiveFetchRetryDelaysMs: [10, 10],
    });
    await pool.restore();

    fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 13 } });

    await vi.waitFor(async () => expect(await archiveIdsOf(stores)).toHaveLength(1));
    const [archiveId] = await archiveIdsOf(stores);
    expect(await stores.archive.read(archiveId!)).toEqual({
      kind: 'body',
      body: '一時的に取れなかった生ログ',
    });
    expect(attempts).toBe(3);
    await vi.waitFor(() => expect(fake.deletes).toEqual([`${job.id}/${ARCHIVE_ID}`]));
  });

  it('やり直しの回数を使い切ったら、置き場へ入れず、消させもせず、跡を残す', async () => {
    const lines: string[] = [];
    setStderrSinkForTesting((line) => lines.push(line));
    try {
      const stores = createMemoryStores();
      await stores.jobs.putJob(job);
      const fake = fakeRunner(new Map([[ARCHIVE_ID, '取れない']]));
      let attempts = 0;
      fake.runner.fetchArchive = async () => {
        attempts += 1;
        throw new Error('fetch failed');
      };
      pool = createManagerPool({
        stores,
        post: () => undefined,
        runners: createRunnerRegistry([fake.runner]),
        archiveFetchRetryDelaysMs: [10],
      });
      await pool.restore();

      fake.emit({ type: 'archive', managerId: job.id, ref: { id: ARCHIVE_ID, chars: 4 } });

      await vi.waitFor(() =>
        expect(
          lines.some(
            (line) =>
              line.includes('トランスクリプトの退避') &&
              !line.includes('やり直す') &&
              line.includes(ARCHIVE_ID),
          ),
        ).toBe(true),
      );
      expect(attempts).toBe(2);
      expect(await archiveIdsOf(stores)).toEqual([]);
      expect(fake.deletes).toEqual([]);
    } finally {
      setStderrSinkForTesting(null);
    }
  });
});
