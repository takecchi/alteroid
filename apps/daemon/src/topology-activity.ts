import {
  qualifiedToolName,
  WORKER_AGENT_NAME,
  type JournalEntry,
  type WorkerToolEvent,
} from '@alteroid/core';

// 「いま流れている」と読む閾値を置かない: 閾値を焼くと、画面ごとに違う「いま」を持てなくなるため。
// 外部サービスの線は連携の鍵で受け付けたものだけにする: 外部から呼んだわけではないものを外部として光らせると、観測が嘘になるため。
// 日誌の `external_event` からは拾わない: `at` が受信箱から取り出して書いた時刻で受け付けた時刻ではなく、拾うと同じ呼び出しで線が2度光るため。

export type LinkDirection = 'down' | 'up' | 'activity';

export interface LinkActivity {
  key: string;
  lastDownAt?: string;
  lastUpAt?: string;
  lastActivityAt?: string;
}

export interface WorkerActivity {
  managerId: string;
  agentType: string;
  lastTool?: string;
  lastToolAt?: string;
  runningTool?: { tool: string; startedAt: string };
}

export interface ExternalActivity {
  keyId: string;
  name: string;
  source: string;
  lastAt: string;
}

export const HUMAN_CLONE_LINK = 'human~clone';
export const CLONE_STORAGE_LINK = 'clone~storage';

export function cloneManagerLink(managerId: string): string {
  return `clone~manager:${managerId}`;
}

export function externalCloneLink(keyId: string): string {
  return `external:${keyId}~clone`;
}

export const EXTERNAL_OTHERS_LINK = 'external-others~clone';

export function managerWorkerLink(managerId: string, agentType: string): string {
  return `manager:${managerId}~worker:${agentType}`;
}

const STORAGE_READ_TOOLS: ReadonlySet<string> = new Set(
  [
    'memory_list',
    'memory_read',
    'memory_outline',
    'memory_section_read',
    'journal_read',
    'conversation_read',
  ].flatMap((name) => [name, qualifiedToolName(name)]),
);

const STORAGE_WRITE_TOOLS: ReadonlySet<string> = new Set(
  [
    'memory_write',
    'memory_append',
    'memory_delete',
    'memory_frontmatter_set',
    'memory_section_move',
    'journal_write',
  ].flatMap((name) => [name, qualifiedToolName(name)]),
);

// `Agent` と `Task` の両方を受ける: SDK の版で `Task` から `Agent` へ変わっているため。
const SUBAGENT_DISPATCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

export interface LinkTouch {
  key: string;
  direction: LinkDirection;
  at: string;
}

export interface WorkerTouch {
  managerId: string;
  agentType: string;
  at: string;
  tool?: string;
}

export interface ExternalTouch {
  keyId: string;
  name: string;
  source: string;
  at: string;
}

export interface EntryMapping {
  links: LinkTouch[];
  workers: WorkerTouch[];
}

export function managerIdOfActor(actor: string): string | undefined {
  if (!actor.startsWith('manager:')) return undefined;
  const id = actor.slice('manager:'.length);
  return id.length === 0 ? undefined : id;
}

export function parseWorkerActor(
  actor: string,
): { managerId: string; agentType: string } | undefined {
  if (!actor.startsWith('worker:')) return undefined;
  const rest = actor.slice('worker:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return { managerId: rest.slice(0, sep), agentType: rest.slice(sep + 1) };
}

function dispatchedInBackground(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as { run_in_background?: unknown }).run_in_background === true
  );
}

function dispatchedAgentType(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'subagent_type' in input) {
    const value = (input as { subagent_type?: unknown }).subagent_type;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return WORKER_AGENT_NAME;
}

// 写せないものは空を返す: 黙って別の線へ倒さないため。
export function mapJournalEntry(entry: JournalEntry): EntryMapping {
  const empty: EntryMapping = { links: [], workers: [] };
  const at = entry.at;
  switch (entry.type) {
    case 'exchange': {
      if (entry.with === 'human') {
        return {
          links: [
            {
              key: HUMAN_CLONE_LINK,
              direction: entry.role === 'inbound' ? 'down' : 'up',
              at,
            },
          ],
          workers: [],
        };
      }
      if (entry.with === 'manager') {
        if (entry.managerId === undefined) return empty;
        return {
          links: [
            {
              key: cloneManagerLink(entry.managerId),
              direction: entry.role === 'outbound' ? 'down' : 'up',
              at,
            },
          ],
          workers: [],
        };
      }
      return empty;
    }
    case 'escalation': {
      if (entry.managerId === undefined) return empty;
      return {
        links: [{ key: cloneManagerLink(entry.managerId), direction: 'up', at }],
        workers: [],
      };
    }
    case 'memory_update': {
      if (entry.cause === 'human') return empty;
      return { links: [{ key: CLONE_STORAGE_LINK, direction: 'down', at }], workers: [] };
    }
    case 'tool_use': {
      if (entry.actor === 'clone') {
        if (STORAGE_READ_TOOLS.has(entry.tool)) {
          return { links: [{ key: CLONE_STORAGE_LINK, direction: 'up', at }], workers: [] };
        }
        if (STORAGE_WRITE_TOOLS.has(entry.tool)) {
          return { links: [{ key: CLONE_STORAGE_LINK, direction: 'down', at }], workers: [] };
        }
        return empty;
      }
      const managerId = managerIdOfActor(entry.actor);
      if (managerId !== undefined) {
        if (!SUBAGENT_DISPATCH_TOOLS.has(entry.tool)) return empty;
        const agentType = dispatchedAgentType(entry.input);
        return {
          links: [
            {
              key: managerWorkerLink(managerId, agentType),
              direction: dispatchedInBackground(entry.input) ? 'down' : 'up',
              at,
            },
          ],
          workers: [{ managerId, agentType, at }],
        };
      }
      const worker = parseWorkerActor(entry.actor);
      if (worker !== undefined) {
        return {
          links: [
            {
              key: managerWorkerLink(worker.managerId, worker.agentType),
              direction: 'activity',
              at,
            },
          ],
          workers: [{ ...worker, at, tool: entry.tool }],
        };
      }
      return empty;
    }
    default:
      return empty;
  }
}

function later(current: string | undefined, next: string): string {
  if (current === undefined) return next;
  const a = Date.parse(current);
  const b = Date.parse(next);
  if (Number.isNaN(b)) return current;
  if (Number.isNaN(a)) return next;
  return b > a ? next : current;
}

export const TOPOLOGY_TOOL_TOMBSTONE_CAP = 1000;

export const TOPOLOGY_ACTIVITY_CAP = 2000;

export interface TopologyActivityTracker {
  record(entry: JournalEntry): void;
  links(): LinkActivity[];
  recordExternal(touch: ExternalTouch): void;
  externals(): ExternalActivity[];
  workersOf(managerId: string): WorkerActivity[];
  attach(subscribe: (listener: (entry: JournalEntry) => void) => () => void): () => void;
  recordWorkerTool(event: WorkerToolEvent): void;
  onChange(listener: () => void): () => void;
  attachWorkerTools(
    subscribe: (listener: (event: WorkerToolEvent) => void) => () => void,
  ): () => void;
}

// 遅延で差し込む: プール（`createClone` の中で作られる）が地図（`createApp`）より先に作られるため。
export interface WorkerToolBus {
  emit(event: WorkerToolEvent): void;
  subscribe(listener: (event: WorkerToolEvent) => void): () => void;
}

export function createWorkerToolBus(): WorkerToolBus {
  const listeners = new Set<(event: WorkerToolEvent) => void>();
  return {
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 1人の受け口が壊れても、他の受け口を巻き込まない
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createTopologyActivityTracker(
  cap: number = TOPOLOGY_ACTIVITY_CAP,
): TopologyActivityTracker {
  const links = new Map<string, LinkActivity>();
  const workers = new Map<string, WorkerActivity>();
  const externals = new Map<string, ExternalActivity>();
  const externalStamp = (row: ExternalActivity): number => {
    const value = Date.parse(row.lastAt);
    return Number.isNaN(value) ? 0 : value;
  };
  // 作業者の行とは別に持つ: 行が間引かれても数えを壊さないため。
  const running = new Map<
    string,
    { workerKey: string; managerId: string; agentType: string; tool: string; startedAt: string }
  >();
  const tombstones = new Set<string>();
  const changeListeners = new Set<() => void>();
  const notifyChange = (): void => {
    for (const listener of changeListeners) {
      try {
        listener();
      } catch {
        // 受け口の失敗で取り込みを止めない
      }
    }
  };
  const workerKeyOf = (managerId: string, agentType: string): string =>
    `${managerId}\u0000${agentType}`;

  const newest = (a: LinkActivity): number => {
    const times = [a.lastDownAt, a.lastUpAt, a.lastActivityAt]
      .filter((v): v is string => v !== undefined)
      .map((v) => Date.parse(v))
      .filter((v) => !Number.isNaN(v));
    return times.length === 0 ? 0 : Math.max(...times);
  };

  function pruneRunning(): void {
    if (running.size <= cap) return;
    const ordered = [...running.entries()].sort(
      (a, b) => Date.parse(a[1].startedAt) - Date.parse(b[1].startedAt),
    );
    for (const [id] of ordered.slice(0, running.size - cap)) running.delete(id);
  }

  function prune(): void {
    if (links.size > cap) {
      const ordered = [...links.values()].sort((a, b) => newest(a) - newest(b));
      for (const victim of ordered.slice(0, links.size - cap)) links.delete(victim.key);
    }
    if (externals.size > cap) {
      const ordered = [...externals.values()].sort((a, b) => externalStamp(a) - externalStamp(b));
      for (const victim of ordered.slice(0, externals.size - cap)) externals.delete(victim.keyId);
    }
    if (workers.size > cap) {
      const stamp = (row: WorkerActivity): number => {
        const value = Date.parse(row.lastToolAt ?? '');
        return Number.isNaN(value) ? 0 : value;
      };
      const ordered = [...workers.entries()].sort((a, b) => stamp(a[1]) - stamp(b[1]));
      for (const [key] of ordered.slice(0, workers.size - cap)) workers.delete(key);
    }
  }

  const tracker: TopologyActivityTracker = {
    record(entry) {
      const mapped = mapJournalEntry(entry);
      for (const touch of mapped.links) {
        const row = links.get(touch.key) ?? { key: touch.key };
        if (touch.direction === 'down') row.lastDownAt = later(row.lastDownAt, touch.at);
        else if (touch.direction === 'up') row.lastUpAt = later(row.lastUpAt, touch.at);
        else row.lastActivityAt = later(row.lastActivityAt, touch.at);
        links.set(touch.key, row);
      }
      for (const touch of mapped.workers) {
        const key = workerKeyOf(touch.managerId, touch.agentType);
        const row = workers.get(key) ?? { managerId: touch.managerId, agentType: touch.agentType };
        if (touch.tool !== undefined) {
          const updated = later(row.lastToolAt, touch.at);
          if (updated === touch.at) row.lastTool = touch.tool;
          row.lastToolAt = updated;
        }
        workers.set(key, row);
      }
      if (mapped.links.length > 0 || mapped.workers.length > 0) prune();
    },
    recordExternal(touch) {
      if (typeof touch.keyId !== 'string' || touch.keyId === '') return;
      if (Number.isNaN(Date.parse(touch.at))) return;
      const row = externals.get(touch.keyId);
      if (row === undefined) {
        externals.set(touch.keyId, {
          keyId: touch.keyId,
          name: touch.name,
          source: touch.source,
          lastAt: touch.at,
        });
      } else {
        const updated = later(row.lastAt, touch.at);
        if (updated === touch.at) {
          row.name = touch.name;
          row.source = touch.source;
        }
        row.lastAt = updated;
      }
      prune();
      notifyChange();
    },
    links() {
      return [...links.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => newest(b) - newest(a) || a.key.localeCompare(b.key));
    },
    externals() {
      return [...externals.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => externalStamp(b) - externalStamp(a) || a.keyId.localeCompare(b.keyId));
    },
    workersOf(managerId) {
      const rows = new Map<string, WorkerActivity>();
      for (const [key, row] of workers) {
        if (row.managerId === managerId) rows.set(key, { ...row });
      }
      for (const tool of running.values()) {
        if (tool.managerId !== managerId) continue;
        const row = rows.get(tool.workerKey) ?? { managerId, agentType: tool.agentType };
        const current = row.runningTool;
        if (current === undefined || Date.parse(tool.startedAt) < Date.parse(current.startedAt)) {
          row.runningTool = { tool: tool.tool, startedAt: tool.startedAt };
        }
        rows.set(tool.workerKey, row);
      }
      return [...rows.values()].sort((a, b) => a.agentType.localeCompare(b.agentType));
    },
    attach(subscribe) {
      return subscribe((entry) => tracker.record(entry));
    },
    recordWorkerTool(event) {
      if (event.type === 'tool_end') {
        if (running.delete(event.toolUseId)) {
          notifyChange();
          return;
        }
        tombstones.add(event.toolUseId);
        while (tombstones.size > TOPOLOGY_TOOL_TOMBSTONE_CAP) {
          const oldest = tombstones.values().next().value;
          if (oldest === undefined) break;
          tombstones.delete(oldest);
        }
        return;
      }
      if (tombstones.delete(event.toolUseId)) return;
      const worker = parseWorkerActor(event.actor);
      if (worker === undefined) return;
      if (Number.isNaN(Date.parse(event.startedAt))) return;
      running.set(event.toolUseId, {
        workerKey: workerKeyOf(worker.managerId, worker.agentType),
        managerId: worker.managerId,
        agentType: worker.agentType,
        tool: event.tool,
        startedAt: event.startedAt,
      });
      pruneRunning();
      notifyChange();
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    attachWorkerTools(subscribe) {
      return subscribe((event) => tracker.recordWorkerTool(event));
    },
  };
  return tracker;
}
