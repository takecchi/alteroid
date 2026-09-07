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
function nudgeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];

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
      sends.push({ managerId, text });
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
    sends,
    resumes,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
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

  it('人間・クローンが止めた委譲は甦らせない（R4。判断は日誌に残る）', async () => {
    const s = await setup();
    s.fake.push(reached());
    await settle();
    await s.pool.abort('mgr-usage');
    s.fake.sends.length = 0;
    s.fake.resumes.length = 0;

    const nudged = await s.pool.resumeStoppedByUsage();

    expect(nudged).toEqual([]);
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    // **`status=stopped` まで見る。** 「起こさなかった」だけを見ると、別の理由
    // （届かなかった・像が無かった）で起きなかった回と区別できない。
    const jobs = await s.stores.jobs.listJobs();
    expect(jobs[0]?.status).toBe('stopped');
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

  it('挑むのは1回きり。2度目の回転で同じ委譲へ二重に投げない', async () => {
    const s = await setup();
    s.fake.push(reached());
    s.fake.push(failedReport());
    await settle();

    expect(await s.pool.resumeStoppedByUsage()).toEqual(['mgr-usage']);
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    expect(s.fake.sends).toHaveLength(1);
  });
});
