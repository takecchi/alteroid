import type { TopologySnapshot, TopologySnapshotManager } from './types.js';
import { formatDateTime, formatRelative } from './format.js';

export const FLOW_WINDOW_MS = 5_000;
export const WORKER_RUNNING_WINDOW_MS = 30_000;

// 場面の型をここで定義する: logic は ui を import できないため。構造は `SystemTopology` の props に合わせる。
export type SceneStatus =
  'idle' | 'running' | 'awaiting' | 'waiting' | 'error' | 'offline' | 'ok' | 'unknown';
export type SceneFlow = 'idle' | 'down' | 'up' | 'both';

export interface SceneDetail {
  label: string;
  value: string;
  mono?: boolean;
}

// 欄が無いことは「不明」: 既定のモデルで埋めない
export interface SceneAgent {
  model?: string;
}

export interface SceneWorker {
  id: string;
  label: string;
  task?: string;
  status: SceneStatus;
  flow: SceneFlow;
  details?: readonly SceneDetail[];
  agent?: SceneAgent;
}

export interface SceneManager {
  id: string;
  runner?: string;
  label: string;
  task?: string;
  status: SceneStatus;
  flow: SceneFlow;
  workers: readonly SceneWorker[];
  details?: readonly SceneDetail[];
  agent?: SceneAgent;
  group?: boolean;
}

export interface SceneRunner {
  id: string;
  label: string;
  status: SceneStatus;
}

// `status` を持たない: 観測できるのは最後に呼ばれた時刻だけで、外部サービスの状態は観測していないため。
export interface SceneExternal {
  id: string;
  label: string;
  task?: string;
  flow: SceneFlow;
  details?: readonly SceneDetail[];
}

export interface TopologySceneData {
  human: { flow: SceneFlow };
  externals: readonly SceneExternal[];
  clone: {
    task?: string;
    status: SceneStatus;
    details?: readonly SceneDetail[];
    agent?: SceneAgent;
  };
  db: {
    label: string;
    task?: string;
    status: SceneStatus;
    flow: SceneFlow;
    details?: readonly SceneDetail[];
  };
  runners: readonly SceneRunner[];
  managers: readonly SceneManager[];
  unreadableCount?: number;
}

type Link = TopologySnapshot['links'][number];
type TopologyWorker = TopologySnapshotManager['workers'][number];

function within(iso: string | undefined, nowMs: number, windowMs: number): boolean {
  if (iso === undefined) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  const age = nowMs - at;
  // 未来を許さない（丸め誤差の1秒だけ除く）: 時計のずれで「これから流れる」光を出さないため。
  return age >= -1_000 && age <= windowMs;
}

export function flowOfLink(link: Link | undefined, nowMs: number): SceneFlow {
  if (link === undefined) return 'idle';
  const down = within(link.lastDownAt, nowMs, FLOW_WINDOW_MS);
  const up = within(link.lastUpAt, nowMs, FLOW_WINDOW_MS);
  if (down && up) return 'both';
  if (down) return 'down';
  if (up) return 'up';
  return 'idle';
}

function isAwaitingBackground(manager: TopologySnapshotManager): boolean {
  return manager.status === 'done' && manager.awaitingBackground !== undefined;
}

const USAGE_BLOCKED_TASK = '利用枠の上限で止まっている';

function isUsageBlocked(manager: TopologySnapshotManager): boolean {
  if (manager.usageStoppedAt === undefined) return false;
  if (manager.status === 'running') return manager.live;
  return manager.status === 'done';
}

function isInProgress(manager: TopologySnapshotManager): boolean {
  if (manager.status === 'running') return manager.live;
  if (manager.status === 'waiting_human') return true;
  if (isUsageBlocked(manager)) return true;
  return manager.awaitingBackground !== undefined;
}

function managerStatus(manager: TopologySnapshotManager): SceneStatus {
  if (isUsageBlocked(manager)) return 'waiting';
  if (isAwaitingBackground(manager)) return 'awaiting';
  switch (manager.status) {
    case 'running':
      // プロセスが居ない running は offline: 台帳が走っていると言っても走っていると描かない。
      return manager.live ? 'running' : 'offline';
    case 'waiting_human':
      return 'waiting';
    case 'done':
    case 'stopped':
      return 'idle';
    case 'failed':
      return 'error';
    case 'lost':
      return 'offline';
    default: {
      // 版のずれは「分からない」へ倒す: 待機・正常と描かないため。
      const exhaustive: never = manager.status;
      void exhaustive;
      return 'unknown';
    }
  }
}

function managerTask(manager: TopologySnapshotManager): string {
  if (isUsageBlocked(manager)) return `${USAGE_BLOCKED_TASK}: ${manager.request}`;
  const awaiting = manager.awaitingBackground;
  if (isAwaitingBackground(manager) && awaiting !== undefined) {
    // 「完了:」とは言わない: まだ終わっていないため。
    const what =
      awaiting.tasks > 0 ? `背景処理 ${awaiting.tasks} 件の完了待ち` : '背景処理の完了待ち';
    return `${what}: ${manager.request}`;
  }
  switch (manager.status) {
    case 'done':
      return `完了: ${manager.request}`;
    case 'stopped':
      return `停止: ${manager.request}`;
    default:
      return manager.request;
  }
}

function managerDetails(manager: TopologySnapshotManager, nowMs: number): SceneDetail[] {
  const rows: SceneDetail[] = [
    { label: 'マネージャー ID', value: manager.managerId, mono: true },
    { label: '開始', value: formatDateTime(manager.startedAt, nowMs) },
  ];
  if (manager.runnerId !== undefined) {
    rows.push({ label: 'runner', value: manager.runnerId, mono: true });
  }
  if (manager.lastReportAt !== undefined) {
    rows.push({ label: '最後の報告', value: formatDateTime(manager.lastReportAt, nowMs) });
  }
  if (
    manager.usageStoppedAt !== undefined &&
    manager.status !== 'failed' &&
    manager.status !== 'lost' &&
    manager.status !== 'stopped'
  ) {
    rows.push({
      label: '利用枠',
      value: `${USAGE_BLOCKED_TASK}（${formatDateTime(manager.usageStoppedAt, nowMs)} から）`,
    });
  }
  const awaiting = manager.awaitingBackground;
  if (isAwaitingBackground(manager) && awaiting !== undefined) {
    rows.push({
      label: '完了待ち',
      value:
        awaiting.breakdown === ''
          ? `背景処理 ${awaiting.tasks} 件`
          : `背景処理 ${awaiting.tasks} 件（${awaiting.breakdown}）`,
    });
    rows.push({ label: '待ち始め', value: formatDateTime(awaiting.since, nowMs) });
  }
  const first = manager.waiting[0];
  if (first !== undefined) {
    const more = manager.waiting.length - 1 + (manager.waitingOmitted ?? 0);
    rows.push({
      label: '返事待ち',
      value: more > 0 ? `${first.summary}（ほか ${more} 件）` : first.summary,
    });
  }
  return rows;
}

// 前景の呼び出しが返ったことを「仕事なし」の根拠にしない: 開始は日誌に載らず、もう一度呼んだ直後は返った後と同じ形に見えるため。
function workerStatus(
  link: Link | undefined,
  manager: TopologySnapshotManager,
  nowMs: number,
  runningTool?: TopologyWorker['runningTool'],
): SceneStatus {
  if (runningTool !== undefined) return 'running';
  if (within(link?.lastActivityAt, nowMs, WORKER_RUNNING_WINDOW_MS)) return 'running';
  return isInProgress(manager) ? 'unknown' : 'idle';
}

function formatRunningFor(startedAt: string, nowMs: number): string {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return '実行中';
  const minutes = Math.floor(Math.max(0, nowMs - started) / 60_000);
  if (minutes < 1) return '1 分未満実行中';
  if (minutes < 60) return `${minutes} 分実行中`;
  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分実行中`;
}

function peerLabel(provider: string): string {
  return provider === 'codex' ? 'Codex' : provider;
}

/**
 * peer（マネージャーが MCP `peer` で頼んだ Codex）の札（#4122）。作業者の札と同じ並び・同じ線に乗る。
 * **「実行中」はターンの開始と終わりで必ず知らされる**（runner がターンの開始ですぐ送る）ので、
 * 作業者と違い「観測できない」に倒さず、実行中でなければ「終わった（idle）」と読む。
 */
function peerWorkerScene(
  manager: TopologySnapshotManager,
  worker: TopologyWorker,
  peer: { provider: string },
  link: Link | undefined,
  nowMs: number,
): SceneWorker {
  const label = peerLabel(peer.provider);
  const running = worker.runningTool;
  const status: SceneStatus = running === undefined ? 'idle' : 'running';
  const task = running?.tool ?? worker.lastTool;
  const model = worker.model ?? `${label} の既定`;
  return {
    id: `${manager.managerId}:${worker.agentType}`,
    label,
    ...(task === undefined ? {} : { task }),
    status,
    flow: flowOfLink(link, nowMs),
    // 作業者と違い、親マネージャーの workerModel には従わない（peer のモデルは名指しか相手の名乗り）
    agent: { model },
    details: [
      { label: '種類', value: `peer（${label}）`, mono: false },
      { label: '頼んだマネージャー', value: managerLabel(manager.managerId), mono: true },
      { label: 'モデル', value: model, mono: worker.model !== undefined },
      running === undefined
        ? { label: '状態', value: 'ターンは終わっている' }
        : {
            label: '実行中',
            value: `${running.tool}（${formatRunningFor(running.startedAt, nowMs)}）`,
          },
      ...(worker.lastToolAt === undefined
        ? []
        : [
            {
              label: '最後の道具',
              value: `${worker.lastTool ?? '(不明)'}（${formatDateTime(worker.lastToolAt, nowMs)}）`,
            },
          ]),
    ],
  };
}

function agentOf(model: string | undefined): SceneAgent {
  return model === undefined ? {} : { model };
}

function managerLabel(managerId: string): string {
  return managerId.length > 8 ? managerId.slice(0, 8) : managerId;
}

function cloneScene(
  clone: TopologySnapshot['clone'],
  managers: readonly TopologySnapshotManager[],
  observedAt: string,
  nowMs: number,
) {
  const observed: SceneDetail = { label: '観測', value: formatDateTime(observedAt, nowMs) };
  switch (clone.state) {
    case 'idle': {
      const open = managers.filter(isInProgress).length;
      if (open > 0) {
        return {
          status: 'awaiting' as const,
          task: `委譲 ${open} 本の完了待ち`,
          details: [observed],
        };
      }
      return { status: 'idle' as const, details: [observed] };
    }
    case 'busy':
      return {
        status: 'running' as const,
        task:
          clone.turn?.kind === 'distill' ? '記憶を整理している（蒸留）' : 'ターンを処理している',
        details: [
          ...(clone.turn?.conversationId === undefined
            ? []
            : [{ label: '会話', value: clone.turn.conversationId, mono: true }]),
          observed,
        ],
      };
    case 'usage_blocked':
      return {
        status: 'waiting' as const,
        task: USAGE_BLOCKED_TASK,
        details: [observed],
      };
    case 'unknown':
      return {
        status: 'unknown' as const,
        task: 'ターンの有無を確認できない',
        details: [observed],
      };
    default: {
      const exhaustive: never = clone.state;
      void exhaustive;
      return { status: 'unknown' as const, task: '状態を読めない', details: [observed] };
    }
  }
}

function storageLabel(label: string | undefined): string {
  if (label === undefined) return '記憶ストア';
  if (label === 'postgres') return 'PostgreSQL';
  if (label === 'fs') return 'ファイル';
  return label;
}

function storageScene(storage: TopologySnapshot['storage'], nowMs: number) {
  const details: SceneDetail[] = [];
  if (storage.checkedAt !== undefined) {
    details.push({ label: '確認', value: formatDateTime(storage.checkedAt, nowMs) });
  }
  switch (storage.state) {
    case 'ok':
      return { status: 'ok' as const, details };
    case 'unreachable':
      return {
        status: 'offline' as const,
        task: storage.error ?? '繋がらない',
        details,
      };
    case 'unknown':
      return {
        status: 'unknown' as const,
        task: '確かめる手段が無い・まだ確かめていない',
        details,
      };
    default: {
      const exhaustive: never = storage.state;
      void exhaustive;
      return { status: 'unknown' as const, task: '状態を読めない', details };
    }
  }
}

// `connecting` / `unreachable` / `unusable` / `lost` は出さない: まだ開けていない・名乗りが止まった器を「居る」と描かないため。
export function liveRunnersOf(runners: TopologySnapshot['runners']): SceneRunner[] {
  const out = new Map<string, SceneRunner>();
  for (const runner of runners) {
    if (runner.state !== 'connected' && runner.state !== 'vacating') continue;
    const id = runner.runnerId ?? `label:${runner.label}`;
    const name = runner.runnerId ?? runner.label;
    const before = out.get(id);
    if (before !== undefined && runner.state !== 'connected') continue;
    out.set(id, {
      id,
      label: runner.state === 'vacating' ? `${name}（空け中）` : name,
      status: 'ok',
    });
  }
  return [...out.values()];
}

export const IDLE_COLLAPSE_THRESHOLD = 3;
export const IDLE_GROUP_ID = 'idle-group';

function isCollapsible(manager: SceneManager): boolean {
  return manager.status === 'idle' && manager.workers.length === 0 && manager.flow === 'idle';
}

export function collapseIdleManagers(
  managers: readonly SceneManager[],
  groupKey?: string,
): readonly SceneManager[] {
  const idle = managers.filter(isCollapsible);
  if (idle.length <= IDLE_COLLAPSE_THRESHOLD) return managers;
  const rest = managers.filter((manager) => !isCollapsible(manager));
  const group: SceneManager = {
    id: groupKey === undefined ? IDLE_GROUP_ID : `${IDLE_GROUP_ID}:${groupKey}`,
    ...(idle[0]?.runner === undefined ? {} : { runner: idle[0].runner }),
    label: `仕事なし ${idle.length} 本`,
    task: '手が空いている。札を押すと一覧',
    status: 'idle',
    flow: 'idle',
    group: true,
    workers: [],
    details: idle.map((manager) => ({
      label: manager.label,
      value: manager.task ?? manager.id,
    })),
  };
  return [...rest, group];
}

// `managersOmitted` は場面に載せない: `SystemTopology` の props に余計な欄が増えるため。
export function topologySceneFromSnapshot(
  snapshot: TopologySnapshot,
  nowMs: number,
): TopologySceneData {
  const links = new Map(snapshot.links.map((link) => [link.key, link]));
  const clone = {
    ...cloneScene(snapshot.clone, snapshot.managers, snapshot.observedAt, nowMs),
    agent: agentOf(snapshot.clone.model),
  };
  const storage = storageScene(snapshot.storage, nowMs);
  const runners = liveRunnersOf(snapshot.runners);
  const scenes = managerScenes(snapshot, new Set(runners.map((runner) => runner.id)), links, nowMs);

  return {
    human: { flow: flowOfLink(links.get('human~clone'), nowMs) },
    externals: externalScenes(snapshot, links, nowMs),
    clone,
    db: {
      label: storageLabel(snapshot.storage.label),
      ...storage,
      flow: flowOfLink(links.get('clone~storage'), nowMs),
    },
    runners,
    ...((snapshot.unreadable?.length ?? 0) > 0
      ? { unreadableCount: snapshot.unreadable!.length }
      : {}),
    managers: [...runners.map((runner) => runner.id), undefined].flatMap((key) =>
      collapseIdleManagers(
        scenes.filter((scene) => scene.runner === key),
        key ?? 'unknown',
      ),
    ),
  };
}

const EXTERNAL_SCOPE_NOTE =
  '時刻はデーモンが受け付けた時刻で、クローンが処理した時刻ではない' +
  '（クローンが処理中・利用枠で止まっていても先に光る）。' +
  'デーモンの起動後に連携の鍵で呼ばれた、直近 10 分のものだけを出す';

// 札は `snapshot.externals` からだけ作る: 線の key から起こすと、版ずれで知らない key が来たときに壊れるため。
function externalScenes(
  snapshot: TopologySnapshot,
  links: ReadonlyMap<string, Link>,
  nowMs: number,
): SceneExternal[] {
  const cards: SceneExternal[] = (snapshot.externals ?? []).map((external) => ({
    id: `external:${external.keyId}`,
    label: external.name === '' ? external.keyId : external.name,
    task: `最後の呼び出し: ${formatRelative(external.lastAt, nowMs)}`,
    flow: flowOfLink(links.get(`external:${external.keyId}~clone`), nowMs),
    details: [
      { label: '鍵の名前', value: external.name === '' ? '（名前なし）' : external.name },
      { label: '鍵 ID', value: external.keyId, mono: true },
      { label: 'source', value: external.source, mono: true },
      { label: '最後の呼び出し', value: formatDateTime(external.lastAt, nowMs) },
      { label: '観測の範囲', value: EXTERNAL_SCOPE_NOTE },
    ],
  }));
  const omitted = snapshot.externalsOmitted ?? 0;
  if (omitted > 0) {
    cards.push({
      id: 'external-others',
      label: `ほか ${omitted} 件`,
      task: '札にしていない連携の鍵',
      flow: flowOfLink(links.get('external-others~clone'), nowMs),
      details: [
        { label: '件数', value: `${omitted} 件（地図に載せる上限を超えた連携の鍵）` },
        { label: '観測の範囲', value: EXTERNAL_SCOPE_NOTE },
      ],
    });
  }
  return cards;
}

function managerScenes(
  snapshot: TopologySnapshot,
  runnerKeys: ReadonlySet<string>,
  links: ReadonlyMap<string, Link>,
  nowMs: number,
): SceneManager[] {
  return snapshot.managers.map((manager) => ({
    id: manager.managerId,
    ...(manager.runnerId !== undefined && runnerKeys.has(manager.runnerId)
      ? { runner: manager.runnerId }
      : {}),
    label: managerLabel(manager.managerId),
    task: managerTask(manager),
    status: managerStatus(manager),
    flow: flowOfLink(links.get(`clone~manager:${manager.managerId}`), nowMs),
    details: managerDetails(manager, nowMs),
    agent: agentOf(manager.managerModel),
    workers: manager.workers.map((worker) => {
      const link = links.get(`manager:${manager.managerId}~worker:${worker.agentType}`);
      if (worker.peer !== undefined)
        return peerWorkerScene(manager, worker, worker.peer, link, nowMs);
      const status = workerStatus(link, manager, nowMs, worker.runningTool);
      const task = worker.runningTool?.tool ?? worker.lastTool;
      return {
        id: `${manager.managerId}:${worker.agentType}`,
        label: worker.agentType,
        ...(task === undefined ? {} : { task }),
        status,
        flow: flowOfLink(link, nowMs),
        // 作業者のモデルは親マネージャーの名乗り（workerModel）に従う
        agent: agentOf(manager.workerModel),
        details: [
          { label: '種類', value: worker.agentType, mono: true },
          ...(worker.runningTool === undefined
            ? []
            : [
                {
                  label: '実行中の道具',
                  value: `${worker.runningTool.tool}（${formatRunningFor(worker.runningTool.startedAt, nowMs)}）`,
                },
              ]),
          ...(status === 'unknown'
            ? [{ label: '状態の根拠', value: '長い道具の実行中か、終わったかは観測できない' }]
            : []),
          ...(worker.lastToolAt === undefined
            ? []
            : [
                {
                  label: '最後の道具',
                  value:
                    status === 'unknown'
                      ? `${formatRelative(worker.lastToolAt, nowMs)}（${formatDateTime(worker.lastToolAt, nowMs)}）`
                      : formatDateTime(worker.lastToolAt, nowMs),
                },
              ]),
        ],
      };
    }),
  }));
}
