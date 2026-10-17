import { describe, expect, it } from 'vitest';

import {
  composeHeldDelivery,
  createManagerPool,
  HELD_MESSAGE_TTL_MS,
  HELD_FORCE_FOLD_AFTER_MS,
  HELD_MESSAGES_MAX_COUNT,
  type ManagerSummary,
} from './manager.js';
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
import { describeHeldMessages } from './tools.js';

const JOB: Job = {
  id: 'mgr-held',
  managerId: 'mgr-held',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

// 背景処理の本数を後から変えられる偽の runner（`manager-send-stale-token.test.ts` と同じ形）。
function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const sends: { managerId: string; text: string }[] = [];
  const resumes: RunnerResumeCommand[] = [];
  const stops: string[] = [];
  const behavior: {
    background: number;
    waiting: RunnerManagerState['waiting'];
    failResume: boolean;
    peers: number | undefined;
    commands: string[] | undefined;
  } = {
    background: 0,
    peers: undefined,
    commands: undefined,
    waiting: [],
    failResume: false,
  };

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(command): Promise<{ cwd?: string }> {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
      });
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      if (behavior.failResume) throw new Error('resume が落ちた');
      resumes.push(command);
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return {};
    },
    async send(managerId, text) {
      sends.push({ managerId, text });
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      stops.push(managerId);
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return alive.map((state) => ({
        ...state,
        waiting: behavior.waiting,
        liveBackgroundTasks: behavior.background,
        ...(behavior.peers === undefined ? {} : { liveBackgroundPeers: behavior.peers }),
        ...(behavior.commands === undefined ? {} : { backgroundTaskCommands: behavior.commands }),
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
    stops,
    behavior,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type Stores = ReturnType<typeof createMemoryStores>;

async function setup(options: { stores?: Stores; job?: Job; clock?: { now: number } } = {}) {
  const stores = options.stores ?? createMemoryStores();
  if (options.stores === undefined) await stores.jobs.putJob(options.job ?? JOB);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const active = { tokenId: 'tok-a', generation: 59 };
  const clock = options.clock ?? { now: Date.parse('2026-10-11T02:00:00.000Z') };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    tokenIdentity: () => ({ ...active }),
    now: () => clock.now,
  });
  await pool.restore();
  if (options.stores === undefined) {
    fake.push({
      type: 'report',
      managerId: 'mgr-held',
      text: '終わった',
      status: 'done',
    } as RunnerEvent);
    await settle();
  }
  fake.resumes.length = 0;
  fake.sends.length = 0;
  const rotate = (): void => {
    active.tokenId = 'tok-b';
    active.generation = 60;
  };
  return { pool, fake, stores, inbox, rotate, clock };
}

async function heldOf(stores: Stores): Promise<NonNullable<Job['heldMessages']>> {
  const job = (await stores.jobs.listJobs()).find((entry) => entry.id === 'mgr-held');
  return job?.heldMessages ?? [];
}

async function deliverHeld(pool: { deliverHeldMessages?: () => Promise<void> }): Promise<void> {
  if (pool.deliverHeldMessages === undefined) throw new Error('deliverHeldMessages が無い');
  await pool.deliverHeldMessages();
}

function inboxText(inbox: InboxEvent[]): string {
  return JSON.stringify(inbox);
}

describe('manager_send が届けられない伝言を台帳に預かり、届けられるようになったら届ける（#4441）', () => {
  it('⭐ 背景処理が残って畳めない done への伝言は、捨てずに台帳へ預かり、held と名乗る', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;

    const result = await s.pool.send('mgr-held', 'DEVENV の続きをお願い');

    expect(result.outcome).toBe('held');
    expect(result.detail).toContain('預かった');
    expect(result.detail).toContain('送り直さないこと');
    expect(result.detail).not.toContain('送り直す。');
    expect(s.fake.sends).toHaveLength(0);
    expect(s.fake.stops).toHaveLength(0);
    const held = await heldOf(s.stores);
    expect(held.map((item) => item.text)).toEqual(['DEVENV の続きをお願い']);
    expect(held[0]?.reason).toContain('背景処理が 1 本');
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('届けずに預かった'),
    );
    expect(decisions).toHaveLength(1);
    await s.pool.stop();
  });

  it('⭐ 背景処理が終わったら、周期の見回りが預かった順に1通へまとめて新しい鍵で届け、日誌とクローンへ知らせる', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '1通目')).outcome).toBe('held');
    expect((await s.pool.send('mgr-held', '2通目')).outcome).toBe('held');
    expect((await heldOf(s.stores)).map((item) => item.text)).toEqual(['1通目', '2通目']);

    await deliverHeld(s.pool);
    expect(s.fake.resumes).toHaveLength(0);
    expect(await heldOf(s.stores)).toHaveLength(2);
    const listed = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-held');
    const firstHeldAt = (await heldOf(s.stores))[0]?.heldAt;
    expect(listed?.heldMessages).toEqual({ count: 2, oldestHeldAt: firstHeldAt });

    s.fake.behavior.background = 0;
    await deliverHeld(s.pool);

    const after = (await s.pool.list()).find((entry) => entry.managerId === 'mgr-held');
    expect(after?.heldMessages).toBeUndefined();
    expect(s.fake.stops).toEqual(['mgr-held']);
    expect(s.fake.resumes).toHaveLength(1);
    const delivered = s.fake.resumes[0]?.message ?? '';
    expect(delivered).toContain('預かっていた伝言 2 通');
    expect(delivered.indexOf('1通目')).toBeLessThan(delivered.indexOf('2通目'));
    expect(await heldOf(s.stores)).toEqual([]);
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('預かっていた伝言 2 通を届けた'),
    );
    expect(decisions).toHaveLength(1);

    await s.pool.stop();
    expect(inboxText(s.inbox)).toContain('預かっていた伝言 2 通を mgr-held へ届けた');
  });

  it('預かりがある間の新しい伝言は追い越さずに列の後ろへ積み、届けられるならまとめて届け、応答が知らせを兼ねる', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '先の伝言')).outcome).toBe('held');

    s.fake.behavior.background = 0;
    const result = await s.pool.send('mgr-held', '後の伝言');

    expect(result.outcome).toBe('delivered');
    expect(result.detail).toContain('預かっていた伝言 2 通');
    expect(s.fake.resumes).toHaveLength(1);
    const delivered = s.fake.resumes[0]?.message ?? '';
    expect(delivered.indexOf('先の伝言')).toBeLessThan(delivered.indexOf('後の伝言'));
    expect(await heldOf(s.stores)).toEqual([]);
    await s.pool.stop();
    expect(inboxText(s.inbox)).not.toContain('へ届けた');
  });

  it('デーモンが作り直されても預かりは台帳に残り、新しいプールの見回りが届ける', async () => {
    const first = await setup();
    first.rotate();
    first.fake.behavior.background = 1;
    expect((await first.pool.send('mgr-held', '再起動をまたぐ伝言')).outcome).toBe('held');
    await first.pool.stop();

    const second = await setup({ stores: first.stores });
    await deliverHeld(second.pool);

    const delivered = [
      ...second.fake.sends.map((entry) => entry.text),
      ...second.fake.resumes.map((entry) => entry.message ?? ''),
    ].join('\n');
    expect(delivered).toContain('再起動をまたぐ伝言');
    expect(await heldOf(first.stores)).toEqual([]);
    await second.pool.stop();
  });

  it('期限（24時間）を過ぎた預かりは届けずに捨て、本文ごと日誌とクローンへ返す', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '古くなる伝言')).outcome).toBe('held');

    s.clock.now += HELD_MESSAGE_TTL_MS + 1;
    s.fake.behavior.background = 0;
    await deliverHeld(s.pool);

    expect(s.fake.resumes).toHaveLength(0);
    expect(s.fake.sends).toHaveLength(0);
    expect(await heldOf(s.stores)).toEqual([]);
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('届けずに捨てた'),
    );
    expect(decisions).toHaveLength(1);
    expect(JSON.stringify(decisions[0])).toContain('古くなる伝言');
    await s.pool.stop();
    expect(inboxText(s.inbox)).toContain('古くなる伝言');
  });

  it('委譲が止められたら、預かりは届けずに本文ごと返す', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '止める前の伝言')).outcome).toBe('held');

    await s.pool.abort('mgr-held');
    await deliverHeld(s.pool);

    expect(await heldOf(s.stores)).toEqual([]);
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('届けずに捨てた'),
    );
    expect(decisions).toHaveLength(1);
    expect(JSON.stringify(decisions[0])).toContain('止める前の伝言');
    await s.pool.stop();
  });

  it('⭐ 枠で止まった印の付いた failed・lost の担当の預かりは、起こし直しを待って捨てない（#4854）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '起こし直した後に読む伝言')).outcome).toBe('held');
    await s.pool.stop();

    for (const status of ['failed', 'lost'] as const) {
      const job = (await s.stores.jobs.listJobs()).find((entry) => entry.id === 'mgr-held')!;
      await s.stores.jobs.putJob({ ...job, status, usageStoppedAt: '2026-10-11T02:00:00.000Z' });
      const s2 = await setup({ stores: s.stores });
      await deliverHeld(s2.pool);

      expect((await heldOf(s.stores)).map((item) => item.text)).toEqual([
        '起こし直した後に読む伝言',
      ]);
      const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
        JSON.stringify(e).includes('届けずに捨てた'),
      );
      expect(decisions, status).toHaveLength(0);
      await s2.pool.stop();
    }
  });

  it('印の付いた failed の担当でも、預かりの期限を過ぎた分は今どおり本文ごと返す（#4854）', async () => {
    const clock = { now: Date.parse('2026-10-11T02:00:00.000Z') };
    const s = await setup({ clock });
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '期限を過ぎる伝言')).outcome).toBe('held');
    await s.pool.stop();

    const job = (await s.stores.jobs.listJobs()).find((entry) => entry.id === 'mgr-held')!;
    await s.stores.jobs.putJob({
      ...job,
      status: 'failed',
      usageStoppedAt: '2026-10-11T02:00:00.000Z',
    });
    clock.now += HELD_MESSAGE_TTL_MS + 60_000;
    const s2 = await setup({ stores: s.stores, clock });
    await deliverHeld(s2.pool);

    expect(await heldOf(s.stores)).toEqual([]);
    await s2.pool.stop();
  });

  it('対照: 印の無い failed の担当の預かりは、今どおり本文ごと返す（#4854）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '落ちた担当への伝言')).outcome).toBe('held');
    await s.pool.stop();

    const job = (await s.stores.jobs.listJobs()).find((entry) => entry.id === 'mgr-held')!;
    await s.stores.jobs.putJob({ ...job, status: 'failed' });
    const s2 = await setup({ stores: s.stores });
    await deliverHeld(s2.pool);

    expect(await heldOf(s.stores)).toEqual([]);
    await s2.pool.stop();
  });

  it('上限を超える分は預からず、これまでどおり declined で断る', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    for (let i = 0; i < HELD_MESSAGES_MAX_COUNT; i += 1) {
      expect((await s.pool.send('mgr-held', `伝言 ${String(i)}`)).outcome).toBe('held');
    }

    const result = await s.pool.send('mgr-held', 'あふれる伝言');

    expect(result.outcome).toBe('declined');
    expect(result.detail).toContain('預かりの上限');
    expect(await heldOf(s.stores)).toHaveLength(HELD_MESSAGES_MAX_COUNT);
    await s.pool.stop();
  });

  it('添付付きの送信は預からず、これまでどおり declined で断る', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    s.fake.push({
      type: 'hello',
      runnerId: 'runner-primary',
      capabilities: ['manager-attachments'],
    } as RunnerEvent);
    await settle();

    const result = await s.pool.send('mgr-held', '添付付き', {
      attachments: [
        {
          id: 'att-1',
          name: 'a.txt',
          mediaType: 'text/plain',
          size: 1,
          sha256: 'x',
          data: Buffer.from('a').toString('base64'),
        },
      ],
    });

    expect(result.outcome).toBe('declined');
    expect(await heldOf(s.stores)).toEqual([]);
    await s.pool.stop();
  });
});

describe('composeHeldDelivery', () => {
  it('1通なら、遅れて届いたことと送られた時刻を頭に付ける', () => {
    const text = composeHeldDelivery([
      { text: '本文', heldAt: '2026-10-11T00:00:00.000Z', reason: 'r' },
    ]);
    expect(text).toContain('2026-10-11T00:00:00.000Z に送られた');
    expect(text.endsWith('本文')).toBe(true);
  });

  it('複数なら、送られた順に通し番号と時刻を付けて並べる', () => {
    const text = composeHeldDelivery([
      { text: 'A', heldAt: '2026-10-11T00:00:00.000Z', reason: 'r' },
      { text: 'B', heldAt: '2026-10-11T00:05:00.000Z', reason: 'r' },
    ]);
    expect(text).toContain('預かっていた伝言 2 通');
    expect(text.indexOf('1通目（2026-10-11T00:00:00.000Z')).toBeLessThan(
      text.indexOf('2通目（2026-10-11T00:05:00.000Z'),
    );
  });
});

describe('describeHeldMessages（manager_list と manager_report の行）', () => {
  it('預かりがあれば件数・最初の預かり・その期限を言い、送り直さないよう添える', () => {
    const line = describeHeldMessages({
      heldMessages: { count: 3, oldestHeldAt: '2026-10-11T00:00:00.000Z' },
    } as ManagerSummary);
    expect(line).toContain('預かっている伝言');
    expect(line).toContain('3 通');
    expect(line).toContain('最初の預かり 2026-10-11T00:00:00.000Z');
    expect(line).toContain('その期限 2026-10-12T00:00:00.000Z');
    expect(line).toContain('送り直さないこと');
  });

  it('預かりが無ければ行を作らない', () => {
    expect(describeHeldMessages({} as ManagerSummary)).toBeNull();
  });
});

describe('背景処理だけが理由で預かりが待ちの上限を過ぎたら、背景処理ごと畳んで新しい鍵で届ける（#4472）', () => {
  it('⭐ 背景処理が下りないまま 15 分経ったら、旧セッションを畳んで resume し、畳んだことを本文の頭と日誌で言う', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '居座りの先の伝言')).outcome).toBe('held');

    s.clock.now += HELD_FORCE_FOLD_AFTER_MS - 1;
    await deliverHeld(s.pool);
    expect(s.fake.stops).toHaveLength(0);
    expect(await heldOf(s.stores)).toHaveLength(1);

    s.clock.now += 1;
    await deliverHeld(s.pool);

    expect(s.fake.stops).toEqual(['mgr-held']);
    expect(s.fake.resumes).toHaveLength(1);
    const delivered = s.fake.resumes[0]?.message ?? '';
    expect(delivered).toContain('背景処理 1 本');
    expect(delivered).toContain('居座りの先の伝言');
    expect(await heldOf(s.stores)).toEqual([]);
    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('背景処理 1 本ごと畳んで'),
    );
    expect(decisions).toHaveLength(1);
    await s.pool.stop();
  });

  it('⚠️ 確認待ちも残っていれば、15 分を過ぎても畳まず預かったまま', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    s.fake.behavior.waiting = [
      {
        requestId: 'req-1',
        summary: 'Bash を許可するか',
        kind: 'permission',
        askedAt: '2026-10-11T01:00:00.000Z',
      },
    ];
    expect((await s.pool.send('mgr-held', '確認待ちの先の伝言')).outcome).toBe('held');

    s.clock.now += HELD_FORCE_FOLD_AFTER_MS + 1;
    await deliverHeld(s.pool);

    expect(s.fake.stops).toHaveLength(0);
    expect(s.fake.resumes).toHaveLength(0);
    expect(await heldOf(s.stores)).toHaveLength(1);
    await s.pool.stop();
  });

  it('⚠️ 預かりの無い送信（呼び手が直接送った回）は、背景処理があれば今どおり畳まず預かる', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    s.clock.now += HELD_FORCE_FOLD_AFTER_MS * 2;

    const result = await s.pool.send('mgr-held', 'はじめての伝言');

    expect(result.outcome).toBe('held');
    expect(s.fake.stops).toHaveLength(0);
    await s.pool.stop();
  });

  async function foldThenFailResume() {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '伝言X')).outcome).toBe('held');
    s.clock.now += HELD_FORCE_FOLD_AFTER_MS;
    s.fake.behavior.failResume = true;
    await deliverHeld(s.pool);
    expect(s.fake.stops).toEqual(['mgr-held']);
    expect(await heldOf(s.stores)).toHaveLength(1);
    s.fake.behavior.failResume = false;
    s.fake.behavior.background = 0;
    s.clock.now += 61_000;
    return s;
  }

  it('⭐ 畳んだ後の resume が失敗しても、再試行で届く回の本文に背景処理を畳んだ断り書きが付く（#4472）', async () => {
    const s = await foldThenFailResume();
    expect(s.fake.resumes).toHaveLength(0);

    await deliverHeld(s.pool);

    const delivered = s.fake.resumes[0]?.message ?? '';
    expect(delivered).toContain('背景処理 1 本をセッションごと畳んで');
    expect(delivered).toContain('伝言X');
    expect(delivered.split('背景処理 1 本を')).toHaveLength(2);
    expect(await heldOf(s.stores)).toEqual([]);
    await s.pool.stop();
  });

  it('⭐ 断り書きは器の再起動を跨いでも残る（台帳に持つ）', async () => {
    const s = await foldThenFailResume();
    await s.pool.stop();

    const restarted = await setup({ stores: s.stores, clock: s.clock });
    await deliverHeld(restarted.pool);

    expect(restarted.fake.resumes[0]?.message ?? '').toContain(
      '背景処理 1 本をセッションごと畳んで',
    );
    await restarted.pool.stop();
  });

  it('断り書きは届いた回で下ろし、その後の次の伝言には付かない', async () => {
    const s = await foldThenFailResume();
    await deliverHeld(s.pool);
    expect(s.fake.resumes).toHaveLength(1);
    const job = (await s.stores.jobs.listJobs()).find((entry) => entry.id === 'mgr-held');
    expect(job?.pendingFoldNotice).toBeUndefined();

    s.fake.push({
      type: 'report',
      managerId: 'mgr-held',
      text: '終わった',
      status: 'done',
    } as RunnerEvent);
    await settle();
    const result = await s.pool.send('mgr-held', '次の伝言');

    expect(result.outcome).toBe('delivered');
    const texts = [
      ...s.fake.resumes.map((r) => r.message ?? ''),
      ...s.fake.sends.map((x) => x.text),
    ];
    const next = texts.find((text) => text.includes('次の伝言')) ?? '';
    expect(next).not.toContain('背景処理');
    await s.pool.stop();
  });

  const FOLDED_NOTICE =
    '背景処理 1 本を畳んで起こし直し、結果は届かないので自分で確かめて続きを進めるよう促した';

  it('⭐ 15 分届かず背景処理ごと畳んで届け直した回は、クローンへ「畳んだ」旨を届け直しの知らせの中で1回だけ出す（#4913）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '居座りの先の伝言')).outcome).toBe('held');
    s.clock.now += HELD_FORCE_FOLD_AFTER_MS;

    await deliverHeld(s.pool);

    expect(s.fake.stops).toEqual(['mgr-held']);
    await s.pool.stop();
    const text = inboxText(s.inbox);
    expect(text.split(FOLDED_NOTICE)).toHaveLength(2);
    expect(text).toContain('預かっていた伝言 1 通を mgr-held へ届けた');
  });

  it('畳みの無い届け直しには「畳んだ」旨を出さない（#4913）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    expect((await s.pool.send('mgr-held', '伝言')).outcome).toBe('held');
    s.fake.behavior.background = 0;

    await deliverHeld(s.pool);

    await s.pool.stop();
    expect(inboxText(s.inbox)).toContain('預かっていた伝言 1 通を mgr-held へ届けた');
    expect(inboxText(s.inbox)).not.toContain('結果は届かないので');
  });

  describe('15 分届かず畳めない預かりは、クローンへ1回だけ知らせる（#5041）', () => {
    const STUCK_NOTICE = '待ちの上限（15 分）を過ぎても、畳めずに届けられていない';
    const WAITING = [
      {
        requestId: 'req-1',
        summary: 'Bash を許可するか',
        kind: 'permission' as const,
        askedAt: '2026-10-11T01:00:00.000Z',
      },
    ];

    async function stuckSetup() {
      const s = await setup();
      s.rotate();
      s.fake.behavior.background = 1;
      s.fake.behavior.commands = ['pnpm e2e --watch'];
      s.fake.behavior.waiting = WAITING;
      expect((await s.pool.send('mgr-held', '合流の続きを')).outcome).toBe('held');
      return s;
    }

    async function stuckDecisions(s: Awaited<ReturnType<typeof setup>>) {
      return (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
        JSON.stringify(e).includes('クローンへ知らせた'),
      );
    }

    it('⭐ 15 分を過ぎた見回りで1回出し、理由・コマンド・預かりの時刻・取れる手を載せ、日誌にも残す', async () => {
      const s = await stuckSetup();
      const heldAt = (await heldOf(s.stores))[0]?.heldAt ?? '';
      s.clock.now += HELD_FORCE_FOLD_AFTER_MS;

      await deliverHeld(s.pool);

      expect(s.fake.stops).toHaveLength(0);
      expect(await heldOf(s.stores)).toHaveLength(1);
      expect(await stuckDecisions(s)).toHaveLength(1);
      await s.pool.stop();
      const text = inboxText(s.inbox);
      expect(text.split(STUCK_NOTICE)).toHaveLength(2);
      expect(text).toContain('確認待ちが 1 件残っている');
      expect(text).toContain('起こしっぱなしの背景処理が 1 本残っている');
      expect(text).toContain('pnpm e2e --watch');
      expect(text).toContain(heldAt);
      expect(text).toContain('世代 59');
      expect(text).toContain('manager_stop → manager_start');
      expect(text).toContain('自動で届ける');
    });

    it('同じ理由の次の見回りでは知らせない', async () => {
      const s = await stuckSetup();
      s.clock.now += HELD_FORCE_FOLD_AFTER_MS;
      await deliverHeld(s.pool);
      s.clock.now += 61_000;
      await deliverHeld(s.pool);
      s.clock.now += 61_000;
      await deliverHeld(s.pool);

      expect(await stuckDecisions(s)).toHaveLength(1);
      await s.pool.stop();
      expect(inboxText(s.inbox).split(STUCK_NOTICE)).toHaveLength(2);
    });

    it('理由が変わったら、もう1回知らせる', async () => {
      const s = await stuckSetup();
      s.clock.now += HELD_FORCE_FOLD_AFTER_MS;
      await deliverHeld(s.pool);

      s.fake.behavior.background = 2;
      s.clock.now += 61_000;
      await deliverHeld(s.pool);

      expect(await stuckDecisions(s)).toHaveLength(2);
      await s.pool.stop();
      const text = inboxText(s.inbox);
      expect(text.split(STUCK_NOTICE)).toHaveLength(3);
      expect(text).toContain('起こしっぱなしの背景処理が 2 本残っている');
    });

    it('15 分より前は知らせない', async () => {
      const s = await stuckSetup();
      s.clock.now += HELD_FORCE_FOLD_AFTER_MS - 1;

      await deliverHeld(s.pool);

      expect(await stuckDecisions(s)).toHaveLength(0);
      await s.pool.stop();
      expect(inboxText(s.inbox)).not.toContain(STUCK_NOTICE);
    });

    it('背景処理だけが理由なら、今どおり畳んで届け、知らせは出さない', async () => {
      const s = await setup();
      s.rotate();
      s.fake.behavior.background = 1;
      expect((await s.pool.send('mgr-held', '伝言')).outcome).toBe('held');
      s.clock.now += HELD_FORCE_FOLD_AFTER_MS;

      await deliverHeld(s.pool);

      expect(s.fake.stops).toEqual(['mgr-held']);
      expect(s.fake.resumes).toHaveLength(1);
      expect(await stuckDecisions(s)).toHaveLength(0);
      await s.pool.stop();
      expect(inboxText(s.inbox)).not.toContain(STUCK_NOTICE);
    });

    // 「届いた後にまた預かって15分過ぎたら、もう1回知らせる」は試験にしていない: 1回目を届けると担当は新しい鍵で起き直し、
    // この偽の runner では同じ担当に2度目の預かり（古い鍵のまま背景処理待ち）を作り直せないため。記憶を消すのは届けた所（`#deliverHeld`）・捨てた所（`#releaseHeld`）・担当を外した所で、`#lastStaleDecline` と同じ3か所である
    it('鍵の値は知らせにも日誌にも載らない', async () => {
      const s = await stuckSetup();
      const secret = 'sk-ant-oat01-SECRETSECRETSECRET1234567890';
      s.fake.behavior.commands = [`CLAUDE_CODE_OAUTH_TOKEN=${secret} pnpm e2e`];
      s.clock.now += HELD_FORCE_FOLD_AFTER_MS;

      await deliverHeld(s.pool);

      const decisions = JSON.stringify(await stuckDecisions(s));
      expect(decisions).toContain('pnpm e2e');
      expect(decisions).not.toContain('SECRETSECRET');
      await s.pool.stop();
      expect(inboxText(s.inbox)).toContain('pnpm e2e');
      expect(inboxText(s.inbox)).not.toContain('SECRETSECRET');
    });
  });

  describe('背景処理待ちに入った時刻が預かりより早ければ、そこから待ちを数える（#5041）', () => {
    const WAIT_MS = 20 * 60 * 1000;

    it('⭐ 背景処理待ちに入って 20 分たった担当への伝言は、預かった直後の見回りで背景処理ごと畳んで届ける', async () => {
      const s = await setup();
      s.fake.push({
        type: 'report',
        managerId: 'mgr-held',
        text: '完了を待つ',
        status: 'done',
        awaitingBackground: { count: 1, breakdown: 'local_bash×1' },
      } as RunnerEvent);
      await settle();
      s.rotate();
      s.fake.behavior.background = 1;
      s.clock.now += WAIT_MS;
      expect((await s.pool.send('mgr-held', '待ち中の伝言')).outcome).toBe('held');

      await deliverHeld(s.pool);

      expect(s.fake.stops).toEqual(['mgr-held']);
      expect(s.fake.resumes).toHaveLength(1);
      expect(s.fake.resumes[0]?.message ?? '').toContain('待ち中の伝言');
      expect(await heldOf(s.stores)).toEqual([]);
      await s.pool.stop();
    });

    it('背景処理待ちに入った時刻が分からなければ、今どおり預かりから 15 分で畳む', async () => {
      const s = await setup();
      s.rotate();
      s.fake.behavior.background = 1;
      s.clock.now += WAIT_MS;
      expect((await s.pool.send('mgr-held', '伝言')).outcome).toBe('held');

      s.clock.now += HELD_FORCE_FOLD_AFTER_MS - 1;
      await deliverHeld(s.pool);
      expect(s.fake.stops).toHaveLength(0);

      s.clock.now += 1;
      await deliverHeld(s.pool);
      expect(s.fake.stops).toEqual(['mgr-held']);
      await s.pool.stop();
    });
  });

  it('peer だけの回には「畳んだ」旨を出さない（#4913）', async () => {
    const s = await setup();
    s.rotate();
    s.fake.behavior.background = 1;
    s.fake.behavior.peers = 1;
    expect((await s.pool.send('mgr-held', '伝言')).outcome).toBe('held');
    s.clock.now += HELD_FORCE_FOLD_AFTER_MS;

    await deliverHeld(s.pool);

    await s.pool.stop();
    expect(inboxText(s.inbox)).not.toContain('結果は届かないので');
    expect(inboxText(s.inbox)).not.toContain('背景処理 0 本');
  });
});
