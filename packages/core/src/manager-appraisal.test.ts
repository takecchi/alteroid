import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import { JOB_APPRAISAL_DECISION_PREFIX, type InboxEvent, type Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * 委譲の評定（#1054。自己改善の段1の後半）。
 *
 * ## ⭐ この歯がいちばん守りたいもの
 *
 * **走行中の委譲へ書いた評定が、プールの次の `#persist` で踏み消されないこと。**
 *
 * 走行中の `Job` は `ManagerPool` がプロセス内の像（`#records`）として握って
 * いて、`#persist` は `record.job` を丸ごと書く。⟹ ストアの側から評定だけ足すと、
 * **次の `#persist` が黙って消す** —— 書けたように見えて消える、という「静かに
 * 失敗する道具」そのものである。
 *
 * **⚠️ この性質は「評定を書いて、すぐ読む」形では絶対に出ない。** 書いたあとに
 * **プールが台帳へ書く契機をもう一度起こす**必要がある（ここでは `report` を
 * 起こして `#persist` を通す）。AGENTS.md の「2回通しても壊れない」を測るテストは、
 * 1周目と2周目のあいだに「2周目でだけ壊れる状態」を挟むこと、と同じ形である。
 */

/**
 * **`listJobs()` が写しを返す `JobStore`**（fs / pg と同じ振る舞い）。
 *
 * ## ⚠️ なぜこれが要るのか —— インメモリの器は、この歯が測りたい穴を隠す
 *
 * `createMemoryStores()` の `JobStore` は **`putJob` が受け取った参照をそのまま
 * `Map` に入れ、`listJobs()` がその参照を返す**（実測: `read === job` が `true`）。
 * ⟹ 「台帳から読んで書き換える」形のコードが、**プールの像をも同時に書き換えて
 * しまう** —— 踏み消しのバグが在っても、インメモリの上では起きない。
 *
 * **fs / pg は JSON を経由するので必ず写しになる。** ⟹ 本番でだけ壊れる。
 *
 * **実測（変異試験、2026-09-16）:** この写しを噛ませる前は、`ManagerPool.appraise`
 * を「像を見ずに台帳から読む」形（＝踏み消される形）へ変異させても、この歯は
 * **6件とも緑のまま**だった。噛ませた後は⭐の1件が赤くなる。
 *
 * ⟹ **インメモリの器をそのまま使う歯は、「台帳の写しと像が別物である」ことに
 * 依存する性質を測れない。** 同じ形の歯を書く人はここを読むこと。
 */
function copyingJobStore(inner: Stores['jobs']): Stores['jobs'] {
  return {
    ...inner,
    async listJobs() {
      return (await inner.listJobs()).map((job) => structuredClone(job));
    },
    async putJob(job) {
      await inner.putJob(structuredClone(job));
    },
  };
}

const START = '2026-09-01T00:00:00.000Z';

interface Fake {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(managerId: string, text: string, status: 'running' | 'done'): void;
}

function fakeRunner(runnerId = 'runner-primary'): Fake {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start() {},
    async resume() {},
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
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
  return {
    runner,
    alive,
    report(managerId, text, status) {
      emit?.({ type: 'report', managerId, text, status });
    },
  };
}

interface Setup {
  pool: ManagerPool;
  stores: Stores;
  fake: Fake;
}

async function setup(managerId = 'mgr-appraise'): Promise<Setup> {
  const job: Job = {
    id: managerId,
    createdAt: START,
    updatedAt: START,
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const base = createMemoryStores();
  // **写しを返す器で回す**（`copyingJobStore` の doc）。素のインメモリだと、
  // この歯が測りたい踏み消しが起きない。
  const stores: Stores = { ...base, jobs: copyingJobStore(base.jobs) };
  await stores.jobs.putJob(job);

  const fake = fakeRunner();
  fake.alive.push({
    managerId,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([fake.runner]),
    now: () => Date.parse(START),
  });
  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });
  return { pool, stores, fake };
}

const jobOf = async (stores: Stores, id: string): Promise<Job | undefined> =>
  (await stores.jobs.listJobs()).find((entry) => entry.id === id);

describe('委譲の評定（ManagerPool.appraise）', () => {
  it('⭐ 走行中に付けた評定は、その後プールが台帳へ書いても消えない', async () => {
    const { pool, stores, fake } = await setup();

    const result = await pool.appraise('mgr-appraise', 'unclear', 'clone', 'まだ材料が無い');
    expect(result.outcome).toBe('appraised');
    expect(await jobOf(stores, 'mgr-appraise')).toMatchObject({ appraisal: 'unclear' });

    // **ここが本題。** プールに台帳を書かせる契機をもう一度起こす。像の側に
    // 評定が乗っていなければ、この書き込みが評定を踏み消す。
    fake.report('mgr-appraise', '途中経過', 'running');
    await vi.waitFor(async () => {
      const after = await jobOf(stores, 'mgr-appraise');
      if (after?.lastReport !== '途中経過') throw new Error('報告がまだ台帳に載っていない');
    });

    const after = await jobOf(stores, 'mgr-appraise');
    expect(after?.appraisal).toBe('unclear');
    expect(after?.appraisalReason).toBe('まだ材料が無い');
  });

  it('終端した委譲（プールが像を手放したもの）にも付く', async () => {
    const { pool, stores, fake } = await setup();

    fake.report('mgr-appraise', '終わった', 'done');
    await vi.waitFor(async () => {
      const done = await jobOf(stores, 'mgr-appraise');
      if (done?.status !== 'done') throw new Error('まだ終端していない');
    });

    const result = await pool.appraise('mgr-appraise', 'good', 'clone', '一発で通った');
    expect(result.outcome).toBe('appraised');
    expect(await jobOf(stores, 'mgr-appraise')).toMatchObject({
      appraisal: 'good',
      appraisedBy: 'clone',
      appraisalReason: '一発で通った',
      // **評定は終わり方を書き換えない**（別の軸である）。
      status: 'done',
    });
  });

  it('理由を渡さない覆しは、前の理由を消す', async () => {
    const { pool, stores } = await setup();
    await pool.appraise('mgr-appraise', 'good', 'clone', '通った');

    const result = await pool.appraise('mgr-appraise', 'bad', 'human');
    expect(result.outcome).toBe('appraised');
    // **覆す前の字面が返る＝較正の材料。**
    expect(result.previous).toContain('うまくいった');
    expect(result.previous).toContain('通った');

    const after = await jobOf(stores, 'mgr-appraise');
    expect(after?.appraisal).toBe('bad');
    expect(after?.appraisedBy).toBe('human');
    // 残すと「うまくいかなかった」の理由が「通った」になる。
    expect(after?.appraisalReason).toBeUndefined();
  });

  it('覆した事実は日誌に残る（前の値が本文に入る）', async () => {
    const { pool, stores } = await setup();
    await pool.appraise('mgr-appraise', 'good', 'clone', '通った');
    await pool.appraise('mgr-appraise', 'bad', 'human', '差し戻し');

    const decisions = (await stores.journal.list({ types: ['decision'] })).filter((entry) =>
      entry.type === 'decision' ? entry.decision.startsWith(JOB_APPRAISAL_DECISION_PREFIX) : false,
    );
    expect(decisions).toHaveLength(2);
    // **並び順に依存しない**（日誌の list が新しい順か古い順かは、この歯の主題ではない）。
    const texts = decisions.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
    const overturn = texts.find((text) => text.includes('bad'));
    expect(overturn).toBeDefined();
    // **前の値が入っていること。** 行は「いまの値」しか持たないので、ここに落ちて
    // いなければ「クローンは good と言っていた」がどこにも残らない。
    expect(overturn).toContain('うまくいった');
    expect(overturn).toContain('通った');
  });

  it('台帳に居ない id は absent（「書けた」と嘘をつかない）', async () => {
    const { pool } = await setup();
    const result = await pool.appraise('mgr-missing', 'good', 'human');
    expect(result.outcome).toBe('absent');
    expect(result.previous).toBeNull();
  });

  it('ManagerSummary にも載る（載らないと評定が書き込み専用になる）', async () => {
    const { pool } = await setup();
    await pool.appraise('mgr-appraise', 'bad', 'human', '手戻りが多い');
    const summary = (await pool.list()).find((m) => m.managerId === 'mgr-appraise');
    expect(summary).toMatchObject({ appraisal: 'bad', appraisedBy: 'human' });
  });
});
