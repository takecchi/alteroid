import {
  qualifiedToolName,
  WORKER_AGENT_NAME,
  type JournalEntry,
  type WorkerToolEvent,
} from '@alteroid/core';

/**
 * 稼働の地図（`GET /topology`）の**線の活動**を、日誌の追記から数える層。
 *
 * **持つのは「最後にいつ流れたか」だけである。** 「いま流れている」と読む閾値は
 * ここにも API にも置かない（読み手が決める。閾値を焼くと、画面ごとに違う
 * 「いま」を持てなくなる）。判断も無い——日誌に載ったものを線へ写すだけで、
 * 日誌に載らないものは線にも載らない（**取れない軸に 0 の行を作らない**。線が
 * 無いことは「流れていない」ではなく「まだ観測していない」でありうる）。
 *
 * ## 線と向き
 *
 * 向きは**指揮する側から見る**。`down` = 人間→クローン→マネージャー→作業者の指示
 * （クローン→記憶は書き込み）、`up` = 報告・確認（記憶→クローンは読み出し）。
 *
 * | 線 | down | up |
 * | --- | --- | --- |
 * | `human~clone` | 人間の発言（`exchange` with=human inbound） | クローンの応答（outbound） |
 * | `clone~storage` | 記憶の書き込み（`memory_update`） | 記憶・日誌を読む道具 |
 * | `clone~manager:<id>` | 委譲・追送（`exchange` with=manager outbound） | 報告の受け取り（inbound）・確認（`escalation`） |
 * | `manager:<id>~worker:<type>` | 作業者を背景で起こした（`Agent` / `Task` で `run_in_background: true`） | 前景で起こした呼び出しが終わった（結果が戻った） |
 *
 * **`tool_use` は道具が終わった後に書かれる**（`runner.ts` の `#onPostToolUse`）。前景の
 * `Agent` / `Task` は作業者が終わるまで返らないので、その時刻は起こした瞬間ではなく
 * **結果が上へ戻った瞬間**である。背景（`run_in_background: true`）は起こした直後に
 * 返るので起こした瞬間（down）。**起こした瞬間が前景では日誌に載らない**ことは読み手が
 * 知っておく（down が無いのは「起こしていない」ではない）。
 *
 * **作業者の線の `lastActivityAt` は作業者の道具実行**（`worker:<id>:<type>` の
 * `tool_use`）。向きの無い印である（作業者の道具実行は指示でも報告でもない）。
 */

export type LinkDirection = 'down' | 'up' | 'activity';

/** 線1本ぶんの最後の活動時刻。**無い欄は「その向きでは一度も観測していない」。** */
export interface LinkActivity {
  key: string;
  lastDownAt?: string;
  lastUpAt?: string;
  lastActivityAt?: string;
}

/** 作業者（`managerId` × `agentType` で束ねた1行。段1では個体を見分けない）。 */
export interface WorkerActivity {
  managerId: string;
  agentType: string;
  lastTool?: string;
  lastToolAt?: string;
  /**
   * いま実行中の道具のうち**最も古いもの**（Issue #2725）。runner の `tool_running` が
   * 届いて `tool_end` がまだの分。**日誌に載らない**メモリだけの観測で、欄が無いことは
   * 「実行中でない」ではなく「観測していない」。読み出し側（`topology.ts`）が
   * 委譲の状態・経過時間で更に絞る。
   */
  runningTool?: { tool: string; startedAt: string };
}

export const HUMAN_CLONE_LINK = 'human~clone';
export const CLONE_STORAGE_LINK = 'clone~storage';

export function cloneManagerLink(managerId: string): string {
  return `clone~manager:${managerId}`;
}

export function managerWorkerLink(managerId: string, agentType: string): string {
  return `manager:${managerId}~worker:${agentType}`;
}

/** クローンが記憶・日誌を**読む**道具（地図では記憶→クローンの向き）。 */
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

/**
 * クローンが記憶・日誌を**書く**道具。**これらは自前で日誌へ書く道具なので、
 * 通常は `tool_use` ではなく `memory_update` / `decision` として残る**
 * （`SELF_JOURNALING_CLONE_TOOLS`）。書き込みの主な材料は `memory_update` で、
 * ここは検証落ち等で `tool_use` として残った回の保険である。
 */
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

/**
 * マネージャーが作業者（サブエージェント）を起こす道具の名前。SDK の版で `Task` から
 * `Agent` へ変わっている（`sdk-tools.d.ts` の `AgentInput`）ので両方を受ける。
 */
const SUBAGENT_DISPATCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** 1件の日誌が線へ与える変化。 */
export interface LinkTouch {
  key: string;
  direction: LinkDirection;
  at: string;
}

/** 1件の日誌が作業者の行へ与える変化。 */
export interface WorkerTouch {
  managerId: string;
  agentType: string;
  at: string;
  /** 作業者自身の道具実行のときだけ。 */
  tool?: string;
}

export interface EntryMapping {
  links: LinkTouch[];
  workers: WorkerTouch[];
}

/** `manager:<id>` の `<id>`。形が違えば `undefined`。 */
export function managerIdOfActor(actor: string): string | undefined {
  if (!actor.startsWith('manager:')) return undefined;
  const id = actor.slice('manager:'.length);
  return id.length === 0 ? undefined : id;
}

/**
 * `worker:<managerId>:<agentType>` を分ける。**`managerId` は最初の `:` まで**
 * （既定の発行器は `mgr-<uuid>` で `:` を含まない）。`agentType` は残り全部。
 */
export function parseWorkerActor(
  actor: string,
): { managerId: string; agentType: string } | undefined {
  if (!actor.startsWith('worker:')) return undefined;
  const rest = actor.slice('worker:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return undefined;
  return { managerId: rest.slice(0, sep), agentType: rest.slice(sep + 1) };
}

/**
 * 背景で起こしたか。`input.run_in_background === true` のときだけ真（欠落・真偽値でない値は
 * 前景＝結果が戻った側として扱う）。欄名は SDK 0.3.288 の `sdk-tools.d.ts` の
 * `AgentInput.run_in_background?: boolean` に逐語で在る。
 */
function dispatchedInBackground(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as { run_in_background?: unknown }).run_in_background === true
  );
}

/** `Agent` / `Task` の入力から、起こす作業者の種類を取り出す。 */
function dispatchedAgentType(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'subagent_type' in input) {
    const value = (input as { subagent_type?: unknown }).subagent_type;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  // `subagent_type` を省いた呼び出し。作業者層の本体は `WORKER_AGENT_NAME` 1つだけで、
  // 実行側（`runner.ts`）も種類が取れないときはこの名前で actor を組む。
  return WORKER_AGENT_NAME;
}

/**
 * 日誌1件を、線と作業者の変化へ写す。**純関数。**
 *
 * **写せないものは空を返す**（黙って別の線へ倒さない）。`exchange` の
 * `with: 'manager'` で `managerId` が無い行（古い行・内部の注記）は、どの線とも
 * 結べないので数えない。
 */
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
              // クローンが渡す（outbound）のが指示で、受け取る（inbound）のが報告。
              direction: entry.role === 'outbound' ? 'down' : 'up',
              at,
            },
          ],
          workers: [],
        };
      }
      return empty; // 内部ターン（self）は線の外
    }
    case 'escalation': {
      // マネージャー発の確認だけが線に乗る。クローン自身が人間へ上げた確認
      // （`managerId` 無し）は human~clone の側の出来事で、ここでは数えない。
      if (entry.managerId === undefined) return empty;
      return {
        links: [{ key: cloneManagerLink(entry.managerId), direction: 'up', at }],
        workers: [],
      };
    }
    case 'memory_update': {
      // **人間の直接編集（`cause: 'human'`）はクローンの書き込みではない**
      // （人間→記憶の線は地図に無い）。
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
          // 向きによらず行を作る（道具をまだ1本も実行していなくても、居る）。
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

/** 時刻（ISO8601）の新しいほうを返す。読めない値は採らない。 */
function later(current: string | undefined, next: string): string {
  if (current === undefined) return next;
  const a = Date.parse(current);
  const b = Date.parse(next);
  if (Number.isNaN(b)) return current;
  if (Number.isNaN(a)) return next;
  return b > a ? next : current;
}

/** `tool_end` が先に届いた道具の印（tombstone）の上限。超えたら古い順に忘れる。 */
export const TOPOLOGY_TOOL_TOMBSTONE_CAP = 1000;

/** 追跡する線・作業者の上限。超えたら最後の活動が古いものから落とす（無限に伸ばさない）。 */
export const TOPOLOGY_ACTIVITY_CAP = 2000;

export interface TopologyActivityTracker {
  /** 日誌1件を取り込む。 */
  record(entry: JournalEntry): void;
  /** 線の活動の写し。**最後の活動が新しい順。** */
  links(): LinkActivity[];
  /** あるマネージャーの作業者（種類ごと）。 */
  workersOf(managerId: string): WorkerActivity[];
  /** 日誌の購読口（`JournalBus.subscribe`）へ繋ぐ。戻り値は解除。 */
  attach(subscribe: (listener: (entry: JournalEntry) => void) => () => void): () => void;
  /**
   * 作業者の道具の実行中の合図（`tool_running` / `tool_end`。Issue #2725）を取り込む。
   * **日誌は通らない。** `tool_end` が先に届いた道具は、後から来る `tool_running` を
   * 無視する（入れ替わり対策）。
   */
  recordWorkerTool(event: WorkerToolEvent): void;
  /** 作業者の実行中の道具が変わったときに呼ぶ。戻り値は解除。 */
  onChange(listener: () => void): () => void;
  /** 作業者の道具の合図の購読口（`WorkerToolBus.subscribe`）へ繋ぐ。戻り値は解除。 */
  attachWorkerTools(
    subscribe: (listener: (event: WorkerToolEvent) => void) => () => void,
  ): () => void;
}

/**
 * runner→daemon の作業者の道具の合図を、プールと地図の tracker のあいだで中継する口。
 * **プール（`createClone` の中で作られる）が地図（`createApp`）より先に作られる**ので、
 * 遅延で差し込む（`journal-bus.ts` の `createJournalBus` と同じ形）。
 */
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
  /** 実行中の道具（`toolUseId` → ）。作業者の行とは別に持つ（行が間引かれても数えを壊さない）。 */
  const running = new Map<
    string,
    { workerKey: string; managerId: string; agentType: string; tool: string; startedAt: string }
  >();
  /** `tool_end` が先に届いた `toolUseId`（挿入順＝古い順に忘れる）。 */
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
    links() {
      return [...links.values()]
        .map((row) => ({ ...row }))
        .sort((a, b) => newest(b) - newest(a) || a.key.localeCompare(b.key));
    },
    workersOf(managerId) {
      // 実行中の道具だけが先に届いた作業者（日誌に1行も無い）も、行として載せる。
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
        // 先に届いた。後から来る tool_running を無視するための印。
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
