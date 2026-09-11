import { describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  runnerEventSchema,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { SystemErrorFacts } from './system-error.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * **台帳（`Job.lastSystemError`）が、実際に立ち・下りることを測る（#713 段3）。**
 *
 * `packages/core/src/manager-closed-failed-system-error.test.ts` は
 * `event.systemError` が受信箱の本文（読み捨てられる通知）まで届くことしか
 * 測っていない。**この歯は、その先——`manager.ts` の `#onEvent` が台帳
 * （`record.job.lastSystemError`）へ実際に書く／消すところまで、`pool.list()`
 * が返す `ManagerSummary` で確かめる。** 受信箱は流れるので、これが無いと
 * 「値は一瞬だけ作られたが、振り返る面からは復元できない」を見逃す。
 *
 * 足場（`manualRunner` / `runningManualSetup`）は上記ファイルと同じ形を複製
 * してある（同ファイルの doc と同じ理由——duplicated on purpose）。
 * `reported()` を追加している点だけが違う——「起こし直されて報告が届いた」
 * を模すのに要る。
 *
 * ## 測る4つ
 *
 * 1. B（`systemError` 在り）: `lastSystemError` に `code`/`errno`/`syscall`/`at`
 *    がそのまま立つ
 * 2. D（無し）: `lastSystemError` は**欄ごと**無い（`code=` の形の既定値を
 *    作らない——`Object.hasOwn` で確かめる）
 * 3. 古びる: 立った直後は在り、`report` が届いた後は**キーごと**消える
 *    （`event.failure` の有無に関係なく——「セッションが生きて出力したか」
 *    が軸なので、そのターン自体が失敗で終わったかは無関係）
 * 4. `report` が届くまでは、時間が経つだけでは消えない（時限式ではないこと
 *    の対照）
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, reason: string, systemError?: SystemErrorFacts): void;
  reported(
    managerId: string,
    text: string,
    options?: { failure?: { code: string; via: string } },
  ): void;
}

function manualRunner(runnerId = 'runner-primary'): ManualRunner {
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
    async start() {
      /* この検証では使わない */
    },
    async resume() {
      /* この検証では使わない */
    },
    async send() {
      /* この検証では使わない */
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
    async close() {
      /* この検証では使わない */
    },
  };

  function send(raw: RunnerEvent): void {
    // **daemon の境界（runnerEventSchema.safeParse）を実際に通す。** スキーマに
    // 無い欄はここで黙って落ちるので、emit した中身だけを見ていると境界で
    // 消えたことに気づけない（`manager-closed-failed-system-error.test.ts` と
    // 同じ作法）。
    const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
    if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
    emit?.(parsed.data);
  }

  return {
    runner,
    alive,
    closed(managerId, reason, systemError) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      send({
        type: 'closed',
        managerId,
        status: 'failed',
        reason,
        ...(systemError !== undefined ? { systemError } : {}),
      });
    },
    reported(managerId, text, options = {}) {
      send({
        type: 'report',
        managerId,
        text,
        status: 'done',
        ...(options.failure !== undefined ? { failure: options.failure } : {}),
      });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(managerId = 'mgr-quota'): Promise<ManualSetup> {
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
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
  });

  await pool.restore();
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

async function listedOf(pool: ManagerPool, managerId: string) {
  const all = await pool.list();
  const found = all.find((m) => m.managerId === managerId);
  if (!found) throw new Error(`${managerId} が一覧に居ない`);
  return found;
}

describe('台帳の lastSystemError が、実際に立ち・下りる（#713 段3）', () => {
  it('B: systemError が在るとき、台帳（ManagerSummary）に code/errno/syscall/at がそのまま立つ', async () => {
    const { pool, fake } = await runningManualSetup('mgr-b');

    fake.closed('mgr-b', 'マネージャーのセッションが落ちた: Error: spawn …/claude EAGAIN', {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-b');
    expect(listed.status).toBe('failed');
    expect(listed.lastSystemError).toEqual({
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
      at: expect.any(String),
    });

    await pool.stop();
  });

  it('D: systemError が無いとき、lastSystemError は欄ごと無い（code= 形の既定値を作らない）', async () => {
    const { pool, fake } = await runningManualSetup('mgr-d');

    fake.closed('mgr-d', 'マネージャーのセッションが落ちた: Error: 何か（signal で畳まれた）');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const listed = await listedOf(pool, 'mgr-d');
    expect(listed.status).toBe('failed');
    expect(listed.lastSystemError).toBeUndefined();
    // キーごと無いこと（`undefined` を代入した形と区別する——`lastFailure` の
    // 既存の歯と同じ確かめ方）。
    expect(Object.hasOwn(listed as object, 'lastSystemError')).toBe(false);

    await pool.stop();
  });

  it(
    '古びる: 立った直後は在り、起こし直されて report が届くと欄ごと消える' +
      '（event.failure の有無に関係なく）',
    async () => {
      const { pool, fake } = await runningManualSetup('mgr-stale');

      fake.closed('mgr-stale', 'マネージャーのセッションが落ちた: Error: spawn EAGAIN', {
        code: 'EAGAIN',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterClosed = await listedOf(pool, 'mgr-stale');
      expect(afterClosed.lastSystemError).toBeDefined();

      // **起こし直された**（同じ managerId で再び alive になり、report が届く）。
      // このターン自体は成功で終わった——`event.failure` は無い。
      fake.alive.push({
        managerId: 'mgr-stale',
        status: 'running',
        cwd: '/work/project',
        request: '調べて',
        waiting: [],
      });
      fake.reported('mgr-stale', '起こし直して、普通に報告した');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const afterReport = await listedOf(pool, 'mgr-stale');
      expect(afterReport.lastSystemError).toBeUndefined();
      expect(Object.hasOwn(afterReport as object, 'lastSystemError')).toBe(false);
      // 新しい報告自体は読める（下ろしただけで他は壊れていない）。
      expect(afterReport.lastReport).toBe('起こし直して、普通に報告した');

      await pool.stop();
    },
  );

  it(
    '古びる（event.failure が在る回でも下ろす）: セッションは生きて出力しているので、' +
      'そのターン自体が失敗で終わったかとは無関係に lastSystemError を下ろす',
    async () => {
      const { pool, fake } = await runningManualSetup('mgr-stale-failure');

      fake.closed('mgr-stale-failure', 'マネージャーのセッションが落ちた: Error: spawn EAGAIN', {
        code: 'EAGAIN',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await listedOf(pool, 'mgr-stale-failure')).lastSystemError).toBeDefined();

      fake.alive.push({
        managerId: 'mgr-stale-failure',
        status: 'running',
        cwd: '/work/project',
        request: '調べて',
        waiting: [],
      });
      // **このターン自体は枠に当たって失敗で終わった**（`event.failure` 在り）。
      // それでも `lastSystemError` は「セッションが生きて出力したか」の軸なので
      // 下りる——`lastFailure`（このターンの失敗）のほうは別に立つ。
      fake.reported('mgr-stale-failure', '（このターンは応答を返さずに終わった: billing_error）', {
        failure: { code: 'billing_error', via: 'assistant_error' },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const after = await listedOf(pool, 'mgr-stale-failure');
      expect(after.lastSystemError).toBeUndefined();
      expect(Object.hasOwn(after as object, 'lastSystemError')).toBe(false);
      // `lastFailure`（別の軸）は、このターンの失敗どおり新しく立っている。
      expect(after.lastFailure?.code).toBe('billing_error');

      await pool.stop();
    },
  );

  it('report が届くまでは、時間が経つだけでは消えない（時限式ではないことの対照）', async () => {
    const { pool, fake } = await runningManualSetup('mgr-persist');

    fake.closed('mgr-persist', 'マネージャーのセッションが落ちた: Error: spawn EAGAIN', {
      code: 'EAGAIN',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await listedOf(pool, 'mgr-persist')).lastSystemError).toBeDefined();

    // report を送らずに、もう一度 list() を呼ぶだけ（時間だけ経過させる）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stillThere = await listedOf(pool, 'mgr-persist');
    expect(stillThere.lastSystemError).toBeDefined();
    expect(stillThere.lastSystemError?.code).toBe('EAGAIN');

    await pool.stop();
  });
});
