import { qualifiedToolName, type JournalEntry } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import {
  CLONE_STORAGE_LINK,
  HUMAN_CLONE_LINK,
  cloneManagerLink,
  createTopologyActivityTracker,
  managerWorkerLink,
  mapJournalEntry,
  parseWorkerActor,
} from './topology-activity.js';

const T1 = '2026-10-04T10:00:01.000Z';
const T2 = '2026-10-04T10:00:02.000Z';

let seq = 0;
function entry<T extends JournalEntry['type']>(
  type: T,
  fields: Omit<Extract<JournalEntry, { type: T }>, 'type' | 'id' | 'at'> & { at?: string },
): JournalEntry {
  seq += 1;
  return { type, id: `e${seq}`, at: T1, ...fields } as unknown as JournalEntry;
}

describe('mapJournalEntry（日誌1件 → 線の変化）', () => {
  it('人間の発言は human~clone の down、クローンの応答は up', () => {
    expect(
      mapJournalEntry(entry('exchange', { with: 'human', role: 'inbound', text: 'こんにちは' }))
        .links,
    ).toEqual([{ key: HUMAN_CLONE_LINK, direction: 'down', at: T1 }]);
    expect(
      mapJournalEntry(entry('exchange', { with: 'human', role: 'outbound', text: 'やあ' })).links,
    ).toEqual([{ key: HUMAN_CLONE_LINK, direction: 'up', at: T1 }]);
  });

  it('内部ターン（self）はどの線にも載らない', () => {
    expect(
      mapJournalEntry(entry('exchange', { with: 'self', role: 'inbound', text: '蒸留' })),
    ).toEqual({ links: [], workers: [] });
  });

  it('マネージャーとの往復は managerId があるときだけ線へ載る（outbound=down / inbound=up）', () => {
    expect(
      mapJournalEntry(
        entry('exchange', {
          with: 'manager',
          role: 'outbound',
          text: '[m1] 実装して',
          managerId: 'm1',
        }),
      ).links,
    ).toEqual([{ key: 'clone~manager:m1', direction: 'down', at: T1 }]);
    expect(
      mapJournalEntry(
        entry('exchange', {
          with: 'manager',
          role: 'inbound',
          text: '[m1/done] 終わった',
          managerId: 'm1',
        }),
      ).links,
    ).toEqual([{ key: 'clone~manager:m1', direction: 'up', at: T1 }]);
  });

  it('managerId の無い manager の行（古い行・内部の注記）は数えない（text から推測しない）', () => {
    expect(
      mapJournalEntry(
        entry('exchange', { with: 'manager', role: 'outbound', text: '[m1] 実装して' }),
      ),
    ).toEqual({ links: [], workers: [] });
  });

  it('マネージャー発の escalation は up、managerId の無い escalation は数えない', () => {
    expect(
      mapJournalEntry(
        entry('escalation', { question: 'どうする', approvalId: 'a1', managerId: 'm1' }),
      ).links,
    ).toEqual([{ key: 'clone~manager:m1', direction: 'up', at: T1 }]);
    expect(
      mapJournalEntry(entry('escalation', { question: 'どうする', approvalId: 'a2' })).links,
    ).toEqual([]);
  });

  it('記憶の書き込み（memory_update）は clone~storage の down。人間の直接編集は数えない', () => {
    expect(
      mapJournalEntry(
        entry('memory_update', { slug: 'a', cause: 'clone', action: 'write' } as never),
      ).links,
    ).toEqual([{ key: CLONE_STORAGE_LINK, direction: 'down', at: T1 }]);
    expect(
      mapJournalEntry(
        entry('memory_update', { slug: 'a', cause: 'human', action: 'write' } as never),
      ).links,
    ).toEqual([]);
  });

  it('クローンの読む道具は clone~storage の up（修飾名でも素の名前でも）', () => {
    for (const tool of [qualifiedToolName('memory_read'), 'journal_read']) {
      expect(mapJournalEntry(entry('tool_use', { actor: 'clone', tool, input: {} })).links).toEqual(
        [{ key: CLONE_STORAGE_LINK, direction: 'up', at: T1 }],
      );
    }
  });

  it('クローンの書く道具が tool_use として残った回は down。無関係な道具・サブエージェントは数えない', () => {
    expect(
      mapJournalEntry(
        entry('tool_use', { actor: 'clone', tool: qualifiedToolName('memory_write'), input: {} }),
      ).links,
    ).toEqual([{ key: CLONE_STORAGE_LINK, direction: 'down', at: T1 }]);
    expect(
      mapJournalEntry(entry('tool_use', { actor: 'clone', tool: 'Bash', input: {} })).links,
    ).toEqual([]);
    expect(
      mapJournalEntry(
        entry('tool_use', {
          actor: 'clone:sub:x',
          tool: qualifiedToolName('memory_read'),
          input: {},
        }),
      ).links,
    ).toEqual([]);
  });

  it('背景（run_in_background: true）で起こすと worker 線の down と行の作成', () => {
    for (const tool of ['Agent', 'Task']) {
      const mapped = mapJournalEntry(
        entry('tool_use', {
          actor: 'manager:m1',
          tool,
          input: { subagent_type: 'reviewer', run_in_background: true },
        }),
      );
      expect(mapped.links).toEqual([
        { key: managerWorkerLink('m1', 'reviewer'), direction: 'down', at: T1 },
      ]);
      expect(mapped.workers).toEqual([{ managerId: 'm1', agentType: 'reviewer', at: T1 }]);
    }
  });

  it('前景の呼び出し（run_in_background が無い・false・真偽値でない）は結果が戻った up。行は作る', () => {
    for (const input of [
      { subagent_type: 'reviewer' },
      { subagent_type: 'reviewer', run_in_background: false },
      { subagent_type: 'reviewer', run_in_background: 'true' },
      { subagent_type: 'reviewer', run_in_background: 1 },
    ]) {
      const mapped = mapJournalEntry(
        entry('tool_use', { actor: 'manager:m1', tool: 'Agent', input }),
      );
      expect(mapped.links).toEqual([
        { key: managerWorkerLink('m1', 'reviewer'), direction: 'up', at: T1 },
      ]);
      expect(mapped.workers).toEqual([{ managerId: 'm1', agentType: 'reviewer', at: T1 }]);
    }
  });

  it('subagent_type が無い起こし方は作業者層の既定名（worker）で数える。Bash 等は数えない', () => {
    expect(
      mapJournalEntry(
        entry('tool_use', { actor: 'manager:m1', tool: 'Agent', input: { prompt: 'x' } }),
      ).links[0]?.key,
    ).toBe('manager:m1~worker:worker');
    expect(
      mapJournalEntry(entry('tool_use', { actor: 'manager:m1', tool: 'Bash', input: {} })),
    ).toEqual({ links: [], workers: [] });
  });

  it('作業者の道具実行は線の activity と行の lastTool', () => {
    const mapped = mapJournalEntry(
      entry('tool_use', { actor: 'worker:m1:worker', tool: 'Edit', input: {} }),
    );
    expect(mapped.links).toEqual([
      { key: 'manager:m1~worker:worker', direction: 'activity', at: T1 },
    ]);
    expect(mapped.workers).toEqual([
      { managerId: 'm1', agentType: 'worker', at: T1, tool: 'Edit' },
    ]);
  });

  it('parseWorkerActor は managerId を最初の : までで切る。形が違えば undefined', () => {
    expect(parseWorkerActor('worker:mgr-1:a:b')).toEqual({ managerId: 'mgr-1', agentType: 'a:b' });
    expect(parseWorkerActor('worker:mgr-1')).toBeUndefined();
    expect(parseWorkerActor('worker::x')).toBeUndefined();
    expect(parseWorkerActor('manager:m1')).toBeUndefined();
  });

  it('対象外の種別は空', () => {
    expect(mapJournalEntry(entry('decision', { text: 'x' } as never))).toEqual({
      links: [],
      workers: [],
    });
  });
});

describe('createTopologyActivityTracker', () => {
  it('向きごとに最後の時刻だけを持ち、古い時刻で巻き戻さない', () => {
    const tracker = createTopologyActivityTracker();
    tracker.record(entry('exchange', { with: 'human', role: 'inbound', text: 'a', at: T2 }));
    tracker.record(entry('exchange', { with: 'human', role: 'inbound', text: 'b', at: T1 }));
    tracker.record(entry('exchange', { with: 'human', role: 'outbound', text: 'c', at: T1 }));
    expect(tracker.links()).toEqual([{ key: HUMAN_CLONE_LINK, lastDownAt: T2, lastUpAt: T1 }]);
  });

  it('作業者は managerId × agentType で束ね、lastTool は新しい側の道具', () => {
    const tracker = createTopologyActivityTracker();
    tracker.record(entry('tool_use', { actor: 'manager:m1', tool: 'Agent', input: {} }));
    expect(tracker.workersOf('m1')).toEqual([{ managerId: 'm1', agentType: 'worker' }]);
    tracker.record(
      entry('tool_use', { actor: 'worker:m1:worker', tool: 'Read', input: {}, at: T1 }),
    );
    tracker.record(
      entry('tool_use', { actor: 'worker:m1:worker', tool: 'Edit', input: {}, at: T2 }),
    );
    tracker.record(
      entry('tool_use', { actor: 'worker:m1:worker', tool: 'Grep', input: {}, at: T1 }),
    );
    expect(tracker.workersOf('m1')).toEqual([
      { managerId: 'm1', agentType: 'worker', lastTool: 'Edit', lastToolAt: T2 },
    ]);
    expect(tracker.workersOf('m2')).toEqual([]);
  });

  it('上限を超えたら最後の活動が古い線から落とす', () => {
    const tracker = createTopologyActivityTracker(2);
    for (const [id, at] of [
      ['m1', '2026-10-04T10:00:01.000Z'],
      ['m2', '2026-10-04T10:00:02.000Z'],
      ['m3', '2026-10-04T10:00:03.000Z'],
    ] as const) {
      tracker.record(
        entry('exchange', { with: 'manager', role: 'outbound', text: id, managerId: id, at }),
      );
    }
    expect(tracker.links().map((link) => link.key)).toEqual([
      cloneManagerLink('m3'),
      cloneManagerLink('m2'),
    ]);
  });

  it('attach は購読口へ繋ぎ、解除すると取り込まなくなる', () => {
    const listeners = new Set<(entry: JournalEntry) => void>();
    const tracker = createTopologyActivityTracker();
    const detach = tracker.attach((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    for (const listener of listeners) {
      listener(entry('exchange', { with: 'human', role: 'inbound', text: 'a' }));
    }
    expect(tracker.links()).toHaveLength(1);
    detach();
    expect(listeners.size).toBe(0);
  });
});
