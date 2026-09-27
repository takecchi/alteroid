import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job, JobStatus } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **横断レビュー14回目（s2）。issue #1772（issue #1105 C の穴）を赤で確かめ、
 * 直った後は緑のままそれを固定する。**
 *
 * `manager.ts` の `renotifyStalledDenials()` は、かつて `record.job.status
 * !== 'running'`（＝`waiting_human`）なら**その委譲の全キーを丸ごと**見送って
 * いた。この関門は `record.job.status === 'waiting_human'` を「クローンには
 * 既に別の合図（`ask`）が届いている」の代理指標として使っていたが、その `ask`
 * がいま見ている拒否と同じものかは区別していなかった——同じ委譲の中に
 * **無関係な**未決の確認（別の道具・別の拒否とは無関係な通常の許可確認）が
 * 1件でもあれば、まったく別の、とっくに10分・30分を超えて止まっている拒否に
 * ついても知らせ直しが完全に止まっていた。
 *
 * **このファイルはそれを再現し、直った後の形を固定する。** 修正後は
 * `ManagerRecord.deniedLastRequestId`（拒否の `event.toolUseId`）と
 * `record.waiting[].requestId` を突き合わせ、この拒否自身への P1 の確認
 * （issue #1105「1回だけの許可」）が無ければ知らせ直す——**無関係な確認が
 * 片付くのを待たない。** これがこのファイルの主張であり、テストの名前も
 * それに合わせてある（Issue #1772 本文の注意——テストの名前に「恒久的に
 * 止める」と書くと不正確で、正しくは「無関係な確認が片付くまで止める」
 * ——このテストは、修正後は**それすら待たない**ことを固定する）。
 *
 * ## 足場（`manager-denial-renotify.test.ts` の `manualRunner` と同じ複製）
 *
 * `RunnerEvent` を直接組み立てて emit する。SDK 層を経由しないので、
 * `manager.ts` の帳面・`#emit`・`renotifyStalledDenials()` を単体で確かめる。
 */

interface AnsweredCall {
  requestId: string;
  message: string;
  decision?: 'allow' | 'deny';
}

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  answeredCalls: AnsweredCall[];
  report(managerId: string, text: string, status: JobStatus): void;
  ask(managerId: string, requestId: string, summary: string): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
  denied(managerId: string, tool: string, fields?: { actor?: string; inputHead?: string }): void;
  toolUse(managerId: string, actor: string, tool: string): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  // **`manager_send` が実際にどの `requestId` へ当てたかを控える**
  // （issue #1772・「許しすぎる」側の確認用。下の「無関係な確認へ当たる」テスト）。
  const answeredCalls: AnsweredCall[] = [];

  const runner: RunnerClient = {
    runnerId,
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume() {
      /* この検証では使わない */
    },
    async send() {
      return true;
    },
    async answer(_managerId, answer): Promise<RunnerAnswerOutcome> {
      answeredCalls.push({
        requestId: answer.requestId,
        message: answer.message,
        ...(answer.decision === undefined ? {} : { decision: answer.decision }),
      });
      return { delivered: true };
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
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    alive,
    answeredCalls,
    report(managerId, text, status) {
      emit?.({ type: 'report', managerId, text, status });
    },
    ask(managerId, requestId, summary) {
      emit?.({
        type: 'ask',
        managerId,
        requestId,
        kind: 'permission',
        summary,
        askedAt: new Date().toISOString(),
      });
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
    denied(managerId, tool, fields = {}) {
      emit?.({
        type: 'permission_denied',
        managerId,
        toolUseId: `${tool}:${String(Math.random())}`,
        tool,
        input: {},
        via: 'live',
        ...fields,
      });
    },
    toolUse(managerId, actor, tool) {
      emit?.({ type: 'tool_use', managerId, actor, tool });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
  advance: (ms: number) => void;
}

async function runningManualSetup(managerId = 'mgr-denial-renotify-cross'): Promise<ManualSetup> {
  const job: Job = {
    id: managerId,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    status: 'running',
    summary: '調べ物',
    request: '調べて',
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId: 'runner-primary',
  };
  const stores = createMemoryStores();
  await stores.jobs.putJob(job);

  const fake = manualRunner();
  fake.alive.push({
    managerId: job.id,
    status: 'running',
    cwd: '/work/project',
    request: '調べて',
    waiting: [],
    sessionId: job.sessionId,
  });

  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake, advance: (ms) => (clock += ms) };
}

async function waitForDenialJournaled(stores: Stores, tool: string): Promise<void> {
  await vi.waitFor(async () => {
    const entries = await stores.journal.list({ types: ['exchange'] });
    const matches = entries.filter((entry) =>
      JSON.stringify(entry).includes(`${tool} の実行が確認へ上がらずに止められた`),
    );
    if (matches.length < 1) {
      throw new Error(`${tool} の拒否がまだ日誌に載っていない`);
    }
  });
}

const TEN_MINUTES_MS = 10 * 60_000;

describe('renotifyStalledDenials のクロスtool starvation（横断レビュー14回目 s2・issue #1772）', () => {
  it(
    '無関係な道具の未決確認（waiting_human）が片付くのを待たずに、' +
      '10分以上前に拒否された別の道具の知らせ直しが届く',
    async () => {
      const { pool, stores, inbox, fake, advance } = await runningManualSetup();

      // Bash が拒否される。これが「動きが無い」を測りたい対象。
      fake.denied('mgr-denial-renotify-cross', 'Bash', {
        actor: 'manager:mgr-denial-renotify-cross',
      });
      await waitForDenialJournaled(stores, 'Bash');

      // Bash の拒否から10分が経った——通常ならここで1回目の知らせ直しが届く。
      advance(TEN_MINUTES_MS + 1);

      // ところが、Bash とは無関係などの確認がちょうどこのタイミングで
      // 未決になっている（例: 別の作業の普通の許可確認。Bash の拒否や
      // P1 の1回だけの許可とは無関係——`requestId` が Bash の拒否の
      // `toolUseId` と一致しない）。
      fake.ask('mgr-denial-renotify-cross', 'req-unrelated', '無関係などの許可確認');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const before = inbox.length;
      await pool.renotifyStalledDenials();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // **あるべき挙動**: Bash の拒否は Read の未決確認とは無関係なので、
      // 知らせ直しは無関係な確認が片付くのを待たずに届く。
      const delivered = inbox.slice(before).find((event) => event.type === 'manager_message');
      expect(
        delivered,
        'Bash の知らせ直しが届くべきだが、現行コードは無関係な未決確認の影響で止める',
      ).toBeDefined();

      await pool.stop();
    },
  );

  it(
    '（既知の残留リスク・issue #1772 の範囲外）無関係な確認が未決のまま知らせ直しが届いた後、' +
      'requestId 無しの decision はその無関係な確認へ当たる——`#choosePending` 自体は直していない',
    async () => {
      // **この歯は「直った」ことの確認ではない。** `renotifyStalledDenials()` の
      // 判定を委譲ごとから拒否ごとへ戻した結果、無関係な未決の確認が1件だけ
      // 在る状態のままクローンへ知らせ直しが届くようになった——それ自体は
      // このファイルの主張（上のテスト）どおり直っている。**それでも
      // `DENIAL_REPLY_ROUTE` は `requestId` を付けずに `decision` を送るなと
      // 注意するだけで、`#choosePending`（`manager_send` が宛先を選ぶ判定）
      // 自体はこの PR の範囲外（renotify 周りだけを触る指示）——クローンが
      // その注意に反して `decision` だけを付けて返すと、待ちがちょうど1件
      // （この無関係な確認）なので、そちらへ当たってしまう。** この歯は
      // その現状（直していないこと）を実測で固定し、PR 本文で報告する
      // ための対照である。
      const { pool, stores, fake, advance } = await runningManualSetup();

      fake.denied('mgr-denial-renotify-cross', 'Bash', {
        actor: 'manager:mgr-denial-renotify-cross',
      });
      await waitForDenialJournaled(stores, 'Bash');
      advance(TEN_MINUTES_MS + 1);

      // Bash の拒否とは無関係な確認が1件、未決のまま残っている。
      fake.ask('mgr-denial-renotify-cross', 'req-unrelated-2', '無関係などの許可確認');
      await new Promise((resolve) => setTimeout(resolve, 20));

      await pool.renotifyStalledDenials();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // クローンが `DENIAL_REPLY_ROUTE` の注意に反して、`requestId` を付けずに
      // `decision` だけを付けて答えたとする（例: 知らせ直しを Bash への確認だと
      // 誤解した）。
      const result = await pool.send('mgr-denial-renotify-cross', 'よし、許可します', {
        decision: 'allow',
      });

      // **実測: これは「答えた」ことになり、無関係な確認（`req-unrelated-2`）
      // へ当たる。** Bash の拒否自体は `requestId` を持たない（`#choosePending`
      // の doc）ので、当たり得るとしたら他に待っている確認しかない——それが
      // ここでは無関係な確認の1件だけである。
      expect(result.outcome).toBe('answered');
      expect(fake.answeredCalls).toHaveLength(1);
      expect(fake.answeredCalls[0]?.requestId).toBe('req-unrelated-2');
      expect(fake.answeredCalls[0]?.decision).toBe('allow');

      await pool.stop();
    },
  );
});
