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
import { formatDateTime } from './format.js';

/** 線の「いま流れている」と読む窓。この間に `lastDownAt` / `lastUpAt` が在れば流れていると言う。 */
export const FLOW_WINDOW_MS = 5_000;
/** 作業者を「実行中」と読む窓。この間に `lastActivityAt`（道具の実行）が在れば実行中。 */
export const WORKER_RUNNING_WINDOW_MS = 30_000;

export type SceneStatus = 'idle' | 'running' | 'waiting' | 'error' | 'offline' | 'ok' | 'unknown';
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

function managerStatus(manager: TopologySnapshotManager): SceneStatus {
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

function managerLabel(managerId: string): string {
  return managerId.length > 8 ? managerId.slice(0, 8) : managerId;
}

function cloneScene(clone: TopologySnapshot['clone'], observedAt: string, nowMs: number) {
  const observed: SceneDetail = { label: '観測', value: formatDateTime(observedAt, nowMs) };
  switch (clone.state) {
    case 'idle':
      return { status: 'idle' as const, details: [observed] };
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
  const clone = cloneScene(snapshot.clone, snapshot.observedAt, nowMs);
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
    managers: snapshot.managers.map((manager) => ({
      id: manager.managerId,
      label: managerLabel(manager.managerId),
      task: managerTask(manager),
      status: managerStatus(manager),
      flow: flowOfLink(links.get(`clone~manager:${manager.managerId}`), nowMs),
      details: managerDetails(manager, nowMs),
      workers: manager.workers.map((worker) => {
        const link = links.get(`manager:${manager.managerId}~worker:${worker.agentType}`);
        return {
          id: `${manager.managerId}:${worker.agentType}`,
          label: worker.agentType,
          ...(worker.lastTool === undefined ? {} : { task: worker.lastTool }),
          status: within(link?.lastActivityAt, nowMs, WORKER_RUNNING_WINDOW_MS)
            ? ('running' as const)
            : ('idle' as const),
          flow: flowOfLink(link, nowMs),
          details: [
            { label: '種類', value: worker.agentType, mono: true },
            ...(worker.lastToolAt === undefined
              ? []
              : [{ label: '最後の道具', value: formatDateTime(worker.lastToolAt, nowMs) }]),
          ],
        };
      }),
    })),
  };
}
