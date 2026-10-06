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
  IDLE_COLLAPSE_THRESHOLD,
  IDLE_GROUP_ID,
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
  // 親は既定で `done`（途中ではない）。#2726 で、親が途中のときの窓の外は「不明」になった
  // （下の「作業者の窓の外」）。ここの `idle`（仕事なし）の期待は親が途中でない形で残してある。
  const withWorkerLink = (
    extra: Record<string, string>,
    parent: Partial<TopologySnapshotManager> = { status: 'done' },
  ) =>
    topologySceneFromSnapshot(
      snapshot({
        managers: [
          { ...MANAGER, ...parent, workers: [{ agentType: 'reviewer', lastTool: 'Read' }] },
        ],
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

describe('作業者の窓の外は、前景が返ったか・親が途中かで分ける（#2726 / #2725）', () => {
  const stale = ago(WORKER_RUNNING_WINDOW_MS + 60_000);
  const worker = (
    extra: Record<string, string>,
    parent: Partial<TopologySnapshotManager>,
    lastToolAt?: string,
  ) =>
    topologySceneFromSnapshot(
      snapshot({
        managers: [
          {
            ...MANAGER,
            ...parent,
            workers: [
              { agentType: 'reviewer', lastTool: 'Bash', ...(lastToolAt ? { lastToolAt } : {}) },
            ],
          },
        ],
        links: [{ key: `manager:${MANAGER.managerId}~worker:reviewer`, ...extra }],
      }),
      NOW,
    ).managers[0]!.workers[0]!;
  const awaitingParent = {
    status: 'done',
    awaitingBackground: {
      tasks: 1,
      withheldReports: 1,
      breakdown: 'local_agent×1',
      since: ago(60_000),
    },
  } as const;

  it('窓の中なら、親が何であっても実行中', () => {
    expect(worker({ lastActivityAt: ago(1000) }, { status: 'done' }).status).toBe('running');
    expect(worker({ lastActivityAt: ago(1000) }, awaitingParent).status).toBe('running');
  });

  // 前景の呼び出しの開始は日誌に載らない。同じ種類をもう一度前景で呼んだ最初の道具の間は
  // 「返った後」と同じ形に見えるので、返ったことを「仕事なし」の根拠にしない。
  it('前景の呼び出しが返った（lastUpAt が最後の活動以後）後でも、親が途中なら仕事なしと言わず不明', () => {
    expect(worker({ lastActivityAt: stale, lastUpAt: ago(10_000) }, {}).status).toBe('unknown');
    expect(worker({ lastUpAt: ago(10_000) }, {}).status).toBe('unknown');
    // 親が途中でなければ仕事なし。
    expect(
      worker({ lastActivityAt: stale, lastUpAt: ago(10_000) }, { status: 'done' }).status,
    ).toBe('idle');
  });

  it('最後の活動のほうが新しい（返った後にまた道具を使った）ときも、親が途中なら不明', () => {
    expect(
      worker({ lastUpAt: ago(WORKER_RUNNING_WINDOW_MS + 120_000), lastActivityAt: stale }, {})
        .status,
    ).toBe('unknown');
  });

  it('(ii) 親が途中（running+live / 背景処理待ち）なら、待機ではなく不明。最後の道具は何分前かを言う', () => {
    const running = worker({ lastActivityAt: stale }, {}, stale);
    expect(running.status).toBe('unknown');
    expect(running.details?.find((d) => d.label === '最後の道具')?.value).toContain('2分前');
    expect(running.details?.some((d) => d.value.includes('観測できない'))).toBe(true);
    expect(worker({ lastActivityAt: stale }, awaitingParent).status).toBe('unknown');
    // 線が無い（一度も観測していない）作業者も、親が途中なら不明。
    expect(worker({}, {}).status).toBe('unknown');
  });

  it('(iii) 親が途中でないなら仕事なし（done・欄なし / stopped / running だが live でない）', () => {
    expect(worker({ lastActivityAt: stale }, { status: 'done' }).status).toBe('idle');
    expect(worker({ lastActivityAt: stale }, { status: 'stopped' }).status).toBe('idle');
    expect(worker({ lastActivityAt: stale }, { status: 'running', live: false }).status).toBe(
      'idle',
    );
  });
});

describe('作業者の実行中の道具（runningTool。#2725）', () => {
  const worker = (
    runningTool: { tool: string; startedAt: string } | undefined,
    parent: Partial<TopologySnapshotManager> = {},
    extra: Record<string, string> = {},
  ) =>
    topologySceneFromSnapshot(
      snapshot({
        managers: [
          {
            ...MANAGER,
            ...parent,
            workers: [
              {
                agentType: 'reviewer',
                lastTool: 'Read',
                ...(runningTool === undefined ? {} : { runningTool }),
              },
            ],
          },
        ],
        links: [{ key: `manager:${MANAGER.managerId}~worker:reviewer`, ...extra }],
      }),
      NOW,
    ).managers[0]!.workers[0]!;
  const stale = ago(WORKER_RUNNING_WINDOW_MS + 60_000);

  it('runningTool が在れば、窓の外でも実行中。task は道具名、details は「N 分実行中」', () => {
    const result = worker(
      { tool: 'Bash', startedAt: ago(3 * 60_000 + 5000) },
      {},
      {
        lastActivityAt: stale,
      },
    );
    expect(result.status).toBe('running');
    expect(result.task).toBe('Bash');
    expect(result.details?.find((d) => d.label === '実行中の道具')?.value).toBe(
      'Bash（3 分実行中）',
    );
    // 「観測できない」の根拠は出さない。
    expect(result.details?.some((d) => d.value.includes('観測できない'))).toBe(false);
  });

  it('1分未満・1時間以上の言い方', () => {
    const value = (ms: number) =>
      worker({ tool: 'Bash', startedAt: ago(ms) }).details?.find((d) => d.label === '実行中の道具')
        ?.value;
    expect(value(30_000)).toBe('Bash（1 分未満実行中）');
    expect(value(65 * 60_000)).toBe('Bash（1 時間 5 分実行中）');
  });

  it('runningTool が無ければ今までの表のまま（窓の外で親が途中なら不明、途中でなければ待機）', () => {
    expect(worker(undefined, {}, { lastActivityAt: stale }).status).toBe('unknown');
    expect(worker(undefined, { status: 'done' }, { lastActivityAt: stale }).status).toBe('idle');
    expect(worker(undefined, {}, { lastActivityAt: stale }).task).toBe('Read');
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

  describe('クローンのターンの外は、途中の委譲が在れば完了待ち（#2726）', () => {
    const cloneOf = (managers: TopologySnapshotManager[]) =>
      topologySceneFromSnapshot(snapshot({ clone: { state: 'idle' }, managers }), NOW).clone;
    const awaitingBackground = {
      tasks: 2,
      withheldReports: 1,
      breakdown: 'local_agent×2',
      since: ago(60_000),
    };

    it.each([
      ['走行中（live）', { status: 'running', live: true }],
      ['背景処理待ち', { status: 'done', awaitingBackground }],
      ['人間の返事待ち', { status: 'waiting_human' }],
    ] as const)('途中の委譲（%s）が1本以上 → awaiting。「委譲 N 本の完了待ち」', (_name, patch) => {
      const clone = cloneOf([
        { ...MANAGER, ...patch },
        { ...MANAGER, managerId: 'z', status: 'done' },
      ]);
      expect(clone.status).toBe('awaiting');
      expect(clone.task).toBe('委譲 1 本の完了待ち');
    });

    it('途中の委譲が0本（終端だけ・走行中でも live でない・居ない）→ 仕事なし', () => {
      expect(cloneOf([]).status).toBe('idle');
      expect(
        cloneOf([
          { ...MANAGER, status: 'done' },
          { ...MANAGER, managerId: 'y', status: 'stopped' },
        ]).status,
      ).toBe('idle');
      expect(cloneOf([{ ...MANAGER, status: 'running', live: false }]).status).toBe('idle');
    });

    it('ターン中は実行中のまま、unknown は不明のまま（委譲の有無で上書きしない）', () => {
      const m = [{ ...MANAGER }];
      expect(
        topologySceneFromSnapshot(
          snapshot({ clone: { state: 'busy', turn: { kind: 'normal' } }, managers: m }),
          NOW,
        ).clone.status,
      ).toBe('running');
      expect(
        topologySceneFromSnapshot(snapshot({ clone: { state: 'unknown' }, managers: m }), NOW).clone
          .status,
      ).toBe('unknown');
      expect(
        topologySceneFromSnapshot(snapshot({ clone: { state: 'usage_blocked' }, managers: m }), NOW)
          .clone.status,
      ).toBe('waiting');
    });
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

  it('runner: 生きた器（connected / vacating）だけを1台1枠で。名前は runnerId、無ければ宛先の label', () => {
    const at = (runners: TopologySnapshot['runners']) =>
      topologySceneFromSnapshot(snapshot({ runners }), NOW).runners;
    const r = (
      state: TopologySnapshot['runners'][number]['state'],
      runnerId?: string,
      label = 'http://r',
    ) => ({ label, ...(runnerId === undefined ? {} : { runnerId }), state, since: ago(1) });
    expect(
      at([
        r('connected', 'runner-primary'),
        r('lost', 'runner-2'),
        r('unreachable'),
        r('connecting'),
        r('unusable'),
        r('vacating', 'runner-3'),
      ]),
    ).toEqual([
      { id: 'runner-primary', label: 'runner-primary', status: 'ok' },
      { id: 'runner-3', label: 'runner-3（空け中）', status: 'ok' },
    ]);
    // 名乗っていない器は label を名前にする。同じ runnerId の行は1枠。
    expect(at([r('connected', undefined, 'http://x')]).map((x) => x.label)).toEqual(['http://x']);
    expect(at([r('vacating', 'a'), r('connected', 'a')])).toEqual([
      { id: 'a', label: 'a', status: 'ok' },
    ]);
    expect(at([])).toEqual([]);
  });
});

describe('マネージャーは居る器ごとに振り分ける', () => {
  const live = (runnerId: string) => ({
    label: `http://${runnerId}`,
    runnerId,
    state: 'connected' as const,
    since: ago(1),
  });

  it('runnerId が生きた器と突き合えば runner を付け、器の順に並べる。突き合わないものは消さずに末尾（runner 無し）', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        runners: [
          live('runner-primary'),
          live('runner-2'),
          { ...live('runner-dead'), state: 'lost' },
        ],
        managers: [
          { ...MANAGER, managerId: 'on-dead', runnerId: 'runner-dead' },
          { ...MANAGER, managerId: 'on-2', runnerId: 'runner-2' },
          { ...MANAGER, managerId: 'no-runner' },
          { ...MANAGER, managerId: 'on-1', runnerId: 'runner-primary' },
        ],
      }),
      NOW,
    );
    expect(scene.managers.map((m) => [m.id, m.runner])).toEqual([
      ['on-1', 'runner-primary'],
      ['on-2', 'runner-2'],
      ['on-dead', undefined],
      ['no-runner', undefined],
    ]);
  });

  it('仕事なしの畳みは器ごと（別の器の分とは合算しない）', () => {
    const idle = (id: string, runnerId: string) => ({
      ...MANAGER,
      managerId: id,
      status: 'done' as const,
      runnerId,
      runnerListedAt: ago(1000),
    });
    const many = (runnerId: string, n: number) =>
      Array.from({ length: n }, (_, i) => idle(`${runnerId}-${i}`, runnerId));
    const scene = topologySceneFromSnapshot(
      snapshot({
        runners: [live('a'), live('b')],
        managers: [
          ...many('a', IDLE_COLLAPSE_THRESHOLD + 1),
          ...many('b', IDLE_COLLAPSE_THRESHOLD),
        ],
      }),
      NOW,
    );
    const ids = scene.managers.map((m) => m.id);
    expect(ids.filter((id) => id.startsWith(IDLE_GROUP_ID))).toEqual([`${IDLE_GROUP_ID}:a`]);
    expect(scene.managers.filter((m) => m.runner === 'b')).toHaveLength(IDLE_COLLAPSE_THRESHOLD);
    expect(scene.managers.find((m) => m.id === `${IDLE_GROUP_ID}:a`)?.runner).toBe('a');
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

  it('done + awaitingBackground は awaiting（完了待ち）。task は「完了:」と言わず待っている件数を言う', () => {
    const scene = sceneOf({
      status: 'done',
      awaitingBackground: {
        tasks: 3,
        withheldReports: 2,
        breakdown: 'local_agent×3',
        since: '2026-10-04T02:50:00.000Z',
      },
    });
    expect(scene.status).toBe('awaiting');
    expect(scene.task).toBe('背景処理 3 件の完了待ち: codex の駆動役を配線する');
    expect(scene.task).not.toContain('完了:');
    expect(scene.details).toContainEqual({
      label: '完了待ち',
      value: '背景処理 3 件（local_agent×3）',
    });
  });

  it('欄の無い done は idle（仕事なし）のまま。stopped は awaitingBackground が在っても idle', () => {
    expect(sceneOf({ status: 'done' }).status).toBe('idle');
    expect(
      sceneOf({
        status: 'stopped',
        awaitingBackground: { tasks: 1, withheldReports: 0, breakdown: '', since: ago(1) },
      }).status,
    ).toBe('idle');
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

describe('runner に居る手の空いたマネージャー（runnerListedAt）', () => {
  const idle = (
    id: string,
    extra: Partial<TopologySnapshotManager> = {},
  ): TopologySnapshotManager => ({
    ...MANAGER,
    managerId: id,
    status: 'done',
    live: true,
    updatedAt: ago(3 * 60 * 60_000),
    runnerListedAt: ago(5_000),
    ...extra,
  });

  it('少ないうちは個別の札で、窓内の done と同じ「仕事なし」の描き方', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({ managers: [idle('aaaaaaaa1'), idle('bbbbbbbb1')] }),
      NOW,
    );
    expect(scene.managers.map((m) => [m.id, m.status])).toEqual([
      ['aaaaaaaa1', 'idle'],
      ['bbbbbbbb1', 'idle'],
    ]);
    expect(scene.managers[0]?.task).toBe(`完了: ${MANAGER.request}`);
  });

  it('しきい値を超えたら「仕事なし N 本」の1枚へ畳み、個別は詳細に1行ずつ残す。動いているものは畳まない', () => {
    const ids = Array.from({ length: IDLE_COLLAPSE_THRESHOLD + 1 }, (_, i) => `idle000${i}`);
    const scene = topologySceneFromSnapshot(
      snapshot({
        managers: [
          { ...MANAGER, managerId: 'running1' },
          ...ids.map((id) => idle(id)),
          idle('withwork', { workers: [{ agentType: 'implementer' }] }),
        ],
      }),
      NOW,
    );
    expect(scene.managers.map((m) => m.id)).toEqual([
      'running1',
      'withwork',
      `${IDLE_GROUP_ID}:unknown`,
    ]);
    const group = scene.managers.at(-1);
    expect(group?.label).toBe(`仕事なし ${ids.length} 本`);
    expect(group?.status).toBe('idle');
    expect(group?.details?.map((row) => row.label)).toEqual(ids);
  });

  it('しきい値ちょうどは畳まない', () => {
    const ids = Array.from({ length: IDLE_COLLAPSE_THRESHOLD }, (_, i) => `idle000${i}`);
    const scene = topologySceneFromSnapshot(snapshot({ managers: ids.map((id) => idle(id)) }), NOW);
    expect(scene.managers.map((m) => m.id)).toEqual(ids);
  });
});

describe('枠(利用上限)で止まっているマネージャー（usageStoppedAt）', () => {
  const STOPPED_AT = ago(2 * 60 * 60_000);
  const done = (
    id: string,
    extra: Partial<TopologySnapshotManager> = {},
  ): TopologySnapshotManager => ({
    ...MANAGER,
    managerId: id,
    status: 'done',
    live: true,
    updatedAt: ago(3 * 60 * 60_000),
    ...extra,
  });
  const sceneOf = (managers: TopologySnapshotManager[], clone?: TopologySnapshot['clone']) =>
    topologySceneFromSnapshot(snapshot({ managers, ...(clone ? { clone } : {}) }), NOW);

  it('止まった札は、クローンの usage_blocked と同じ「止まっている」(waiting) と同じ文言で、仕事なしと分かれる', () => {
    const scene = sceneOf([done('blocked01', { usageStoppedAt: STOPPED_AT }), done('quiet001')], {
      state: 'usage_blocked',
    });
    const [blocked, quiet] = scene.managers;
    expect(blocked?.status).toBe('waiting');
    expect(blocked?.status).toBe(scene.clone.status);
    expect(blocked?.task).toContain(scene.clone.task);
    expect(blocked?.details?.some((d) => d.label === '利用枠')).toBe(true);
    expect(quiet?.status).toBe('idle');
    expect(quiet?.details?.some((d) => d.label === '利用枠')).toBe(false);
  });

  it('走行中で live の札にも立つ。完了待ち（awaitingBackground）より先', () => {
    const scene = sceneOf([
      { ...MANAGER, managerId: 'run00001', usageStoppedAt: STOPPED_AT },
      done('await001', {
        usageStoppedAt: STOPPED_AT,
        awaitingBackground: { tasks: 1, withheldReports: 0, breakdown: 'x', since: ago(1000) },
      }),
    ]);
    expect(scene.managers.map((m) => m.status)).toEqual(['waiting', 'waiting']);
  });

  it('終端・プロセスが居ない running は、その状態のまま（枠で止まっていると言い切らない）', () => {
    const scene = sceneOf([
      done('failed01', { status: 'failed', usageStoppedAt: STOPPED_AT }),
      done('lost0001', { status: 'lost', usageStoppedAt: STOPPED_AT }),
      done('nolive01', { status: 'running', live: false, usageStoppedAt: STOPPED_AT }),
    ]);
    expect(scene.managers.map((m) => m.status)).toEqual(['error', 'offline', 'offline']);
  });

  it('「仕事なし N 本」の畳みに入れない（枠で止まった札は個別のまま残る）', () => {
    const quiet = Array.from({ length: IDLE_COLLAPSE_THRESHOLD + 1 }, (_, i) => `idle000${i}`);
    const scene = sceneOf([
      ...quiet.map((id) => done(id, { runnerListedAt: ago(5_000) })),
      done('blocked01', { usageStoppedAt: STOPPED_AT }),
    ]);
    expect(scene.managers.map((m) => m.id)).toEqual(['blocked01', `${IDLE_GROUP_ID}:unknown`]);
    expect(scene.managers[0]?.status).toBe('waiting');
    expect(scene.managers.at(-1)?.details?.map((row) => row.label)).toEqual(quiet);
  });

  it('印が下りた（欄が無い）done は仕事なしに戻る', () => {
    expect(sceneOf([done('resumed1')]).managers[0]?.status).toBe('idle');
  });

  it('クローンのターンの外でも、止まった委譲は仕事なしではなく完了待ちに数える', () => {
    const scene = sceneOf([done('blocked01', { usageStoppedAt: STOPPED_AT })], { state: 'idle' });
    expect(scene.clone.status).toBe('awaiting');
  });
});

describe('外部サービス（連携の鍵）の札と線（Issue #3676）', () => {
  const external = (keyId: string, name: string, lastAt: string) => ({
    keyId,
    name,
    source: 'github',
    lastAt,
  });

  it('連携の鍵の線が直近に down なら、その札だけが down で光る', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        externals: [
          external('k1', 'GitHub 連携', ago(1000)),
          external('k2', 'CI', ago(FLOW_WINDOW_MS + 30_000)),
        ],
        links: [
          { key: 'external:k1~clone', lastDownAt: ago(1000) },
          { key: 'external:k2~clone', lastDownAt: ago(FLOW_WINDOW_MS + 30_000) },
        ],
      }),
      NOW,
    );
    expect(scene.externals?.map((e) => [e.label, e.flow])).toEqual([
      ['GitHub 連携', 'down'],
      ['CI', 'idle'],
    ]);
  });

  it('札には最後の呼び出しと、時刻の意味・観測の範囲の断りが出る', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        externals: [external('k1', 'GitHub 連携', ago(120_000))],
        links: [{ key: 'external:k1~clone', lastDownAt: ago(120_000) }],
      }),
      NOW,
    );
    const card = scene.externals?.[0];
    expect(card?.id).toBe('external:k1');
    // 状態（正常・仕事なし）は言わない。外部サービスの状態は観測していない。
    expect(card).not.toHaveProperty('status');
    const labels = card?.details?.map((d) => d.label) ?? [];
    expect(labels).toEqual(
      expect.arrayContaining(['鍵の名前', '鍵 ID', 'source', '最後の呼び出し', '観測の範囲']),
    );
    const note = card?.details?.find((d) => d.label === '観測の範囲')?.value ?? '';
    expect(note).toContain('デーモンが受け付けた時刻');
    expect(note).toContain('クローンが処理した時刻ではない');
    expect(note).toContain('起動後');
  });

  it('上限を超えた分は「ほか N 件」の札になり、まとめの線が光ればそれが光る', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        externals: [external('k1', 'A', ago(1000))],
        externalsOmitted: 2,
        links: [
          { key: 'external:k1~clone', lastDownAt: ago(1000) },
          { key: 'external-others~clone', lastDownAt: ago(1000) },
        ],
      }),
      NOW,
    );
    expect(scene.externals?.map((e) => [e.id, e.label, e.flow])).toEqual([
      ['external:k1', 'A', 'down'],
      ['external-others', 'ほか 2 件', 'down'],
    ]);
  });

  it('古いデーモン（externals も外部の線も無い）でも落ちず、札は出さない', () => {
    const scene = topologySceneFromSnapshot(snapshot(), NOW);
    expect(scene.externals ?? []).toEqual([]);
  });

  it('知らない key の線・札の無い外部の線は無視する（版ずれ。他の線は壊れない）', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({
        links: [
          { key: 'external:ghost~clone', lastDownAt: ago(1000) },
          { key: 'something-new~clone', lastDownAt: ago(1000) },
          { key: 'human~clone', lastDownAt: ago(1000) },
        ],
      }),
      NOW,
    );
    expect(scene.externals ?? []).toEqual([]);
    expect(scene.human.flow).toBe('down');
  });

  it('札はあるが線が無い（欠けた）ときは idle に倒す（光を作らない）', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({ externals: [external('k1', 'A', ago(1000))] }),
      NOW,
    );
    expect(scene.externals?.[0]?.flow).toBe('idle');
  });

  it('読めない時刻の lastAt でも落ちない', () => {
    const scene = topologySceneFromSnapshot(
      snapshot({ externals: [external('k1', 'A', 'not-a-date')] }),
      NOW,
    );
    expect(scene.externals).toHaveLength(1);
  });
});
