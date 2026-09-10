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
 * **`event.systemError` が、クローンの受信箱まで実際に届くこと（#713 段2）。**
 *
 * `packages/core/src/runner-closed-system-error.test.ts` は runner → daemon の
 * 境界（`runnerEventSchema.safeParse`）までしか測っていない。**この歯は、
 * その先——`manager.ts` が `#queueSynthesizedNotice` / `#flushSynthesizedNotices`
 * / `#emit` を経て実際にクローンへ配る本文まで通す。**
 *
 * 依頼者の指摘（値を作ったことと、クローンに見えることは別）どおり、
 * `#queueSynthesizedNotice` に積んだ中身を直接覗くのではなく、**合流窓が閉じて
 * `manager_message` として受信箱（`inbox`）に立った文字列**を見る——
 * `manager-synthesized-notices.test.ts` の「機構合成の知らせが、合流窓の中で
 * 1件にまとまる」と同じ足場（`manualRunner` / `runningManualSetup`）を、
 * この歯専用に複製してある（同ファイルの doc と同じ理由——duplicated on
 * purpose）。
 *
 * **daemon の境界も飛ばさない。** 本番では `RunnerClient.connect(onEvent)` へ
 * 渡る前に `apps/daemon/src/runner-client.ts` が `runnerEventSchema.safeParse`
 * を通す（スキーマに無い欄はここで黙って落ちる）。`manualRunner.closed()` は
 * それと同じ形——`JSON.parse(JSON.stringify(event))` を挟んでから
 * `runnerEventSchema.safeParse` に通し、**その結果**を manager へ渡す。
 *
 * ## 4区別が別の行・別の経路になること
 *
 * - A（枠で落ちた）: `systemError` 無し、`reason` に枠の文言
 * - B（器の資源）: `systemError` 在り
 * - C（セッション切断）: `selfFenced` の枝——この歯では扱わない（早期 return）
 * - D（分類が取れなかった）: `systemError` 無し、`reason` に枠の文言なし
 *
 * A と D はどちらも「`systemError` 無し」だが、**D の行が A の `reason` を
 * 飲み込んで「何も分からない」に見せていないか**を最後の1本で測る。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  closed(managerId: string, reason: string, systemError?: SystemErrorFacts): void;
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

  return {
    runner,
    alive,
    closed(managerId, reason, systemError) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      // **daemon の境界（runnerEventSchema.safeParse）を実際に通す。** スキーマ
      // に無い欄はここで黙って落ちるので、emit した中身だけを見ていると
      // 境界で消えたことに気づけない（`runner-closed-system-error.test.ts` と
      // 同じ作法）。
      const raw: RunnerEvent = {
        type: 'closed',
        managerId,
        status: 'failed',
        reason,
        ...(systemError !== undefined ? { systemError } : {}),
      };
      const parsed = runnerEventSchema.safeParse(JSON.parse(JSON.stringify(raw)) as unknown);
      if (!parsed.success) throw new Error(`境界で落ちた: ${parsed.error.message}`);
      emit?.(parsed.data);
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

function reportTextsOf(inbox: InboxEvent[]): string[] {
  return inbox
    .filter((event) => event.type === 'manager_message' && event.kind === 'report')
    .map((event) => (event as { text: string }).text);
}

describe('event.systemError が、合流窓を経てクローンの受信箱まで実際に届く（#713 段2）', () => {
  it('B: systemError が在るとき、配られた本文に code / errno / syscall が生の値のまま乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-b');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-b', 'マネージャーのセッションが落ちた: Error: spawn …/claude EAGAIN', {
      code: 'EAGAIN',
      errno: -11,
      syscall: 'spawn /app/node_modules/.bin/claude',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    // **reason 本文はそのまま残る。**
    expect(text).toContain('マネージャーのセッションが落ちた: Error: spawn …/claude EAGAIN');
    // **SDK が出した値がそのまま、配られた本文に乗る。**
    expect(text).toContain('code=EAGAIN');
    expect(text).toContain('errno=-11');
    expect(text).toContain('syscall=spawn /app/node_modules/.bin/claude');
  });

  it('D: systemError が無い（signal で畳まれた等）とき、配られた本文に「取れなかった」行が乗る', async () => {
    const { pool, inbox, fake } = await runningManualSetup('mgr-d');
    const before = reportTextsOf(inbox).length;

    fake.closed('mgr-d', 'マネージャーのセッションが落ちた: Error: 何か');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pool.stop();

    const texts = reportTextsOf(inbox).slice(before);
    expect(texts).toHaveLength(1);
    const text = texts[0] ?? '';
    expect(text).toContain('マネージャーのセッションが落ちた: Error: 何か');
    expect(text).toContain('器の資源による落ち方かどうかは');
    // **「取れなかった」を値で埋めていない**——`code=` の形は一切出ない。
    expect(text).not.toContain('code=');
  });

  it(
    'A: 枠で落ちた回（systemError 無し）は、D の行に飲み込まれず reason の枠の文言が' +
      'そのまま読める——D の行が付いても「何も分からない」にならない',
    async () => {
      const { pool, inbox, fake } = await runningManualSetup('mgr-a');
      const before = reportTextsOf(inbox).length;

      const quotaReason =
        'マネージャーのセッションが落ちた: Error: ' +
        "You've hit your individual spend limit for this account.";
      fake.closed('mgr-a', quotaReason);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await pool.stop();

      const texts = reportTextsOf(inbox).slice(before);
      expect(texts).toHaveLength(1);
      const text = texts[0] ?? '';
      // **枠の事実（A）が、D の行に上書きされずそのまま残る。**
      expect(text).toContain("You've hit your individual spend limit for this account.");
      // **D の行も付くが、対象は「器の資源の軸」に限定されている**——
      // 「分類できない」という無限定な文言では、この行と枠の文言が同じ本文に
      // 並んだとき、読み手が「枠かどうかも分からない」と誤読しうる。D の行
      // 自身が「枠はこの欄の対象外」だと名乗っていることを、配られた本文の
      // 側で確かめる（値を作っただけでなく、実際にクローンへ届く形を測る）。
      expect(text).toContain('器の資源による落ち方かどうかは');
      expect(text).toContain('枠に当たった場合');
    },
  );
});
