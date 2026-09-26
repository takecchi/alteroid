import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * バグハント（wbug-jobs 続き）: 「範囲外」で上げた `abort()` / `send()` の
 * 孤児ジョブ分岐（`#load()` を経由するもの）の再現。**この歯は直していない
 * ——起票してから直す指示を待つ。**
 *
 * ## 何を確かめたか
 *
 * `abort()` / `send()` はどちらも同じ形で始まる:
 *
 * ```
 * const record = this.#records.get(managerId) ?? (await this.#load(managerId));
 * ```
 * （`grep -Fn -- 'const record = this.#records.get(managerId) ?? (await this.#load(managerId));' packages/core/src/manager.ts`）
 *
 * `#load()` は逐語で次のとおりで、**呼ぶたびに独立した新しいコピーを作り、
 * `#records` へ無条件に上書きで登録する**（既存のレコードがあるかどうかを
 * 見ない）:
 *
 * ```
 * async #load(managerId: string): Promise<ManagerRecord | null> {
 *   const job = (await this.#stores.jobs.listJobs()).find((entry) => entry.id === managerId);
 *   if (!job) return null;
 *   const record: ManagerRecord = { job: { ...job }, waiting: [], attached: false };
 *   this.#records.set(managerId, record);
 *   return record;
 * }
 * ```
 * （`packages/core/src/manager.ts` の `#load`）
 *
 * ⟹ 「同じ像を返すのか、別のコピーを返すのか」——**別のコピーを返す。**
 * だから、`#records` に像を持たない同じ孤児ジョブに対して2つの独立した
 * 非同期処理（例: `send()` と `abort()`）が同時に `#load()` を呼ぶと、
 * それぞれが**別々の Job のコピー**を掴んだまま自分の分岐を進め、それぞれが
 * 独立に `#persist()`（＝ `putJob()`、ジョブ丸ごとの上書き）を呼ぶ。
 * 後から `putJob()` した側が、先に書かれた変更ごと丸ごと上書きする——
 * `JobStore` に CAS が無い状態で「読んでから書く」が2箇所から独立に走る、
 * #1674（`ManagerPool.appraise()`）と同じ形の穴である。
 *
 * ## 実際に何が起きるか（この歯が確かめること）
 *
 * `send()` は `#claimForResume()` の中で一度 `putJob()` を呼び（貸し出しの
 * 付与を「書けたことを条件にする」ため）、resume が成功した後にもう一度
 * `job.status = 'running'` を書いて `putJob()` を呼ぶ。`abort()` は
 * `runner.stop()` を確かめた後に `job.status = 'stopped'` を書いて
 * `putJob()` を呼び、その後 `#retire()` で `#records` から自分を消す。
 *
 * 2つを同時に投げると、**`abort()` は「止めた（`outcome: 'stopped'`、
 * `sessionGone: true`）」と答えるのに、最終的に台帳へ残る `status` は
 * `send()` が最後に書いた `'running'` になる**——**記録（`abort()` の返り値）
 * と実際（台帳の中身）が食い違う。** しかも `abort()` が `#retire()` を
 * 呼んでいるので、この管理者はもう `#records`（プロセス内の像）に居ない
 * ——`status: 'running'`（＝走っているはず）を名乗る行が、誰にも
 * 自動では拾われない状態で台帳に取り残される。
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
    // **生きているセッションが1つも無い。** `restore()` はこの状態で
    // `status === 'lost'` のジョブを `#records` へ載せない
    // （`#restoreJobs` の `if (job.status === 'lost') continue;`）ので、
    // このジョブは「孤児」（`#records` に像を持たない）のまま残る。
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

describe('abort() / send() の孤児ジョブ分岐（#load() の二重読み込み。未修正・再現のみ）', () => {
  it('前提: status:lost の委譲は #records に載らない', async () => {
    const managerId = 'mgr-orphan-precondition';
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
    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([neverAliveRunner()]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    const summary = (await pool.list()).find((m) => m.managerId === managerId);
    expect(summary?.status).toBe('lost');
  });

  it('⛔ send() と abort() を同時に投げると、abort() は「止めた」と言うのに台帳は running のまま残る', async () => {
    const managerId = 'mgr-orphan-race';
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

    const pool = createManagerPool({
      stores,
      post: () => {},
      runners: createRunnerRegistry([neverAliveRunner()]),
      now: () => Date.parse(START),
    });
    await pool.restore();

    // **本物の重なりを作る。** どちらも `this.#records.get(managerId) ??
    // (await this.#load(managerId))` で始まり、`#load()` の中の
    // `listJobs()` まで同期的に進む——`Promise.all` で同時に起こせば、
    // 両方の `#load()` が「まだ `#records` に居ない」を見た状態で
    // それぞれ独立に台帳を読みに行く（横取りは要らない。実際に
    // `listJobs()` を2回横取りして両方とも重なって呼ばれることを
    // 別途確認済み）。
    const [sendResult, abortResult] = await Promise.all([
      pool.send(managerId, 'hello'),
      pool.abort(managerId),
    ]);

    // 両方とも「うまくいった」と答える。
    expect(sendResult.outcome).toBe('delivered');
    expect(abortResult.outcome).toBe('stopped');
    expect(abortResult.sessionGone).toBe(true);

    // ⛔ **ここが本題（赤）。** `abort()` が「止めた」（`outcome: 'stopped'`、
    // `sessionGone: true` ＝ runner にセッションが無いことまで確かめた）と
    // 答えた以上、台帳に最終的に残る `status` も `'stopped'` であるべき
    // ——記録（返り値）と実際（台帳の中身）が食い違ってはいけない、という
    // 期待である。
    //
    // **いまは red。** 実際には `send()` が後から書いた `'running'` が
    // 残り、`abort()` 自身が書いた `'stopped'` は `send()` の `putJob()` に
    // 丸ごと踏み消される（`abort()` と `send()` はそれぞれ独立に
    // `#load()` した別々の `Job` のコピーを持ち、後から `putJob()` した側が
    // 先に書かれた変更ごと上書きするため）。生の失敗はこのファイルの
    // コミット時点の CI ログ、または `npx vitest run
    // src/manager-orphan-load-race.test.ts` を参照。
    const finalJob = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
    expect(finalJob?.status).toBe('stopped');
  });
});
