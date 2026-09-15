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
 * Issue #978 の再現専用の2本目のジョブ。**「デーモン再起動を挟んだ二重
 * restore」を測るには、生きたセッションが最低1つ要る**——`RUNNING_JOB` 1本
 * だけでも再現できるが、「再起動後に何件が `undefined` になるか」を数える
 * ためにもう1本並べてある（2本とも同じ runner・同じ形で living 枝に入る）。
 */
const RUNNING_JOB_2: Job = {
  id: 'mgr-gen-2',
  managerId: 'mgr-gen-2',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'running',
  summary: '調べもの2',
  request: '調べておいて2',
  cwd: '/work/project',
  sessionId: 'sess-2',
  runnerId: 'runner-primary',
};

/**
 * Issue #988 の「一度も観測されていない委譲」専用のジョブ。**`status: 'done'`
 * にしてあるのは、`#restoreJobs` が running / waiting_human 以外の状態では
 * resume を試みない（`#resumeOnce` を呼ばない）ためである。** `alive`（runner
 * に生きているセッション）にも居ないので living 枝も通らない——結果として
 * `#records` へは載る（session_id を持つので）が、`#tokenIdentities` には
 * 一度も触れられない。プールは配線されている（他の委譲では観測できる）のに、
 * この委譲だけがまだ起きていない、という組み合わせを作るための最小形。
 */
const DONE_JOB: Job = {
  id: 'mgr-gen-done',
  managerId: 'mgr-gen-done',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  status: 'done',
  summary: '調べもの3',
  request: '調べておいて3',
  cwd: '/work/project',
  sessionId: 'sess-3',
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
    // **Issue #988。** 欄が消える理由が「プールを配線していない」だと名乗る
    // ——「一度も観測されていない」「再起動をまたいだ引き取り」とは別の理由。
    expect(summary.tokenGenerationUnknownReason).toBe('pool-not-wired');

    await pool.stop();
  });

  /**
   * **Issue #988。** プールは配線されているのに、この委譲**固有**の理由——
   * まだ一度もこのプロセスで起きていない——で欄が消えるケース。直上の
   * テスト（プール未配線。全マネージャー共通の理由）とは別の材料で立てる。
   */
  it('プールは配線されているが、まだ一度も起きていない委譲は「一度も観測されていない」と名乗る', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(DONE_JOB);
    const { pool } = await setup({
      stores,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 3 }),
    });

    // 対照: 同じプールで RUNNING_JOB（setup() が起こす）は観測済みになる。
    const observed = await summaryFor(pool, 'mgr-gen');
    expect(observed.tokenGeneration).toBe(3);

    const summary = await summaryFor(pool, 'mgr-gen-done');
    expect(summary.tokenGeneration).toBeUndefined();
    expect(summary.tokenGenerationUnknownReason).toBe('not-yet-observed');

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

describe('デーモン再起動を挟んだ二重 restore（Issue #978）', () => {
  /*
   * **これは現行の欠陥を仕様として固定したものである（Issue #978。
   * AGENTS.md「現行の欠陥を仕様として固定しているテストは反転させてよい」）。**
   *
   * 上の6件は「同一プールインスタンス内の回転」しか作っていない。ここで作るのは
   * 「デーモンを再起動して、runner に生きたままのセッションへ繋ぎ直す」——独立
   * した2つの `ManagerPool` インスタンスで再現する（1つ目でセッションを起こして
   * 世代3 → 回転 → 2つ目で同じ runner の生きたセッションへ再接続）。
   *
   * `ManagerPool#restore()` の living 枝（同じ runner に既に生きているセッション
   * を見つけて引き取る側。`#records` へ載せた直後に `#rememberTokenIdentity` を
   * 呼ぶ箇所）は、**セッションの env を一切更新しないのに**、その瞬間の現役の
   * 世代を新しいプロセスの `#tokenIdentities`（プロセス内 Map。デーモンを作り
   * 直すと空になる）へ書き込む。認証トークンは起動時に env へ焼かれて凍る
   * （`token-spread.ts`）ので、runner 側の実プロセスは古い世代の鍵のまま走り
   * 続けている——**記録だけが現役へ追いつき、本物の食い違いが「一致」に化ける**。
   *
   * トークンの身元（`tokenId`）はダミー値（`tok-a` / `tok-b`）——本物の形
   * （メールアドレス状のラベル）ではない。実測はしない（AGENTS.md「秘密の扱い」）。
   */
  it('living 枝で引き取ったセッションは、runner の env を更新していないのに、デーモン再起動後は世代の食い違いが消える（偽陰性）', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(RUNNING_JOB);
    await stores.jobs.putJob(RUNNING_JOB_2);

    let current: { tokenId: string; generation: number } = { tokenId: 'tok-a', generation: 3 };

    // POOL1: 2本のセッションを起こす。`fake` の `alive` はまだ空なので、
    // どちらも「resume」枝（`#resume()`）を通って `#rememberTokenIdentity` が
    // 走る——既存の6件と同じ経路（`setup()` の注記を参照）。
    const fake = tokenRunner();
    const registry1 = createRunnerRegistry([fake.runner]);
    const pool1 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry1,
      profile: createProfileService({ stores, runners: registry1 }),
      tokenIdentity: () => current,
    });
    await pool1.restore();

    const before1 = await summaryFor(pool1, 'mgr-gen');
    const before2 = await summaryFor(pool1, 'mgr-gen-2');
    expect(before1.tokenGeneration).toBe(3);
    expect(before1.activeTokenGeneration).toBe(3);
    expect(before2.tokenGeneration).toBe(3);
    expect(before2.activeTokenGeneration).toBe(3);

    // 回転（同一プロセス内、再起動なし）。runner 側のセッションはターンの
    // 境界に一度も達していないので、抱えている世代は追いつかない——ここで
    // ⚠ が正しく立つ（#968 が直した本来の検知そのもの）。
    current = { tokenId: 'tok-b', generation: 5 };

    const afterRotation1 = await summaryFor(pool1, 'mgr-gen');
    const afterRotation2 = await summaryFor(pool1, 'mgr-gen-2');
    expect(afterRotation1.tokenGeneration).toBe(3);
    expect(afterRotation1.activeTokenGeneration).toBe(5);
    expect(afterRotation2.tokenGeneration).toBe(3);
    expect(afterRotation2.activeTokenGeneration).toBe(5);

    await pool1.stop();

    // POOL2: デーモンを作り直した相当。**新しい `ManagerPool` インスタンスなので
    // `#tokenIdentities` は空の Map から始まる。** runner 側は生きたまま——同じ
    // `fake.runner`（同一オブジェクト）を新しい registry へ載せて共有し、
    // `list()` が返す `alive` の中身（pool1 の resume() が push したもの）を
    // そのまま引き継ぐ。**runner 側の env は一度も更新していない**——実プロセスは
    // 世代3の鍵のまま走り続けている。`tokenIdentity` は「新しいデーモンが起動時に
    // 認識している現役の世代」（回転後の5）を返す。
    const registry2 = createRunnerRegistry([fake.runner]);
    const pool2 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry2,
      profile: createProfileService({ stores, runners: registry2 }),
      tokenIdentity: () => current,
    });
    await pool2.restore();

    const after1 = await summaryFor(pool2, 'mgr-gen');
    const after2 = await summaryFor(pool2, 'mgr-gen-2');

    // ⚠ 旧: living 枝が観測だけで `#tokenIdentities` を書き換えるため、実際には
    // runner 側が世代3のまま止まっているのに、記録上は現役（5）と「一致」して
    // しまっていた。#968 が入れた ⚠ が、再起動を挟んだだけで消えていた。
    //
    // **2026-09-15 直した（Issue #978）。** living 枝はもう `#tokenIdentities`
    // を書かない——新しいプロセス（POOL2）の `#tokenIdentities` にはこの委譲の
    // 記録が無いままなので、`tokenGeneration` は `undefined` になる
    // （`summaryOf` が `activeTokenGeneration` も道連れに落とす。`tools.ts` の
    // `describeTokenGeneration` はこの委譲について1行も出さない）。**嘘の
    // 「一致」が消え、正直な「材料が無い」に変わった。**
    expect(after1.tokenGeneration).toBeUndefined();
    expect(after1.activeTokenGeneration).toBeUndefined();
    expect(after2.tokenGeneration).toBeUndefined();
    expect(after2.activeTokenGeneration).toBeUndefined();
    // **2026-09-15 Issue #988 で埋めた。** 「材料が無い」自体は一度も観測されて
    // いない場合と同じ見た目だったが、いまはその理由を名乗る——living 枝で
    // 引き取ったことそのものが `tokenGenerationUnknownReason` に残る。
    expect(after1.tokenGenerationUnknownReason).toBe('reattached-across-restart');
    expect(after2.tokenGenerationUnknownReason).toBe('reattached-across-restart');

    await pool2.stop();
  });

  /**
   * **Issue #988。** 理由の印は living 枝で立てたきりではなく、デーモンが
   * 実際にこの委譲へ触れた瞬間（ここでは `runner.ts` が送る
   * `note.tokenRotation: true` の形）に消える——`#rememberTokenIdentity` の
   * doc の3つの呼び出し口と同じ理由。**片方だけ触れたら、触れていないほうの
   * 印は残ったままであること**も確かめる（印がマネージャーごとに独立して
   * いるという確認——グローバルな旗ではない）。
   */
  it('再起動後に daemon がこの委譲へ実際に触れば、「再起動をまたいだ」の印は消える', async () => {
    const stores = createMemoryStores();
    await stores.jobs.putJob(RUNNING_JOB);
    await stores.jobs.putJob(RUNNING_JOB_2);

    let current: { tokenId: string; generation: number } = { tokenId: 'tok-a', generation: 3 };

    const fake = tokenRunner();
    const registry1 = createRunnerRegistry([fake.runner]);
    const pool1 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry1,
      profile: createProfileService({ stores, runners: registry1 }),
      tokenIdentity: () => current,
    });
    await pool1.restore();
    current = { tokenId: 'tok-b', generation: 5 };
    await pool1.stop();

    const registry2 = createRunnerRegistry([fake.runner]);
    const pool2 = createManagerPool({
      stores,
      post: () => {
        /* この検証では読まない */
      },
      runners: registry2,
      profile: createProfileService({ stores, runners: registry2 }),
      tokenIdentity: () => current,
    });
    await pool2.restore();

    // 再起動直後は両方とも「再起動をまたいだ」——前のテストと同じ前提。
    expect((await summaryFor(pool2, 'mgr-gen')).tokenGenerationUnknownReason).toBe(
      'reattached-across-restart',
    );
    expect((await summaryFor(pool2, 'mgr-gen-2')).tokenGenerationUnknownReason).toBe(
      'reattached-across-restart',
    );

    // daemon が mgr-gen にだけ実際に触れる（`runner.ts` の
    // `#reopenForTokenRotation` が送る形そのもの）。
    fake.note(true);

    const touched = await summaryFor(pool2, 'mgr-gen');
    const untouched = await summaryFor(pool2, 'mgr-gen-2');

    // 触れたほうは世代が埋まり、理由の印は消える（欄ごと消えるので
    // `tokenGenerationUnknownReason` 自体が無い）。
    expect(touched.tokenGeneration).toBe(5);
    expect(touched.tokenGenerationUnknownReason).toBeUndefined();
    // 触れていないほうは、印が残ったまま——グローバルな旗ではない。
    expect(untouched.tokenGeneration).toBeUndefined();
    expect(untouched.tokenGenerationUnknownReason).toBe('reattached-across-restart');

    await pool2.stop();
  });
});
