import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * バグハント（wbug-jobs、担当A・JobStore）: Issue #1674。
 *
 * `ManagerPool.appraise()` は、`#records` に像を持たない委譲（孤児ジョブ。
 * `status:'lost'` 等）に対して `listJobs().find()` → 同期的な書き換え →
 * `putJob()` という read-modify-write を行っていた。`JobStore` に CAS が
 * 無かったため、`listJobs()` と `putJob()` の間に別の書き込みが挟まると、
 * `appraise()` は自分が読んだ古いスナップショットを丸ごと書き戻し、割り込んだ
 * 書き込みを黙って消していた（#1654 の `ScheduleStore.editRequest` と同じ形）。
 *
 * **直した後**: `appraise()` の孤児ジョブ分岐は `JobStore.updateJob()`
 * （現在値を排他区間の中で読み直し、`mutate` で書き換えて書く）を通す。
 * だから `updateJob()` を呼ぶ**前**に割り込んだ書き込みは、`updateJob()` の
 * 排他区間の中で読み直された現在値として `mutate` に渡り、消えない。
 *
 * ⚠️ **横取りの形を `listJobs` から `updateJob` へ変えた。** 直す前は
 * `listJobs()` を横取りして「読んだ**後**」に割り込んでいたが、直した後の
 * `appraise()` は `listJobs()` を呼ばない（`updateJob()` 1本になった）ので、
 * 同じ横取りではもう何も測れない。ここでは `updateJob()` を横取りし、
 * **実装へ委譲する直前**（＝ストア側の排他区間へ入る前）に割り込みの書き込みを
 * 差し込む——これは「呼び出し側が `updateJob()` を呼ぶと決めてから、実際に
 * ストアの排他区間へ入るまでの隙間に別の書き込みが起きた」ことの忠実な
 * 再現であり、直った実装なら排他区間の中で読み直すのでその割り込みを拾える。
 */

const START = '2026-09-01T00:00:00.000Z';

function neverAliveRunner(runnerId = 'runner-primary'): RunnerClient {
  return {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect() {},
    async start() {},
    async resume() {},
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {},
    // **生きているセッションが1つも無い。** `#restoreJobs` はこの状態で
    // `status === 'lost'` のジョブを `#records` へ載せない
    // （`job.sessionId === undefined) continue;` の次、
    // `if (job.status === 'lost') continue;` の分岐）。
    async list() {
      return [];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {},
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  /** 横取りしていない側から常に「素の」現在値を読む。 */
  rawListJobs: () => ReturnType<Stores['jobs']['listJobs']>;
}

async function setupOrphanJob(managerId: string): Promise<Setup> {
  const job: Job = {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'lost',
    summary: '調べ物',
    sessionId: 'sess-old',
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);
  const rawListJobs = stores.jobs.listJobs.bind(stores.jobs);

  const pool = createManagerPool({
    stores,
    post: () => {},
    runners: createRunnerRegistry([neverAliveRunner()]),
    now: () => Date.parse(START),
  });
  await pool.restore();

  return { pool, stores, rawListJobs };
}

describe('ManagerPool.appraise の読み書き競合（#records に像を持たない孤児ジョブ）', () => {
  it('前提: status:lost の委譲は #records に載らない（updateJob 経由でしか触れない）', async () => {
    const managerId = 'mgr-lost-precondition';
    const { pool } = await setupOrphanJob(managerId);
    const summary = (await pool.list()).find((m) => m.managerId === managerId);
    expect(summary?.status).toBe('lost');
  });

  it('✅ updateJob() を呼ぶ直前に割り込んだ別の書き込みは、appraise() の結果に残る', async () => {
    const managerId = 'mgr-lost-race';
    const { pool, stores, rawListJobs } = await setupOrphanJob(managerId);

    // `appraise()` が内部で呼ぶ `updateJob()` を横取りし、実装へ委譲する
    // **直前**（＝排他区間へ入る前）に別の書き込みを割り込ませる——fs なら
    // 別プロセスの書き込みが `withPathLock` の外側で先に終わっていた、pg なら
    // 別コネクションの書き込みが `select … for update` より前に commit して
    // いた、という状況に相当する。
    const realUpdateJob = stores.jobs.updateJob.bind(stores.jobs);
    let intercepted = false;
    stores.jobs.updateJob = async (id, mutate) => {
      if (!intercepted) {
        intercepted = true;
        const current = (await rawListJobs()).find((entry) => entry.id === id);
        if (current === undefined) {
          throw new Error('セットアップ不備: 台帳に居ない');
        }
        // 割り込みの書き込み: 例えば resume が成功して session が繋ぎ直った、
        // という別経路の更新を模す。
        await stores.jobs.putJob({
          ...current,
          status: 'running',
          sessionId: 'sess-new',
          updatedAt: '2026-09-01T00:05:00.000Z',
        });
      }
      return realUpdateJob(id, mutate);
    };

    const result = await pool.appraise(managerId, 'good', 'human', '確認済み');
    expect(result.outcome).toBe('appraised');

    const after = (await rawListJobs()).find((entry) => entry.id === managerId);
    // 評定は書けている。
    expect(after?.appraisal).toBe('good');
    // ✅ ここが本題: 割り込みで書いた `status: 'running'` / `sessionId:
    // 'sess-new'` が、`updateJob()` の排他区間の中で読み直された現在値として
    // 引き継がれ、消えずに残っている。
    expect(after?.status).toBe('running');
    expect(after?.sessionId).toBe('sess-new');
  });
});
