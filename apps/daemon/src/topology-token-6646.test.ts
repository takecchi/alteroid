import type { ManagerSummary } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { topologyResponseSchema } from './openapi.js';
import { createTopologyActivityTracker } from './topology-activity.js';
import { buildTopologySnapshot, type TopologyInputs } from './topology.js';

const NOW = Date.parse('2026-11-09T16:30:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function manager(overrides: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: 'mgr-a',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: iso(-60_000),
    updatedAt: iso(-1_000),
    waiting: [],
    ...overrides,
  } as ManagerSummary;
}

function snapshotOf(extra: Partial<TopologyInputs>) {
  const input: TopologyInputs = {
    nowMs: NOW,
    turn: null,
    usageBlocked: false,
    storage: { state: 'unknown' },
    runners: [],
    managers: [],
    activity: createTopologyActivityTracker(),
    ...extra,
  };
  const snapshot = buildTopologySnapshot(input);
  topologyResponseSchema.parse(snapshot);
  return snapshot;
}

describe('地図: どの担当がどの鍵で動いているか（#6646）', () => {
  it('マネージャーとクローンに、鍵の id とラベルを載せる（値は載せない）', () => {
    const snapshot = snapshotOf({
      managers: [
        manager({ managerId: 'mgr-a', tokenId: 'tok-1' }),
        manager({ managerId: 'mgr-b', tokenId: 'tok-2' }),
      ],
      tokenLabels: new Map([
        ['tok-1', 'alice@example.test'],
        ['tok-2', 'bob@example.test'],
      ]),
      cloneTokenId: 'tok-2',
    });

    expect(snapshot.clone.token).toEqual({ tokenId: 'tok-2', label: 'bob@example.test' });
    expect(snapshot.managers.map((m) => [m.managerId, m.token])).toEqual([
      ['mgr-a', { tokenId: 'tok-1', label: 'alice@example.test' }],
      ['mgr-b', { tokenId: 'tok-2', label: 'bob@example.test' }],
    ]);
  });

  it('プールに居ない鍵（消された行）は id だけを載せる', () => {
    const snapshot = snapshotOf({
      managers: [manager({ tokenId: 'tok-gone' })],
      tokenLabels: new Map([['tok-1', 'alice@example.test']]),
    });
    expect(snapshot.managers[0]?.token).toEqual({ tokenId: 'tok-gone' });
  });

  it('鍵が分からない担当には欄を作らない（現役で埋めない）', () => {
    const snapshot = snapshotOf({
      managers: [manager()],
      tokenLabels: new Map([['tok-1', 'alice@example.test']]),
    });
    expect(snapshot.managers[0]).not.toHaveProperty('token');
    expect(snapshot.clone).not.toHaveProperty('token');
  });
});
