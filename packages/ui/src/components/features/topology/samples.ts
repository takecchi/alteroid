import type { SystemTopologyProps } from './system-topology';

/** 見本帳だけが使う場面。stories のファイルから見本以外を export しないためにここへ置く。 */

export const idleScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'idle', task: '次の発意 tick を待っている' },
  db: { status: 'idle', flow: 'idle' },
  runner: { status: 'idle' },
  managers: [],
};

export const busyScene: SystemTopologyProps = {
  human: { flow: 'down' },
  clone: {
    status: 'running',
    task: '#486 の段取りを3本へ割っている',
    details: [
      { label: 'モデル', value: 'opus', mono: true },
      { label: '起点', value: '人間の依頼（Web UI）' },
      { label: '受信箱', value: '未読 2 件' },
    ],
  },
  db: { status: 'running', flow: 'both' },
  runner: { status: 'running' },
  managers: [
    {
      id: 'm1',
      label: 'mgr-7f3a',
      task: 'codex の駆動役を配線する',
      status: 'running',
      flow: 'down',
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
        },
        {
          id: 'w2',
          label: 'worker-2',
          task: 'pnpm test --shard 2/4',
          status: 'running',
          flow: 'up',
        },
      ],
    },
    {
      id: 'm2',
      label: 'mgr-c019',
      task: 'PR #2695 のレビュー',
      status: 'waiting',
      details: [
        { label: '確認', value: 'main へ squash マージしてよいか' },
        { label: '待ち始め', value: '2026-10-04 07:52 JST' },
      ],
      flow: 'up',
      workers: [
        { id: 'w3', label: 'worker-3', task: '差分を読み終えた', status: 'idle', flow: 'idle' },
      ],
    },
    {
      id: 'm3',
      label: 'mgr-91be',
      task: 'Railway のデプロイ時刻を調べる',
      status: 'running',
      flow: 'both',
      workers: [],
    },
  ],
};

export const runnerDownScene: SystemTopologyProps = {
  ...busyScene,
  clone: { status: 'waiting', task: 'runner へ繋ぎ直している' },
  human: { flow: 'up' },
  db: { status: 'running', flow: 'down' },
  runner: { status: 'offline' },
  managers: busyScene.managers.map((m) => ({
    ...m,
    status: 'offline',
    flow: 'idle',
    workers: m.workers?.map((w) => ({ ...w, status: 'offline', flow: 'idle' })),
  })),
};

/** Live の見本が順に巡る場面。委譲が始まり、報告が上り、片付くまで。 */
export const liveFrames: readonly SystemTopologyProps[] = [
  idleScene,
  {
    human: { flow: 'down' },
    clone: { status: 'running', task: '依頼を読んで記憶を引いている' },
    db: { status: 'running', flow: 'up' },
    runner: { status: 'idle' },
    managers: [],
  },
  {
    human: { flow: 'idle' },
    clone: { status: 'running', task: 'manager_start × 2' },
    db: { status: 'idle', flow: 'idle' },
    runner: { status: 'running' },
    managers: [
      { id: 'm1', label: 'mgr-7f3a', task: '起動中', status: 'running', flow: 'down', workers: [] },
      { id: 'm2', label: 'mgr-c019', task: '起動中', status: 'running', flow: 'down', workers: [] },
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

/** マネージャー5本・作業者がまちまち。線の出口と幹が分かれていることを見る。 */
export const crowdedScene: SystemTopologyProps = {
  ...busyScene,
  managers: Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
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
