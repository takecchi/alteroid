import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import type { RunnerEvent } from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

// `Pool#handleEvent` の `case 'closed'` のうち、`#closeJob` の頭の同期の段（台帳へ写す `#applyClosedToJob`）と、
// その直後の pids 飽和の印（`#notePidsSaturationAtClose`）を、外から見える結果だけで縛る
// （台帳の行の全欄・待ちの取り下げの日誌・貸し出しの返却・pids の印の順・microtask の周回数）。
// 切り出し前は `Pool` の `#applyClosedToJob`・`#notePidsSaturationAtClose`、切り出し後は `manager-closed-apply.ts`。
// 期待の値は、切り出し前の作りの出力（`-u` で生成したインラインのスナップショット）を目で読んで確かめたもの
// （仕様を先に書いたものではない）。
// 実時間では待たない: 出来事を 1 件ずつ流し、そのたびにマイクロタスクを流しきる。時計は注入する。

const JOB_ID = 'mgr-closed-apply-pin';
const RUNNER_ID = 'runner-primary';
const T0 = '2026-11-01T00:00:00.000Z';
const T_NOW = '2026-11-01T01:00:00.000Z';

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

interface OpenOptions {
  job?: Partial<Job>;
  /** 台帳へ書く直前（`#persist` の途中）に呼ばれる。像がまだ `#records` に居る窓を覗くために使う。 */
  beforePut?: (row: Job) => Promise<void>;
}

async function open(options: OpenOptions = {}) {
  let emit = null as ((event: RunnerEvent) => void) | null;
  const runner = fakeRunnerClient({
    runnerId: RUNNER_ID,
    async connect(onEvent) {
      emit = onEvent;
    },
    async list() {
      return [];
    },
    async setProfile() {
      return { ok: true as const };
    },
  });
  const signs: string[] = [];
  const registry = fakeRunnerRegistry({
    list: () => Promise.resolve([runner]),
    get: (runnerId) => Promise.resolve(runnerId === RUNNER_ID ? runner : null),
    notePidsSaturationSign(runnerId, sign) {
      signs.push(`${runnerId}:${sign}`);
    },
  });
  const stores = createMemoryStores();
  await stores.jobs.putJob({
    id: JOB_ID,
    createdAt: T0,
    updatedAt: T0,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: RUNNER_ID,
    ...options.job,
  });
  // 台帳へ書いた回数と、書く時点の status を控える
  const puts: string[] = [];
  const jobs = stores.jobs;
  const putJob = jobs.putJob.bind(jobs);
  jobs.putJob = async (row) => {
    puts.push(row.status);
    await options.beforePut?.(row);
    return putJob(row);
  };
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    now: () => Date.parse(T_NOW),
    post: (event) => inbox.push(event),
    runners: registry,
  });
  await pool.restore();
  await settle();
  // 像を畳む前に残る目印（拒否 1 件）を載せる。畳まれたかは `denials()` が空になるかで見る。
  emit?.({
    type: 'permission_denied',
    managerId: JOB_ID,
    toolUseId: 'tu-1',
    tool: 'Bash',
    via: 'result',
  });
  await settle();
  expect(pool.denials(JOB_ID)).toHaveLength(1);
  puts.length = 0;
  const escalationBefore = (await stores.journal.list({ types: ['escalation'] })).length;
  return {
    pool,
    stores,
    signs,
    puts,
    async ask(requestId: string, summary: string): Promise<void> {
      emit?.({
        type: 'ask',
        managerId: JOB_ID,
        requestId,
        kind: 'question',
        summary,
        askedAt: T0,
      });
      await settle();
    },
    async push(event: RunnerEvent): Promise<void> {
      emit?.(event);
      await settle();
    },
    /** 出来事を流した直後から、台帳への書き込み・pids の印・像の畳みが初めて成り立つまでの microtask の周回数。 */
    async hops(event: RunnerEvent): Promise<{ put: number; sign: number; retired: number }> {
      const seen = { put: -1, sign: -1, retired: -1 };
      emit?.(event);
      for (let i = 1; i <= 200; i += 1) {
        await Promise.resolve();
        if (seen.put < 0 && puts.length > 0) seen.put = i;
        if (seen.sign < 0 && signs.length > 0) seen.sign = i;
        if (seen.retired < 0 && pool.denials(JOB_ID).length === 0) seen.retired = i;
      }
      return seen;
    },
    retired(): boolean {
      return pool.denials(JOB_ID).length === 0;
    },
    async job(): Promise<Job | null> {
      return stores.jobs.getJob(JOB_ID);
    },
    /** `closed` を受けて取り下げられた確認（escalation の行。`id`・`at` は毎回変わるので落とす）。 */
    async withdrawals(): Promise<unknown[]> {
      const entries = await stores.journal.list({ types: ['escalation'] });
      return entries
        .reverse()
        .slice(escalationBefore)
        .filter((entry) => 'withdrawnAt' in entry)
        .map((entry) =>
          Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'at')),
        );
    },
  };
}

function closed(
  status: 'done' | 'failed' | 'lost',
  extra: Partial<Extract<RunnerEvent, { type: 'closed' }>> = {},
): Extract<RunnerEvent, { type: 'closed' }> {
  return { type: 'closed', managerId: JOB_ID, status, reason: `${status} で畳んだ`, ...extra };
}

/** 前の回が残した欄を全部持つ台帳の行（`closed` が下ろすもの・残すもの・返すものを区別して縛るため）。 */
const STALE_JOB: Partial<Job> = {
  lease: {
    runnerId: RUNNER_ID,
    instanceId: 'boot-1',
    fence: 4,
    grantedAt: '2026-10-31T00:00:00.000Z',
    seenAt: '2026-10-31T00:30:00.000Z',
    ttlMs: 600_000,
  },
  lastSystemError: { code: 'ENOMEM', at: '2026-10-31T00:00:00.000Z' },
  lastCgroupEvents: { oomKillDelta: 2, at: '2026-10-31T00:00:00.000Z' },
  awaitingBackgroundSince: '2026-10-31T00:00:00.000Z',
  lastFailure: { code: 'turn_failed', via: 'result', at: '2026-10-31T00:00:00.000Z' },
  lastReport: '前の報告',
};

const EAGAIN = { code: 'EAGAIN', errno: -11, syscall: 'spawn claude' };
const CGROUP = { pidsMaxDelta: 14, oomKillDelta: 0 };
const UNPUSHED = {
  kind: 'ok' as const,
  result: { cwd: '/work/project', worktrees: [{ relativePath: '.', branch: 'feat/closed-apply' }] },
};

describe('closed を受けて台帳の行へ写す（#applyClosedToJob）', () => {
  it('done: status を写し、背景待ちを下ろし、待ちを取り下げ、貸し出しを返し（fence を残す）、前の回の失敗の事実を下ろす。failed 専用の欄は書かない', async () => {
    const s = await open({ job: STALE_JOB });
    await s.ask('req-1', 'どちらにしますか');
    await s.ask('req-2', 'もう1つ');

    await s.push(
      closed('done', { systemError: EAGAIN, cgroupEvents: CGROUP, unpushedWork: UNPUSHED }),
    );

    expect(await s.job()).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-11-01T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-closed-apply-pin",
        "lastFailure": {
          "at": "2026-10-31T00:00:00.000Z",
          "code": "turn_failed",
          "via": "result",
        },
        "lastReport": "前の報告",
        "lastUnpushedWorkObservation": {
          "at": "2026-11-01T01:00:00.000Z",
          "cwd": "/work/project",
          "kind": "observed",
          "source": "closed",
          "worktrees": [
            {
              "branch": "feat/closed-apply",
              "relativePath": ".",
            },
          ],
        },
        "lease": {
          "fence": 5,
          "grantedAt": "2026-11-01T01:00:00.000Z",
          "releasedAt": "2026-11-01T01:00:00.000Z",
          "runnerId": "runner-primary",
          "seenAt": "2026-11-01T01:00:00.000Z",
          "ttlMs": 600000,
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "runnerSessionSince": "2026-11-01T01:00:00.000Z",
        "sessionId": "sess-1",
        "silentDoneNotifiedFor": "2026-11-01T01:00:00.000Z",
        "status": "done",
        "summary": "調べ物",
        "turnStartedAt": "2026-11-01T01:00:00.000Z",
        "updatedAt": "2026-11-01T01:00:00.000Z",
      }
    `);
    expect(await s.withdrawals()).toMatchInlineSnapshot(`
      [
        {
          "approvalId": "req-1",
          "managerId": "mgr-closed-apply-pin",
          "question": "どちらにしますか",
          "type": "escalation",
          "withdrawnAt": "2026-11-01T01:00:00.000Z",
          "withdrawnReason": "この確認への答えは届かない（セッションが閉じた（status=done））",
        },
        {
          "approvalId": "req-2",
          "managerId": "mgr-closed-apply-pin",
          "question": "もう1つ",
          "type": "escalation",
          "withdrawnAt": "2026-11-01T01:00:00.000Z",
          "withdrawnReason": "この確認への答えは届かない（セッションが閉じた（status=done））",
        },
      ]
    `);
    expect(s.signs).toEqual([]);
    expect(s.retired()).toBe(true);
    await s.pool.stop();
  });

  it('failed（systemError と cgroupEvents あり）: 前の回の値を下ろしてから今回の値を at 付きで書く。未 push の観測は status で絞らず書く', async () => {
    const s = await open({ job: STALE_JOB });

    await s.push(
      closed('failed', { systemError: EAGAIN, cgroupEvents: CGROUP, unpushedWork: UNPUSHED }),
    );

    expect(await s.job()).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-11-01T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-closed-apply-pin",
        "lastCgroupEvents": {
          "at": "2026-11-01T01:00:00.000Z",
          "oomKillDelta": 0,
          "pidsMaxDelta": 14,
        },
        "lastFailure": {
          "at": "2026-10-31T00:00:00.000Z",
          "code": "turn_failed",
          "via": "result",
        },
        "lastReport": "前の報告",
        "lastSystemError": {
          "at": "2026-11-01T01:00:00.000Z",
          "code": "EAGAIN",
          "errno": -11,
          "syscall": "spawn claude",
        },
        "lastUnpushedWorkObservation": {
          "at": "2026-11-01T01:00:00.000Z",
          "cwd": "/work/project",
          "kind": "observed",
          "source": "closed",
          "worktrees": [
            {
              "branch": "feat/closed-apply",
              "relativePath": ".",
            },
          ],
        },
        "lease": {
          "fence": 5,
          "grantedAt": "2026-11-01T01:00:00.000Z",
          "releasedAt": "2026-11-01T01:00:00.000Z",
          "runnerId": "runner-primary",
          "seenAt": "2026-11-01T01:00:00.000Z",
          "ttlMs": 600000,
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "runnerSessionSince": "2026-11-01T01:00:00.000Z",
        "sessionId": "sess-1",
        "status": "failed",
        "summary": "調べ物",
        "turnStartedAt": "2026-11-01T01:00:00.000Z",
        "updatedAt": "2026-11-01T01:00:00.000Z",
      }
    `);
    expect(s.retired()).toBe(true);
    await s.pool.stop();
  });

  it('failed（欄なし）: 前の回の lastSystemError・lastCgroupEvents は欄ごと消え、今回は作らない。lastFailure・lastReport は触らない', async () => {
    const s = await open({ job: STALE_JOB });

    await s.push(closed('failed'));

    const job = await s.job();
    expect(Object.hasOwn(job as object, 'lastSystemError')).toBe(false);
    expect(Object.hasOwn(job as object, 'lastCgroupEvents')).toBe(false);
    expect(Object.hasOwn(job as object, 'lastUnpushedWorkObservation')).toBe(false);
    expect(job).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-11-01T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-closed-apply-pin",
        "lastFailure": {
          "at": "2026-10-31T00:00:00.000Z",
          "code": "turn_failed",
          "via": "result",
        },
        "lastReport": "前の報告",
        "lease": {
          "fence": 5,
          "grantedAt": "2026-11-01T01:00:00.000Z",
          "releasedAt": "2026-11-01T01:00:00.000Z",
          "runnerId": "runner-primary",
          "seenAt": "2026-11-01T01:00:00.000Z",
          "ttlMs": 600000,
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "runnerSessionSince": "2026-11-01T01:00:00.000Z",
        "sessionId": "sess-1",
        "status": "failed",
        "summary": "調べ物",
        "turnStartedAt": "2026-11-01T01:00:00.000Z",
        "updatedAt": "2026-11-01T01:00:00.000Z",
      }
    `);
    await s.pool.stop();
  });

  it('lost: status だけ写し、systemError・cgroupEvents は台帳へ書かない（failed の回だけ）。印は立てる', async () => {
    const s = await open({ job: STALE_JOB });

    await s.push(closed('lost', { systemError: EAGAIN, cgroupEvents: CGROUP }));

    expect(await s.job()).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-11-01T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-closed-apply-pin",
        "lastFailure": {
          "at": "2026-10-31T00:00:00.000Z",
          "code": "turn_failed",
          "via": "result",
        },
        "lastReport": "前の報告",
        "lease": {
          "fence": 5,
          "grantedAt": "2026-11-01T01:00:00.000Z",
          "releasedAt": "2026-11-01T01:00:00.000Z",
          "runnerId": "runner-primary",
          "seenAt": "2026-11-01T01:00:00.000Z",
          "ttlMs": 600000,
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "runnerSessionSince": "2026-11-01T01:00:00.000Z",
        "sessionId": "sess-1",
        "status": "lost",
        "summary": "調べ物",
        "turnStartedAt": "2026-11-01T01:00:00.000Z",
        "updatedAt": "2026-11-01T01:00:00.000Z",
      }
    `);
    expect(s.signs).toEqual([`${RUNNER_ID}:eagain`, `${RUNNER_ID}:fork-denied`]);
    await s.pool.stop();
  });

  it('前の回の欄が何も無い done: 台帳の行は status と貸し出しの返却だけが変わる。待ちが無ければ取り下げの日誌も書かない', async () => {
    const s = await open();

    await s.push(closed('done'));

    expect(await s.job()).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-11-01T00:00:00.000Z",
        "cwd": "/work/project",
        "id": "mgr-closed-apply-pin",
        "lease": {
          "fence": 1,
          "grantedAt": "2026-11-01T01:00:00.000Z",
          "releasedAt": "2026-11-01T01:00:00.000Z",
          "runnerId": "runner-primary",
          "seenAt": "2026-11-01T01:00:00.000Z",
          "ttlMs": 600000,
        },
        "request": "調べて",
        "runnerId": "runner-primary",
        "runnerSessionSince": "2026-11-01T01:00:00.000Z",
        "sessionId": "sess-1",
        "silentDoneNotifiedFor": "2026-11-01T01:00:00.000Z",
        "status": "done",
        "summary": "調べ物",
        "turnStartedAt": "2026-11-01T01:00:00.000Z",
        "updatedAt": "2026-11-01T01:00:00.000Z",
      }
    `);
    expect(await s.withdrawals()).toEqual([]);
    await s.pool.stop();
  });

  it('未 push の観測の上書きガード: 既に新しい観測が在れば、古い時刻で届いた closed の観測では上書きしない（時計は T_NOW に固定）', async () => {
    const newer = {
      kind: 'observed' as const,
      at: '2026-11-01T02:00:00.000Z',
      cwd: '/work/project',
      worktrees: [{ relativePath: '.', branch: 'feat/newer' }],
    };
    const s = await open({ job: { lastUnpushedWorkObservation: newer } });

    await s.push(closed('failed', { unpushedWork: UNPUSHED }));

    expect((await s.job())?.lastUnpushedWorkObservation).toEqual(newer);
    await s.pool.stop();
  });

  it('record.attached を偽にする: 台帳へ書く窓（persist の途中）で、done の前任はもう生きていないと読まれ、後継を断らない', async () => {
    // `#assertSupersedable` は `status === 'done' && record.attached` を「セッションが生きている」と読んで断る。
    let probe: Promise<string> | undefined;
    const s = await open({
      beforePut: async (row) => {
        if (row.status !== 'done' || probe !== undefined) return;
        probe = s2
          .start({ request: '続き', cwd: '/work/project', supersedes: JOB_ID })
          .then(() => 'accepted')
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        await settle();
      },
    });
    const s2 = s.pool;

    await s.push(closed('done'));

    expect(await probe).not.toContain('セッションが生きている');
    await s.pool.stop();
  });
});

describe('pids 飽和の印（#notePidsSaturationAtClose）', () => {
  it('EAGAIN と fork 拒否が両方在るとき、eagain → fork-denied の順で、器の名簿へ知らせる', async () => {
    const s = await open();

    await s.push(closed('failed', { systemError: EAGAIN, cgroupEvents: CGROUP }));

    expect(s.signs).toEqual([`${RUNNER_ID}:eagain`, `${RUNNER_ID}:fork-denied`]);
    await s.pool.stop();
  });

  it.each([
    ['done', { systemError: EAGAIN, cgroupEvents: CGROUP }],
    [
      'failed',
      { systemError: { code: 'ENOENT' }, cgroupEvents: { pidsMaxDelta: 0, oomKillDelta: 1 } },
    ],
    ['failed', {}],
  ] as const)('%s で印の材料が無い・足りない回は知らせない（%j）', async (status, extra) => {
    const s = await open();

    await s.push(closed(status, extra));

    expect(s.signs).toEqual([]);
    await s.pool.stop();
  });
});

describe('microtask の周回数（`#closeJob` の頭の同期の段を数える歯）', () => {
  // 協力者へ移したあと、`async` で包み直す・口を `async` の皮で包む・`await` を足すと、ここの数が増える。
  // 数は切り出し前の作りで測った値。実時間は使わない。
  it('done: 台帳への書き込み・像の畳みまでの周回数', async () => {
    const s = await open();
    expect(await s.hops(closed('done'))).toMatchInlineSnapshot(`
      {
        "put": 1,
        "retired": 15,
        "sign": -1,
      }
    `);
    await s.pool.stop();
  });

  it('failed（EAGAIN と fork 拒否）: 書き込み・pids の印・像の畳みまでの周回数', async () => {
    const s = await open();
    expect(await s.hops(closed('failed', { systemError: EAGAIN, cgroupEvents: CGROUP })))
      .toMatchInlineSnapshot(`
      {
        "put": 1,
        "retired": 9,
        "sign": 6,
      }
    `);
    await s.pool.stop();
  });
});
