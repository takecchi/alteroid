import type { ManagerSummary, WorkerToolEvent } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { topologyResponseSchema } from './openapi.js';
import {
  createTopologyActivityTracker,
  managerWorkerLink,
  peerAgentType,
} from './topology-activity.js';
import { buildTopologySnapshot, type TopologyInputs } from './topology.js';

/**
 * peer（マネージャーが MCP `peer` で頼んだ Codex）が、作業者と同じ経路でホームの稼働状況に載ること（#4122）。
 * - 日誌の `tool_use`（actor `peer:<managerId>:<provider>`）→ 札の「最後の道具」と光
 * - マネージャーの `mcp__alteroid-peer__peer_run` → 頼んだ線と札（名指しのモデル）
 * - runner の `tool_running` / `tool_end`（ターンの開始と終わり）→ 札の「実行中」とモデル
 */

const NOW = Date.parse('2026-10-08T03:00:00.000Z');
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

function snapshotOf(activity: ReturnType<typeof createTopologyActivityTracker>) {
  const input: TopologyInputs = {
    nowMs: NOW,
    turn: null,
    usageBlocked: false,
    storage: { state: 'unknown' },
    runners: [],
    managers: [manager()],
    activity,
  };
  const snapshot = buildTopologySnapshot(input);
  topologyResponseSchema.parse(snapshot);
  return snapshot;
}

const peerRunning = (toolUseId: string, model?: string): WorkerToolEvent => ({
  type: 'tool_running',
  managerId: 'm1',
  actor: 'peer:m1:codex',
  tool: 'peer_run',
  toolUseId,
  startedAt: iso(-5_000),
  ...(model === undefined ? {} : { model }),
});

describe('peer（Codex）の札（#4122）', () => {
  it('ターンが始まると、頼んだマネージャーの下に「実行中」の札が立ち、モデルが出る', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(peerRunning('peer:s1:1', 'gpt-5.5'));
    expect(snapshotOf(activity).managers[0]?.workers).toEqual([
      {
        agentType: 'peer:codex',
        peer: { provider: 'codex' },
        model: 'gpt-5.5',
        runningTool: { tool: 'peer_run', startedAt: iso(-5_000) },
      },
    ]);
  });

  it('ターンが終わると「実行中」は消えるが、札とモデルは残る', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(peerRunning('peer:s1:1', 'gpt-5.5'));
    activity.recordWorkerTool({ type: 'tool_end', managerId: 'm1', toolUseId: 'peer:s1:1' });
    expect(snapshotOf(activity).managers[0]?.workers).toEqual([
      { agentType: 'peer:codex', peer: { provider: 'codex' }, model: 'gpt-5.5' },
    ]);
  });

  it('モデルを名乗らないターンは、モデルの欄を作らない（既定と読む）', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(peerRunning('peer:s1:1'));
    const [row] = snapshotOf(activity).managers[0]?.workers ?? [];
    expect(row).not.toHaveProperty('model');
  });

  it('peer が実行した道具（日誌の tool_use）は、札の最後の道具と光になる', () => {
    const activity = createTopologyActivityTracker();
    activity.record({
      id: 'x',
      at: iso(-2_000),
      type: 'tool_use',
      actor: 'peer:m1:codex',
      tool: 'commandExecution',
      input: {},
    } as never);
    expect(snapshotOf(activity).managers[0]?.workers).toEqual([
      {
        agentType: 'peer:codex',
        peer: { provider: 'codex' },
        lastTool: 'commandExecution',
        lastToolAt: iso(-2_000),
      },
    ]);
    expect(activity.links()).toEqual([
      { key: managerWorkerLink('m1', peerAgentType('codex')), lastActivityAt: iso(-2_000) },
    ]);
  });

  it('マネージャーの peer_run は頼んだ線（返り）と札を立て、名指しのモデルを札に置く', () => {
    const activity = createTopologyActivityTracker();
    activity.record({
      id: 'y',
      at: iso(-1_000),
      type: 'tool_use',
      actor: 'manager:m1',
      tool: 'mcp__alteroid-peer__peer_run',
      input: { provider: 'codex', prompt: '直して', model: 'gpt-5.5' },
    } as never);
    expect(snapshotOf(activity).managers[0]?.workers).toEqual([
      { agentType: 'peer:codex', peer: { provider: 'codex' }, model: 'gpt-5.5' },
    ]);
    expect(activity.links()).toEqual([
      { key: managerWorkerLink('m1', 'peer:codex'), lastUpAt: iso(-1_000) },
    ]);
  });

  it('以前の actor（peer:<provider>。マネージャーを持たない）は地図に載せない（推測で寄せない）', () => {
    const activity = createTopologyActivityTracker();
    activity.record({
      id: 'z',
      at: iso(-1_000),
      type: 'tool_use',
      actor: 'peer:codex',
      tool: 'commandExecution',
      input: {},
    } as never);
    expect(snapshotOf(activity).managers[0]?.workers).toEqual([]);
  });

  it('作業者の札と並んで出て、混ざらない', () => {
    const activity = createTopologyActivityTracker();
    activity.recordWorkerTool(peerRunning('peer:s1:1', 'gpt-5.5'));
    activity.recordWorkerTool({
      type: 'tool_running',
      managerId: 'm1',
      actor: 'worker:m1:worker',
      tool: 'Bash',
      toolUseId: 'w1',
      startedAt: iso(-30_000),
    });
    const rows = snapshotOf(activity).managers[0]?.workers ?? [];
    expect(rows.map((row) => [row.agentType, row.peer?.provider, row.runningTool?.tool])).toEqual([
      ['peer:codex', 'codex', 'peer_run'],
      ['worker', undefined, 'Bash'],
    ]);
  });
});
