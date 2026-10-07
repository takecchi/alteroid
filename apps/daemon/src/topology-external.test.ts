import type { JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { topologyResponseSchema } from './openapi.js';
import * as activityModule from './topology-activity.js';
import {
  createTopologyActivityTracker,
  mapJournalEntry,
  type ExternalTouch,
} from './topology-activity.js';
import * as topologyModule from './topology.js';
import { buildTopologySnapshot, type TopologyInputs } from './topology.js';

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function touch(keyId: string, name: string, at: string, source = 'github'): ExternalTouch {
  return { keyId, name, source, at };
}

let seq = 0;
function externalEvent(
  fields: { source?: string; via?: { keyId: string; name: string }; at?: string } = {},
): JournalEntry {
  seq += 1;
  return {
    type: 'external_event',
    id: `x${seq}`,
    at: fields.at ?? iso(-1_000),
    source: fields.source ?? 'github',
    summary: '{}',
    ...(fields.via === undefined ? {} : { via: fields.via }),
  } as unknown as JournalEntry;
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

describe('日誌の external_event は拾わない（受け付けた時刻で入れるので、二重に光らせない）', () => {
  it('via 付きでも線にも札にもならない（at はクローンが取り出した時刻で、受け付けた時刻ではない）', () => {
    const mapped = mapJournalEntry(
      externalEvent({ via: { keyId: 'k1', name: 'GitHub 連携' }, source: 'github', at: iso(-500) }),
    );
    expect(mapped).toEqual({ links: [], workers: [] });

    const activity = createTopologyActivityTracker();
    activity.record(externalEvent({ via: { keyId: 'k1', name: 'GitHub 連携' } }));
    activity.record(externalEvent({ source: 'internal' }));
    expect(activity.externals()).toEqual([]);
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toBeUndefined();
    expect(snapshot.links.filter((l) => l.key.startsWith('external'))).toEqual([]);
  });

  it('受け付けた後に日誌の行が来ても、時刻は受け付けた時刻のまま', () => {
    const activity = createTopologyActivityTracker();
    activity.recordExternal(touch('k1', 'GitHub 連携', iso(-5_000)));
    activity.record(externalEvent({ via: { keyId: 'k1', name: 'GitHub 連携' }, at: iso(-1_000) }));
    expect(activity.externals().map((e) => e.lastAt)).toEqual([iso(-5_000)]);
  });
});

describe('recordExternal', () => {
  it('keyId が空・時刻が読めないものは数えない（実行時の倒れ先）', () => {
    const activity = createTopologyActivityTracker();
    activity.recordExternal(touch('', 'x', iso(-1_000)));
    activity.recordExternal(touch('k1', 'x', 'not-a-time'));
    expect(activity.externals()).toEqual([]);
  });

  it('流れ（onChange）へ知らせる——日誌を通らないので、知らせないと SSE が組み直さない', () => {
    const activity = createTopologyActivityTracker();
    let changes = 0;
    activity.onChange(() => {
      changes += 1;
    });
    activity.recordExternal(touch('k1', 'GitHub 連携', iso(-1_000)));
    expect(changes).toBe(1);
  });
});

describe('スナップショットの外部サービス', () => {
  it('連携の鍵で受けた呼び出しは external:<keyId>~clone を down で光らせる', () => {
    const activity = createTopologyActivityTracker();
    activity.recordExternal(touch('k1', 'GitHub 連携', iso(-2_000)));
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.links).toContainEqual({
      key: 'external:k1~clone',
      lastDownAt: iso(-2_000),
    });
    expect(snapshot.externals).toEqual([
      { keyId: 'k1', name: 'GitHub 連携', source: 'github', lastAt: iso(-2_000) },
    ]);
    const link = snapshot.links.find((l) => l.key === 'external:k1~clone');
    expect(link?.lastUpAt).toBeUndefined();
    expect(link?.lastActivityAt).toBeUndefined();
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('何も受け付けていなければ札も線も作らない（欄ごと無い）', () => {
    const snapshot = buildTopologySnapshot(inputs());
    expect(snapshot.externals).toBeUndefined();
    expect(snapshot.externalsOmitted).toBeUndefined();
    expect(snapshot.links.filter((l) => l.key.startsWith('external'))).toEqual([]);
  });

  it('同じ鍵の呼び出しは1枚にまとまり、時刻は新しいほう・名前は最後のものを採る', () => {
    const activity = createTopologyActivityTracker();
    activity.recordExternal(touch('k1', '旧名', iso(-9_000)));
    activity.recordExternal(touch('k1', '新名', iso(-3_000)));
    activity.recordExternal(touch('k1', '旧名', iso(-8_000)));
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toEqual([
      { keyId: 'k1', name: '新名', source: 'github', lastAt: iso(-3_000) },
    ]);
  });

  it('観測の窓（10分）を過ぎた鍵は札も線も出さない', () => {
    const activity = createTopologyActivityTracker();
    const window = topologyModule.TOPOLOGY_EXTERNAL_WINDOW_MS;
    activity.recordExternal(touch('old', '古い', iso(-window - 1_000)));
    activity.recordExternal(touch('new', '新しい', iso(-window + 1_000)));
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals?.map((e) => e.keyId)).toEqual(['new']);
    expect(snapshot.links.map((l) => l.key)).not.toContain('external:old~clone');
  });

  it('上限を超えた分は札にせず externalsOmitted と「ほか」の線にまとめる（光ればその線が光る）', () => {
    const activity = createTopologyActivityTracker();
    const max = topologyModule.TOPOLOGY_EXTERNALS_MAX;
    for (let i = 0; i < max + 2; i++) {
      activity.recordExternal(touch(`k${i}`, `鍵${i}`, iso(-1_000 - i * 1_000)));
    }
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toHaveLength(max);
    expect(snapshot.externalsOmitted).toBe(2);
    const othersKey = activityModule.EXTERNAL_OTHERS_LINK;
    expect(snapshot.links.find((l) => l.key === othersKey)).toEqual({
      key: 'external-others~clone',
      lastDownAt: iso(-1_000 - max * 1_000),
    });
    const shown = new Set(snapshot.externals?.map((e) => e.keyId));
    const individual = snapshot.links
      .filter((l) => l.key.startsWith('external:'))
      .map((l) => l.key.slice('external:'.length, -'~clone'.length));
    expect(new Set(individual)).toEqual(shown);
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('上限ちょうどなら「ほか」は出ない', () => {
    const activity = createTopologyActivityTracker();
    const max = topologyModule.TOPOLOGY_EXTERNALS_MAX;
    for (let i = 0; i < max; i++) {
      activity.recordExternal(touch(`k${i}`, `鍵${i}`, iso(-1_000)));
    }
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toHaveLength(max);
    expect(snapshot.externalsOmitted).toBeUndefined();
    expect(snapshot.links.map((l) => l.key)).not.toContain('external-others~clone');
  });

  it('札の並びは安定している（新しく呼ばれても並び替えない: 名前→keyId の順）', () => {
    const activity = createTopologyActivityTracker();
    activity.recordExternal(touch('b', 'B', iso(-5_000)));
    activity.recordExternal(touch('a', 'A', iso(-4_000)));
    const before = buildTopologySnapshot(inputs({ activity })).externals?.map((e) => e.keyId);
    activity.recordExternal(touch('b', 'B', iso(-1_000)));
    const after = buildTopologySnapshot(inputs({ activity })).externals?.map((e) => e.keyId);
    expect(before).toEqual(['a', 'b']);
    expect(after).toEqual(['a', 'b']);
  });
});
