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
 * **`manager_message` の `statusAtDelivery`（issue #870）を、`manager.ts` の
 * 実装を実際に通して確かめる。** `schema.test.ts` 側は schema そのもの
 * （parse できるか・省略時に既定値を作らないか）を見るが、こちらは
 * **producer 側**（`manager.ts` の `#statusAtDelivery` と、それを展開する
 * 7箇所の `#post({ type: 'manager_message', … })`）が実際に正しい値を
 * 積むかを見る。
 *
 * ## この歯が使う足場
 *
 * `manager-withheld-reports.test.ts` の `manualRunner()` /
 * `runningManualSetup()` と同じ作法（この歯専用に複製——同じ複製の理由が
 * あちらのファイル冒頭にある）。`RunnerEvent` を直接組み立てて emit する
 * ので、SDK 層を経由せずに `manager.ts` の `#onEvent` を単体で確かめられる。
 */

interface ManualRunner {
  runner: RunnerClient;
  alive: RunnerManagerState[];
  report(
    managerId: string,
    text: string,
    status: JobStatus,
    fields?: { awaitingBackground?: { count: number; breakdown: string } },
  ): void;
  closed(managerId: string, status: 'done' | 'lost' | 'failed', reason: string): void;
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
    report(managerId, text, status, fields = {}) {
      emit?.({ type: 'report', managerId, text, status, ...fields });
    },
    closed(managerId, status, reason) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
      emit?.({ type: 'closed', managerId, status, reason });
    },
  };
}

interface ManualSetup {
  pool: ManagerPool;
  stores: Stores;
  inbox: InboxEvent[];
  fake: ManualRunner;
}

async function runningManualSetup(managerId = 'mgr-sad'): Promise<ManualSetup> {
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
  const clock = Date.parse('2026-09-01T00:00:00.000Z');
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    now: () => clock,
  });

  await pool.restore();
  // `restore()` の知らせ（`#notifyRestored`）を待ってから `before` を取る
  // （`manager-withheld-reports.test.ts` と同じ理由）。
  await vi.waitFor(() => {
    if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
  });

  return { pool, stores, inbox, fake };
}

function managerMessages(inbox: InboxEvent[]) {
  return inbox.filter(
    (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
      event.type === 'manager_message',
  );
}

describe('manager.ts の producer 側: statusAtDelivery（issue #870）', () => {
  /**
   * **歯1: 「status を構造化欄から読める」。**
   *
   * `case 'report'` の経路には、`text` に `status=` のような散文の飾りは
   * 一切入らない（本文は呼び出し元がそのまま渡した文字列）。**にもかかわらず
   * `statusAtDelivery` は付く。** これは「text を1文字も見ずに status が
   * 読める」ことの直接の証拠——飾りが無い経路でも欄が独立に機能している。
   */
  it('プレーンな report でも、text に status= の飾りが無いまま statusAtDelivery が付く', async () => {
    const { pool, inbox, fake } = await runningManualSetup();
    const before = managerMessages(inbox).length;

    fake.report('mgr-sad', 'ただの報告です', 'waiting_human');

    const event = await vi.waitFor(() => {
      const found = managerMessages(inbox).slice(before);
      const hit = found.find((entry) => entry.kind === 'report');
      if (!hit) throw new Error('まだ届いていない');
      return hit;
    });

    // **飾りが無いことの確認**（このアサーションが無いと、次の expect が
    // 「text の中の status= を読んでいるだけ」の可能性を否定できない）。
    expect(event.text).not.toContain('status=');
    // **フィクスチャが与えた値そのもの**（'waiting_human'）が構造化欄に出る。
    expect(event.statusAtDelivery).toBe('waiting_human');

    await pool.stop();
  });

  /**
   * **歯2: 「散文の書式が変わっても照合が壊れない」。**
   *
   * `case 'closed'` かつ「畳んでいた報告が在る」ときだけ、`text` に
   * `この委譲は終わった（status=${event.status}）。` という**唯一の**
   * 散文の飾りが入る（`manager.ts` の当該箇所。他の6箇所にはこの飾りは
   * 無い——AGENTS.md の踏査どおり「散文へ status= を埋めている
   * manager_message は現物で1箇所だけ」）。
   *
   * ここでは **その1箇所を実際に踏んで**、
   *
   * 1. 散文には確かに `status=lost` という飾りが入ること（人間可読の面が
   *    生きていることの確認——正本ではないが消えてもいない）
   * 2. **`statusAtDelivery` は、その散文の中の `status=` を1文字も
   *    パースしていない** —— 構造化欄への代入は `#statusAtDelivery`
   *    （`this.#records` から手元で読む）で完結しており、`text` の
   *    どの部分にも依存しない
   *
   * の両方を、別々のアサーションとして確かめる。(1) と (2) が同じ値
   * （'lost'）を指していても、**(2) の正しさは (1) の文字列に一度も
   * 触れずに成立する** —— この「触れずに成立する」設計を、変異試験で
   * 実際に (1) の飾り（`この委譲は終わった` の周辺の語）だけを書き換えて
   * 確かめる（PR 本文の変異試験の節）。
   */
  it('唯一「status=」を散文に埋める経路でも、statusAtDelivery は散文を読まずに同じ値になる', async () => {
    const { pool, stores, inbox, fake } = await runningManualSetup();

    // 先に「背景処理の完了待ちで畳んだ報告」を1本作る——`#withheldReports`
    // に積みが無いと、`case 'closed'` は「status=」の散文を組み立てる
    // 分岐へ入らない（`manager.ts` の `if (this.#withheldReports.has(...))`）。
    fake.report('mgr-sad', '完了を待つ', 'done', {
      awaitingBackground: { count: 1, breakdown: 'shell×1' },
    });
    // **`job.lastReport` の更新では待たない。** それは `#withholdBackgroundReport`
    // より手前（`await this.#persist(record)`）で確定する値なので、そこで
    // 待つと「畳む」処理自体がまだ終わっていないうちに次へ進める競走になる
    // （実測——この待ち方で書いたところ `case 'closed'` が
    // `#withheldReports.has()` を偽のまま読み、この歯が生む唯一の
    // 「status=」散文が1件も届かなかった）。**畳んだこと自体の跡**である
    // decision 日誌を待つ（`manager.ts` の当該 `#journal` 呼び出しの本文）。
    await vi.waitFor(async () => {
      const entries = await stores.journal.list({ types: ['decision'] });
      const found = entries.some((entry) =>
        JSON.stringify(entry).includes(
          '背景処理の完了待ちで畳んだターンの報告なので受信箱へは回さない',
        ),
      );
      if (!found) throw new Error('まだ畳まれていない');
    });

    const before = managerMessages(inbox).length;
    fake.closed('mgr-sad', 'lost', '接続が切れた');

    // **文言では選ばない。** `case 'closed'` の withheld 分岐は、この managerId
    // に対して `#emit` をちょうど1回しか呼ばない——「積みが在るときの
    // ただ1本」という**位置**で特定する（`entry.text.includes(...)` のような
    // 文言一致で選ぶと、その選び方自体が散文に依存してしまい、歯2が確かめ
    // たいはずの「文言に依存しない」を選定ロジックの側で破ってしまう）。
    const event = await vi.waitFor(() => {
      const found = managerMessages(inbox).slice(before);
      const hit = found[0];
      if (!hit) throw new Error('まだ届いていない');
      return hit;
    });

    // (1) 散文の飾りが実在すること（人間可読の面。正本ではない）。
    expect(event.text).toContain('status=lost');
    // (2) 構造化欄——(1) の文字列を一度も参照しない、独立したアサーション。
    expect(event.statusAtDelivery).toBe('lost');

    await pool.stop();
  });
});
