import type { SystemTopologyProps } from './system-topology';

export const idleScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'idle', task: '次の発意 tick を待っている' },
  db: { status: 'idle', flow: 'idle' },
  runners: [{ id: 'r1', label: 'runner-primary', status: 'ok' }],
  managers: [],
};

export const busyScene: SystemTopologyProps = {
  human: { flow: 'down' },
  clone: {
    status: 'running',
    task: '#486 の段取りを3本へ割っている',
    agent: { model: 'opus' },
    details: [
      { label: '起点', value: '人間の依頼（Web UI）' },
      { label: '受信箱', value: '未読 2 件' },
    ],
  },
  db: { status: 'running', flow: 'both' },
  runners: [
    { id: 'r1', label: 'runner-primary', status: 'ok' },
    { id: 'r2', label: 'runner-2', status: 'ok' },
  ],
  managers: [
    {
      id: 'm1',
      runner: 'r1',
      label: 'mgr-7f3a',
      task: 'codex の駆動役を配線する',
      status: 'running',
      flow: 'down',
      agent: { model: 'opus' },
      details: [
        { label: 'manager_id', value: 'mgr-7f3a2c91', mono: true },
        { label: '開始', value: '2026-10-04 07:41 JST' },
        { label: '枝', value: 'feat/codex-driver', mono: true },
        { label: 'runner', value: 'runner-primary', mono: true },
      ],
      workers: [
        {
          id: 'w1',
          label: 'worker-1',
          task: 'agent-ports.ts へ型を足す',
          status: 'running',
          flow: 'down',
          agent: { model: 'sonnet' },
        },
        {
          id: 'w2',
          label: 'worker-2',
          task: 'pnpm test --shard 2/4',
          status: 'running',
          flow: 'up',
          agent: { model: 'sonnet' },
        },
      ],
    },
    {
      id: 'm2',
      runner: 'r1',
      label: 'mgr-c019',
      task: 'PR #2695 のレビュー',
      status: 'waiting',
      agent: { model: 'opus' },
      details: [
        { label: '確認', value: 'main へ squash マージしてよいか' },
        { label: '待ち始め', value: '2026-10-04 07:52 JST' },
      ],
      flow: 'up',
      workers: [
        {
          id: 'w3',
          label: 'worker-3',
          task: '差分を読み終えた',
          status: 'idle',
          flow: 'idle',
          // 名乗りを受けていない担当の見え方（「不明」の破線の札）
          agent: {},
        },
      ],
    },
    {
      id: 'm3',
      runner: 'r2',
      label: 'mgr-91be',
      task: 'Railway のデプロイ時刻を調べる',
      status: 'running',
      flow: 'both',
      workers: [],
    },
  ],
};

export const runnerUnknownScene: SystemTopologyProps = {
  ...busyScene,
  runners: [],
  managers: busyScene.managers.map((m) => ({ ...m, runner: undefined })),
};

export const runnerDownScene: SystemTopologyProps = {
  ...busyScene,
  clone: { status: 'waiting', task: 'runner へ繋ぎ直している' },
  human: { flow: 'up' },
  db: { status: 'running', flow: 'down' },
  runners: busyScene.runners.map((r) => ({ ...r, status: 'offline' as const })),
  managers: busyScene.managers.map((m) => ({
    ...m,
    status: 'offline',
    flow: 'idle',
    workers: m.workers?.map((w) => ({ ...w, status: 'offline', flow: 'idle' })),
  })),
};

export const liveFrames: readonly SystemTopologyProps[] = [
  idleScene,
  {
    human: { flow: 'down' },
    clone: { status: 'running', task: '依頼を読んで記憶を引いている' },
    db: { status: 'running', flow: 'up' },
    runners: [{ id: 'r1', label: 'runner-primary', status: 'ok' }],
    managers: [],
  },
  {
    human: { flow: 'idle' },
    clone: { status: 'running', task: 'manager_start × 2' },
    db: { status: 'idle', flow: 'idle' },
    runners: [{ id: 'r1', label: 'runner-primary', status: 'ok' }],
    managers: [
      {
        id: 'm1',
        runner: 'r1',
        label: 'mgr-7f3a',
        task: '起動中',
        status: 'running',
        flow: 'down',
        workers: [],
      },
      {
        id: 'm2',
        runner: 'r1',
        label: 'mgr-c019',
        task: '起動中',
        status: 'running',
        flow: 'down',
        workers: [],
      },
    ],
  },
  busyScene,
  {
    ...busyScene,
    clone: { status: 'running', task: '報告をまとめて日誌へ書いている' },
    human: { flow: 'idle' },
    db: { status: 'running', flow: 'down' },
    managers: busyScene.managers.map((m) => ({
      ...m,
      status: 'idle',
      task: '報告済み',
      flow: 'up',
      workers: m.workers?.map((w) => ({ ...w, status: 'idle', flow: 'idle', task: '完了' })),
    })),
  },
  {
    ...idleScene,
    human: { flow: 'up' },
    clone: { status: 'running', task: '人間へ報告している' },
  },
];

export const crowdedScene: SystemTopologyProps = {
  ...busyScene,
  managers: Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    runner: i < 3 ? 'r1' : 'r2',
    label: `mgr-${(0xa0 + i * 17).toString(16)}`,
    task: `並行の仕事 ${i + 1}`,
    status: i === 3 ? ('waiting' as const) : ('running' as const),
    flow: (['down', 'up', 'both', 'up', 'down'] as const)[i],
    workers: Array.from({ length: [3, 0, 2, 1, 4][i] ?? 0 }, (_, j) => ({
      id: `c${i}-${j}`,
      label: `worker-${i + 1}.${j + 1}`,
      task: 'pnpm test',
      status: 'running' as const,
      flow: (['down', 'up', 'both'] as const)[j % 3],
    })),
  })),
};

export const unknownScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'unknown', task: 'ターンの有無を確認できない' },
  db: { label: '記憶ストア', status: 'unknown', task: '確かめる手段が無い', flow: 'idle' },
  runners: [],
  managers: [],
};

export const awaitingScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'awaiting', task: '委譲 1 本の完了待ち' },
  db: { label: 'PostgreSQL', status: 'ok', flow: 'idle' },
  runners: [{ id: 'r1', label: 'runner-primary', status: 'ok' }],
  managers: [
    {
      id: 'm1',
      runner: 'r1',
      label: 'mgr-7f3a',
      task: '背景処理 2 件の完了待ち: codex の駆動役を配線する',
      status: 'awaiting',
      flow: 'idle',
      details: [{ label: '完了待ち', value: '背景処理 2 件（local_agent×2）' }],
      workers: [
        {
          id: 'w1',
          label: 'implementer',
          task: 'Bash',
          status: 'unknown',
          flow: 'idle',
          details: [
            { label: '状態の根拠', value: '長い道具の実行中か、終わったかは観測できない' },
            { label: '最後の道具', value: '3分前' },
          ],
        },
      ],
    },
    {
      id: 'm2',
      runner: 'r1',
      label: 'mgr-c019',
      task: '完了: PR #2695 のレビュー',
      status: 'idle',
      flow: 'idle',
      workers: [],
    },
  ],
};

export const storageDownScene: SystemTopologyProps = {
  ...busyScene,
  clone: { status: 'waiting', task: '利用枠の上限で止まっている' },
  db: { label: 'PostgreSQL', status: 'offline', task: 'ECONNREFUSED', flow: 'idle' },
};

export const unreadableEmptyScene: SystemTopologyProps = {
  ...idleScene,
  unreadableCount: 2,
};

export const perRunnerScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'running', task: 'ターンを処理している' },
  db: { label: 'PostgreSQL', status: 'ok', flow: 'idle' },
  runners: [
    { id: 'r1', label: 'runner-primary', status: 'ok' },
    { id: 'r2', label: 'runner-2', status: 'ok' },
  ],
  managers: [
    {
      id: 'p1',
      runner: 'r1',
      label: 'mgr-7f3a',
      task: 'codex の駆動役を配線する',
      status: 'running',
      flow: 'down',
      workers: [],
    },
    {
      id: 'p2',
      runner: 'r1',
      label: 'mgr-c019',
      task: '完了: PR #2695 のレビュー',
      status: 'idle',
      flow: 'idle',
      workers: [],
    },
    {
      id: 'p3',
      runner: 'r1',
      label: 'mgr-91be',
      task: '完了: Railway のデプロイ時刻を調べる',
      status: 'idle',
      flow: 'idle',
      workers: [],
    },
    {
      id: 'p4',
      label: 'mgr-0d2e',
      task: '器の名前を名乗っていない委譲',
      status: 'running',
      flow: 'idle',
      workers: [],
    },
  ],
};

export const usageBlockedScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'waiting', task: '利用枠の上限で止まっている' },
  db: { label: 'PostgreSQL', status: 'ok', flow: 'idle' },
  runners: [{ id: 'r1', label: 'runner-primary', status: 'ok' }],
  managers: [
    {
      id: 'm1',
      runner: 'r1',
      label: 'mgr-7f3a',
      task: '利用枠の上限で止まっている: codex の駆動役を配線する',
      status: 'waiting',
      flow: 'idle',
      details: [{ label: '利用枠', value: '利用枠の上限で止まっている（1 時間前 から）' }],
      workers: [],
    },
    {
      id: 'm2',
      runner: 'r1',
      label: 'mgr-c019',
      task: '完了: PR #2695 のレビュー',
      status: 'idle',
      flow: 'idle',
      workers: [],
    },
  ],
};

export const externalsScene: SystemTopologyProps = {
  ...idleScene,
  externals: [
    {
      id: 'external:k1',
      label: 'GitHub 連携',
      task: '最後の呼び出し: たった今',
      flow: 'down',
      details: [
        { label: '鍵の名前', value: 'GitHub 連携' },
        { label: '鍵 ID', value: 'k1', mono: true },
        { label: 'source', value: 'github', mono: true },
        {
          label: '観測の範囲',
          value:
            '時刻はデーモンが受け付けた時刻で、クローンが処理した時刻ではない。' +
            'デーモンの起動後に連携の鍵で呼ばれた、直近 10 分のものだけを出す',
        },
      ],
    },
    { id: 'external:k2', label: 'CI', task: '最後の呼び出し: 3 分前', flow: 'idle' },
    { id: 'external-others', label: 'ほか 2 件', task: '札にしていない連携の鍵', flow: 'idle' },
  ],
};
