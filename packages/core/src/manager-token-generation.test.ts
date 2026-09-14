import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * **この委譲が抱えている認証トークンの世代**（`ManagerPool` の
 * `#tokenIdentities` / `#tokenIdentity?.()` から `list()` / `runners()` が
 * `ManagerSummary.tokenGeneration` / `activeTokenGeneration` を組み立てる経路。
 * Issue #914 提案1）。
 *
 * ## なぜ別ファイルにしてあるか
 *
 * `manager-usage-token.test.ts` が同じ `tokenIdentity` の口・同じ形の偽 runner
 * を既に持っているが、あちらが固定するのは「消費の台帳に `tokenId` が付くか」
 * だけで、`ManagerSummary.tokenGeneration` / `activeTokenGeneration`（`manager_list`
 * / `runner_list` が読む欄）はまだ誰も測っていなかった。**測るものが違うので、
 * 同じ `setup` を書き足すのではなく小さく複製する**（同じファイルの理由は
 * `manager-usage-token.test.ts` 冒頭のコメントを参照）。
 *
 * ## ここが固定するもの
 *
 * - セッションが起きた瞬間（`restore()` が引き取る）に、`tokenGeneration` が
 *   そのときの現役の世代を持つこと
 * - **回った後もこのマネージャーが古い世代を抱え続けるあいだ**（ターンの境界
 *   に一度も達していない）、`tokenGeneration`（抱えている世代）と
 *   `activeTokenGeneration`（呼び出し時点の現役）が食い違ったまま出ること
 *   —— これが Issue #914 の症状そのものである（気づく手段が3箇所の時刻の
 *   突き合わせしかなかった）
 * - `runner.ts` の `#reopenForTokenRotation` が送る `note.tokenRotation: true`
 *   だけが `#tokenIdentities` を追いつかせ、`tokenRotation` を伴わない普通の
 *   `note` では追いつかないこと（文字列ではなく欄で判定する、という
 *   `runner-protocol.ts` の doc の約束を運用面から確かめる）
 * - `tokenIdentity` を配線していない器では欄が1文字も立たないこと
 *   （AGENTS.md「取れない軸に 0 の行を作らない」）
 * - `runners()`（`runner_list` の材料）にも同じ値がそのまま伝わること
 */

const RUNNING_JOB: Job = {
  id: 'mgr-gen',
  managerId: 'mgr-gen',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

/**
 * `manager-usage-token.test.ts` の `usageRunner()` の縮小版。**縮めたのは
 * 「使わない口を空にした」ぶんだけで、判定に効く口（`connect` / `resume` /
 * `list`）は同じことをする。** `usage()` の代わりに `note()` を持つ——ここで
 * 押し込みたいのは消費のイベントではなく `note`（`runner.ts` の
 * `#reopenForTokenRotation` が送るものの形）である。
 */
function tokenRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      // **同期的に名乗らせない**（本物は `void this.#pump(...)` で即 return する）。
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
     * runner の内側の事実として `note` を1つ流す（`manager.ts` の
     * `case 'note'` が受ける形と同じ）。**`tokenRotation` を渡さなければ
     * 普通の note になる**——それが `#rememberTokenIdentity` を呼び直さない
     * 側の対照である。
     */
    note(tokenRotation?: true): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit({
        type: 'note',
        managerId: 'mgr-gen',
        text: '認証トークンが差し替わったので、ターンの境界でセッションを畳んで開き直した。',
        ...(tokenRotation === undefined ? {} : { tokenRotation }),
      } as unknown as RunnerEvent);
    },
  };
}

async function setup(options: {
  stores: Stores;
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
}) {
  await options.stores.jobs.putJob(RUNNING_JOB);
  const fake = tokenRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: options.stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores: options.stores, runners: registry }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
  });
  // 引き取りで `#rememberTokenIdentity` が走る（セッションが起きる瞬間である。
  // `manager-usage-token.test.ts` と同じ経路）。
  await pool.restore();
  return { pool, fake };
}

async function summaryFor(pool: Awaited<ReturnType<typeof setup>>['pool'], managerId: string) {
  const list = await pool.list();
  const found = list.find((s) => s.managerId === managerId);
  if (found === undefined) throw new Error(`${managerId} が list() に見つからない`);
  return found;
}

describe('マネージャーが抱えている認証トークンの世代（Issue #914 提案1）', () => {
  it('`tokenIdentity` を配線していない器では、世代の欄が1文字も立たない', async () => {
    const stores = createMemoryStores();
    const { pool } = await setup({ stores });

    const summary = await summaryFor(pool, 'mgr-gen');

    expect(summary.tokenGeneration).toBeUndefined();
    expect(summary.activeTokenGeneration).toBeUndefined();

    await pool.stop();
  });

  it('セッションが起きた瞬間の世代が、現役と一致していれば両方が同じ値になる', async () => {
    const stores = createMemoryStores();
    const { pool } = await setup({
      stores,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 3 }),
    });

    const summary = await summaryFor(pool, 'mgr-gen');

    expect(summary.tokenGeneration).toBe(3);
    expect(summary.activeTokenGeneration).toBe(3);

    await pool.stop();
  });

  it('現役が回った後も、ターンの境界に達していないマネージャーは古い世代を抱えたまま食い違う', async () => {
    // **これが Issue #914 の症状そのものである。** セッションは生きている
    // （`live`）のに、抱えている鍵の世代だけが古い——気づく手段がこれまで
    // 無かった。
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool } = await setup({ stores, tokenIdentity: () => current });

    // 起こした後で、他の委譲の枠当たりを契機に現役が回った（このマネージャー
    // 自身のセッションはまだターンの境界に達していない）。
    current = { tokenId: 'tok-b', generation: 5 };

    const summary = await summaryFor(pool, 'mgr-gen');

    // 抱えている世代（起きた瞬間の身元）は変わらない。
    expect(summary.tokenGeneration).toBe(3);
    // 現役は `list()` を呼ぶたびに読み直すので、いまの値を映す。
    expect(summary.activeTokenGeneration).toBe(5);

    await pool.stop();
  });

  it('runner がターンの境界で自動的に開き直すと（note.tokenRotation）、抱えている世代が現役に追いつく', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool, fake } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };
    expect((await summaryFor(pool, 'mgr-gen')).tokenGeneration).toBe(3); // 食い違いを確認

    // `runner.ts` の `#reopenForTokenRotation` が送る形そのもの。
    fake.note(true);

    const summary = await summaryFor(pool, 'mgr-gen');
    expect(summary.tokenGeneration).toBe(5);
    expect(summary.activeTokenGeneration).toBe(5);

    await pool.stop();
  });

  it('`tokenRotation` を伴わない普通の note では、抱えている世代を追いつかせない', async () => {
    // **文字列ではなく欄で判定する**（`runner-protocol.ts` の `note.tokenRotation`
    // の doc）。ここが `text` の言い回しに反応して追いつかせてしまうと、
    // #570 の起こし直し通知など他の note でも世代が動いてしまい、
    // 「ターンの境界に達した」以外の理由で食い違いが消える——検知そのものが
    // 意味を失う。
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool, fake } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };
    fake.note(); // tokenRotation を伴わない

    const summary = await summaryFor(pool, 'mgr-gen');
    expect(summary.tokenGeneration).toBe(3); // 追いついていない
    expect(summary.activeTokenGeneration).toBe(5);

    await pool.stop();
  });

  it('runners()（runner_list の材料）にも同じ世代がそのまま伝わる', async () => {
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 3 };
    const { pool } = await setup({ stores, tokenIdentity: () => current });

    current = { tokenId: 'tok-b', generation: 5 };

    const overview = await pool.runners();
    const runner = overview.runners.find((r) => r.runnerId === 'runner-primary');
    if (runner === undefined) throw new Error('runner-primary が見つからない');
    const entry = runner.managers.find((m) => m.managerId === 'mgr-gen');
    if (entry === undefined) throw new Error('mgr-gen が runner-primary の内訳に無い');

    expect(entry.tokenGeneration).toBe(3);
    expect(entry.activeTokenGeneration).toBe(5);

    await pool.stop();
  });
});
