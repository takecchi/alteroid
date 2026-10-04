import { afterAll, describe, expect, it, vi } from 'vitest';

/*
 * 詳細の時刻は `formatDateTime`（閲覧者の端末の時間帯）で出る。`format.ts` は読み込み時に
 * `Intl.DateTimeFormat` を作るので、固定は `vi.hoisted` で import より前に行う
 * （理由の逐語は `apps/web/app/routes/reports.test.tsx` の冒頭、同じ形は `format.test.ts`）。
 */
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

import {
  FLOW_WINDOW_MS,
  topologySceneFromSnapshot,
  WORKER_RUNNING_WINDOW_MS,
} from './topology-scene.js';
import type { TopologySnapshot, TopologySnapshotManager } from './types.js';

const NOW = Date.parse('2026-10-04T03:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function snapshot(patch: Partial<TopologySnapshot> = {}): TopologySnapshot {
  return {
    observedAt: new Date(NOW).toISOString(),
    clone: { state: 'idle' },
    storage: { state: 'ok', label: 'postgres', checkedAt: ago(1000) },
    runners: [{ label: 'runner-a', state: 'connected', since: ago(60_000) }],
    managers: [],
    links: [],
    ...patch,
  };
}

const MANAGER: TopologySnapshotManager = {
  managerId: 'abcdef1234567890',
  status: 'running',
  live: true,
  request: 'codex の駆動役を配線する',
  startedAt: '2026-10-04T02:00:00.000Z',
  updatedAt: '2026-10-04T02:30:00.000Z',
  waiting: [],
  workers: [],
};

describe('線の流れは時刻の窓だけで決まる', () => {
  const link = (extra: Record<string, string>) => ({ key: 'human~clone', ...extra });

  it('down だけ・up だけ・両方・どちらも窓の外', () => {
    const flowOf = (l: ReturnType<typeof link>) =>
      topologySceneFromSnapshot(snapshot({ links: [l] }), NOW).human.flow;
    expect(flowOf(link({ lastDownAt: ago(1000) }))).toBe('down');
    expect(flowOf(link({ lastUpAt: ago(1000) }))).toBe('up');
    expect(flowOf(link({ lastDownAt: ago(1000), lastUpAt: ago(2000) }))).toBe('both');
    expect(flowOf(link({ lastDownAt: ago(FLOW_WINDOW_MS + 1), lastUpAt: ago(60_000) }))).toBe(
      'idle',
    );
  });

  it('窓の境目: ちょうど窓の長さは流れている、1ms 越えたら流れていない', () => {
    const flowOf = (ms: number) =>
      topologySceneFromSnapshot(snapshot({ links: [link({ lastDownAt: ago(ms) })] }), NOW).human
        .flow;
    expect(flowOf(FLOW_WINDOW_MS)).toBe('down');
    expect(flowOf(FLOW_WINDOW_MS + 1)).toBe('idle');
  });

  it('線が無い・時刻が読めない・遠い未来のときは流れていないと言う', () => {
    expect(topologySceneFromSnapshot(snapshot(), NOW).human.flow).toBe('idle');
    expect(
      topologySceneFromSnapshot(snapshot({ links: [link({ lastDownAt: 'not-a-date' })] }), NOW)
        .human.flow,
    ).toBe('idle');
    expect(
      topologySceneFromSnapshot(snapshot({ links: [link({ lastDownAt: ago(-60_000) })] }), NOW)
        .human.flow,
    ).toBe('idle');
  });

  it('記憶・マネージャー・作業者の線はそれぞれの key で引く', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        managers: [{ ...MANAGER, workers: [{ agentType: 'implementer', lastTool: 'Edit' }] }],
        links: [
          { key: 'clone~storage', lastDownAt: ago(500) },
          { key: `clone~manager:${MANAGER.managerId}`, lastUpAt: ago(500) },
          {
            key: `manager:${MANAGER.managerId}~worker:implementer`,
            lastDownAt: ago(500),
            lastUpAt: ago(500),
          },
        ],
      }),
      NOW,
    );
    expect(scene.db.flow).toBe('down');
    expect(scene.human.flow).toBe('idle');
    expect(scene.managers[0]?.flow).toBe('up');
    expect(scene.managers[0]?.workers[0]?.flow).toBe('both');
  });
});

describe('作業者の状態は lastActivityAt から、光は作らない', () => {
  const withWorkerLink = (extra: Record<string, string>) =>
    topologySceneFromSnapshot(
      snapshot({
        managers: [{ ...MANAGER, workers: [{ agentType: 'reviewer', lastTool: 'Read' }] }],
        links: [{ key: `manager:${MANAGER.managerId}~worker:reviewer`, ...extra }],
      }),
      NOW,
    ).managers[0]!.workers[0]!;

  it('窓の中なら running、外なら idle。どちらも flow は idle のまま', () => {
    const recent = withWorkerLink({ lastActivityAt: ago(WORKER_RUNNING_WINDOW_MS) });
    expect(recent.status).toBe('running');
    expect(recent.flow).toBe('idle');
    const stale = withWorkerLink({ lastActivityAt: ago(WORKER_RUNNING_WINDOW_MS + 1) });
    expect(stale.status).toBe('idle');
    expect(stale.flow).toBe('idle');
  });

  it('id は managerId:agentType、ラベルは agentType、task は lastTool', () => {
    const worker = withWorkerLink({});
    expect(worker.id).toBe(`${MANAGER.managerId}:reviewer`);
    expect(worker.label).toBe('reviewer');
    expect(worker.task).toBe('Read');
    expect(worker.status).toBe('idle');
  });
});

describe('状態は嘘をつかない', () => {
  it.each([
    [{ state: 'idle' }, 'idle'],
    [{ state: 'busy', turn: { kind: 'normal' } }, 'running'],
    [{ state: 'usage_blocked' }, 'waiting'],
    [{ state: 'unknown' }, 'unknown'],
  ] as const)('クローン %j は %s', (clone, expected) => {
    expect(topologySceneFromSnapshot(snapshot({ clone }), NOW).clone.status).toBe(expected);
  });

  it('利用枠で止まっているクローンは、止まっている理由を task で言う', () => {
    const { clone } = topologySceneFromSnapshot(
      snapshot({ clone: { state: 'usage_blocked' } }),
      NOW,
    );
    expect(clone.task).toContain('利用枠');
  });

  it('クローンが unknown のとき、待機・実行中とは言わず、確認できないと言う', () => {
    const { clone } = topologySceneFromSnapshot(snapshot({ clone: { state: 'unknown' } }), NOW);
    expect(clone.status).toBe('unknown');
    expect(clone.task).toContain('確認できない');
  });

  it('記憶ストア: ok / unreachable（理由を task へ）/ unknown', () => {
    const at = (storage: TopologySnapshot['storage']) =>
      topologySceneFromSnapshot(snapshot({ storage }), NOW).db;
    expect(at({ state: 'ok', label: 'postgres' }).status).toBe('ok');
    const down = at({ state: 'unreachable', label: 'postgres', error: 'ECONNREFUSED' });
    expect(down.status).toBe('offline');
    expect(down.task).toBe('ECONNREFUSED');
    expect(at({ state: 'unknown' }).status).toBe('unknown');
  });

  it('記憶ストアの名前: 既知の種類は読みやすく、無いときは PostgreSQL と決め打たない', () => {
    const label = (storage: TopologySnapshot['storage']) =>
      topologySceneFromSnapshot(snapshot({ storage }), NOW).db.label;
    expect(label({ state: 'ok', label: 'postgres' })).toBe('PostgreSQL');
    expect(label({ state: 'ok', label: 'fs' })).toBe('ファイル');
    expect(label({ state: 'unknown' })).toBe('記憶ストア');
  });

  it('runner: 1つでも connected なら ok、居るが繋がっていなければ offline、0件は unknown', () => {
    const at = (runners: TopologySnapshot['runners']) =>
      topologySceneFromSnapshot(snapshot({ runners }), NOW).runner.status;
    const r = (state: 'connected' | 'unreachable' | 'connecting') => ({
      label: 'r',
      state,
      since: ago(1),
    });
    expect(at([r('unreachable'), r('connected')])).toBe('ok');
    expect(at([r('unreachable'), r('connecting')])).toBe('offline');
    expect(at([])).toBe('unknown');
  });
});

describe('マネージャー', () => {
  const sceneOf = (patch: Partial<TopologySnapshotManager>) =>
    topologySceneFromSnapshot(snapshot({ managers: [{ ...MANAGER, ...patch }] }), NOW).managers[0]!;

  it.each([
    ['running', true, 'running'],
    ['running', false, 'offline'],
    ['waiting_human', true, 'waiting'],
    ['done', true, 'idle'],
    ['failed', true, 'error'],
    ['lost', false, 'offline'],
    ['stopped', true, 'idle'],
  ] as const)('%s（live=%s）は %s', (status, live, expected) => {
    expect(sceneOf({ status, live }).status).toBe(expected);
  });

  it('知らない状態（版のずれ）は、待機・正常ではなく unknown', () => {
    const scene = sceneOf({ status: 'brand_new' as never });
    expect(scene.status).toBe('unknown');
  });

  it('完了・停止は task の頭に言う。走行中は依頼の抜粋のまま', () => {
    expect(sceneOf({ status: 'done' }).task).toBe('完了: codex の駆動役を配線する');
    expect(sceneOf({ status: 'stopped' }).task).toBe('停止: codex の駆動役を配線する');
    expect(sceneOf({}).task).toBe('codex の駆動役を配線する');
  });

  it('ラベルは短い id、詳細に id・開始・runner・最初の返事待ちが出る', () => {
    const scene = sceneOf({
      status: 'waiting_human',
      runnerId: 'runner-1',
      waiting: [
        { requestId: 'q1', summary: 'マージしてよいか' },
        { requestId: 'q2', summary: '別件' },
      ],
    });
    expect(scene.label).toBe('abcdef12');
    expect(scene.details).toEqual([
      { label: 'マネージャー ID', value: 'abcdef1234567890', mono: true },
      { label: '開始', value: '10/04 11:00' },
      { label: 'runner', value: 'runner-1', mono: true },
      { label: '返事待ち', value: 'マージしてよいか（ほか 1 件）' },
    ]);
  });

  it('デーモンが切った返事待ち（waitingOmitted）も「ほか」に数える', () => {
    const scene = sceneOf({
      waiting: [{ requestId: 'q1', summary: 'A' }],
      waitingOmitted: 4,
    });
    expect(scene.details?.find((row) => row.label === '返事待ち')?.value).toBe('A（ほか 4 件）');
  });

  it('並びはデーモンが決めた順のまま', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        managers: [
          { ...MANAGER, managerId: 'zzzzzzzz1' },
          { ...MANAGER, managerId: 'aaaaaaaa1' },
        ],
      }),
      NOW,
    );
    expect(scene.managers.map((m) => m.id)).toEqual(['zzzzzzzz1', 'aaaaaaaa1']);
  });
});

describe('unreadable（#2705）', () => {
  it('1件以上のときだけ unreadableCount を載せ、無ければ鍵ごと無い', () => {
    const counted = topologySceneFromSnapshot(
      snapshot({ unreadable: [{ reason: 'a' }, { id: 'b', reason: 'c' }] }),
      NOW,
    );
    expect(counted.unreadableCount).toBe(2);
    expect('unreadableCount' in topologySceneFromSnapshot(snapshot({}), NOW)).toBe(false);
  });
});
