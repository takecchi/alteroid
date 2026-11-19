import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import {
  createRunnerRegistry,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileResult,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';
import type { AgentToken } from './token-pool.js';
import type { TokenRotatorObservation } from './token-rotator.js';

// 作業者だけが担当の抱えている鍵の枠で落ちたとき、担当本体が当たったときと同じ経路（`onUsageObservation`）へ流す

// 2026-11-19 の本番と同じ形: 5時間の枠。日付なしの resets は24時間以内を指す
const RAW = "You've hit your 5-hour limit · resets 6pm (Asia/Tokyo)";
const RESET_AT = Date.parse('2026-10-17T09:00:00.000Z');
const NOW = Date.parse('2026-10-17T08:32:41.000Z');
const SECRET_A = 'sk-ant-oat01-SECRET-A-VALUE';

function token(overrides: Partial<AgentToken> & Pick<AgentToken, 'id' | 'label' | 'order'>) {
  return overrides as AgentToken;
}

const COOLING = { cooldownUntil: RESET_AT, cooldownSource: 'quota_reset' as const };
const KEY_A = token({ id: 'aaaaaaaa-1111', label: '鍵A', order: 1, value: SECRET_A, ...COOLING });
const KEY_B = token({ id: 'bbbbbbbb-2222', label: '鍵B', order: 2 });
const KEY_C = token({ id: 'cccccccc-3333', label: '鍵C', order: 3 });

const JOB: Job = {
  id: 'mgr-flow',
  managerId: 'mgr-flow',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const delivered: string[] = [];
  const runner = fakeRunnerClient({
    runnerId: 'runner-primary',
    async connect(onEvent) {
      emit = onEvent;
    },
    async resume(command: RunnerResumeCommand): Promise<{ cwd: string }> {
      delivered.push(command.message ?? '');
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
    async send(_managerId, text) {
      delivered.push(text);
      return true;
    },
    async stop(managerId) {
      const at = alive.findIndex((state) => state.managerId === managerId);
      if (at >= 0) alive.splice(at, 1);
    },
    async list() {
      return alive.map((state) => ({ ...state, waiting: [] }));
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
  });
  return {
    runner,
    delivered,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 時計の同一ミリ秒で「新しいターン」の判定が揺れないように、呼ぶたびに必ず進める
function strictlyIncreasingNow(): () => number {
  let last = 0;
  return () => {
    last = Math.max(NOW, last + 1);
    return last;
  };
}

async function setup(
  pool: readonly AgentToken[],
  options: {
    // 呼ばれるたびに観測を受け取る。割り当て替えの再現はここで `target` を書き換える
    onObservation?: (
      observation: Omit<TokenRotatorObservation, 'observedBy'> & { observedBy?: unknown },
      target: { current: { tokenId: string; generation: number } },
    ) => void;
  } = {},
) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  await stores.tokens.replace([...pool]);
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const observations: (Omit<TokenRotatorObservation, 'observedBy'> & { observedBy?: unknown })[] =
    [];
  // 走るべき鍵（割り当てが在ればそれ）。起動時に担当が掴む鍵は鍵A（世代 7）
  const target = { current: { tokenId: KEY_A.id, generation: 7 } };
  const managerPool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: strictlyIncreasingNow(),
    tokenIdentity: () => ({ ...target.current }),
    tokenAvailability: async () => 'ready',
    onUsageObservation: async (observation) => {
      observations.push(observation);
      options.onObservation?.(observation, target);
    },
  });
  await managerPool.restore();
  fake.delivered.length = 0;
  return { pool: managerPool, fake, stores, inbox, observations, target };
}

function workerLimitNote(raw: string, preRotationKey = false): RunnerEvent {
  return {
    type: 'note',
    managerId: JOB.id,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    notifyClone: true,
    workerLimit: { raw, preRotationKey },
  } as RunnerEvent;
}

function doneReport(): RunnerEvent {
  return { type: 'report', managerId: JOB.id, text: '終わった', status: 'done' } as RunnerEvent;
}

const noticesOf = (observations: readonly { notice?: unknown }[]) =>
  observations.filter((one) => one.notice !== undefined);

describe('作業者だけの上限を、担当の抱えている鍵の枠と一意に一致したときだけ鍵の休止経路へ流す', () => {
  it('⭐ 5時間の枠が担当の抱えている鍵（冷却明けと一致）のもの: 担当の身元つき・reached で1回呼ばれ、日誌に decision が残る', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote(RAW));
    await vi.waitFor(() => {
      expect(noticesOf(s.observations)).toHaveLength(1);
    });

    const [one] = noticesOf(s.observations) as { notice: { kind: string; text: string } }[];
    expect(one?.notice.kind).toBe('reached');
    expect(one?.notice.text).toBe(RAW);
    expect(s.observations[0]).toMatchObject({ observedBy: { tokenId: KEY_A.id, generation: 7 } });

    const decisions = (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
      JSON.stringify(e).includes('担当が抱えている鍵'),
    );
    expect(decisions).toHaveLength(1);
    const text = JSON.stringify(decisions[0]);
    expect(text).toContain(JOB.id);
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain(KEY_A.id);
    expect(text).not.toContain('SECRET');
    // 流した回は、クローンへの知らせにも日誌の note にもそうと分かる
    const report = s.inbox.find((e) => e.type === 'manager_message' && e.text.includes('作業者'));
    expect(JSON.stringify(report)).toContain('休ませて担当を移す経路へ流した');
    // 鍵の突き合わせの行は末尾のまま
    expect((report && 'text' in report ? report.text : '').split('\n').at(-1)).toContain(
      '鍵の突き合わせ:',
    );
    // 担当本体が枠で止まったわけではない
    expect((await s.stores.jobs.listJobs())[0]?.usageStoppedAt).toBeUndefined();
    await s.pool.stop();
  });

  it('同じ鍵への2通目以降も、割り当てが替わるまでは同じ形で届く（受け側の判定は回し手に任せる）', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote(RAW));
    s.fake.push(workerLimitNote(RAW));
    await vi.waitFor(() => {
      expect(noticesOf(s.observations)).toHaveLength(2);
    });
    expect(JSON.stringify(noticesOf(s.observations))).not.toContain('SECRET');
    await s.pool.stop();
  });

  it.each([
    [
      '別の鍵（担当の抱えていない鍵）に一致',
      [{ ...KEY_A, cooldownUntil: undefined }, { ...KEY_B, ...COOLING }, KEY_C],
    ],
    ['どの鍵にも一致しない', [{ ...KEY_A, cooldownUntil: undefined }, KEY_B, KEY_C]],
    ['複数の鍵に一致', [KEY_A, { ...KEY_B, ...COOLING }, KEY_C]],
  ])('%s なら流さない（決め打ちしない）', async (_name, pool) => {
    const s = await setup(pool as AgentToken[]);
    s.fake.push(workerLimitNote(RAW));
    await settle();

    expect(s.observations).toEqual([]);
    expect(
      (await s.stores.journal.list({ types: ['decision'] })).filter((e) =>
        JSON.stringify(e).includes('担当が抱えている鍵'),
      ),
    ).toEqual([]);
    await s.pool.stop();
  });

  it('原文の resets が読めなければ流さない', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote("You've hit your 5-hour limit"));
    await settle();
    expect(s.observations).toEqual([]);
    await s.pool.stop();
  });

  it('上限（reached）と分類できない原文は、鍵に一致しても流さない', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote('何か別の理由で落ちた · resets 6pm (Asia/Tokyo)'));
    await settle();
    expect(s.observations).toEqual([]);
    await s.pool.stop();
  });
});

describe('作業者の落ちで担当の割り当てが移った後、ターンの終わりで担当を起こす', () => {
  it('⭐ 抱えている鍵と走るべき鍵の tokenId が食い違えば、preRotationKey が偽でも done で起こす', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote("You've hit your 5-hour limit"));
    await settle();
    // 割り当てが鍵Bへ移った（runner の鍵の回転は経ない）
    s.target.current = { tokenId: KEY_B.id, generation: 8 };
    s.fake.push(doneReport());

    await vi.waitFor(() => {
      expect(s.fake.delivered).toHaveLength(1);
    });
    expect(s.fake.delivered[0]).toContain('作業者が上限で落ちた鍵は回った');
    await s.pool.stop();
  });

  it('同じ鍵のまま世代だけが食い違っても、done で起こす', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote("You've hit your 5-hour limit"));
    await settle();
    s.target.current = { tokenId: KEY_A.id, generation: 9 };
    s.fake.push(doneReport());

    await vi.waitFor(() => {
      expect(s.fake.delivered).toHaveLength(1);
    });
    await s.pool.stop();
  });

  it('食い違わなければ（抱えている鍵のまま）、preRotationKey が偽なら今どおり done では起こさない', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C]);
    s.fake.push(workerLimitNote("You've hit your 5-hour limit"));
    s.fake.push(doneReport());
    await settle();

    expect(s.fake.delivered).toEqual([]);
    await s.pool.stop();
  });

  it('⭐ 作業者だけの上限 → 観測が流れ、回し手が割り当てを移す → 担当が done で終えると新しい鍵で起こされる（core 側の2段）', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C], {
      onObservation: (observation, target) => {
        // デーモンの `coolAssigned` + `evacuate` の代役: 休ませた鍵の持ち主を別の鍵へ移す
        if (observation.notice !== undefined) target.current = { tokenId: KEY_B.id, generation: 8 };
      },
    });
    s.fake.push(workerLimitNote(RAW));
    await vi.waitFor(() => {
      expect(noticesOf(s.observations)).toHaveLength(1);
    });
    s.fake.push(doneReport());

    await vi.waitFor(() => {
      expect(s.fake.delivered).toHaveLength(1);
    });
    expect(s.fake.delivered[0]).toContain('いまの現役は世代 8');
    expect(JSON.stringify(s.fake.delivered)).not.toContain(KEY_B.id);
    await s.pool.stop();
  });
});
