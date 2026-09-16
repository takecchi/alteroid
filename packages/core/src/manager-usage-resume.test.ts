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
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * **枠（利用上限）で止まった委譲を、鍵が通る状態へ戻った時点で続きから起こす**
 * （`ManagerPool.resumeStoppedByUsage`）。
 *
 * ## ここが固定するもの
 *
 * 「撒いた」と「復帰した」は別である。トークンを撒くところ（`token-spread.ts`）と、
 * 走行中のセッションを畳んで同じ `sessionId` で開き直すところ（`runner.ts` の
 * `#reopenForTokenRotation`。歯は `runner-token-rotation.test.ts`）は既に在るが、
 * **開き直したセッションは誰かが話しかけるまで何もしない。** ここが測るのは
 * その最後の一歩 —— **枠で止まった委譲へ、続きを促す一言が同じ会話へ届くこと**
 * である（新しいセッションを開かない ＝ 最初からやり直さない）。
 */

const JOB: Job = {
  id: 'mgr-usage',
  managerId: 'mgr-usage',
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

/**
 * 送られた一言と resume を控える偽 runner。
 *
 * `manager-usage-token.test.ts` の `usageRunner` と同じ縮小版だが、**`send` と
 * `resume` の中身を控える**（この検証はそこを測る）。`list()` は引き取りの相手に
 * なるので、本物と同じく「いま載っているセッション」を返す。
 */
/**
 * **`send()` を空振りさせるための切り替え**（`'skipped'` を作る側の細工）。
 *
 * `'ok'` が既定で、これまでどおり届く。`'throw'` にすると `runner.send()` が
 * 例外を投げる——`#sendDetectingMissingSession` は `RunnerHttpError`（404）
 * だけを値へ変えるので、それ以外の例外は `Pool.send()` を素通りして
 * `#nudgeForUsageRotation` の `catch` へ落ち、`'skipped'` になる（resume
 * 経路には入らない。届かなかったことだけを作るための最小の細工）。
 */
function nudgeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const behavior: { sendMode: 'ok' | 'throw' } = { sendMode: 'ok' };
  // **`settleStalledUsageWakes()` の検証専用**（Issue #914 最終段）。既定は
  // `manager-turn-end.test.ts` の `TranscriptRunner` と同じく `null`
  // （生ログが無い）——`setTranscript` を呼ばない既存の検証には1文字も
  // 効かない。
  const transcripts = new Map<string, string | null>();

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
      resumes.push(command);
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send(managerId, text) {
      if (behavior.sendMode === 'throw') {
        throw new Error('この検証が仕込んだ送信エラー（空振りを作るための細工）');
      }
      sends.push({ managerId, text });
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      // **本物と同じく、止めたセッションは一覧から消える。** ここを何もしない
      // ままにすると `abort()` が「止まったと確かめられない」側へ落ち、台帳が
      // `stopped` にならない ⟹ **`stopped` を測るつもりの歯が、実は `running`
      // を測ることになる**（実際にそうなっていて、ホワイトリストを黒リストへ
      // 変える変異が生き残った）。
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return [...alive];
    },
    async transcript(managerId: string) {
      return transcripts.get(managerId) ?? null;
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
    sends,
    resumes,
    behavior,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
    setTranscript(managerId: string, body: string | null): void {
      transcripts.set(managerId, body);
    },
  };
}

async function setup() {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = nudgeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  // 引き取りで像が載り、`connect` が済む（ここから先はイベントで動かせる）。
  await pool.restore();
  // 引き取りの resume は測りたいものではないので、ここで控えを空にする。
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return { pool, fake, stores, inbox };
}

/**
 * **同じ台帳（`stores`）を、別の `ManagerPool`（＝別のデーモン・別の runner）で
 * 開き直す。** 印（`#usageStopped`）はプロセス内の `Set` なので、新しい Pool は
 * 台帳の写し（`Job.usageStoppedAt`）からしか組み直せない——ここが Issue #914
 * 段2の歯の心臓部である（`setup()` が返す元の Pool とは別物であることが
 * 唯一の意味）。
 */
async function reopen(stores: Stores) {
  const fake = nudgeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });
  await pool.restore();
  /*
   * **`setup()` と同じ理由で控えを空にする。** `status: 'running'` のまま
   * 台帳に残っていたジョブは、`#restoreJobs` が（枠とは無関係に）起動時の
   * 引き取りとして無条件に resume を投げる——これはこの変更より前からある
   * 挙動で、ここで測りたい「枠の印による再起動」とは別の契機である。混ざると
   * どちらの契機で resume されたのかが区別できなくなるので、ここで一度払う。
   */
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return { pool, fake, stores, inbox };
}

/** 枠に当たった（もう通らない）通知。runner の `usage_notice` と同じ形。 */
function reached(): RunnerEvent {
  return {
    type: 'usage_notice',
    managerId: 'mgr-usage',
    notice: { kind: 'reached', text: "You've hit your individual spend limit for this account." },
  } as RunnerEvent;
}

/** 枠の失敗でターンが終わった回の報告（セッションは生きている）。 */
function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: 'mgr-usage',
    text: "[failed] You've hit your individual spend limit for this account.",
    status: 'done',
    failure: { code: 'usage_limit', via: 'result' },
  } as RunnerEvent;
}

/** 普通に終わったターンの報告（失敗の印が無い）。 */
function okReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: 'mgr-usage',
    text: '調べ終えた',
    status: 'done',
  } as RunnerEvent;
}

/** イベントを流したあと、`#onEvent` の非同期の中身が落ち着くまで待つ。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * **`ManagerPool#settleStalledUsageWakes()` の検証専用の足場。**
 *
 * `setup()`（直上）と同じ構成だが、`now` を差し替え可能にする——
 * `probeTurnEnds()` の費用の門（`updatedAt` から10分の静止）を跨ぐには、
 * 時計を進められる `now` が要る（`manager-turn-end.test.ts` の
 * `harnessOf()` と同じ作法。あちらから読んで倣った）。
 */
async function setupWithClock() {
  let clock = Date.now();
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  const fake = nudgeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock,
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  return {
    pool,
    fake,
    stores,
    inbox,
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

/**
 * JSONL の1行（assistant、本文つき、`stop_reason: end_turn`）。
 * `manager-turn-end.test.ts` の `assistantTextLine` と同じ形——この観点
 * だけに使う最小の複製で、シンボルを import して結合を増やさない
 * （あちらは同ファイル内のローカル関数で export されていない）。
 */
function turnEndLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp,
    message: {
      role: 'assistant',
      id: 'msg_settle_probe',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  });
}

/** `probeTurnEnds()` の費用の門（`updatedAt` から10分の静止）を跨ぐ猶予。 */
const PAST_QUIET_GATE_MS = 11 * 60_000;

describe('枠で止まった委譲を、鍵が通る状態へ戻った時点で続きから起こす', () => {
  it('枠でターンが死んだ委譲へ、続きを促す一言が生きたセッションへ届く（新しいセッションを開かない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
    expect(s.fake.sends[0]?.text).toContain('最初からやり直さないこと');
    // **同じ会話の続きである。** 新しいセッションを起こしていないこと。
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('セッションごと落ちていた（failed）委譲は、同じ sessionId の resume で続きへ戻す', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push({
      type: 'closed',
      managerId: 'mgr-usage',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: usage limit',
    } as RunnerEvent);
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s.fake.resumes).toHaveLength(1);
    // **同じ `sessionId` で開き直す ＝ 会話は続く。**
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s.fake.resumes[0]?.message).toContain('通る鍵に戻った');
  });

  it('⚠️ 自力でターンを終えた委譲は起こさない（`reached` が来ていても、失敗で終わっていなければ印は下りる）', async () => {
    const s = await setup();
    // 課金枠で通り切って、普通に報告した回（`reached` の通知はターン中に届く）。
    s.fake.push(reached());
    s.fake.push(okReport());
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('枠に当たっていない委譲は起こさない（印そのものが立たない）', async () => {
    const s = await setup();
    s.fake.push({
      type: 'usage_notice',
      managerId: 'mgr-usage',
      notice: { kind: 'transition', text: "You're now using extra usage until your limit resets." },
    } as RunnerEvent);
    s.fake.push(failedReport());
    await settle();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 人間・クローンが止めた委譲は甦らせず、印も永久には残らない（R4。判断は日誌に残る）', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();
    await s.pool.abort('mgr-usage');
    s.fake.sends.length = 0;
    s.fake.resumes.length = 0;

    // 止めた時点では、印（台帳の写し）はまだ立ったままである。
    const beforeAbortResume = await s.stores.jobs.listJobs();
    expect(beforeAbortResume[0]?.usageStoppedAt).toBeDefined();

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    // **`status=stopped` まで見る。** 「起こさなかった」だけを見ると、別の理由
    // （届かなかった・像が無かった）で起きなかった回と区別できない。
    const jobs = await s.stores.jobs.listJobs();
    expect(jobs[0]?.status).toBe('stopped');
    /*
     * **これが `'skipped'`（届かなかった）とは違う分岐であることの固定。**
     * `'skipped'` なら印を残すが、`stopped` は `'gone'`（起こしてはいけない
     * 相手）に分類され、印を下ろす——残すと、人間・クローンが止めた委譲の
     * 印が台帳に永久に残ってしまう（Issue #914 最終段）。
     */
    expect(jobs[0]?.usageStoppedAt).toBeUndefined();
    const entries = await s.stores.journal.list({ limit: 200 });
    expect(
      entries.some(
        (entry) =>
          entry.type === 'decision' &&
          entry.decision.includes('この委譲は起こし直さない') &&
          entry.decision.includes('status=stopped'),
      ),
    ).toBe(true);
  });

  /**
   * **⭐ 鍵が戻った瞬間に、その委譲がまだ走っていることがある。**
   *
   * いちばん普通の順序がこれである —— 枠に当たったのはこの委譲自身なので、
   * 回し手を起こすのもこの委譲の `usage_notice` である。回し手は撒いてから
   * `resumeStoppedByUsage()` を呼ぶが、**そのとき `report`（ターンが終わった）は
   * まだ届いていないことがある**（`#onEvent` は `void` で起こされるので並行に
   * 走る）。
   *
   * **そこで印を捨てると、この委譲は永久に止まったままになる** —— 回転はもう
   * 済んでいるので、次の契機が来ない（同じ鍵で回すことは #668 の門が止める）。
   */
  it('⭐ 起こしに行った時点でまだ走っていたら、そのターンが枠で終わった時点で起こす', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();

    // まだ走っている（`report` が来ていない）⟹ この回では起こせない。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    // ターンが枠で終わった。**ここで起こす。**
    s.fake.push(failedReport());
    await settle();

    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
  });

  /**
   * **⭐ 回ったのが「この委譲が枠に当たる前」でも起こす。**
   *
   * 別のマネージャー（かクローン）が枠に当たって鍵が回った直後、まだ古い鍵で
   * 走っていたこの委譲がそのターンで枠に落ちる形。**回転はもう済んでいるので、
   * 鍵の側からの契機は二度と来ない。**
   */
  it('⭐ 走っている最中に鍵が回っていれば、その後で枠に落ちた時点で起こす', async () => {
    const s = await setup();

    // 鍵が回った。この委譲はまだ枠に当たっていない（印も立っていない）。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    // そのまま古い鍵で走り続け、このターンで枠に落ちた。
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(s.fake.sends).toHaveLength(1);
  });

  it('⚠️ 鍵が戻ったと誰も言っていないなら、枠で終わっても起こさない（勝手に挑み直さない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    // ここで起こすと、**同じ鍵でもう一度当たるだけ**である。
    expect(s.fake.sends).toHaveLength(0);
    // 鍵が戻ったと言われた時点で起きる。
    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
  });

  it('⚠️ 鍵が回った時点で走っていても、そのターンが自力で終わったなら起こさない（1ターン焼かない）', async () => {
    const s = await setup();

    // 鍵が回った時点では走っていた（借りが立つ）。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    // そのターンは枠に当たらずに終わった ⟹ 起こす理由が無い。
    s.fake.push(okReport());
    await settle();

    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
  });

  it('⭐ 走っている最中に鍵が回り、その後セッションごと枠で落ちた回も起こす（report が出ない道）', async () => {
    const s = await setup();

    // 鍵が回った時点では走っていた。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    // **`report` は出ないまま `closed` だけが届く**（`runner.ts` の `#read` の
    // catch 節を通った回）。ここで起こさないと、この委譲は誰にも拾われない。
    s.fake.push(reached());
    s.fake.push({
      type: 'closed',
      managerId: 'mgr-usage',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: usage limit',
    } as RunnerEvent);
    await settle();

    expect(s.fake.resumes).toHaveLength(1);
    expect(s.fake.resumes[0]?.sessionId).toBe('sess-1');
  });

  it('⚠️ 陰性対照: 届いた回はこれまでどおり1回きり（`nudged` は印を下ろすので、二度目の回転で二重に投げない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(1);
  });

  /**
   * **⭐ Issue #914 最終段の本題。** 空振り（`send()` が届かない・投げる）は
   * `'skipped'` を返し、`'nudged'`（届いた）や `'gone'`（起こす相手がもう
   * 居ない・`stopped`）とは違って印を残す——残さないと、この委譲が次に拾われる
   * には新しい `usage_notice`（`kind === 'reached'`）が要り、それにはこの委譲
   * 自身がターンを回す必要がある。回すには誰かが起こす必要があり、起こす手段が
   * まさにこの機構である ⟹ 空振り1回で「クローンが手で `manager_send` を打つ
   * まで戻らない」に落ちる。ここが対象になるのは `done` / `failed` / `lost` の
   * どれで座っていても同じである（{@link Pool.#nudgeForUsageRotation} のホワイト
   * リスト）。
   */
  it('⭐ 空振りしても印が残り、次の回転で起こされる（`skipped` は下ろさない）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport()); // status → 'done'。usageStoppedAt が台帳に立つ。
    await settle();

    // **1回目は届かない**（`send()` が例外を投げる細工）。
    s.fake.behavior.sendMode = 'throw';
    const first = await s.pool.resumeStoppedByUsage();
    expect(first).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);

    // **印（台帳の写し）が残っている。** 空振りは `'gone'` ではない。
    const mid = await s.stores.jobs.listJobs();
    expect(mid[0]?.usageStoppedAt).toBeDefined();

    // **2回目は届く** ⟹ 残っていた印のおかげで、この委譲がまだ対象に入る。
    s.fake.behavior.sendMode = 'ok';
    const second = await s.pool.resumeStoppedByUsage();
    expect(second).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);

    // 実際に届いた後は、これまでどおり印が下りる。
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();
  });

  it('⭐ 空振りの後にデーモンが入れ替わっても、写しが残っているので新しい Pool が起こす', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    // 空振り。印は同じデーモンのプロセス内にも、台帳の写しにも残る。
    s.fake.behavior.sendMode = 'throw';
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    // **デーモンの入れ替わり。** 新しい Pool はプロセス内の `Set` を持たない
    // ——台帳の写し（`Job.usageStoppedAt`）だけが頼りである（Issue #914 段2と
    // 同じ仕組みを、空振りを跨いだ場合について固定する）。
    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    // 新しい Pool には生きたセッションが無いので resume 経由で届く。
    expect(s2.fake.resumes).toHaveLength(1);
    expect(s2.fake.resumes[0]?.sessionId).toBe('sess-1');
  });
});

/**
 * **印（`#usageStopped`）を台帳へ写す（Issue #914 段2）。**
 *
 * 上の一群は同じ `ManagerPool`（＝同じデーモンのプロセス）の中で完結している。
 * ここが固定するのは、**デーモンが作り直された後**——プロセス内の `Set` が
 * 空から始まる新しい `ManagerPool` でも、台帳に残った `Job.usageStoppedAt`
 * から `resumeStoppedByUsage()` の対象を組み直せること——である
 * （`reopen()` が「新しいデーモン」の役を演じる）。
 *
 * **何が起こす対象になり、何がならないか**が本題。陽性（マークが残っている）と
 * 陰性（マークが無い・自力で消えた・一度使われた・諦めで畳まれた）を両方
 * 固定する。
 */
describe('枠で止まった印を台帳へ持たせ、デーモンの入れ替わりを跨いで起こす（Issue #914 段2）', () => {
  it('入れ替わりを跨いで起こす: 台帳に usageStoppedAt が立ち、新しい Pool（status=done）がそれを読んで起こす', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport()); // status → 'done'（セッションは生きている想定の終わり方）
    await settle();

    // **台帳に写しが立っている。** これが無いと次の起動で復元できない。
    const before = await s.stores.jobs.listJobs();
    expect(before[0]?.status).toBe('done');
    expect(before[0]?.usageStoppedAt).toBeDefined();

    // **デーモンの入れ替わり。** 新しい Pool はプロセス内の `#usageStopped` を
    // 持たずに生まれる——台帳の写しだけが頼りである。
    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    // 新しい Pool には生きたセッションが無い（`attach` されていない）ので、
    // resume 経由で届く——`resumes` 側に載る（既存の「セッションごと落ちていた」
    // 検証と同じ形）。
    expect(s2.fake.resumes).toHaveLength(1);
    expect(s2.fake.resumes[0]?.sessionId).toBe('sess-1');
    expect(s2.fake.resumes[0]?.message).toContain('通る鍵に戻った');
  });

  it('入れ替わりを跨いで起こす: status=lost で座っている分も拾える（#restoreJobs の continue を跨ぐ）', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push({
      type: 'resume_failed',
      managerId: 'mgr-usage',
      sessionId: 'sess-1',
      reason: '前のセッションが見つからなかった',
      recovered: false,
    } as RunnerEvent);
    await settle();

    /*
     * ⚠️ **このジョブ自体は `resume_failed`（回復せず）で帳簿ごと畳まれている**
     * （下の「resume_failed で帳簿が畳まれる」検証が本題）。ここでは
     * `usageStoppedAt` が残っている状態を人為的に作り直し、**`#restoreJobs` が
     * `lost` を `continue` した後でも、印の復元（`this.#records.has` 直後）は
     * 通っていること**だけを測る——`#nudgeForUsageRotation` のホワイトリストに
     * `lost` が載っているので、印さえ復元できれば起こせる。
     */
    const stuck = await s.stores.jobs.listJobs();
    expect(stuck[0]?.status).toBe('lost');
    await s.stores.jobs.putJob({ ...stuck[0]!, usageStoppedAt: '2026-09-10T00:00:00.000Z' });

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s2.fake.resumes).toHaveLength(1);
    expect(s2.fake.resumes[0]?.sessionId).toBe('sess-1');
  });

  it('⚠️ 陰性対照: 印の無い委譲は、入れ替わりの後も起こされない（枠以外で落ちた委譲を起こさない）', async () => {
    const s = await setup();
    // **`reached()` を一度も流していない。** 枠とは無関係に終わった委譲。
    s.fake.push({
      type: 'closed',
      managerId: 'mgr-usage',
      status: 'failed',
      reason: 'マネージャーのセッションが落ちた: 何か別の理由',
    } as RunnerEvent);
    await settle();

    const before = await s.stores.jobs.listJobs();
    expect(before[0]?.status).toBe('failed');
    expect(before[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    // **起こす対象に一切入らない。** Issue #914 が段1の受け入れ条件として
    // 名指ししている歯——枠以外で落ちた委譲を、鍵の回転で誤って起こさない。
    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 自力でターンを終えた委譲は、台帳からも印が消える', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(okReport()); // 失敗の印を伴わない = 自力で完走した
    await settle();

    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('一度起こしたら、入れ替わりの後に二度は起こさない', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    // **同じデーモンの中で、鍵の回転が1回来た。**
    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);

    // **起こした時点で、台帳からも印が下りている。**
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    // **その後にデーモンが入れ替わっても、二度目は起こらない。**
    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('resume_failed（recovered: false）で帳簿が畳まれる: 台帳の印が消え、新しい Pool はもう起こさない', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();
    const stopped = await s.stores.jobs.listJobs();
    expect(stopped[0]?.usageStoppedAt).toBeDefined();

    s.fake.push({
      type: 'resume_failed',
      managerId: 'mgr-usage',
      sessionId: 'sess-1',
      reason: '前のセッションが見つからなかった',
      recovered: false,
    } as RunnerEvent);
    await settle();

    /*
     * **これが Issue #914 段2 の本題である。** `#retire()` が像を消し台帳を
     * `lost` にする——それだけでは、台帳に残った `usageStoppedAt` が
     * 「次のデプロイでまた同じ死体を起こしに行く」リークを作る。
     */
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('lost');
    expect(after[0]?.usageStoppedAt).toBeUndefined();

    const s2 = await reopen(s.stores);
    const nudged = await s2.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s2.fake.resumes).toHaveLength(0);
    expect(s2.fake.sends).toHaveLength(0);
  });

  it('対照: resume_failed（recovered: true）では印を落とさない（新しいセッションのターンが枠で終われば、まだ起こす対象）', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();

    s.fake.push({
      type: 'resume_failed',
      managerId: 'mgr-usage',
      sessionId: 'sess-1',
      reason: '前のセッションが見つからなかったが、新しいセッションで開けた',
      recovered: true,
    } as RunnerEvent);
    await settle();

    // **`recovered: true` の枝はこの変更が触っていない。** 新しいセッションが
    // 走り出しただけで、そのターンが枠で終わるかどうかはまだ分からない——
    // 印は残ったままで正しい（そのターンが枠で終われば `case 'report'` /
    // `case 'closed'` が `#settleUsageWake` 経由で清算する）。
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.usageStoppedAt).toBeDefined();
  });
});

/**
 * **`ManagerPool#settleStalledUsageWakes()`（Issue #914 最終段）。**
 *
 * ## 埋める穴
 *
 * `resumeStoppedByUsage()` は、鍵が戻った時点でまだ `running` だった委譲を
 * 借り（`#usageWakeOwed`）へ載せて見送る。その借りを返す口は `case 'report'`
 * と `case 'closed'` の2箇所しかない —— **そのセッションが二度と `report` も
 * `closed` も出さないまま黙った場合**（429 でターンが終わったのにデーモンまで
 * 届かない等）、借りは永久に返らず、台帳の `status` は `running` のまま固まる
 * （Issue #914 の 2026-09-14T20:19Z のコメント、2026-09-16 の再発）。
 *
 * `ManagerPool#probeTurnEnds()`（Issue #567）が計算し直す `turnEndedAt` を、
 * `record.job.lastReportAt` と突き合わせて「ターンは終わっているのに、その
 * 報告がまだ届いていない」と読めたときだけ、既存の一言（`#nudgeForUsageRotation`
 * の `send()`）を1本だけ届ける。
 *
 * ## 4条件（1つでも欠けたら発火しない）
 *
 * 1. `#usageWakeOwed` に借りが立っている
 * 2. `#usageStopped` の印（枠で止まった）が立っている
 * 3. `record.job.status === 'running'`（`waiting_human` は含めない）
 * 4. `record.turnEndedAt` が在り、`record.job.lastReportAt` が無いか
 *    それより後
 *
 * **何が対象になり、何がならないかを固定する。** 各 `it` の名前がその軸を
 * 名指しする。
 */
describe('ManagerPool#settleStalledUsageWakes — report/closed を二度と出さないまま固まった借りを清算する（Issue #914 最終段）', () => {
  it('⭐ 4条件が揃うと一言が届く。record.job.status は書き換えない（stopped/lost に落ちない）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();

    // 鍵が戻った。まだ走っている ⟹ 借りが立つ（このターンでは起こせない）。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    /*
     * **このセッションは、この後 report も closed も二度と出さない**
     * （429 でターンが終わったのにデーモンまで届かない、という想定そのもの）。
     * `probeTurnEnds()` だけが「ターンは終わっているらしい」と気づく。
     */
    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('ここでターンが枠の壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();

    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBe('2026-09-07T02:00:00.000Z');
    expect(probed?.status).toBe('running');
    // 条件4の「lastReportAt が無い」側——report は一度も届いていない。
    const before = await s.stores.jobs.listJobs();
    expect(before[0]?.lastReportAt).toBeUndefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
    expect(s.fake.sends[0]?.text).toContain('通る鍵に戻った');
    // **同じ会話の続きである。** 新しいセッションを起こしていないこと。
    expect(s.fake.resumes).toHaveLength(0);

    // **`record.job.status` を勝手に書き換えていない。** `send()` の中で
    // status が動くのは既存の挙動（届いた委譲は 'running' のまま）だが、
    // `stopped` / `lost` へは落ちていない。
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('running');
    // 起こせたと分かったので、枠の印は下りる。
    expect(after[0]?.usageStoppedAt).toBeUndefined();
  });

  it('⚠️ 陰性対照: turnEndedAt が無ければ発火しない（「分からない」を症状へ倒さない）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]); // 借りが立つ

    // **`probeTurnEnds()` を一度も呼んでいない** ⟹ `turnEndedAt` は付かない。
    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBeUndefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    // 印は残ったまま——清算されていない。
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.status).toBe('running');
    expect(after[0]?.usageStoppedAt).toBeDefined();
  });

  it('⚠️ 陰性対照: turnEndedAt が lastReportAt 以前なら発火しない（報告は届いている）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]); // 1回目の借り

    /*
     * **報告は実際に届いている（`lastReportAt` が進む）。** ただし `status` は
     * `running` のまま続く——枠に当たったまま作業自体は続いている、という
     * やや作為的な形だが、ここで確かめたいのは「`lastReportAt` が在れば
     * `turnEndedAt` と正しく突き合わせられる」ことだけである。この報告で
     * `#settleUsageWake` が呼ばれ、1回目の借りはここで消費される
     * （`status: 'running'` なので `'still-running'` に落ちて何も起こさない）。
     */
    s.fake.push({
      type: 'report',
      managerId: 'mgr-usage',
      text: '進捗の途中経過（まだ続く）',
      status: 'running',
      failure: { code: 'usage_limit', via: 'result' },
    } as RunnerEvent);
    await settle();

    const midJobs = await s.stores.jobs.listJobs();
    const lastReportAt = midJobs[0]?.lastReportAt;
    expect(lastReportAt).toBeDefined();
    expect(s.fake.sends).toHaveLength(0);

    // 1回目の借りはこの報告で消費された。もう一度、走っている最中に鍵が
    // 回ったことにして借りを立て直す（条件1を満たすためだけの操作。
    // `lastReportAt` には触れない）。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);

    // `turnEndedAt` を `lastReportAt` より前にする。
    const before = new Date(Date.parse(lastReportAt!) - 60_000).toISOString();
    s.fake.setTranscript('mgr-usage', turnEndLine('まだ届いていた頃のテール', before));
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();

    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBe(before);

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 借りが立っていなければ発火しない（鍵が戻ったと誰も言っていない）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    // **`resumeStoppedByUsage()` を一度も呼んでいない** ⟹ 借り
    // （`#usageWakeOwed`）が立たない。

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();
    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBeDefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: 枠の印（usageStopped）が無ければ発火しない（枠以外の理由で長く走っている委譲を掃かない）', async () => {
    const s = await setupWithClock();
    // **`reached()` を一度も流していない。** 枠とは無関係に長く走っているだけ。
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]); // 借りは status=running なので立つ

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('枠以外の理由で長く働いているだけ', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();
    const probed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probed?.turnEndedAt).toBeDefined();

    const nudged = await s.pool.settleStalledUsageWakes();

    // **一般の停滞検知になっていないことの固定。** 借り・turnEndedAt が
    // 揃っていても、枠の印（`usageStopped`）が無ければ何もしない。
    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  it('⚠️ 陰性対照: waiting_human は起こさない（待っているのは枠ではなく人間の回答である）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]); // 借りが立つ（running）

    // **`turnEndedAt` は running のうちに立てておく**（`probeTurnEnds()` の
    // 費用の門は `status === 'running'` だけを引くので、`waiting_human` に
    // なった後では立てられない——条件3だけを切り出して確かめるための順序）。
    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();
    const probedBefore = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-usage');
    expect(probedBefore?.turnEndedAt).toBeDefined();

    // ここで人間の回答待ちへ移る。
    s.fake.push({
      type: 'ask',
      managerId: 'mgr-usage',
      requestId: 'req-1',
      kind: 'question',
      summary: '続けてよいか確認したい',
    } as RunnerEvent);
    await settle();
    const waiting = await s.stores.jobs.listJobs();
    expect(waiting[0]?.status).toBe('waiting_human');

    const nudged = await s.pool.settleStalledUsageWakes();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
  });

  /**
   * **⭐ Issue #914 最終段の本題そのもの。** 空振り（`send()` が届かない）は
   * `resumeStoppedByUsage()` の規則と同じで、借りは（挑む前に）下ろすが印
   * （`#usageStopped` / `Job.usageStoppedAt`）は残す——残さないと、次の鍵の
   * 回転（`resumeStoppedByUsage()`）が再び借りを立てても、この委譲がもう
   * 拾えなくなる（枠の印そのものが無ければ、`settleStalledUsageWakes()` は
   * 条件2で弾く）。
   */
  it('空振り（send() が届かない）のとき、借りは下りるが印は残る（次の鍵の回転が拾い直す）', async () => {
    const s = await setupWithClock();
    s.fake.push(reached());
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]); // 借りが立つ

    s.fake.setTranscript(
      'mgr-usage',
      turnEndLine('壁に当たって切れた', '2026-09-07T02:00:00.000Z'),
    );
    s.advance(PAST_QUIET_GATE_MS);
    await s.pool.probeTurnEnds();

    // **空振りを作る細工**（`nudgeRunner()` の doc）。
    s.fake.behavior.sendMode = 'throw';
    const first = await s.pool.settleStalledUsageWakes();

    expect(first).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    // **印（台帳の写し）は残っている。** 空振りは `'gone'` ではない。
    const mid = await s.stores.jobs.listJobs();
    expect(mid[0]?.usageStoppedAt).toBeDefined();
    expect(mid[0]?.status).toBe('running');

    // **借りは挑む前に下ろしてある**——同じ回では二度と対象に入らない
    // （条件1が外れる）。
    const again = await s.pool.settleStalledUsageWakes();
    expect(again).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);

    /*
     * **次の鍵の回転**（`resumeStoppedByUsage()`。実際の token rotation の
     * 契機）が来ると、借りが立て直される——印がまだ残っているおかげで、
     * この委譲はまだ対象である。`resumeStoppedByUsage()` 自身は `running`
     * を起こさない（ホワイトリストが素通しにするのは `done` / `failed` /
     * `lost` だけ）ので、実際に届けるのは次の `settleStalledUsageWakes()`
     * である。
     */
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    s.fake.behavior.sendMode = 'ok';
    const recovered = await s.pool.settleStalledUsageWakes();

    expect(recovered).toEqual(['mgr-usage']);
    expect(s.fake.sends).toHaveLength(1);
    const after = await s.stores.jobs.listJobs();
    expect(after[0]?.usageStoppedAt).toBeUndefined();
  });
});
