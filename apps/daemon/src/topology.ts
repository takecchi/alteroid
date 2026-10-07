import {
  codePointBoundary,
  type CloneHost,
  type ManagerSummary,
  type RunnerRegistry,
  type UnreadableJob,
} from '@alteroid/core';
import type { z } from 'zod';

import type { topologyResponseSchema } from './openapi.js';
import type { TopologyActivityTracker } from './topology-activity.js';
import {
  cloneManagerLink,
  externalCloneLink,
  EXTERNAL_OTHERS_LINK,
  HUMAN_CLONE_LINK,
  CLONE_STORAGE_LINK,
} from './topology-activity.js';

export type TopologySnapshot = z.infer<typeof topologyResponseSchema>;
type TopologyManager = TopologySnapshot['managers'][number];

export const TOPOLOGY_ENDED_WINDOW_MS = 10 * 60 * 1000;
export const TOPOLOGY_EXTERNAL_WINDOW_MS = TOPOLOGY_ENDED_WINDOW_MS;
// 上限は 5: 左の列は人間・記憶と並び、クローンの左辺へ入る線の出口は 36px に収まる（7本 = 人間 + 5 + 記憶で6px 間隔）ため。
export const TOPOLOGY_EXTERNALS_MAX = 5;
// 古い観測では居座らせない: `/managers` だけが詰まると前の観測が残るため。
export const TOPOLOGY_RUNNER_LISTING_FRESH_MS = 60 * 1000;
export const TOPOLOGY_REQUEST_LIMIT = 200;
export const TOPOLOGY_WAITING_SUMMARY_LIMIT = 160;
export const TOPOLOGY_WAITING_PER_MANAGER = 5;
export const TOPOLOGY_RUNNING_TOOL_MAX_MS = 2 * 60 * 60 * 1000;
export const TOPOLOGY_WORKERS_PER_MANAGER = 20;
// 件数ではなく文字数で締める: 件数 × 1行の長さは何件で溢れるかが運任せになるため。
export const TOPOLOGY_MANAGERS_CHAR_BUDGET = 40_000;

function clipLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  return `${line.slice(0, codePointBoundary(line, limit))}…`;
}

function isActiveStatus(status: ManagerSummary['status']): boolean {
  return status === 'running' || status === 'waiting_human';
}

function isListedOnRunner(manager: ManagerSummary, nowMs: number): boolean {
  if (manager.runnerListedAt === undefined) return false;
  if (manager.status === 'lost' || manager.status === 'failed' || manager.status === 'stopped') {
    return false;
  }
  const listed = Date.parse(manager.runnerListedAt);
  if (Number.isNaN(listed)) return false;
  return nowMs - listed <= TOPOLOGY_RUNNER_LISTING_FRESH_MS;
}

export function isStoppedByUsage(manager: ManagerSummary): boolean {
  if (manager.usageStoppedAt === undefined) return false;
  return manager.status !== 'lost' && manager.status !== 'failed' && manager.status !== 'stopped';
}

// 背景処理待ちは終端の窓に関係なく載せる: 台帳の `status` が `done` でも仕事の途中で、窓で落とすと作業者ごと地図から消えるため。
// runner の一覧に載っている委譲・枠で止まっている委譲も窓に関係なく載せる: 窓で落とすと、器の上に居ること・枠で止まっていることが図から消えるため。
export function isOnTopology(manager: ManagerSummary, nowMs: number): boolean {
  if (isActiveStatus(manager.status)) return true;
  if (isStoppedByUsage(manager)) return true;
  if (manager.awaitingBackground !== undefined) return true;
  if (isListedOnRunner(manager, nowMs)) return true;
  const updated = Date.parse(manager.updatedAt);
  // 読めない時刻は「直近」と決めない: 古いものを居座らせないため。
  if (Number.isNaN(updated)) return false;
  return nowMs - updated <= TOPOLOGY_ENDED_WINDOW_MS;
}

function mayShowRunningTool(manager: ManagerSummary): boolean {
  if (manager.status === 'failed' || manager.status === 'lost' || manager.status === 'stopped') {
    return false;
  }
  if (manager.status === 'running') return manager.live;
  if (manager.status === 'waiting_human') return true;
  return manager.awaitingBackground !== undefined;
}

function topologyManagerOf(
  manager: ManagerSummary,
  activity: TopologyActivityTracker,
  nowMs: number,
): TopologyManager {
  const showRunningTool = mayShowRunningTool(manager);
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
      ...(showRunningTool &&
      worker.runningTool !== undefined &&
      nowMs - Date.parse(worker.runningTool.startedAt) <= TOPOLOGY_RUNNING_TOOL_MAX_MS
        ? { runningTool: worker.runningTool }
        : {}),
    }));
  return {
    managerId: manager.managerId,
    status: manager.status,
    live: manager.live,
    ...(manager.runnerId === undefined ? {} : { runnerId: manager.runnerId }),
    ...(manager.runnerListedAt === undefined ? {} : { runnerListedAt: manager.runnerListedAt }),
    ...(manager.usageStoppedAt === undefined ? {} : { usageStoppedAt: manager.usageStoppedAt }),
    request: clipLine(manager.request, TOPOLOGY_REQUEST_LIMIT),
    startedAt: manager.startedAt,
    updatedAt: manager.updatedAt,
    ...(manager.lastReportAt === undefined ? {} : { lastReportAt: manager.lastReportAt }),
    waiting,
    ...(waitingOmitted > 0 ? { waitingOmitted } : {}),
    ...(manager.awaitingBackground === undefined
      ? {}
      : {
          awaitingBackground: {
            tasks: manager.awaitingBackground.tasks,
            withheldReports: manager.awaitingBackground.withheldReports,
            breakdown: manager.awaitingBackground.breakdown,
            since: manager.awaitingBackground.since,
          },
        }),
    workers,
  };
}

// 背景処理待ち・枠で止まっている委譲は走行中と同じ段にする: 予算で切られるのは終端が先で、クローンの「完了待ち」判定が、載らなかった委譲に途中のものが混じらない前提を置くため。
function rank(manager: ManagerSummary): number {
  if (manager.status === 'waiting_human') return 0;
  if (
    manager.status === 'running' ||
    manager.awaitingBackground !== undefined ||
    isStoppedByUsage(manager)
  ) {
    return 1;
  }
  return 2;
}

export type StorageHealth = TopologySnapshot['storage'];

export interface TopologyInputs {
  nowMs: number;
  turn: ReturnType<NonNullable<CloneHost['activeTurn']>> | undefined;
  usageBlocked: boolean;
  storage: StorageHealth;
  runners: readonly { label: string; runnerId?: string; state: string; since: string }[];
  managers: readonly ManagerSummary[];
  unreadable?: readonly UnreadableJob[];
  activity: TopologyActivityTracker;
}

export function buildTopologySnapshot(input: TopologyInputs): TopologySnapshot {
  // `usageBlocked` が先: 枠で止まっていれば、ターンが残っていても「止まっている」が本筋のため。
  const clone: TopologySnapshot['clone'] = input.usageBlocked
    ? { state: 'usage_blocked', ...(input.turn ? { turn: input.turn } : {}) }
    : input.turn === undefined
      ? { state: 'unknown' }
      : input.turn === null
        ? { state: 'idle' }
        : { state: 'busy', turn: input.turn };

  const onMap = input.managers
    .filter((manager) => isOnTopology(manager, input.nowMs))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.startedAt.localeCompare(a.startedAt) ||
        a.managerId.localeCompare(b.managerId),
    );

  const managers: TopologyManager[] = [];
  let used = 0;
  for (const manager of onMap) {
    const row = topologyManagerOf(manager, input.activity, input.nowMs);
    const size = JSON.stringify(row).length;
    // 1本目は必ず載せる: 1本も載らない一覧は「居ない」と読めるため。
    if (managers.length > 0 && used + size > TOPOLOGY_MANAGERS_CHAR_BUDGET) break;
    managers.push(row);
    used += size;
  }
  const managersOmitted = onMap.length - managers.length;

  const shown = new Set(managers.map((manager) => manager.managerId));
  const links = input.activity.links().filter((link) => {
    if (link.key === HUMAN_CLONE_LINK || link.key === CLONE_STORAGE_LINK) return true;
    for (const id of shown) {
      if (link.key === cloneManagerLink(id) || link.key.startsWith(`manager:${id}~`)) return true;
    }
    return false;
  });

  // 札の並びは名前→keyId の順で固定する: 呼ばれるたびに札が入れ替わって見えないように。
  const recent = input.activity.externals().filter((row) => {
    const at = Date.parse(row.lastAt);
    return !Number.isNaN(at) && input.nowMs - at <= TOPOLOGY_EXTERNAL_WINDOW_MS;
  });
  const shownExternals = recent
    .slice(0, TOPOLOGY_EXTERNALS_MAX)
    .sort((a, b) => a.name.localeCompare(b.name) || a.keyId.localeCompare(b.keyId));
  const omittedExternals = recent.slice(TOPOLOGY_EXTERNALS_MAX);
  const externalLinks: TopologySnapshot['links'] = shownExternals.map((row) => ({
    key: externalCloneLink(row.keyId),
    lastDownAt: row.lastAt,
  }));
  if (omittedExternals.length > 0) {
    externalLinks.push({ key: EXTERNAL_OTHERS_LINK, lastDownAt: omittedExternals[0]!.lastAt });
  }

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
    // 1件でも在るときだけ載せる: 0件で空配列を作ると「読めない行は無い」と読めるため。
    ...(input.unreadable !== undefined && input.unreadable.length > 0
      ? { unreadable: [...input.unreadable] }
      : {}),
    // 1件でも在るときだけ載せる: 0件で空配列を作ると「呼ばれていない」と読めるため。
    ...(shownExternals.length > 0
      ? {
          externals: shownExternals.map((row) => ({
            keyId: row.keyId,
            name: row.name,
            source: row.source,
            lastAt: row.lastAt,
          })),
        }
      : {}),
    ...(omittedExternals.length > 0 ? { externalsOmitted: omittedExternals.length } : {}),
    links: [...links, ...externalLinks],
  };
}

export function topologySignature(snapshot: TopologySnapshot): string {
  return JSON.stringify({ ...snapshot, observedAt: undefined });
}

export const STORAGE_PROBE_INTERVAL_MS = 15_000;
export const STORAGE_PROBE_TIMEOUT_MS = 3_000;

// 理由は種別だけにする: 接続エラーの文面には接続先（host:port）が載りうるため。
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
  current(): StorageHealth;
}

export interface StorageHealthOptions {
  label: string | undefined;
  probe: (() => Promise<void>) | undefined;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

// 呼び手を待たせない: 古ければ背景で聞き直し、器が詰まっていても地図の応答が止まらないようにするため。手段が無ければ `ok` を作らず `unknown` にする。
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

export interface TopologyServiceDeps {
  clone: Pick<CloneHost, 'usageBlocked' | 'activeTurn'> & {
    managers: { list(): Promise<ManagerSummary[]> };
  };
  runners?: Pick<RunnerRegistry, 'entries'>;
  unreadableJobs?: () => Promise<UnreadableJob[]>;
  activity: TopologyActivityTracker;
  storage: StorageHealthTracker;
  now?: () => number;
}

export interface TopologySnapshotOptions {
  // 日誌の追記を受けた再計算と `GET /topology` は 0 のままにする: 直前の出来事を取りこぼさないため。
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
    const unreadable = deps.unreadableJobs === undefined ? [] : await deps.unreadableJobs();
    const value = buildTopologySnapshot({
      nowMs,
      // 実装していない器は `undefined`（分からない）: `null`（走っていない）と区別するため。
      turn: deps.clone.activeTurn === undefined ? undefined : deps.clone.activeTurn(),
      usageBlocked: deps.clone.usageBlocked,
      storage: deps.storage.current(),
      runners: deps.runners === undefined ? [] : deps.runners.entries(),
      managers,
      unreadable,
      activity: deps.activity,
    });
    cached = { at: nowMs, value };
    return value;
  }

  let inflight: { at: number; promise: Promise<TopologySnapshot> } | null = null;

  return {
    async snapshot(options) {
      const maxAgeMs = options?.maxAgeMs ?? 0;
      if (maxAgeMs > 0) {
        if (cached !== null && now() - cached.at < maxAgeMs) return cached.value;
        if (inflight !== null && now() - inflight.at < maxAgeMs) return inflight.promise;
      }
      const promise = build();
      inflight = { at: now(), promise };
      const clear = (): void => {
        if (inflight?.promise === promise) inflight = null;
      };
      promise.then(clear, clear);
      return promise;
    },
  };
}
