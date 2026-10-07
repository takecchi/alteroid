import type { ManagerSummary, WorkerToolEvent } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { topologyResponseSchema } from './openapi.js';
import { createTopologyActivityTracker, createWorkerToolBus } from './topology-activity.js';
import {
  TOPOLOGY_RUNNING_TOOL_MAX_MS,
  buildTopologySnapshot,
  type TopologyInputs,
} from './topology.js';

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function manager(overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: 'm1',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: iso(-3_600_000),
    updatedAt: iso(-1_000),
    waiting: [],
    ...overrides,
  } as ManagerSummary;
}

const running = (toolUseId: string, startedAt: string, tool = 'Bash'): WorkerToolEvent => ({
  type: 'tool_running',
  managerId: 'm1',
  actor: 'worker:m1:worker',
  tool,
  toolUseId,
  startedAt,
});
const end = (toolUseId: string): WorkerToolEvent => ({
  type: 'tool_end',
  managerId: 'm1',
  toolUseId,
});

function snapshotOf(
  activity: ReturnType<typeof createTopologyActivityTracker>,
  m: ManagerSummary = manager(),
) {
  const input: TopologyInputs = {
    nowMs: NOW,
    turn: null,
    usageBlocked: false,
    storage: { state: 'unknown' },
    runners: [],
    managers: [m],
    activity,
  };
  const snapshot = buildTopologySnapshot(input);
  topologyResponseSchema.parse(snapshot);
  return snapshot;
}

const runningToolOf = (snapshot: ReturnType<typeof snapshotOf>) =>
  snapshot.managers[0]?.workers[0]?.runningTool;

describe('作業者の実行中の道具（#2725）', () => {
  it('tool_running で載り、未決のうち最も古いものを返す', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(running('b', iso(-30_000), 'Read'));
    activity.recordWorkerTool(running('a', iso(-90_000), 'Bash'));
    expect(runningToolOf(snapshotOf(activity))).toEqual({ tool: 'Bash', startedAt: iso(-90_000) });
  });

  it('tool_end で消え、残りがあれば次に古いものへ移る', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(running('a', iso(-90_000)));
    activity.recordWorkerTool(running('b', iso(-30_000), 'Read'));
    activity.recordWorkerTool(end('a'));
    expect(runningToolOf(snapshotOf(activity))).toEqual({ tool: 'Read', startedAt: iso(-30_000) });
    activity.recordWorkerTool(end('b'));
    expect(runningToolOf(snapshotOf(activity))).toBeUndefined();
  });

  it('tool_end が先に届いても、後から来る tool_running は残らない', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(end('a'));
    activity.recordWorkerTool(running('a', iso(-90_000)));
    expect(runningToolOf(snapshotOf(activity))).toBeUndefined();
  });

  it('変化したときだけ onChange を呼ぶ（未知の end では呼ばない）', () => {
    const activity = createTopologyActivityTracker();
    let calls = 0;
    activity.onChange(() => (calls += 1));
    activity.recordWorkerTool(end('zzz'));
    expect(calls).toBe(0);
    activity.recordWorkerTool(running('a', iso(-90_000)));
    activity.recordWorkerTool(end('a'));
    expect(calls).toBe(2);
  });

  it('上限を超えたら古いものから間引く', () => {
    const activity = createTopologyActivityTracker(2);
    activity.recordWorkerTool(running('a', iso(-300_000)));
    activity.recordWorkerTool(running('b', iso(-200_000), 'Read'));
    activity.recordWorkerTool(running('c', iso(-100_000), 'Edit'));
    expect(runningToolOf(snapshotOf(activity))).toEqual({ tool: 'Read', startedAt: iso(-200_000) });
  });

  it('欄を送らない古い runner では、今までどおり runningTool が無い', () => {
    const activity = createTopologyActivityTracker();
    activity.record({
      id: 'x',
      at: iso(-2000),
      type: 'tool_use',
      actor: 'worker:m1:worker',
      tool: 'Edit',
      input: {},
    } as never);
    const snapshot = snapshotOf(activity);
    expect(snapshot.managers[0]?.workers).toEqual([
      { agentType: 'worker', lastTool: 'Edit', lastToolAt: iso(-2000) },
    ]);
  });

  describe('読み出しの保険（載せない条件）', () => {
    const seeded = () => {
      const activity = createTopologyActivityTracker();
      activity.recordWorkerTool(running('a', iso(-90_000)));
      return activity;
    };
    it('途中の委譲（running + live）には載る', () => {
      expect(runningToolOf(snapshotOf(seeded()))).toBeDefined();
    });
    it('返事待ち・背景処理待ちにも載る', () => {
      expect(
        runningToolOf(snapshotOf(seeded(), manager({ status: 'waiting_human' }))),
      ).toBeDefined();
      expect(
        runningToolOf(
          snapshotOf(
            seeded(),
            manager({
              status: 'done',
              live: false,
              awaitingBackground: {
                tasks: 1,
                withheldReports: 0,
                breakdown: '',
                since: iso(-1000),
              },
            } as Partial<ManagerSummary>),
          ),
        ),
      ).toBeDefined();
    });
    it.each(['done', 'stopped', 'failed', 'lost'] as const)('終端（%s）には載せない', (status) => {
      expect(runningToolOf(snapshotOf(seeded(), manager({ status, live: false })))).toBeUndefined();
      expect(runningToolOf(snapshotOf(seeded(), manager({ status, live: true })))).toBeUndefined();
    });
    it('live でない running には載せない', () => {
      expect(runningToolOf(snapshotOf(seeded(), manager({ live: false })))).toBeUndefined();
    });
    it('開始から2時間を超えたら載せない（ちょうどは載る）', () => {
      const old = createTopologyActivityTracker();
      old.recordWorkerTool(running('a', iso(-TOPOLOGY_RUNNING_TOOL_MAX_MS - 1)));
      expect(runningToolOf(snapshotOf(old))).toBeUndefined();
      const edge = createTopologyActivityTracker();
      edge.recordWorkerTool(running('a', iso(-TOPOLOGY_RUNNING_TOOL_MAX_MS)));
      expect(runningToolOf(snapshotOf(edge))).toBeDefined();
    });
  });
});

describe('createWorkerToolBus', () => {
  it('購読者へ流し、1人が投げても他へ届く。解除できる', () => {
    const bus = createWorkerToolBus();
    const got: string[] = [];
    bus.subscribe(() => {
      throw new Error('壊れた受け口');
    });
    const off = bus.subscribe((e) => got.push(e.type));
    bus.emit(end('a'));
    off();
    bus.emit(end('b'));
    expect(got).toEqual(['tool_end']);
  });

  it('tracker を attachWorkerTools で繋ぐと実行中が載る', () => {
    const bus = createWorkerToolBus();
    const activity = createTopologyActivityTracker();
    activity.attachWorkerTools(bus.subscribe);
    bus.emit(running('a', iso(-90_000)));
    expect(runningToolOf(snapshotOf(activity))).toBeDefined();
  });
});
