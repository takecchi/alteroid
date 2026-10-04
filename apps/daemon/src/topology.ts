import {
  codePointBoundary,
  type CloneHost,
  type ManagerSummary,
  type RunnerRegistry,
} from '@alteroid/core';
import type { z } from 'zod';

import type { topologyResponseSchema } from './openapi.js';
import type { TopologyActivityTracker } from './topology-activity.js';
import { cloneManagerLink, HUMAN_CLONE_LINK, CLONE_STORAGE_LINK } from './topology-activity.js';

/**
 * 稼働の地図のスナップショットを組む層（`GET /topology` と `GET /topology/stream`）。
 *
 * **デーモンが既に持っている情報だけで組む**——新しい往復も、新しい永続も無い。
 * 取れないものは「分からない」（`unknown`）と言い、取れたふりをしない。
 * **全文は載せない**（一覧→詳細。`.claude/skills/listing-and-detail/SKILL.md`）。
 * 抜粋と文字数の予算で締め、切ったら件数を言う。全文は `GET /managers/:id`。
 */

export type TopologySnapshot = z.infer<typeof topologyResponseSchema>;
type TopologyManager = TopologySnapshot['managers'][number];

/** 終端した委譲を地図に残す窓。画面が「畳まれていく」のを見せるための猶予。 */
export const TOPOLOGY_ENDED_WINDOW_MS = 10 * 60 * 1000;
/** `request` の抜粋の長さ。 */
export const TOPOLOGY_REQUEST_LIMIT = 200;
/** 返事待ち1件の `summary` の抜粋の長さ。 */
export const TOPOLOGY_WAITING_SUMMARY_LIMIT = 160;
/** 委譲1本あたりに載せる返事待ちの件数の上限（残りは `waitingOmitted`）。 */
export const TOPOLOGY_WAITING_PER_MANAGER = 5;
/** 委譲1本あたりに載せる作業者の種類の上限。 */
export const TOPOLOGY_WORKERS_PER_MANAGER = 20;
/**
 * 委譲の行に使える文字数の予算（JSON にしたときの長さ）。**件数ではなく文字数で締める**
 * （件数 × 1行の長さは何件で溢れるかが運任せになる。`listing-and-detail` 参照）。
 */
export const TOPOLOGY_MANAGERS_CHAR_BUDGET = 40_000;

/** 改行を潰して先頭 `limit` 文字に切る。切ったら `…` を付ける（全文は詳細の口）。 */
function clipLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  return `${line.slice(0, codePointBoundary(line, limit))}…`;
}

/** 走っている・返事待ちか。 */
function isActiveStatus(status: ManagerSummary['status']): boolean {
  return status === 'running' || status === 'waiting_human';
}

/** 地図に載せる委譲か（走行中・返事待ち、または直近に終わったもの）。 */
export function isOnTopology(manager: ManagerSummary, nowMs: number): boolean {
  if (isActiveStatus(manager.status)) return true;
  const updated = Date.parse(manager.updatedAt);
  // 読めない時刻は「直近」と決めない（古いものを居座らせない）。
  if (Number.isNaN(updated)) return false;
  return nowMs - updated <= TOPOLOGY_ENDED_WINDOW_MS;
}

function topologyManagerOf(
  manager: ManagerSummary,
  activity: TopologyActivityTracker,
): TopologyManager {
  const waiting = manager.waiting.slice(0, TOPOLOGY_WAITING_PER_MANAGER).map((item) => ({
    requestId: item.requestId,
    ...(item.kind === undefined ? {} : { kind: item.kind }),
    summary: clipLine(item.summary, TOPOLOGY_WAITING_SUMMARY_LIMIT),
    ...(item.askedAt === undefined ? {} : { askedAt: item.askedAt }),
  }));
  const waitingOmitted = manager.waiting.length - waiting.length;
  const workers = activity
    .workersOf(manager.managerId)
    .slice(0, TOPOLOGY_WORKERS_PER_MANAGER)
    .map((worker) => ({
      agentType: worker.agentType,
      ...(worker.lastTool === undefined ? {} : { lastTool: worker.lastTool }),
      ...(worker.lastToolAt === undefined ? {} : { lastToolAt: worker.lastToolAt }),
    }));
  return {
    managerId: manager.managerId,
    status: manager.status,
    live: manager.live,
    ...(manager.runnerId === undefined ? {} : { runnerId: manager.runnerId }),
    request: clipLine(manager.request, TOPOLOGY_REQUEST_LIMIT),
    startedAt: manager.startedAt,
    updatedAt: manager.updatedAt,
    ...(manager.lastReportAt === undefined ? {} : { lastReportAt: manager.lastReportAt }),
    waiting,
    ...(waitingOmitted > 0 ? { waitingOmitted } : {}),
    workers,
  };
}

/** 載せる順。返事待ち → 走行中 → 終端（新しい順）。 */
function rank(status: ManagerSummary['status']): number {
  if (status === 'waiting_human') return 0;
  if (status === 'running') return 1;
  return 2;
}

/** 器の健康（`storage.state` の材料）。 */
export type StorageHealth = TopologySnapshot['storage'];

export interface TopologyInputs {
  nowMs: number;
  /** クローンのターンの有無。`undefined` = この器は答えられない。 */
  turn: ReturnType<NonNullable<CloneHost['activeTurn']>> | undefined;
  usageBlocked: boolean;
  storage: StorageHealth;
  runners: readonly { label: string; runnerId?: string; state: string; since: string }[];
  managers: readonly ManagerSummary[];
  activity: TopologyActivityTracker;
}

/** スナップショットを組む。**純関数**（時刻は引数）。 */
export function buildTopologySnapshot(input: TopologyInputs): TopologySnapshot {
  // `usageBlocked` が先。枠で止まっていれば、ターンが残っていても「止まっている」が本筋。
  const clone: TopologySnapshot['clone'] = input.usageBlocked
    ? { state: 'usage_blocked', ...(input.turn ? { turn: input.turn } : {}) }
    : input.turn === undefined
      ? { state: 'unknown' } // 答えられない器。`idle` を作らない。
      : input.turn === null
        ? { state: 'idle' }
        : { state: 'busy', turn: input.turn };

  const onMap = input.managers
    .filter((manager) => isOnTopology(manager, input.nowMs))
    .sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        b.startedAt.localeCompare(a.startedAt) ||
        a.managerId.localeCompare(b.managerId),
    );

  const managers: TopologyManager[] = [];
  let used = 0;
  for (const manager of onMap) {
    const row = topologyManagerOf(manager, input.activity);
    const size = JSON.stringify(row).length;
    // 1本目は必ず載せる（1本も載らない一覧は「居ない」と読める）。
    if (managers.length > 0 && used + size > TOPOLOGY_MANAGERS_CHAR_BUDGET) break;
    managers.push(row);
    used += size;
  }
  const managersOmitted = onMap.length - managers.length;

  const shown = new Set(managers.map((manager) => manager.managerId));
  const links = input.activity.links().filter((link) => {
    if (link.key === HUMAN_CLONE_LINK || link.key === CLONE_STORAGE_LINK) return true;
    // 載せていない委譲の線は載せない（古い委譲の線が増え続けるのを返さない）。
    for (const id of shown) {
      if (link.key === cloneManagerLink(id) || link.key.startsWith(`manager:${id}~`)) return true;
    }
    return false;
  });

  return {
    observedAt: new Date(input.nowMs).toISOString(),
    clone,
    storage: input.storage,
    runners: input.runners.map((runner) => ({
      label: runner.label,
      ...(runner.runnerId === undefined ? {} : { runnerId: runner.runnerId }),
      state: runner.state as TopologySnapshot['runners'][number]['state'],
      since: runner.since,
    })),
    managers,
    ...(managersOmitted > 0 ? { managersOmitted } : {}),
    links,
  };
}

/**
 * 内容の指紋（`observedAt` を除く）。ストリームが**変わっていないスナップショットを
 * 再送しない**ための比較に使う。
 */
export function topologySignature(snapshot: TopologySnapshot): string {
  const { observedAt: _observedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------------------
// 器の健康（`storageProbe` の結果の保持）
// ---------------------------------------------------------------------------

export const STORAGE_PROBE_INTERVAL_MS = 15_000;
export const STORAGE_PROBE_TIMEOUT_MS = 3_000;

/**
 * 失敗の理由を**種別だけ**にする。接続エラーの文面には接続先（host:port）が載りうる
 * ので、`code`（`ECONNREFUSED` 等）か名前だけを返す。**接続情報を応答に載せない。**
 */
export function describeProbeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(name)) return name;
  }
  return 'error';
}

export interface StorageHealthTracker {
  /** 直近の結果。**聞きに行かない**（古ければ背景で聞き直す）。 */
  current(): StorageHealth;
}

export interface StorageHealthOptions {
  label: string | undefined;
  probe: (() => Promise<void>) | undefined;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * 器の健康を保持する。**呼び手を待たせない**——`current()` は直近の結果を返し、
 * 古ければ1本だけ背景で聞き直す（器が詰まっていても地図の応答が止まらない）。
 * 手段が配線されていなければ常に `unknown`（`ok` を作らない）。
 */
export function createStorageHealthTracker(options: StorageHealthOptions): StorageHealthTracker {
  const { label, probe, now } = options;
  const intervalMs = options.intervalMs ?? STORAGE_PROBE_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? STORAGE_PROBE_TIMEOUT_MS;
  const base = label === undefined ? {} : { label };
  let result: StorageHealth = { ...base, state: 'unknown' };
  let startedAt: number | null = null;
  let running = false;

  async function refresh(): Promise<void> {
    if (probe === undefined || running) return;
    running = true;
    startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })),
            timeoutMs,
          );
        }),
      ]);
      result = { ...base, state: 'ok', checkedAt: new Date(now()).toISOString() };
    } catch (error) {
      result = {
        ...base,
        state: 'unreachable',
        checkedAt: new Date(now()).toISOString(),
        error: describeProbeError(error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      running = false;
    }
  }

  return {
    current() {
      if (
        probe !== undefined &&
        !running &&
        (startedAt === null || now() - startedAt >= intervalMs)
      ) {
        void refresh();
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

export interface TopologyServiceDeps {
  clone: Pick<CloneHost, 'usageBlocked' | 'activeTurn'> & {
    managers: { list(): Promise<ManagerSummary[]> };
  };
  runners?: Pick<RunnerRegistry, 'entries'>;
  activity: TopologyActivityTracker;
  storage: StorageHealthTracker;
  now?: () => number;
}

export interface TopologySnapshotOptions {
  /**
   * この長さより新しい直近の結果があれば、それを返す（既定 0 = 毎回組む）。**周期の
   * 再計算（購読者が増えても台帳を読む回数を増やしたくない側）だけが使う。** 日誌の
   * 追記を受けた再計算と `GET /topology` は 0 のまま——直前の出来事を取りこぼさない。
   */
  maxAgeMs?: number;
}

export interface TopologyService {
  snapshot(options?: TopologySnapshotOptions): Promise<TopologySnapshot>;
}

export function createTopologyService(deps: TopologyServiceDeps): TopologyService {
  const now = deps.now ?? Date.now;
  let cached: { at: number; value: TopologySnapshot } | null = null;

  async function build(): Promise<TopologySnapshot> {
    const nowMs = now();
    const managers = await deps.clone.managers.list();
    const value = buildTopologySnapshot({
      nowMs,
      // 実装していない器は `undefined`（= 分からない）。`null`（走っていない）と区別する。
      turn: deps.clone.activeTurn === undefined ? undefined : deps.clone.activeTurn(),
      usageBlocked: deps.clone.usageBlocked,
      storage: deps.storage.current(),
      runners: deps.runners === undefined ? [] : deps.runners.entries(),
      managers,
      activity: deps.activity,
    });
    cached = { at: nowMs, value };
    return value;
  }

  return {
    async snapshot(options) {
      const maxAgeMs = options?.maxAgeMs ?? 0;
      if (maxAgeMs > 0 && cached !== null && now() - cached.at < maxAgeMs) return cached.value;
      return build();
    },
  };
}
