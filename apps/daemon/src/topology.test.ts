import type { JournalEntry, ManagerSummary } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { topologyResponseSchema } from './openapi.js';
import { createTopologyActivityTracker } from './topology-activity.js';
import {
  TOPOLOGY_ENDED_WINDOW_MS,
  TOPOLOGY_MANAGERS_CHAR_BUDGET,
  TOPOLOGY_REQUEST_LIMIT,
  TOPOLOGY_RUNNER_LISTING_FRESH_MS,
  TOPOLOGY_WAITING_PER_MANAGER,
  buildTopologySnapshot,
  createStorageHealthTracker,
  createTopologyService,
  describeProbeError,
  topologySignature,
  type TopologyInputs,
} from './topology.js';

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function manager(id: string, overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: id,
    status: 'running',
    live: true,
    cwd: '/work',
    request: `依頼 ${id}`,
    startedAt: iso(-60_000),
    updatedAt: iso(-1_000),
    waiting: [],
    ...overrides,
  } as ManagerSummary;
}

function inputs(overrides: Partial<TopologyInputs> = {}): TopologyInputs {
  return {
    nowMs: NOW,
    turn: null,
    usageBlocked: false,
    storage: { state: 'unknown' },
    runners: [],
    managers: [],
    activity: createTopologyActivityTracker(),
    ...overrides,
  };
}

describe('buildTopologySnapshot のモデル（#3921）', () => {
  it('modelsOf と cloneModel の値だけを載せ、無いものは欄ごと載せない', () => {
    const snapshot = buildTopologySnapshot(
      inputs({
        managers: [manager('m1'), manager('m2')],
        modelsOf: (m) =>
          m.managerId === 'm1' ? { managerModel: 'opus', workerModel: 'sonnet' } : {},
        cloneModel: 'opus',
      }),
    );
    expect(topologyResponseSchema.parse(snapshot)).toBeTruthy();
    expect(snapshot.clone).toEqual({ state: 'idle', model: 'opus' });
    const byId = new Map(snapshot.managers.map((m) => [m.managerId, m]));
    expect(byId.get('m1')).toMatchObject({ managerModel: 'opus', workerModel: 'sonnet' });
    expect(byId.get('m2')).not.toHaveProperty('managerModel');
    expect(byId.get('m2')).not.toHaveProperty('workerModel');
    expect(buildTopologySnapshot(inputs()).clone).toEqual({ state: 'idle' });
  });
});

describe('buildTopologySnapshot', () => {
  it('組んだ結果は応答のスキーマを通る', () => {
    const activity = createTopologyActivityTracker();
    const snapshot = buildTopologySnapshot(
      inputs({
        activity,
        turn: { conversationId: 'c1', kind: 'normal' },
        storage: { label: 'fs', state: 'ok', checkedAt: iso(0) },
        runners: [{ label: 'http://r', runnerId: 'r1', state: 'connected', since: iso(-5000) }],
        managers: [
          manager('m1', {
            waiting: [
              { requestId: 'q1', summary: 'どうしますか', kind: 'question', askedAt: iso(-100) },
            ],
          }),
        ],
      }),
    );
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.observedAt).toBe(iso(0));
  });

  describe('clone.state（取れないものを idle にしない）', () => {
    it('ターンを答えられない器（activeTurn 未実装）は unknown', () => {
      expect(buildTopologySnapshot(inputs({ turn: undefined })).clone).toEqual({
        state: 'unknown',
      });
    });
    it('答えられて走っていなければ idle、走っていれば busy とターン', () => {
      expect(buildTopologySnapshot(inputs({ turn: null })).clone).toEqual({ state: 'idle' });
      expect(buildTopologySnapshot(inputs({ turn: { kind: 'distill' } })).clone).toEqual({
        state: 'busy',
        turn: { kind: 'distill' },
      });
    });
    it('枠で止まっていれば usage_blocked（答えられない器でも）', () => {
      expect(buildTopologySnapshot(inputs({ turn: undefined, usageBlocked: true })).clone).toEqual({
        state: 'usage_blocked',
      });
    });
  });

  describe('managers', () => {
    it('走行中・返事待ちと、直近10分以内に終わったものだけを載せる', () => {
      const snapshot = buildTopologySnapshot(
        inputs({
          managers: [
            manager('run', { status: 'running' }),
            manager('wait', { status: 'waiting_human' }),
            manager('fresh-done', {
              status: 'done',
              updatedAt: iso(-TOPOLOGY_ENDED_WINDOW_MS + 1000),
            }),
            manager('old-done', {
              status: 'done',
              updatedAt: iso(-TOPOLOGY_ENDED_WINDOW_MS - 1000),
            }),
            manager('bad-time', { status: 'failed', updatedAt: 'not-a-date' }),
          ],
        }),
      );
      expect(snapshot.managers.map((m) => m.managerId)).toEqual(['wait', 'run', 'fresh-done']);
    });

    describe('背景処理待ち（awaitingBackground。#2726 / #2724）', () => {
      const awaitingBackground = {
        tasks: 2,
        withheldReports: 1,
        breakdown: 'local_agent×2',
        since: iso(-20 * 60_000),
      };

      it('awaitingBackground が在れば、そのまま写る（スキーマも通る）', () => {
        const snapshot = buildTopologySnapshot(
          inputs({ managers: [manager('m', { status: 'done', awaitingBackground })] }),
        );
        expect(snapshot.managers[0]?.awaitingBackground).toEqual(awaitingBackground);
        expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
      });

      it('無いときは鍵ごと無い（「待っていない」と「名乗られていない」を作り分けない）', () => {
        const snapshot = buildTopologySnapshot(inputs({ managers: [manager('m')] }));
        expect(snapshot.managers[0]).not.toHaveProperty('awaitingBackground');
      });

      it('10分を超えた done でも、awaitingBackground が在れば載せ、欄なしは落とす', () => {
        const old = iso(-TOPOLOGY_ENDED_WINDOW_MS - 60_000);
        const snapshot = buildTopologySnapshot(
          inputs({
            managers: [
              manager('waiting-old', { status: 'done', updatedAt: old, awaitingBackground }),
              manager('plain-old', { status: 'done', updatedAt: old }),
            ],
          }),
        );
        expect(snapshot.managers.map((m) => m.managerId)).toEqual(['waiting-old']);
      });

      it('背景処理待ちは走行中と同じ段に並ぶ（終端より先）', () => {
        const snapshot = buildTopologySnapshot(
          inputs({
            managers: [
              manager('ended', { status: 'done', startedAt: iso(-1000) }),
              manager('bg', { status: 'done', startedAt: iso(-5000), awaitingBackground }),
              manager('wait', { status: 'waiting_human' }),
            ],
          }),
        );
        expect(snapshot.managers.map((m) => m.managerId)).toEqual(['wait', 'bg', 'ended']);
      });
    });

    it('request と返事待ちの summary は抜粋で、件数は上限で切って残りを言う', () => {
      const long = 'あ'.repeat(TOPOLOGY_REQUEST_LIMIT * 3);
      const waiting = Array.from({ length: TOPOLOGY_WAITING_PER_MANAGER + 3 }, (_, i) => ({
        requestId: `q${String(i)}`,
        summary: `質問\n${long}`,
      }));
      const [row] = buildTopologySnapshot(
        inputs({ managers: [manager('m1', { request: long, status: 'waiting_human', waiting })] }),
      ).managers;
      expect(row?.request.length).toBeLessThanOrEqual(TOPOLOGY_REQUEST_LIMIT + 1);
      expect(row?.request.endsWith('…')).toBe(true);
      expect(row?.waiting).toHaveLength(TOPOLOGY_WAITING_PER_MANAGER);
      expect(row?.waitingOmitted).toBe(3);
      expect(row?.waiting[0]?.summary).not.toContain('\n');
    });

    it('文字数の予算を超えたら切って、切った件数を言う（1本目は必ず載せる）', () => {
      const many = Array.from({ length: 400 }, (_, i) =>
        manager(`m${String(i).padStart(3, '0')}`, {
          request: 'x'.repeat(TOPOLOGY_REQUEST_LIMIT),
          startedAt: iso(-i * 1000),
        }),
      );
      const snapshot = buildTopologySnapshot(inputs({ managers: many }));
      expect(snapshot.managers.length).toBeGreaterThan(0);
      expect(snapshot.managers.length).toBeLessThan(400);
      expect(snapshot.managersOmitted).toBe(400 - snapshot.managers.length);
      expect(JSON.stringify(snapshot.managers).length).toBeLessThanOrEqual(
        TOPOLOGY_MANAGERS_CHAR_BUDGET + 1000,
      );
      expect(
        buildTopologySnapshot(inputs({ managers: many.slice(0, 2) })).managersOmitted,
      ).toBeUndefined();
    });
  });

  it('作業者は活動から束ね、載せていない委譲の線は返さない', () => {
    const activity = createTopologyActivityTracker();
    const at = iso(-2000);
    const push = (e: unknown) => activity.record({ id: 'x', at, ...(e as object) } as JournalEntry);
    push({
      type: 'tool_use',
      actor: 'manager:m1',
      tool: 'Agent',
      input: { subagent_type: 'worker' },
    });
    push({ type: 'tool_use', actor: 'worker:m1:worker', tool: 'Edit', input: {} });
    push({ type: 'exchange', with: 'manager', role: 'outbound', text: 't', managerId: 'gone' });
    push({ type: 'exchange', with: 'human', role: 'inbound', text: 'h' });
    const snapshot = buildTopologySnapshot(inputs({ activity, managers: [manager('m1')] }));
    expect(snapshot.managers[0]?.workers).toEqual([
      { agentType: 'worker', lastTool: 'Edit', lastToolAt: at },
    ]);
    expect(snapshot.links.map((l) => l.key).sort()).toEqual([
      'human~clone',
      'manager:m1~worker:worker',
    ]);
  });

  it('topologySignature は observedAt を除いて比べる', () => {
    const a = buildTopologySnapshot(inputs({ nowMs: NOW }));
    const b = buildTopologySnapshot(inputs({ nowMs: NOW + 5000 }));
    expect(a.observedAt).not.toBe(b.observedAt);
    expect(topologySignature(a)).toBe(topologySignature(b));
    expect(topologySignature(buildTopologySnapshot(inputs({ turn: undefined })))).not.toBe(
      topologySignature(a),
    );
  });
});

describe('createStorageHealthTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('確かめる手段が無ければ常に unknown（ok を作らない）', async () => {
    const tracker = createStorageHealthTracker({ label: 'fs', probe: undefined, now: Date.now });
    expect(tracker.current()).toEqual({ label: 'fs', state: 'unknown' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tracker.current()).toEqual({ label: 'fs', state: 'unknown' });
  });

  it('最初は unknown、確かめ終わると ok。間隔の内では聞き直さない', async () => {
    const probe = vi.fn(async () => undefined);
    const tracker = createStorageHealthTracker({
      label: 'postgres',
      probe,
      now: Date.now,
      intervalMs: 15_000,
    });
    expect(tracker.current().state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(1);
    expect(tracker.current().state).toBe('ok');
    expect(tracker.current().checkedAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    tracker.current();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    tracker.current();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('失敗は unreachable。理由は種別だけで、接続先を載せない', async () => {
    const probe = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 user=secret'), {
        code: 'ECONNREFUSED',
      });
    });
    const tracker = createStorageHealthTracker({ label: 'postgres', probe, now: Date.now });
    tracker.current();
    await vi.advanceTimersByTimeAsync(1);
    const state = tracker.current();
    expect(state).toMatchObject({ state: 'unreachable', error: 'ECONNREFUSED' });
    expect(JSON.stringify(state)).not.toContain('10.1.2.3');
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('打ち切り時間を超えたら unreachable（TIMEOUT）。呼び手は待たされない', async () => {
    const tracker = createStorageHealthTracker({
      label: undefined,
      probe: () => new Promise<void>(() => undefined),
      now: Date.now,
      timeoutMs: 3000,
    });
    expect(tracker.current().state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(3001);
    expect(tracker.current()).toMatchObject({ state: 'unreachable', error: 'TIMEOUT' });
  });

  it('describeProbeError は code → name → error の順で、危険な文字を含む値は採らない', () => {
    expect(describeProbeError({ code: '57P01' })).toBe('57P01');
    expect(describeProbeError(new TypeError('x'))).toBe('TypeError');
    expect(describeProbeError({ code: 'a b://c' })).toBe('error');
    expect(describeProbeError('boom')).toBe('error');
  });
});

describe('読めなかった委譲の行（#2705）', () => {
  const bad = [{ id: 'mgr-bad', reason: '不正な欄: status' }, { reason: '不正な欄: id' }];

  it('壊れた行が在れば、managers が空でも件数ぶん載る（スキーマも通る）', () => {
    const snapshot = buildTopologySnapshot(inputs({ managers: [], unreadable: bad }));
    expect(snapshot.managers).toEqual([]);
    expect(snapshot.unreadable).toEqual(bad);
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('無い・0件・未配線なら鍵ごと載らない（0件を空配列で作らない）', () => {
    expect('unreadable' in buildTopologySnapshot(inputs())).toBe(false);
    expect('unreadable' in buildTopologySnapshot(inputs({ unreadable: [] }))).toBe(false);
  });

  it('内容の指紋に入る（件数が変われば stream が再送する）', () => {
    expect(topologySignature(buildTopologySnapshot(inputs({ unreadable: bad })))).not.toBe(
      topologySignature(buildTopologySnapshot(inputs())),
    );
  });

  it('サービスは unreadableJobs の口から読んで載せる。0件なら載せない', async () => {
    const make = (rows: typeof bad) =>
      createTopologyService({
        clone: { usageBlocked: false, managers: { list: async () => [] } },
        unreadableJobs: async () => rows,
        activity: createTopologyActivityTracker(),
        storage: { current: () => ({ state: 'unknown' }) },
        now: () => NOW,
      });
    expect((await make(bad).snapshot()).unreadable).toEqual(bad);
    expect('unreadable' in (await make([]).snapshot())).toBe(false);
  });
});

describe('createTopologyService', () => {
  function service(list: () => Promise<ManagerSummary[]>, now: () => number) {
    return createTopologyService({
      clone: { usageBlocked: false, managers: { list } },
      activity: createTopologyActivityTracker(),
      storage: { current: () => ({ state: 'unknown' }) },
      now,
    });
  }

  it('既定は毎回組む。maxAgeMs を渡した周期の再計算だけが直近の結果を使い回す', async () => {
    let clock = NOW;
    const list = vi.fn(async () => []);
    const svc = service(list, () => clock);
    await svc.snapshot();
    await svc.snapshot();
    expect(list).toHaveBeenCalledTimes(2);

    await svc.snapshot({ maxAgeMs: 1000 });
    expect(list).toHaveBeenCalledTimes(2);
    clock += 1500;
    await svc.snapshot({ maxAgeMs: 1000 });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('activeTurn を実装していない clone は unknown、runners 未配線は空', async () => {
    const snapshot = await service(
      async () => [],
      () => NOW,
    ).snapshot();
    expect(snapshot.clone.state).toBe('unknown');
    expect(snapshot.runners).toEqual([]);
    expect(snapshot.storage).toEqual({ state: 'unknown' });
  });
});

describe('runner の上に居る委譲（runnerListedAt）は窓に関係なく載る', () => {
  const OLD = -TOPOLOGY_ENDED_WINDOW_MS - 60 * 60_000;
  const idsOf = (managers: ManagerSummary[]) =>
    buildTopologySnapshot(inputs({ managers })).managers.map((m) => m.managerId);

  it('runner に居る done は10分経っても載り、欄も応答に写る（スキーマも通る）', () => {
    const snapshot = buildTopologySnapshot(
      inputs({
        managers: [
          manager('idle-on-runner', {
            status: 'done',
            updatedAt: iso(OLD),
            runnerId: 'r1',
            runnerListedAt: iso(-5_000),
          }),
        ],
      }),
    );
    expect(snapshot.managers.map((m) => m.managerId)).toEqual(['idle-on-runner']);
    expect(snapshot.managers[0]?.runnerListedAt).toBe(iso(-5_000));
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('観測が無ければ（欄が無い）窓の外の done は載らない', () => {
    expect(
      idsOf([manager('no-obs', { status: 'done', updatedAt: iso(OLD), runnerId: 'r1' })]),
    ).toEqual([]);
  });

  it('lost / failed / stopped は、runner の一覧に載っていても窓の外なら載らない', () => {
    expect(
      idsOf(
        (['lost', 'failed', 'stopped'] as const).map((status) =>
          manager(`t-${status}`, {
            status,
            live: false,
            updatedAt: iso(OLD),
            runnerId: 'r1',
            runnerListedAt: iso(-5_000),
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('観測が古い（60秒より前）なら居座らせない。読めない時刻も同じ', () => {
    expect(
      idsOf([
        manager('stale', {
          status: 'done',
          updatedAt: iso(OLD),
          runnerListedAt: iso(-TOPOLOGY_RUNNER_LISTING_FRESH_MS - 1_000),
        }),
        manager('edge', {
          status: 'done',
          updatedAt: iso(OLD),
          runnerListedAt: iso(-TOPOLOGY_RUNNER_LISTING_FRESH_MS),
        }),
        manager('bad', { status: 'done', updatedAt: iso(OLD), runnerListedAt: 'not-a-date' }),
      ]),
    ).toEqual(['edge']);
  });

  it('並びは終端の段（途中のものより後ろ）で、予算で切られるのもこちらが先', () => {
    const snapshot = buildTopologySnapshot(
      inputs({
        managers: [
          manager('idle', {
            status: 'done',
            startedAt: iso(-1_000),
            updatedAt: iso(OLD),
            runnerListedAt: iso(-5_000),
          }),
          manager('run', { status: 'running', startedAt: iso(-90_000) }),
        ],
      }),
    );
    expect(snapshot.managers.map((m) => m.managerId)).toEqual(['run', 'idle']);

    const big = 'あ'.repeat(TOPOLOGY_REQUEST_LIMIT);
    const many = Array.from({ length: 400 }, (_, i) =>
      manager(`idle-${String(i).padStart(3, '0')}`, {
        status: 'done',
        request: big,
        updatedAt: iso(OLD),
        runnerListedAt: iso(-5_000),
      }),
    );
    const cut = buildTopologySnapshot(
      inputs({ managers: [...many, manager('run', { status: 'running' })] }),
    );
    expect(cut.managers[0]?.managerId).toBe('run');
    expect(cut.managersOmitted ?? 0).toBeGreaterThan(0);
  });
});

describe('枠(利用上限)で止まっている委譲（usageStoppedAt）は窓に関係なく載る', () => {
  const OLD = -TOPOLOGY_ENDED_WINDOW_MS - 60 * 60_000;
  const STOPPED_AT = '2026-10-03T00:00:00.000Z';
  const idsOf = (managers: ManagerSummary[]) =>
    buildTopologySnapshot(inputs({ managers })).managers.map((m) => m.managerId);

  it('窓の外の done でも載り、usageStoppedAt が行に出る（スキーマも通る）', () => {
    const snapshot = buildTopologySnapshot(
      inputs({
        managers: [
          manager('blocked', { status: 'done', updatedAt: iso(OLD), usageStoppedAt: STOPPED_AT }),
        ],
      }),
    );
    expect(snapshot.managers.map((m) => m.managerId)).toEqual(['blocked']);
    expect(snapshot.managers[0]?.usageStoppedAt).toBe(STOPPED_AT);
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('止まっていない done は従来どおり（窓の外なら載らず、窓の中なら載るが欄は無い）', () => {
    expect(idsOf([manager('old', { status: 'done', updatedAt: iso(OLD) })])).toEqual([]);
    const recent = buildTopologySnapshot(
      inputs({ managers: [manager('recent', { status: 'done', updatedAt: iso(-1_000) })] }),
    );
    expect(recent.managers[0]?.managerId).toBe('recent');
    expect(recent.managers[0]).not.toHaveProperty('usageStoppedAt');
  });

  it('鍵が回って印が下りた（欄が無い）委譲は、窓の外なら図から消える', () => {
    expect(idsOf([manager('resumed', { status: 'done', updatedAt: iso(OLD) })])).toEqual([]);
  });

  it('lost / failed / stopped は、印が残っていても窓の外なら載らない', () => {
    expect(
      idsOf(
        (['lost', 'failed', 'stopped'] as const).map((status) =>
          manager(`t-${status}`, {
            status,
            live: false,
            updatedAt: iso(OLD),
            usageStoppedAt: STOPPED_AT,
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('途中の段に置く: 終端より前に並び、予算で先に切られない', () => {
    const big = 'あ'.repeat(TOPOLOGY_REQUEST_LIMIT);
    const ended = Array.from({ length: 400 }, (_, i) =>
      manager(`end-${String(i).padStart(3, '0')}`, {
        status: 'done',
        request: big,
        updatedAt: iso(-1_000),
      }),
    );
    const snapshot = buildTopologySnapshot(
      inputs({
        managers: [
          ...ended,
          manager('blocked', {
            status: 'done',
            startedAt: iso(-1_000_000),
            updatedAt: iso(OLD),
            usageStoppedAt: STOPPED_AT,
          }),
        ],
      }),
    );
    expect(snapshot.managers[0]?.managerId).toBe('blocked');
    expect(snapshot.managersOmitted ?? 0).toBeGreaterThan(0);
  });
});
