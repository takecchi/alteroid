import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job, JournalEntry } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import type { UsageTotals } from './usage.js';

/**
 * **Issue #977 — `manager.ts` の `case 'usage'` → `turn_usage` 日誌の経路に
 * 歯が無い。ここで固定するのはいまの挙動である。**
 *
 * `manager.ts:7203` の `if (Object.keys(fold.delta).length > 0)` は、増分が
 * 空の回に `turn_usage` の行そのものを書かない。**そのとき `event.contextUsage`
 * が付いていても、載せる行が無いので一緒に落ちる**——#976 の「論点」節が
 * 指す3つ目の関門である。
 *
 * ## 別ファイルにしてある理由
 *
 * `manager-usage-token.test.ts` の doc と同じ理由——`manager.test.ts` にも
 * 消費まわりの `describe` が在るが、同じ `SetupOptions` を他の PR も広げて
 * いるので、ここでは縮小版の偽 runner（`manager-usage-token.test.ts` の
 * `usageRunner()` と同型。あちらは `contextUsage` を送らないので、送れる形へ
 * 広げたものを自分で持つ）を複製する。
 */

const RUNNING_JOB: Job = {
  id: 'mgr-ctx',
  managerId: 'mgr-ctx',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-ctx',
  runnerId: 'runner-primary',
};

function totals(over: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    ...over,
  };
}

const SAMPLE_CONTEXT_USAGE = {
  durationMs: 5,
  totalTokens: 12_000,
  rawMaxTokens: 200_000,
  percentage: 6,
};

/** `manager-usage-token.test.ts` の `usageRunner()` に `contextUsage` を送る口を足した形。 */
function usageRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume(command) {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      /* この検証では使わない */
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
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
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    /**
     * 累積スナップショットを1つ降ろす。**境界（`runnerEventSchema.safeParse`）
     * を実際に通す**（`manager-closed-failed-journal.test.ts` と同じ作法——
     * スキーマに無い欄はここで黙って落ちるので、emit した中身だけを見ていると
     * 境界で消えたことに気づけない）。
     */
    usage(models: Record<string, UsageTotals>, contextUsage?: unknown): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      const raw = {
        type: 'usage',
        managerId: 'mgr-ctx',
        sessionId: 'sess-ctx',
        models,
        ...(contextUsage === undefined ? {} : { contextUsage }),
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit(parsed.data);
    },
  };
}

async function setup(stores: Stores) {
  await stores.jobs.putJob(RUNNING_JOB);
  const fake = usageRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });
  // 引き取りで `#rememberTokenIdentity` 等が走る（セッションが起きる瞬間）。
  await pool.restore();
  return { pool, fake, inbox };
}

async function turnUsageRows(
  stores: Stores,
): Promise<Extract<JournalEntry, { type: 'turn_usage' }>[]> {
  const entries = await stores.journal.list({ types: ['turn_usage'] });
  return entries.flatMap((entry) => (entry.type === 'turn_usage' ? [entry] : []));
}

describe('マネージャーの turn_usage に contextUsage が載る経路（Issue #977 — いまの挙動を固定する）', () => {
  it('増分が非空なら turn_usage.contextUsage に値が載る', async () => {
    const stores = createMemoryStores();
    const s = await setup(stores);

    s.fake.usage({ opus: totals({ costUsd: 1 }) }, SAMPLE_CONTEXT_USAGE);

    const rows = await vi.waitFor(async () => {
      const found = await turnUsageRows(stores);
      if (found.length === 0) throw new Error('turn_usage がまだ日誌に無い');
      return found;
    });
    expect(rows[0]?.contextUsage).toEqual(SAMPLE_CONTEXT_USAGE);

    await s.pool.stop();
  });

  it(
    '⚠️ いまの挙動: 増分が空なら turn_usage の行そのものが無く、contextUsage も一緒に落ちる' +
      '（#976 で変わるはずの期待）',
    async () => {
      const stores = createMemoryStores();
      const s = await setup(stores);

      // **増分ゼロ（`models: {}`）。** `#observeContextUsage` 相当の観測は
      // 成功しているのに、増分が無いので `turn_usage` の行そのものが無く
      // （`manager.ts:7193-7195` の「取れない軸に0の行を作らない」の裏側）、
      // 載せる場所が無い contextUsage も一緒に落ちる
      // （#976「論点」の3つ目の関門）。
      s.fake.usage({}, SAMPLE_CONTEXT_USAGE);

      // `usage.record` は増分の有無に関わらず必ず呼ばれる（`usageStartedAt`
      // が `??= at` で無条件に埋まる——`testing.ts` の `UsageStore.record`）
      // ので、これを完了の目印にする。即座に journal を見ると「まだ処理して
      // いないだけ」と「本当に無い」が区別できない。
      await vi.waitFor(async () => {
        const { since } = await stores.usage.aggregate({});
        if (since === null) throw new Error('usage.record がまだ走っていない');
      });

      expect(await turnUsageRows(stores)).toHaveLength(0);

      await s.pool.stop();
    },
  );
});
