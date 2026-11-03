import type { JobStatus, ManagerSummary } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createTopologyActivityTracker } from './topology-activity.js';
import { buildTopologySnapshot, type TopologyInputs } from './topology.js';

// 地図（トポロジー）に載せる判定の、委譲の状態（JobStatus）ごとの端の振る舞いを固定する（現状の挙動を固定。まとめる PR で見直す）。
// 本番コードは変えない。`topology.ts` の isActiveStatus（running / waiting_human）・isListedOnRunner・isStoppedByUsage（lost / failed / stopped を除く）は
// 非公開なので、公開の `buildTopologySnapshot` に載るかどうかで観測する。窓（TOPOLOGY_ENDED_WINDOW_MS）の外に出した古い行にして、窓で載る経路を消す。

const NOW = Date.parse('2026-10-04T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const STATUSES = [
  'running',
  'waiting_human',
  'done',
  'failed',
  'lost',
  'stopped',
  'bogus',
] as const;

function manager(status: string, overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: status,
    status: status as JobStatus,
    live: true,
    cwd: '/work',
    request: `依頼 ${status}`,
    startedAt: iso(-3 * 60 * 60_000),
    updatedAt: iso(-2 * 60 * 60_000),
    waiting: [],
    ...overrides,
  } as ManagerSummary;
}

function onMap(overridesOf: (status: string) => Partial<ManagerSummary>): Record<string, boolean> {
  const input: TopologyInputs = {
    nowMs: NOW,
    turn: null,
    usageBlocked: false,
    storage: { state: 'unknown' },
    runners: [],
    managers: STATUSES.map((status) => manager(status, overridesOf(status))),
    activity: createTopologyActivityTracker(),
  };
  const ids = new Set(buildTopologySnapshot(input).managers.map((m) => m.managerId));
  return Object.fromEntries(STATUSES.map((status) => [status, ids.has(status)]));
}

describe('地図に載る判定 × JobStatus（現状の挙動を固定。まとめる PR で見直す）', () => {
  it('窓の外の古い行は、running と waiting_human だけが載る（isActiveStatus）。未知は載らない', () => {
    expect(onMap(() => ({}))).toEqual({
      running: true,
      waiting_human: true,
      done: false,
      failed: false,
      lost: false,
      stopped: false,
      bogus: false,
    });
  });

  it('枠で止まっている行（usageStoppedAt）は、lost / failed / stopped 以外が載る（isStoppedByUsage）。未知も載る', () => {
    expect(onMap(() => ({ usageStoppedAt: iso(-2 * 60 * 60_000) }))).toEqual({
      running: true,
      waiting_human: true,
      done: true,
      failed: false,
      lost: false,
      stopped: false,
      bogus: true,
    });
  });

  it('runner の一覧に新しく載っている行（runnerListedAt）は、lost / failed / stopped 以外が載る（isListedOnRunner）。未知も載る', () => {
    expect(onMap(() => ({ runnerListedAt: iso(-1_000) }))).toEqual({
      running: true,
      waiting_human: true,
      done: true,
      failed: false,
      lost: false,
      stopped: false,
      bogus: true,
    });
  });

  it('⚠ 未知の値の倒れ先が判定ごとに違う: isActiveStatus は載せない、isStoppedByUsage / isListedOnRunner は載せる', () => {
    const active = onMap(() => ({}));
    const usage = onMap(() => ({ usageStoppedAt: iso(-2 * 60 * 60_000) }));
    expect(active['bogus']).toBe(false);
    expect(usage['bogus']).toBe(true);
  });
});
