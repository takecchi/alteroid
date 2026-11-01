import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPoolOptions } from './manager.js';
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

// 使用量の起こし直し（`manager-usage-resume` ほか）を、掃きの側を別のクラスへ切り出しても崩さないための縛り。
// 公開の口（ManagerPool のメソッドと偽の runner・store）だけで書く。Pool の非公開の欄は読まない。

const ID = 'mgr-usage-guards';

const JOB: Job = {
  id: ID,
  managerId: ID,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-guards',
  runnerId: 'runner-primary',
};

const LIMIT_TEXT = "You've hit your weekly limit · resets Oct 30, 3am (UTC)";

type Availability = 'ready' | 'cooling' | 'disabled' | 'invalidated' | undefined;

function fakeRunner(log: string[]) {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const control = { failDelivery: false, background: 0 };
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd: string }> {
      return { cwd: command.cwd };
    },
    async resume(command): Promise<{ cwd: string }> {
      log.push(`resume:${command.message ?? ''}`);
      resumes.push(command);
      if (control.failDelivery) throw new Error('この検証が仕込んだ resume の失敗');
      alive.push({
        liveBackgroundTasks: 0,
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return { cwd: command.cwd };
    },
    async send(managerId, text) {
      log.push(`send:${text}`);
      sends.push({ managerId, text });
      return !control.failDelivery;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      if (control.failDelivery) return [];
      return alive.map((state) => ({
        ...state,
        waiting: [],
        liveBackgroundTasks: control.background,
      }));
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
    control,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function setup(
  options: {
    job?: Job;
    availability?: ManagerPoolOptions['tokenAvailability'];
    // 立てると、世代ごとに別の鍵（tok-gen1・tok-gen2…）として名乗り、世代 1 の鍵は常に冷却中と答える（古い鍵を抱えたまま新しい鍵へ回った形）
    keyPerGeneration?: boolean;
    stores?: ReturnType<typeof createMemoryStores>;
  } = {},
) {
  const stores = options.stores ?? createMemoryStores();
  if (options.stores === undefined) await stores.jobs.putJob(options.job ?? JOB);
  const log: string[] = [];
  const fake = fakeRunner(log);
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const clock = { now: Date.parse('2026-10-26T00:00:00.000Z') };
  // `hold`: 立てると、鍵の通る状態の問い合わせ（tokenAvailability）が外から外すまで返らない（掃きの途中の await に割り込むため）
  const key = {
    generation: 1,
    availability: 'ready' as Availability,
    hold: undefined as Promise<void> | undefined,
  };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => clock.now,
    tokenIdentity: () => ({
      tokenId: options.keyPerGeneration === true ? `tok-gen${String(key.generation)}` : 'tok-a',
      generation: key.generation,
    }),
    tokenAvailability:
      options.availability ??
      (async (tokenId) => {
        await key.hold;
        if (options.keyPerGeneration === true && tokenId === 'tok-gen1') return 'cooling';
        return key.availability;
      }),
    onUsageObservation: async (observation) => {
      log.push(`observation:${observation.notice.kind}`);
    },
  });
  await pool.restore();
  fake.resumes.length = 0;
  fake.sends.length = 0;
  log.length = 0;
  return { pool, fake, stores, inbox, clock, key, log };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function failedReport(): RunnerEvent {
  return {
    type: 'report',
    managerId: ID,
    text: `[failed] ${LIMIT_TEXT}`,
    status: 'done',
    failure: { code: 'rate_limit', via: 'assistant', status: 429 },
  } as RunnerEvent;
}

function workerLimitNote(preRotationKey: boolean): RunnerEvent {
  return {
    type: 'note',
    managerId: ID,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    workerLimit: { raw: "You've hit your weekly limit", preRotationKey },
  } as RunnerEvent;
}

function closedBy429(): RunnerEvent {
  return {
    type: 'closed',
    managerId: ID,
    status: 'failed',
    reason:
      "マネージャーのセッションが落ちた: You've hit your individual spend limit for this account.",
  } as RunnerEvent;
}

function closedDone(): RunnerEvent {
  return { type: 'closed', managerId: ID, status: 'done' } as RunnerEvent;
}

function doneReport(): RunnerEvent {
  return { type: 'report', managerId: ID, text: '終わった', status: 'done' } as RunnerEvent;
}

// 鍵が通らない間に枠で failed になり、像から外れた担当（`manager-usage-retired-sweep.test.ts` と同じ状態）を用意する
async function retiredByQuota(s: Setup): Promise<void> {
  s.key.availability = 'cooling';
  s.fake.push(closedBy429());
  await settle();
  const job = (await s.stores.jobs.listJobs())[0];
  expect(job?.status).toBe('failed');
  expect(job?.usageStoppedAt).toBeDefined();
  expect(s.fake.resumes).toHaveLength(0);
  s.key.generation = 2;
  s.key.availability = 'ready';
  // 「止まった後に戻った」と言える材料を、世代の食い違いとは別にも置く: 別の経路が起こして抱える世代が現役と揃っても、掃きの判定そのものは「戻った」のままになる
  // （この材料が無いと、判定が偽になって読み直しの歯に届く前に止まる）
  await s.stores.tokens.replace([
    {
      id: 'tok-a',
      label: 'a',
      order: 0,
      updatedAt: new Date(s.clock.now + 60_000).toISOString(),
    },
  ]);
  s.clock.now += 120_000;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// 台帳の読み（getJob）のうち、仕掛けた後の最初の1回だけを外から外すまで返さない（掃きの `#findJob` / `#load` の await に割り込むため）
function holdNextJobRead(s: Setup): () => void {
  const gate = deferred();
  const original = s.stores.jobs.getJob.bind(s.stores.jobs);
  let armed = true;
  s.stores.jobs.getJob = async (id) => {
    if (!armed) return original(id);
    armed = false;
    const job = await original(id);
    await gate.promise;
    return job;
  };
  return gate.release;
}

async function decisionTexts(s: Setup, needle: string): Promise<string[]> {
  return (await s.stores.journal.list({ types: ['decision'] }))
    .map((entry) => JSON.stringify(entry))
    .filter((text) => text.includes(needle));
}

const SWEEP_DECISION = '枠で落ちて像から外れた担当を、掃きで起こし直す';

describe('掃きの最中に担当の状態が変わったら、掃きは古い状態で起こし直さない（await のあとの読み直し）', () => {
  it('⭐ 像から外れた担当の掃きが鍵の状態の問い合わせで待っている間に、回し手が起こして印を下ろしたら、掃きは重ねて起こさない', async () => {
    const s = await setup();
    await retiredByQuota(s);
    const hold = deferred();
    s.key.hold = hold.promise;

    const sweep = s.pool.settleStalledUsageWakes();
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect(s.fake.resumes).toHaveLength(1);
    hold.release();

    expect(await sweep).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
    expect(await decisionTexts(s, SWEEP_DECISION)).toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });

  it('⭐ 掃きが台帳を読んでいる間に、回し手が起こして印を下ろしたら、掃きは重ねて起こさない', async () => {
    const s = await setup();
    await retiredByQuota(s);
    const release = holdNextJobRead(s);

    const sweep = s.pool.settleStalledUsageWakes();
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect(s.fake.resumes).toHaveLength(1);
    release();

    expect(await sweep).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
    expect(await decisionTexts(s, SWEEP_DECISION)).toEqual([]);
    await s.pool.stop();
  });

  it('掃きが台帳を読んでいる間に、人が止めた（stopped）担当は、掃きでは起こされず stopped のまま', async () => {
    const s = await setup();
    await retiredByQuota(s);
    const release = holdNextJobRead(s);

    const sweep = s.pool.settleStalledUsageWakes();
    await settle();
    await s.pool.abort(ID);
    release();

    expect(await sweep).toEqual([]);
    expect(s.fake.resumes).toHaveLength(0);
    expect((await s.stores.jobs.listJobs())[0]?.status).toBe('stopped');
    await s.pool.stop();
  });

  it('⭐ 作業者の上限の掃きが鍵の状態の問い合わせで待っている間に、回し手が担当を起こしたら、掃きは二度目を送らない', async () => {
    const s = await setup();
    s.key.availability = 'cooling';
    s.fake.push(workerLimitNote(true));
    s.fake.push(doneReport());
    await settle();
    expect(s.log).toEqual([]);
    s.key.availability = 'ready';
    const hold = deferred();
    s.key.hold = hold.promise;

    const sweep = s.pool.settleStalledUsageWakes();
    await settle();
    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    const nudges = (): string[] =>
      s.log.filter((line) => line.includes('作業者が上限で落ちた鍵は回った'));
    expect(nudges()).toHaveLength(1);
    hold.release();

    expect(await sweep).toEqual([]);
    expect(nudges()).toHaveLength(1);
    // 掃きが「起こし直す」と判断した跡（日誌）も、回し手の1回きり
    expect(
      await decisionTexts(s, '作業者が上限で落ちた鍵は回ったので、担当を起こし直す'),
    ).toHaveLength(1);
    await s.pool.stop();
  });

  it('⭐ 作業者の上限の掃きが台帳を読んでいる間に、担当が新しいターンを始めたら、掃きは起こさず印を下ろす', async () => {
    const s = await setup();
    s.key.availability = 'cooling';
    s.fake.push(workerLimitNote(true));
    s.fake.push(doneReport());
    await settle();
    s.fake.push(closedDone());
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.workerLimitStopped).toBeDefined();
    s.key.availability = 'ready';
    const release = holdNextJobRead(s);

    const sweep = s.pool.settleStalledUsageWakes();
    await settle();
    // 時計は進める: ターンの開始時刻が同じ値のままだと「新しいターン」と読まれない
    s.clock.now += 60_000;
    await s.pool.send(ID, '新しい指示');
    await settle();
    release();

    expect(await sweep).toEqual([]);
    expect(s.log.filter((line) => line.includes('作業者が上限で落ちた鍵は回った'))).toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.workerLimitStopped).toBeUndefined();
    await s.pool.stop();
  });
});

// `#retire`（終端で像から外す）は、使用量の8つの欄のどれも消さない。畳んだ後こそ読む所が在るため
// （枠で止まった担当の起こし直しと掃き・一覧・作業者の上限の掃き）。公開の口から、残っていることを欄ごとに見る。
describe('像から外れた（終端した）後も、使用量の欄は残る', () => {
  it('⭐ 枠で止まった印（usageStopped）と resets 時刻の突き合わせ（resetTimeSkewMatch）は、一覧（像が無いときは台帳から作る行）にそのまま出る', async () => {
    const s = await setup();
    const resetTarget = Date.parse('2026-10-26T12:00:00.000Z');
    await s.stores.tokens.replace([
      {
        id: 'tok-old',
        label: 'old',
        order: 0,
        cooldownUntil: resetTarget,
        cooldownSource: 'quota_reset',
      },
      { id: 'tok-a', label: 'a', order: 1 },
    ]);
    await s.stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 2,
      rotatedAt: '2026-10-25T00:00:00.000Z',
    });
    s.key.availability = 'cooling';
    s.fake.push({
      type: 'usage_notice',
      managerId: ID,
      notice: {
        kind: 'reached',
        text: "You've hit your session limit · resets 9:00pm (Asia/Tokyo)",
      },
    } as RunnerEvent);
    await settle();
    const live = (await s.pool.list()).find((m) => m.managerId === ID);
    expect(live?.resetTimeSkewMatch).toBe('stale');
    expect(live?.usageStoppedAt).toBeDefined();

    s.fake.push(closedBy429());
    await settle();

    // 像から外れた（終端）後の行は台帳から作る
    const retired = (await s.pool.list()).find((m) => m.managerId === ID);
    expect(retired?.status).toBe('failed');
    expect(retired?.usageStoppedAt).toBeDefined();
    expect(retired?.resetTimeSkewMatch).toBe('stale');
    await s.pool.stop();
  });

  it('⭐ 作業者の上限の印（workerLimitStopped）は残り、done で終端した担当を次の掃きが起こす', async () => {
    const s = await setup();
    s.key.availability = 'cooling';
    s.fake.push(workerLimitNote(true));
    s.fake.push(doneReport());
    await settle();
    s.fake.push(closedDone());
    await settle();
    expect((await s.stores.jobs.listJobs())[0]?.workerLimitStopped).toBeDefined();
    expect(s.log).toEqual([]);

    s.key.availability = 'ready';
    expect(await s.pool.settleStalledUsageWakes()).toEqual([ID]);
    expect(s.log.filter((line) => line.includes('作業者が上限で落ちた鍵は回った'))).not.toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.workerLimitStopped).toBeUndefined();
    await s.pool.stop();
  });

  it('⭐ 挑み直しの状態（usageWakeRetry）は残り、掃きが起こしに失敗した担当は、終端して像から外れても次の挑み直しまで再挑戦しない', async () => {
    const s = await setup();
    await retiredByQuota(s);
    s.fake.control.failDelivery = true;
    // 1回目: 届かない（挑み直しの状態に乗る。担当は像へ載る）
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toHaveLength(1);
    expect(await decisionTexts(s, SWEEP_DECISION)).toHaveLength(1);
    // 人が止めて像から外れる（終端）。印と挑み直しの状態は残る
    await s.pool.abort(ID);
    s.fake.control.failDelivery = false;
    s.fake.resumes.length = 0;
    s.fake.sends.length = 0;

    // 次の挑み直しの時刻（1分後）より前: 像が無くても、挑み直しの状態が残っているので、像から外れた担当の掃き（#5166）の候補にならない。
    // 状態が消えていれば、掃きは起こし直すと判断した跡（日誌）を新しく書く
    s.clock.now += 30_000;
    expect(await s.pool.settleStalledUsageWakes()).toEqual([]);
    expect(s.fake.resumes).toEqual([]);
    expect(s.fake.sends).toEqual([]);
    expect(await decisionTexts(s, SWEEP_DECISION)).toHaveLength(1);
    await s.pool.stop();
  });
});

describe('使用量の印の変化は、預かった伝言の届け直しがそのまま見る', () => {
  it('⭐ 動いている間に枠で止まった担当の預かりは、届けずに預かったまま。印が外れる（起こし直される）と届く', async () => {
    const s = await setup({ keyPerGeneration: true });
    s.fake.push(doneReport());
    await settle();
    // 鍵が回った後で背景処理を抱えた done へ送った伝言は預かられる
    s.fake.control.background = 1;
    s.key.generation = 2;
    expect((await s.pool.send(ID, '起こし直した後に読む伝言')).outcome).toBe('held');
    // 鍵が通らない間に、そのセッションが枠で落ちる（印が動いている Pool の中で立つ）
    s.key.availability = 'cooling';
    s.fake.push(closedBy429());
    await settle();
    const stopped = (await s.pool.list()).find((m) => m.managerId === ID);
    expect(stopped?.status).toBe('failed');
    expect(stopped?.usageStoppedAt).toBeDefined();
    s.fake.control.background = 0;
    s.fake.resumes.length = 0;
    s.fake.sends.length = 0;

    // 印の立つ failed・lost は終端ではない: 預かりは届けも捨てもしない（起こし直しを待つ）
    await s.pool.deliverHeldMessages?.();
    await settle();
    expect(s.fake.resumes).toEqual([]);
    expect(s.fake.sends).toEqual([]);
    expect((await s.stores.jobs.listJobs())[0]?.heldMessages?.map((item) => item.text)).toEqual([
      '起こし直した後に読む伝言',
    ]);

    // 鍵が通って起こし直されると印が外れ、同じ Pool の次の届け直しが預かりを届ける
    s.key.availability = 'ready';
    expect(await s.pool.resumeStoppedByUsage()).toEqual([ID]);
    expect((await s.pool.list()).find((m) => m.managerId === ID)?.usageStoppedAt).toBeUndefined();
    await s.pool.deliverHeldMessages?.();
    await settle();
    const delivered = [
      ...s.fake.resumes.map((r) => r.message ?? ''),
      ...s.fake.sends.map((x) => x.text),
    ].join('\n');
    expect(delivered).toContain('起こし直した後に読む伝言');
    expect((await s.stores.jobs.listJobs())[0]?.heldMessages ?? []).toEqual([]);
    await s.pool.stop();
  });
});

describe('1つの報告で使用量・作業者の上限・鍵の回転の3条件が全部立ったときの呼ぶ順', () => {
  it('⭐ 失敗の報告 1 つに対し、使用量の起こし直し → 作業者の上限の起こし直し → 鍵の回転の依頼の順で走る（case report の枝）', async () => {
    const s = await setup();
    // 借り: 走っている最中に回し手が resumeStoppedByUsage を呼んだ形（印はまだ無い）
    expect(await s.pool.resumeStoppedByUsage()).toEqual([]);
    // 作業者の落ち（回転前の鍵）。印は担当が done で終わった時点の判定が拾う
    s.fake.push(workerLimitNote(true));
    await settle();
    // どの起こし直しも届かない（印は残り、3つ目の条件まで落ちずに通る）
    s.fake.control.failDelivery = true;
    s.log.length = 0;

    s.fake.push(failedReport());
    await settle();

    const steps = s.log
      .map((line) => {
        if (line.startsWith('observation:')) return 'rotation-request';
        if (line.includes('作業者が上限で落ちた鍵は回った')) return 'worker-limit-wake';
        if (line.includes('通る鍵に戻った')) return 'usage-wake';
        return line;
      })
      .filter((step, at, all) => all.indexOf(step) === at);
    // 使用量の起こし直し（届けるために送りも resume も試すので、同じ段の連続は 1 つに畳む）が先、作業者の上限が次、鍵の回転の依頼が最後
    expect(steps).toEqual(['usage-wake', 'worker-limit-wake', 'rotation-request']);
    await s.pool.stop();
  });
});
