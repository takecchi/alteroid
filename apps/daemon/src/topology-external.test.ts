import type { JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { topologyResponseSchema } from './openapi.js';
import * as activityModule from './topology-activity.js';
import { createTopologyActivityTracker, mapJournalEntry } from './topology-activity.js';
import * as topologyModule from './topology.js';
import { buildTopologySnapshot, type TopologyInputs } from './topology.js';

/**
 * 外部サービス（連携の鍵）→ クローンの線（Issue #3676）。
 * 時刻は注入する（実時間を待たない）。
 */

const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

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

describe('external_event の写し（連携の鍵だけが外部の線になる）', () => {
  it('連携の鍵（via）で届いたものは、鍵ごとの外部サービスの活動になる', () => {
    const mapped = mapJournalEntry(
      externalEvent({ via: { keyId: 'k1', name: 'GitHub 連携' }, source: 'github', at: iso(-500) }),
    );
    expect(mapped.externals).toEqual([
      { keyId: 'k1', name: 'GitHub 連携', source: 'github', at: iso(-500) },
    ]);
  });

  it('via の無い external_event（デーモン自身の合図・人間の送信）は外部として数えない', () => {
    const mapped = mapJournalEntry(externalEvent({ source: 'internal' }));
    expect(mapped.externals ?? []).toEqual([]);
    expect(mapped.links).toEqual([]);
  });

  it('keyId が空の壊れた via は数えない（実行時の倒れ先）', () => {
    const mapped = mapJournalEntry(externalEvent({ via: { keyId: '', name: 'x' } }));
    expect(mapped.externals ?? []).toEqual([]);
  });
});

describe('スナップショットの外部サービス', () => {
  it('連携の鍵で受けた呼び出しは external:<keyId>~clone を down で光らせる', () => {
    const activity = createTopologyActivityTracker();
    activity.record(
      externalEvent({
        via: { keyId: 'k1', name: 'GitHub 連携' },
        source: 'github',
        at: iso(-2_000),
      }),
    );
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.links).toContainEqual({
      key: 'external:k1~clone',
      lastDownAt: iso(-2_000),
    });
    expect(snapshot.externals).toEqual([
      { keyId: 'k1', name: 'GitHub 連携', source: 'github', lastAt: iso(-2_000) },
    ]);
    // 向きは down だけ。up / activity は作らない（外部へ返すものは無い）。
    const link = snapshot.links.find((l) => l.key === 'external:k1~clone');
    expect(link?.lastUpAt).toBeUndefined();
    expect(link?.lastActivityAt).toBeUndefined();
    expect(topologyResponseSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('via の無い external_event は札も線も作らない（欄ごと無い）', () => {
    const activity = createTopologyActivityTracker();
    activity.record(externalEvent({ source: 'internal' }));
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toBeUndefined();
    expect(snapshot.externalsOmitted).toBeUndefined();
    expect(snapshot.links.filter((l) => l.key.startsWith('external'))).toEqual([]);
  });

  it('同じ鍵の呼び出しは1枚にまとまり、時刻は新しいほう・名前は最後のものを採る', () => {
    const activity = createTopologyActivityTracker();
    activity.record(externalEvent({ via: { keyId: 'k1', name: '旧名' }, at: iso(-9_000) }));
    activity.record(externalEvent({ via: { keyId: 'k1', name: '新名' }, at: iso(-3_000) }));
    // 古い時刻の行が後から届いても、時刻も名前も戻さない
    activity.record(externalEvent({ via: { keyId: 'k1', name: '旧名' }, at: iso(-8_000) }));
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toEqual([
      { keyId: 'k1', name: '新名', source: 'github', lastAt: iso(-3_000) },
    ]);
  });

  it('観測の窓（10分）を過ぎた鍵は札も線も出さない', () => {
    const activity = createTopologyActivityTracker();
    const window = topologyModule.TOPOLOGY_EXTERNAL_WINDOW_MS;
    activity.record(
      externalEvent({ via: { keyId: 'old', name: '古い' }, at: iso(-window - 1_000) }),
    );
    activity.record(
      externalEvent({ via: { keyId: 'new', name: '新しい' }, at: iso(-window + 1_000) }),
    );
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals?.map((e) => e.keyId)).toEqual(['new']);
    expect(snapshot.links.map((l) => l.key)).not.toContain('external:old~clone');
  });

  it('上限を超えた分は札にせず externalsOmitted と「ほか」の線にまとめる（光ればその線が光る）', () => {
    const activity = createTopologyActivityTracker();
    const max = topologyModule.TOPOLOGY_EXTERNALS_MAX;
    // 新しい順に max 本は札、残り2本はまとめる。まとめた側のうち最も新しい時刻が線に載る。
    for (let i = 0; i < max + 2; i++) {
      activity.record(
        externalEvent({ via: { keyId: `k${i}`, name: `鍵${i}` }, at: iso(-1_000 - i * 1_000) }),
      );
    }
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toHaveLength(max);
    expect(snapshot.externalsOmitted).toBe(2);
    const othersKey = activityModule.EXTERNAL_OTHERS_LINK;
    expect(snapshot.links.find((l) => l.key === othersKey)).toEqual({
      key: 'external-others~clone',
      lastDownAt: iso(-1_000 - max * 1_000),
    });
    // 札になった鍵だけが個別の線を持つ
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
      activity.record(externalEvent({ via: { keyId: `k${i}`, name: `鍵${i}` }, at: iso(-1_000) }));
    }
    const snapshot = buildTopologySnapshot(inputs({ activity }));
    expect(snapshot.externals).toHaveLength(max);
    expect(snapshot.externalsOmitted).toBeUndefined();
    expect(snapshot.links.map((l) => l.key)).not.toContain('external-others~clone');
  });

  it('札の並びは安定している（新しく呼ばれても並び替えない: 名前→keyId の順）', () => {
    const activity = createTopologyActivityTracker();
    activity.record(externalEvent({ via: { keyId: 'b', name: 'B' }, at: iso(-5_000) }));
    activity.record(externalEvent({ via: { keyId: 'a', name: 'A' }, at: iso(-4_000) }));
    const before = buildTopologySnapshot(inputs({ activity })).externals?.map((e) => e.keyId);
    activity.record(externalEvent({ via: { keyId: 'b', name: 'B' }, at: iso(-1_000) }));
    const after = buildTopologySnapshot(inputs({ activity })).externals?.map((e) => e.keyId);
    expect(before).toEqual(['a', 'b']);
    expect(after).toEqual(['a', 'b']);
  });
});
