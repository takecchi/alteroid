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

/** runner が1つも登録されていない（分からない）。器は破線と「— 不明」で言い、正常には見せない。 */
export const runnerUnknownScene: SystemTopologyProps = {
  ...busyScene,
  runner: { status: 'unknown' },
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

/**
 * 確かめられない軸がある場面。クローンのターンの有無を答えられず、記憶ストアは確かめる手段が
 * 無く、runner は1つも見えない。**待機・正常と描かず「不明」と言う**（破線の札）。
 */
export const unknownScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'unknown', task: 'ターンの有無を確認できない' },
  db: { label: '記憶ストア', status: 'unknown', task: '確かめる手段が無い', flow: 'idle' },
  runner: { status: 'unknown' },
  managers: [],
};

/**
 * 「仕事なし」と「完了待ち」の場面（#2726）。クローンはターンの外で、委譲の完了を待っている
 * （完了待ち）。1本目は背景処理待ちで畳んだマネージャー、2本目は終えて何も待っていない
 * マネージャー（仕事なし）。作業者は、長い道具の実行中か終わったかを確かめられない（不明）。
 */
export const awaitingScene: SystemTopologyProps = {
  human: { flow: 'idle' },
  clone: { status: 'awaiting', task: '委譲 1 本の完了待ち' },
  db: { label: 'PostgreSQL', status: 'ok', flow: 'idle' },
  runner: { status: 'ok' },
  managers: [
    {
      id: 'm1',
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
      label: 'mgr-c019',
      task: '完了: PR #2695 のレビュー',
      status: 'idle',
      flow: 'idle',
      workers: [],
    },
  ],
};

/** 記憶ストアへ繋がらない場面。理由（エラーの種別）を札に出し、線は破線にする。 */
export const storageDownScene: SystemTopologyProps = {
  ...busyScene,
  clone: { status: 'waiting', task: '利用枠の上限で止まっている' },
  db: { label: 'PostgreSQL', status: 'offline', task: 'ECONNREFUSED', flow: 'idle' },
  runner: { status: 'ok' },
};

/** 台帳の行が読めない委譲が在り、読めたマネージャーは1本も無い。空と言い切らない。 */
export const unreadableEmptyScene: SystemTopologyProps = {
  ...idleScene,
  unreadableCount: 2,
};
