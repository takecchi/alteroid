/**
 * 稼働の地図のスナップショット（`GET /topology` / SSE の `snapshot`）を、描画用の場面へ写す。
 *
 * **純関数で、時刻は引数（`nowMs`）で受ける。** デーモンが返すのは線ごとの
 * 「最後にいつ流れたか」の時刻だけで、「いま流れている」と読む閾値は**読み手の決めごと**
 * である（`apps/daemon/src/topology-activity.ts` の冒頭）。その決めごとをここへ置く。
 *
 * ## 嘘をつかない
 *
 * - **分からないものを `ok` / `idle` と描かない。** `unknown` はそのまま `unknown`（不明）
 *   に写す。配線されていない軸・聞きに行けない軸に「正常」「待機」と言うと、確かめた
 *   ように読める
 * - **光（流れ）は時刻だけから決める。** 状態（`running` など）から光を作らない。
 *   作業者の `lastActivityAt` は「手を動かしている」の印（`running`）にはなるが、
 *   それだけでは線の光にならない（向きの無い印なので、指示でも報告でもない）
 * - 読めない時刻（`Invalid Date`）は「流れていない」へ倒す。古い・壊れた時刻を
 *   「いま」と読まない
 *
 * ## 型の置き場
 *
 * 場面の形はここで定義する（`@alteroid/ui` の `SystemTopology` の props と**構造が
 * 合う**ように。logic は ui を import できない）。合っているかは、`apps/web` が
 * 両方を繋ぐところで TypeScript が検査する。
 */
import type { TopologySnapshot, TopologySnapshotManager } from './types.js';
import { formatDateTime, formatRelative } from './format.js';

/** 線の「いま流れている」と読む窓。この間に `lastDownAt` / `lastUpAt` が在れば流れていると言う。 */
export const FLOW_WINDOW_MS = 5_000;
/** 作業者を「実行中」と読む窓。この間に `lastActivityAt`（道具の実行）が在れば実行中。 */
export const WORKER_RUNNING_WINDOW_MS = 30_000;

/**
 * 札の状態。**`idle`（仕事なし）と `awaiting`（完了待ち）を分けてある**（#2726）。
 * `idle` は「本当に仕事が無い」、`awaiting` は「仕事の途中で、背景処理・委譲の完了を待っている」。
 * 確かめられないものは `unknown`（不明）で、`idle` に倒さない。
 */
export type SceneStatus =
  'idle' | 'running' | 'awaiting' | 'waiting' | 'error' | 'offline' | 'ok' | 'unknown';
export type SceneFlow = 'idle' | 'down' | 'up' | 'both';

export interface SceneDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface SceneWorker {
  id: string;
  label: string;
  task?: string;
  status: SceneStatus;
  flow: SceneFlow;
  details?: readonly SceneDetail[];
}

export interface SceneManager {
  id: string;
  label: string;
  task?: string;
  status: SceneStatus;
  flow: SceneFlow;
  workers: readonly SceneWorker[];
  details?: readonly SceneDetail[];
}

export interface TopologySceneData {
  human: { flow: SceneFlow };
  clone: { task?: string; status: SceneStatus; details?: readonly SceneDetail[] };
  db: {
    label: string;
    task?: string;
    status: SceneStatus;
    flow: SceneFlow;
    details?: readonly SceneDetail[];
  };
  runner: { status: SceneStatus };
  managers: readonly SceneManager[];
  /** 読めず地図に載せられなかった委譲の件数。1件以上のときだけ（`snapshot.unreadable` の長さ）。 */
  unreadableCount?: number;
}

type Link = TopologySnapshot['links'][number];

/** 時刻が `nowMs` の前の `windowMs` 以内か。読めない時刻・未来の時刻は「いま」と読まない。 */
function within(iso: string | undefined, nowMs: number, windowMs: number): boolean {
  if (iso === undefined) return false;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  const age = nowMs - at;
  // 未来は許さない（時計のずれで「これから流れる」光を出さない）。ただし同じ時計から来た
  // 時刻（`observedAt` を基準にした `nowMs`）の丸め誤差は許す。
  return age >= -1_000 && age <= windowMs;
}

/** 線1本の流れ。向きは指揮する側から見る（`down` = 指示・書き込み、`up` = 報告・確認・読み出し）。 */
export function flowOfLink(link: Link | undefined, nowMs: number): SceneFlow {
  if (link === undefined) return 'idle';
  const down = within(link.lastDownAt, nowMs, FLOW_WINDOW_MS);
  const up = within(link.lastUpAt, nowMs, FLOW_WINDOW_MS);
  if (down && up) return 'both';
  if (down) return 'down';
  if (up) return 'up';
  return 'idle';
}

/** 背景処理（`run_in_background` の子・作業者への委譲）の完了を待って畳んだマネージャーか。 */
function isAwaitingBackground(manager: TopologySnapshotManager): boolean {
  return manager.status === 'done' && manager.awaitingBackground !== undefined;
}

/**
 * 仕事の途中か（地図の上の委譲として）。走行中（プロセスが居る）・背景処理待ち・人間の返事待ち。
 * クローンの「完了待ち」と作業者の「確かめられない」の判定が使う。
 */
function isInProgress(manager: TopologySnapshotManager): boolean {
  if (manager.status === 'running') return manager.live;
  if (manager.status === 'waiting_human') return true;
  return manager.awaitingBackground !== undefined;
}

function managerStatus(manager: TopologySnapshotManager): SceneStatus {
  if (isAwaitingBackground(manager)) return 'awaiting';
  switch (manager.status) {
    case 'running':
      // 台帳は走っていると言うが、プロセスが居ない。走っていると描かない。
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
      // 版のずれ（デーモンが新しい状態を足した）。型は `never` で網羅を強制するが、
      // 実行時は「分からない」へ倒す。待機・正常と描かない。
      const exhaustive: never = manager.status;
      void exhaustive;
      return 'unknown';
    }
  }
}

function managerTask(manager: TopologySnapshotManager): string {
  const awaiting = manager.awaitingBackground;
  if (isAwaitingBackground(manager) && awaiting !== undefined) {
    // 「完了:」とは言わない（まだ終わっていない）。何を待っているかを頭に言う。
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

/**
 * 作業者の状態。観測できるのは「道具が終わった時刻」（`lastActivityAt`）だけで、道具の
 * **開始**は daemon に届かない（#2725）。だから窓の外は2つに割れる。
 *
 * - 窓の中 → 実行中
 * - 窓の外で、親が途中 → **不明**（長い道具の実行中か、終わったかを区別できない）
 * - 窓の外で、親が途中でない → 仕事なし
 *
 * **前景の呼び出しが返った（`lastUpAt` が最後の活動以後）ことを「仕事なし」の根拠にしない。**
 * 前景の呼び出しの開始は日誌に載らない（`apps/daemon/src/topology-activity.ts` の doc）ので、
 * 同じ種類の作業者をもう一度前景で呼んだとき、最初の道具が終わるまでは「返った後」と
 * 同じ形に見える。親が途中なら、返った後でも不明と言う。
 */
function workerStatus(
  link: Link | undefined,
  manager: TopologySnapshotManager,
  nowMs: number,
): SceneStatus {
  if (within(link?.lastActivityAt, nowMs, WORKER_RUNNING_WINDOW_MS)) return 'running';
  return isInProgress(manager) ? 'unknown' : 'idle';
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
      // ターンの外。**途中の委譲が地図に在れば、仕事が無いのではなく委譲の完了を待っている。**
      // 地図に載らなかった委譲（`managersOmitted`）は、デーモンの並び（途中のものが先）により
      // 載せたものより後ろの終端なので、数え漏らしは「仕事なし」を誤らせない。
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
        task: '利用枠の上限で止まっている',
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
        // 理由は種別だけ（接続情報は載らない）。無いときは言えることだけ言う。
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

function runnerStatus(runners: TopologySnapshot['runners']): SceneStatus {
  if (runners.length === 0) return 'unknown';
  return runners.some((runner) => runner.state === 'connected') ? 'ok' : 'offline';
}

/**
 * スナップショットを描画用の場面にする。
 *
 * 委譲の並びはデーモンが決めた順のまま（返事待ち → 走行中 → 終端）。並べ直さない。
 * 切られた件数（`managersOmitted`）は場面には載せない——呼び手が `snapshot` から読んで
 * 地図の下に言う（場面に混ぜると `SystemTopology` の props に余計な欄が増える）。
 */
export function topologySceneFromSnapshot(
  snapshot: TopologySnapshot,
  nowMs: number,
): TopologySceneData {
  const links = new Map(snapshot.links.map((link) => [link.key, link]));
  const clone = cloneScene(snapshot.clone, snapshot.managers, snapshot.observedAt, nowMs);
  const storage = storageScene(snapshot.storage, nowMs);

  return {
    human: { flow: flowOfLink(links.get('human~clone'), nowMs) },
    clone,
    db: {
      label: storageLabel(snapshot.storage.label),
      ...storage,
      flow: flowOfLink(links.get('clone~storage'), nowMs),
    },
    runner: { status: runnerStatus(snapshot.runners) },
    ...((snapshot.unreadable?.length ?? 0) > 0
      ? { unreadableCount: snapshot.unreadable!.length }
      : {}),
    managers: snapshot.managers.map((manager) => ({
      id: manager.managerId,
      label: managerLabel(manager.managerId),
      task: managerTask(manager),
      status: managerStatus(manager),
      flow: flowOfLink(links.get(`clone~manager:${manager.managerId}`), nowMs),
      details: managerDetails(manager, nowMs),
      workers: manager.workers.map((worker) => {
        const link = links.get(`manager:${manager.managerId}~worker:${worker.agentType}`);
        const status = workerStatus(link, manager, nowMs);
        return {
          id: `${manager.managerId}:${worker.agentType}`,
          label: worker.agentType,
          ...(worker.lastTool === undefined ? {} : { task: worker.lastTool }),
          status,
          flow: flowOfLink(link, nowMs),
          details: [
            { label: '種類', value: worker.agentType, mono: true },
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
    })),
  };
}
