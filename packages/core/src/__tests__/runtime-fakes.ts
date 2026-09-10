import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { ClaimOutboxJobsOptions, OutboxStore } from "../interfaces/outbox-store.js";
import type { OutboxJobKind } from "../interfaces/scheduler.js";
import { assertValidEventRetentionDays } from "../interfaces/tenant-settings-store.js";
import type {
  EventRetention,
  EventRetentionSetting,
  TenantSettingsStore,
} from "../interfaces/tenant-settings-store.js";
import type { VectorStore, VectorFilter, VectorHit } from "../interfaces/vector-store.js";
import type { LexicalStore, LexicalFilter, LexicalHit } from "../interfaces/lexical-store.js";
import type { NotIndexedReason } from "../recall.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { MemoryEvent, NewMemoryEvent, EventFilter } from "../event.js";
import type { EventId } from "../ids.js";
import {
  isEmbeddingStatusRollback,
  MemoryStatusConflictError,
} from "../interfaces/memory-store.js";
import type {
  AggregateScopeOptions,
  MemoryStore,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
} from "../interfaces/memory-store.js";
import type { NewRecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { OutboxJobRecord } from "../outbox.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { resolveIdempotentCreate } from "../idempotent-create.js";
import type { IdempotentCreateResult } from "../idempotent-create.js";

/**
 * `packages/core` 自身の runtime テスト用フェイク一式。
 *
 * **`@mnemora/testkit` を import しない。** core は誰にも依存されるが誰にも依存しない
 * （docs/architecture.md §4）——`testkit` は `core` に依存するパッケージであり、逆方向の
 * 依存を core のテストからも作らない。ここでのフェイクは testkit の in-memory 実装と
 * 似ているが意図的に独立している（1つを直せばもう1つが壊れる、という結合を作らない）。
 */

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

type OutboxJobMutable = OutboxJobRecord;

/**
 * `NewMemoryEvent` から永続化済みの `MemoryEvent` を組み立てる。`FakeEventStore.append`
 * と `FakeMemoryStore.updateStatusWithEvent`（ADR 0031）の両方がこれを使う
 * ——`packages/testkit` の `buildStoredMemoryEvent`（`in-memory-event-store.ts`）と
 * 同じ形だが、ファイル冒頭のコメントの通り意図的に独立している。
 */
function buildStoredEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent {
  return {
    id: nextId("evt"),
    tenantId: ctx.tenantId,
    memoryId: event.memoryId,
    kind: event.kind,
    at: event.at ?? new Date(),
    actor: event.actor,
    digestSnapshot: event.digestSnapshot ?? null,
    sizeBeforeBytes: event.sizeBeforeBytes ?? null,
    meta: event.meta,
  };
}

class FakeBackingStore {
  observations = new Map<string, Observation>();
  memories = new Map<string, Memory>();
  extractionIndex = new Map<string, MemoryId>();
  usages = new Set<string>();
  recalls = new Map<string, NewRecallRecord & { tenantId: string }>();
  outboxJobs: OutboxJobMutable[] = [];
  /**
   * ADR 0031: `FakeMemoryStore.updateStatusWithEvent` と `FakeEventStore` が共有する
   * memory_events 相当の配列。以前は `FakeEventStore` が独立した配列を持っており
   * `FakeBackingStore` に載っていなかった——`outboxJobs` と同じ「同一トランザクションで
   * 書く2つの書き込み先を共有する」という形に揃えた。
   */
  events: MemoryEvent[] = [];

  extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    return `${tenantId}:${sourceObservationId ?? ""}:${extractorVersion ?? ""}:${contentHash}`;
  }
}

export class FakeMemoryStore implements MemoryStore {
  constructor(private readonly backing: FakeBackingStore) {}

  /**
   * ADR 0054: 判定と挿入を1つの同期区間に閉じ、`created` をその判定そのものから出す
   * （`InMemoryMemoryStore.createObservationIdempotent` と同じ形・同じ理由）。
   */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
  ): IdempotentCreateResult<Observation> {
    const existing = input.externalId
      ? [...this.backing.observations.values()].find(
          (o) => o.tenantId === ctx.tenantId && o.externalId === input.externalId,
        )
      : undefined;
    return resolveIdempotentCreate(existing, () => {
      const observation: Observation = {
        id: nextId("obs"),
        tenantId: ctx.tenantId,
        subjectId: input.subjectId ?? null,
        externalId: input.externalId ?? null,
        kind: input.kind,
        payload: input.payload,
        occurredAt: input.occurredAt ?? null,
        recordedAt: input.recordedAt ?? new Date(),
      };
      this.backing.observations.set(observation.id, observation);
      return observation;
    });
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    return this.createObservationIdempotent(ctx, input).value;
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    const observation = this.backing.observations.get(id);
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return observation;
  }

  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    const { value: observation, created } = this.createObservationIdempotent(ctx, input);
    if (!created) {
      return { observation, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) =>
      this.enqueueJob(ctx, kind, { observationId: observation.id }),
    );
    return { observation, created: true, jobs };
  }

  private enqueueJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
  ): OutboxJobRecord {
    const job: OutboxJobMutable = {
      id: nextId("job"),
      tenantId: ctx.tenantId,
      kind,
      payload,
      availableAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      attempts: 0,
      completedAt: null,
      failedAt: null,
      lastError: null,
      createdAt: new Date(),
    };
    this.backing.outboxJobs.push(job);
    return job;
  }

  /**
   * ADR 0054: 冪等キーの判定と挿入を1つの同期区間に閉じる
   * （`InMemoryMemoryStore.createMemoryIdempotent` と同じ形・同じ理由）。
   */
  private createMemoryIdempotent(ctx: Ctx, input: NewMemory): IdempotentCreateResult<Memory> {
    const idemKey = this.backing.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    const existingId = input.sourceObservationId
      ? this.backing.extractionIndex.get(idemKey)
      : undefined;
    const existing = existingId !== undefined ? this.backing.memories.get(existingId) : undefined;

    return resolveIdempotentCreate(existing, () => {
      // 外部キー相当（ADR 0047、`packages/testkit` の `InMemoryMemoryStore.createMemory` と
      // 同じ理由・同じ検査）: `sourceObservationId`/`supersededById`/`contestedWithId` は
      // 非 null なら実在する行を指さなければならない。**「存在」だけを見る**——一対一等の
      // 整合まではここでは踏み込まない。
      if (input.sourceObservationId && !this.backing.observations.has(input.sourceObservationId)) {
        throw new Error(
          `FakeMemoryStore: source observation not found: ${input.sourceObservationId}`,
        );
      }
      if (input.supersededById && !this.backing.memories.has(input.supersededById)) {
        throw new Error(`FakeMemoryStore: superseded-by memory not found: ${input.supersededById}`);
      }
      if (input.contestedWithId && !this.backing.memories.has(input.contestedWithId)) {
        throw new Error(
          `FakeMemoryStore: contested-with memory not found: ${input.contestedWithId}`,
        );
      }
      const now = new Date();
      const memory: Memory = {
        id: nextId("mem"),
        tenantId: ctx.tenantId,
        subjectId: input.subjectId ?? null,
        sourceObservationId: input.sourceObservationId ?? null,
        extractorVersion: input.extractorVersion ?? null,
        content: input.content,
        contentHash: input.contentHash,
        digest: input.digest,
        digestSource: input.digestSource,
        provenance: input.provenance,
        status: input.status ?? "active",
        supersededById: input.supersededById ?? null,
        contestedWithId: input.contestedWithId ?? null,
        tags: input.tags,
        occurredAt: input.occurredAt ?? null,
        recordedAt: input.recordedAt,
        lastReinforcedAt: input.lastReinforcedAt ?? null,
        strength: input.strength,
        halfLifeHours: input.halfLifeHours,
        decayFloorAt: input.decayFloorAt,
        embeddingStatus: input.embeddingStatus,
        createdAt: now,
        updatedAt: now,
      };
      this.backing.memories.set(memory.id, memory);
      if (input.sourceObservationId) {
        this.backing.extractionIndex.set(idemKey, memory.id);
      }
      return memory;
    });
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    return this.createMemoryIdempotent(ctx, input).value;
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const { value: memory, created } = this.createMemoryIdempotent(ctx, input);
    if (!created) {
      return { memory, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) => this.enqueueJob(ctx, kind, { memoryId: memory.id }));
    return { memory, created: true, jobs };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    const memory = this.backing.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const id of ids) {
      const memory = this.backing.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  /** ADR 0028: `runtime.reextract` が既存 Memory を判定するための列挙（**SELECT のみ**）。 */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== observationId) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
      results.push(memory);
    }
    return results;
  }

  /**
   * ADR 0030: `opts.expectedStatus` があるときだけ compare-and-swap にする
   * （postgres 実装・testkit の in-memory 実装と同じ意味論）。
   *
   * `beforeUpdateStatus`（テスト専用のフック）は CAS 判定の**直前**に呼ぶ——
   * `reextract` の TOCTOU（読んでから書くまでの間に別の書き込みが割り込む）を
   * 決定的に再現するための差し込み口。本番相当の実装には存在しない、このフェイク限りの機構。
   * ADR 0031 で追加した `updateStatusWithEvent` も、`reextract` が実際に呼ぶ経路として
   * 同じ位置（CAS 判定の直前）でこのフックを発火する——さもないと PR #28 が
   * このフックで決定的に再現している TOCTOU の歯が、`reextract` が `updateStatus` を
   * 呼ばなくなった時点で意味を失う。
   */
  beforeUpdateStatus?: (id: MemoryId) => void;

  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts?.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: `supersededById` を渡すなら実在する Memory を指さなければ
    // ならない。
    if (opts?.supersededById !== undefined && !this.backing.memories.has(opts.supersededById)) {
      throw new Error(`FakeMemoryStore: superseded-by memory not found: ${opts.supersededById}`);
    }
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0031: `updateStatus` と同じ CAS 判定のあと、通ったときだけイベントも積む。
   * `reextract` の supersede ループは、以前の「`updateStatus` を呼んでから
   * 別途 `eventStore.append` を呼ぶ」という2コミットの形をやめてこちらを呼ぶ
   * （`packages/core/src/runtime.ts`）——`beforeUpdateStatus` はここでも CAS 判定の
   * 直前に発火するため、PR #28 の TOCTOU の歯はそのまま生きる。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: updateStatus と同じ理由・同じ検査。
    if (opts.supersededById !== undefined && !this.backing.memories.has(opts.supersededById)) {
      throw new Error(`FakeMemoryStore: superseded-by memory not found: ${opts.supersededById}`);
    }
    memory.status = status;
    if (opts.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    const storedEvent = buildStoredEvent(ctx, event);
    this.backing.events.push(storedEvent);
    return { memory, event: storedEvent };
  }

  /**
   * ADR 0053: `ready` を `failed` へ巻き戻さない。
   * `InMemoryMemoryStore.setEmbeddingStatus`（`packages/testkit`）と同じ意味論・
   * 同じ理由——禁じる遷移の判定は共有の {@link isEmbeddingStatusRollback} に固定し、
   * 実装ごとに条件式を書き直さない。巻き戻しは**例外にせず** no-op のまま現在の行を返す
   * （`runtime.tick` の `catch` の中が唯一の `failed` の呼び出し口であり、そこで投げると
   * 元の埋め込みエラーが握り潰される。ADR 0048 の `reinforce` と同じ理由の形）。
   * `failed → ready` は妨げない（片側だけの規則）。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (isEmbeddingStatusRollback(memory.embeddingStatus, status)) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
      return memory;
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0048（Postgres）/ ADR 0049（本 fake）: 減衰の起点を巻き戻さない。
   * `InMemoryMemoryStore.reinforce`（`packages/testkit`）と同じ意味論・同じ理由
   * ——狭義の `<`（同じ `at` は no-op）で `lastReinforcedAt`/`decayFloorAt` を
   * 同じ条件でまとめて動かす。古い `at` は例外にせず、no-op のまま現在の行を返す。
   */
  async reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (
      memory.lastReinforcedAt !== null &&
      memory.lastReinforcedAt !== undefined &&
      memory.lastReinforcedAt.getTime() >= at.getTime()
    ) {
      return memory;
    }
    memory.lastReinforcedAt = at;
    memory.decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    memory.updatedAt = new Date();
    return memory;
  }

  async recordUsage(
    ctx: Ctx,
    recallId: string,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    // 外部キー相当（ADR 0047、`packages/testkit` の `InMemoryMemoryStore.recordUsage` と
    // 同じ理由・同じ検査）: `recall_usages.recall_id → recalls(id)` /
    // `recall_usages.memory_id → memories(id)`。`memoryIds` が空配列なら Postgres 実装は
    // クエリを一切発行せず即座に空の結果を返す（`recallId` の実在は問われない）ため、
    // その早期リターンより後ろで検査する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    if (!this.backing.recalls.has(recallId)) {
      throw new Error(`FakeMemoryStore: recall not found: ${recallId}`);
    }
    for (const memoryId of memoryIds) {
      if (!this.backing.memories.has(memoryId)) {
        throw new Error(`FakeMemoryStore: memory not found: ${memoryId}`);
      }
    }

    const insertedMemoryIds: MemoryId[] = [];
    for (const memoryId of memoryIds) {
      const key = `${ctx.tenantId}:${recallId}:${memoryId}`;
      if (!this.backing.usages.has(key)) {
        this.backing.usages.add(key);
        insertedMemoryIds.push(memoryId);
      }
    }
    return { insertedMemoryIds };
  }

  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    const inScopeBySubject = new Map<string | null, number>();
    let totalInScope = 0;
    const notIndexed: Record<NotIndexedReason, number> = { pending: 0, failed: 0, skipped: 0 };
    let filteredArchived = 0;
    let filteredSuperseded = 0;
    let filteredForgotten = 0;
    let filteredPeriod = 0;
    // 目次帯の候補（本 PR）: totalInScope に数える条件と**同じ条件**で in-scope の
    // Memory を集める。`digestBand` が要求されなかった場合はこの配列を使わない。
    const inScopeMemories: Memory[] = [];

    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) continue;

      if (memory.status === "archived") {
        filteredArchived += 1;
        continue;
      }
      if (memory.status === "superseded") {
        filteredSuperseded += 1;
        continue;
      }
      if (memory.status === "forgotten") {
        filteredForgotten += 1;
        continue;
      }

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        filteredPeriod += 1;
        continue;
      }

      totalInScope += 1;
      const key = memory.subjectId ?? null;
      inScopeBySubject.set(key, (inScopeBySubject.get(key) ?? 0) + 1);
      if (memory.embeddingStatus !== "ready") {
        notIndexed[memory.embeddingStatus] += 1;
      }
      inScopeMemories.push(memory);
    }

    const groups: ScopeAggregate["groups"] = [...inScopeBySubject.entries()].map(
      ([key, count]) => ({
        axis: "subject" as const,
        key,
        count,
        countKind: "exact" as const,
      }),
    );

    let digests: ScopeAggregate["digests"] = [];
    let digestEligible: ScopeAggregate["digestEligible"] = { count: 0, countKind: "exact" };
    if (opts?.digestBand) {
      const exclude = new Set(opts.digestBand.excludeMemoryIds);
      const eligibleMemories = inScopeMemories.filter((m) => !exclude.has(m.id));
      // 決定的な順序: (occurredAt ?? recordedAt) の降順、同値なら id の降順（本 PR）。
      eligibleMemories.sort((a, b) => {
        const aTime = (a.occurredAt ?? a.recordedAt).getTime();
        const bTime = (b.occurredAt ?? b.recordedAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      digestEligible = { count: eligibleMemories.length, countKind: "exact" };
      digests = eligibleMemories.slice(0, opts.digestBand.limit).map((m) => ({
        memoryId: m.id,
        digest: m.digest,
      }));
    }

    return {
      groups,
      totalInScope,
      countKind: "exact",
      notIndexed: {
        pending: { count: notIndexed.pending, countKind: "exact" },
        failed: { count: notIndexed.failed, countKind: "exact" },
        skipped: { count: notIndexed.skipped, countKind: "exact" },
      },
      filteredArchived: { count: filteredArchived, countKind: "exact" },
      filteredSuperseded: { count: filteredSuperseded, countKind: "exact" },
      filteredForgotten: { count: filteredForgotten, countKind: "exact" },
      filteredPeriod: { count: filteredPeriod, countKind: "exact" },
      digests,
      digestEligible,
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    const id = nextId("rcl");
    this.backing.recalls.set(id, { ...record, tenantId: ctx.tenantId });
    return id;
  }

  /**
   * ADR 0079: 索引に載っていない Memory を `pending` へ戻し、`embed` の outbox 行を
   * 積み直す。**更新と積み直しを `await` を挟まない同期区間で行う**ことで、
   * Postgres 側の単一文（＝同一トランザクション）と同じく「片方だけ起きた中間状態」を
   * 外から観測させない（ADR 0054 と同じ形）。
   */
  async requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
    const targetStatuses: readonly EmbeddingStatus[] = opts.statuses;
    const idFilter = opts.memoryIds === undefined ? null : new Set<string>(opts.memoryIds);
    const targets = [...this.backing.memories.values()]
      .filter(
        (m) =>
          m.tenantId === ctx.tenantId &&
          (m.status === "active" || m.status === "contested") &&
          targetStatuses.includes(m.embeddingStatus) &&
          (idFilter === null || idFilter.has(m.id)),
      )
      .sort(
        (a, b) =>
          a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, Math.max(0, opts.limit));

    const memoryIds: MemoryId[] = [];
    for (const memory of targets) {
      memory.embeddingStatus = "pending";
      memory.updatedAt = new Date();
      this.enqueueJob(ctx, "embed", { memoryId: memory.id });
      memoryIds.push(memory.id);
    }
    return { requeued: memoryIds.length, memoryIds };
  }
}

export class FakeOutboxStore implements OutboxStore {
  constructor(private readonly backing: FakeBackingStore) {}

  /**
   * 歯が outbox 行の**終端状態**（`claimedAt` / `failedAt` / `lastError`）を直接測るための読み口。
   * ADR 0082 の歯が「対応していない kind のジョブは黙って lease 切れを待つのではなく
   * `fail()` で終端に落ちる」「頼まれていない kind は claim すらされない」を測るのに使う——
   * `TickResult` だけでは outbox 行がどうなったかは見えない。
   */
  listJobs(ctx: Ctx): OutboxJobRecord[] {
    return this.backing.outboxJobs
      .filter((job) => job.tenantId === ctx.tenantId)
      .map((job) => ({ ...job }));
  }

  // リース意味論（ADR 0032）は `packages/testkit` の `InMemoryOutboxStore`/
  // `PostgresOutboxStore` と一致させてある——この fake だけ古い意味論のままだと
  // `runtime.test.ts` が「今日の姿」を検査しているつもりで、実は直った後の姿を
  // 検査してしまう食い違いが起きる。
  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    const leaseExpiresBefore = opts.now.getTime() - opts.leaseMs;
    const eligible = this.backing.outboxJobs.filter((job) => {
      const claimedAt = job.claimedAt ?? null;
      return (
        job.tenantId === ctx.tenantId &&
        (opts.kinds === undefined || opts.kinds.includes(job.kind)) &&
        job.completedAt === null &&
        job.failedAt === null &&
        job.availableAt <= opts.now &&
        (claimedAt === null || claimedAt.getTime() <= leaseExpiresBefore)
      );
    });
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      job.claimedAt = opts.now;
      job.claimedBy = opts.claimedBy;
      job.attempts += 1;
    }
    return claimed.map((job) => ({ ...job }));
  }

  async complete(ctx: Ctx, jobId: string): Promise<void> {
    const job = this.backing.outboxJobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (job) {
      job.completedAt = new Date();
    }
  }

  async fail(ctx: Ctx, jobId: string, error: string): Promise<void> {
    const job = this.backing.outboxJobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (job) {
      job.failedAt = new Date();
      job.lastError = error;
    }
  }
}

/**
 * cosine 距離（pgvector の `<=>` 演算子と同じ定義: `1 - cosine_similarity`）。
 * `packages/postgres` の `PostgresVectorStore.search` が実際に使う演算子と同じ式にする
 * ——recall のテストが「本物の pgvector とスコアの意味が違う」という食い違いを生まないため。
 */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) {
    // ADR 0040: 契約は「ゼロベクトルが絡む候補は recall() の結果に出ない」——
    // どんな scoreThreshold でも `total >= scoreThreshold` を通らない値を返さなければならない。
    // `0` でも `1` でもだめ（どちらも scoreThreshold 次第で通りうる）。
    // `Infinity` もだめ——`similarity = 1 - Infinity = -Infinity` になり、
    // `scoreThreshold = -Infinity` のとき `-Infinity >= -Infinity` が真になって通ってしまう。
    // `NaN` は、どんな数との比較も false になる唯一の値である。
    // 🔴 この番人（`normA === 0 || normB === 0`）を「下の式が 0/0 で同じ NaN になるから」と
    // 消さないこと——消しても値は変わらない（等価変異）が、番人が保持しているのは値ではなく
    // 「0/1/Infinity ではなく NaN を選んだ」という決定そのもの。消すと、次に式を触った人が
    // その決定ごと落とす。
    return NaN;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `FakeVectorStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。recall のテストが意味のある結果を得られるよう、
 * `upsert` されたベクトルに対して実際に cosine 距離で ANN を模する
 * （`FakeBackingStore.memories` を参照して `VectorFilter`（ADR 0034）を本物同様に適用する）。
 *
 * **`backing` を必須のコンストラクタ引数にしている（省略不可）。** `status` / `subjectId` /
 * `decayFloorAt` は Memory の属性であって、ベクトルの属性ではない
 * （`VectorFilter` — `packages/core/src/interfaces/vector-store.ts`、ADR 0034）。
 * `packages/testkit` の `InMemoryVectorStore` が `memoryStore` を必須にしたのと同じ理由——
 * **省略可能にしなかった理由（ADR 0034 の「採らなかった案」節）**: 省略できると
 * 「filter を実際に検査できる fake」と「検査できない（＝常に無視しても壊れない）fake」が
 * 同じ緑色の出力になる。このリポジトリは ADR 0011/0025/0027/0028 で同じ族の失敗
 * （名乗れる以上の精度を主張する）を繰り返しており、ここでも繰り返さない。唯一の生成箇所
 * （このファイルの `createFakeRuntimeStores`）は既に `backing` を渡している。
 */
export class FakeVectorStore implements VectorStore {
  entries = new Map<string, { tenantId: string; memoryId: MemoryId; vector: number[] }>();

  constructor(private readonly backing: FakeBackingStore) {}

  private key(space: EmbeddingSpaceId, tenantId: string, memoryId: MemoryId): string {
    return `${space.provider}:${space.model}:${space.dimensions}:${tenantId}:${memoryId}`;
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    // 外部キー相当（ADR 0047）: `memory_embeddings_<space>.memory_id → memories(id)`。
    // `search` は同じ `backing.memories` を真実の源として引いており（クラス doc 参照）、
    // 書き込み側（upsert）でも同じ非対称を強制する——ADR 0034 が実装した「MemoryStore が
    // 真実の源」を、書き込み時点でも成り立たせる。
    if (!this.backing.memories.has(memoryId)) {
      throw new Error(`FakeVectorStore: memory not found: ${memoryId}`);
    }
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      vector,
    });
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    // `InMemoryVectorStore`（packages/testkit）と同じ意味論に揃える（ADR 0065）:
    // 索引を模す prefix は space（provider/model/dimensions）だけで絞る。以前はここで
    // `space` を一度も参照しておらず（引数名も `_space` だった）、異なる space の vector を
    // 混同して返していた——`key()` が space を含む prefix を作っているのに、`search` だけが
    // それを見ていなかった。
    const prefix = `${space.provider}:${space.model}:${space.dimensions}:`;
    const hits: VectorHit[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (entry.tenantId !== opts.filter.tenantId || entry.tenantId !== ctx.tenantId) continue;
      // status / subjectId / decayFloorAtAfter は Memory の属性であり、ベクトルの属性ではない
      // （ADR 0034）。`backing.memories` を真実の源として引く——`InMemoryVectorStore` の
      // `this.memoryStore.get(...)` に対応する一段。
      const memory = this.backing.memories.get(entry.memoryId);
      if (!memory) {
        // 真実の源に無い vector は返さない——Postgres の外部キー制約
        // （`memory_id → memories(id)`）に対応する扱い（ADR 0034 決定2、
        // `InMemoryVectorStore` と揃える）。このリポジトリ内で `vectorStore.upsert` を
        // 直接呼ぶテストは必ず `memoryStore.createMemory` で作った実在の memory.id を渡して
        // いるため（`recall-pipeline.test.ts`）、この既定によって既存の歯が落ちないことを
        // 確認済み。
        continue;
      }
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      if (opts.filter.subjectId !== undefined && memory.subjectId !== opts.filter.subjectId) {
        continue;
      }
      if (
        opts.filter.decayFloorAtAfter !== undefined &&
        memory.decayFloorAt <= opts.filter.decayFloorAtAfter
      ) {
        // 狭義の `>`（境界とちょうど同じものは除外）。この意味論は変えていない。
        continue;
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op
      // （`VectorFilter.excludeProvenanceKinds` の doc 参照。`InMemoryVectorStore` と
      // 同じ意味論）。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0059: period（両端とも包含、`>=`/`<=`）。比較対象は `occurredAt ?? recordedAt`
      // （ADR 0039 の実効時刻）——`InMemoryVectorStore`（`packages/testkit`）と同じ意味論。
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      hits.push({ memoryId: entry.memoryId, distance: cosineDistance(query, entry.vector) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, opts.limit);
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    this.entries.delete(this.key(space, ctx.tenantId, memoryId));
  }
}

/**
 * `FakeLexicalStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。`packages/testkit` の `InMemoryLexicalStore` とは
 * **意図的に独立している**——本 PR の時点で `InMemoryLexicalStore` はまだ書かれている最中
 * （Issue #106 の歯だけを先に置く作業。他の作業者が同時に `packages/testkit` を触っている）
 * ため、それを import しない。
 *
 * **契約は `interfaces/lexical-store.ts` の `LexicalStore` doc に従う**:
 * - `query` の**語彙をすべて含む**候補だけを返す（`ScoreBreakdown.lexicalMatch` の doc —
 *   語彙一致は二値である、という前提そのもの）。全件を無条件で返す実装は、この契約と
 *   `recall-channels.test.ts` 歯①の偽陽性点検（無関係な記憶が混ざっても返らないこと）で落ちる。
 * - `filter` の各フィールドを実際に適用する（`FakeVectorStore.search` と同じ多層防御の作法）。
 * - 返り値は `rank` の降順。`rank` はここでは「一致したトークンの出現回数の総和」という
 *   決定的で単調な値を使う——本物の `ts_rank_cd` を模す必要は無い。`LexicalHit.rank` の doc の
 *   通り、この値は `ScoreBreakdown` には一切入らない（`recall-runtime.ts` が
 *   `LEXICAL_MATCH_VALUE` に丸める）。
 *
 * `calls` / `shouldThrow` は `FakeEmbeddingProvider.shouldFail` と同じ形の診断・注入口——
 * 「一度も呼ばれていないこと」（既定チャンネルが語彙 store に触れない）と
 * 「配線されているが落ちる adapter」の両方を、歯から直接組み立てられるようにするため。
 */
export class FakeLexicalStore implements LexicalStore {
  /** `search` が呼ばれるたびに積む診断ログ。「一度も呼ばれていないこと」を歯が直接検査できる。 */
  calls: { ctx: Ctx; query: string; opts: { limit: number; filter: LexicalFilter } }[] = [];
  /** true にすると `search` は例外を投げる（配線されているが壊れている adapter を模す）。 */
  shouldThrow = false;

  constructor(private readonly backing: FakeBackingStore) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    this.calls.push({ ctx, query, opts });
    if (this.shouldThrow) {
      throw new Error("FakeLexicalStore: simulated search failure");
    }
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    const hits: LexicalHit[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== opts.filter.tenantId || memory.tenantId !== ctx.tenantId) continue;
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      if (opts.filter.subjectId !== undefined && memory.subjectId !== opts.filter.subjectId) {
        continue;
      }
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      // 🔴 契約: クエリの語彙を**すべて**含む候補しか返さない（空クエリは何も返さない）。
      if (tokens.length === 0) continue;
      const matchesAll = tokens.every((t) => memory.content.includes(t));
      if (!matchesAll) continue;

      const rank = tokens.reduce((sum, t) => sum + (memory.content.split(t).length - 1), 0);
      hits.push({ memoryId: memory.id, rank });
    }
    // rank 降順。同率は memoryId 昇順で決定的にする（`FakeVectorStore` の distance 昇順ソートと
    // 同じ「adapter は決定的な順序で返す」という作法）。
    hits.sort((a, b) => b.rank - a.rank || (a.memoryId < b.memoryId ? -1 : 1));
    return hits.slice(0, opts.limit);
  }
}

export class FakeEventStore implements EventStore {
  /**
   * ADR 0031: `backing.events` を共有する（`FakeMemoryStore.updateStatusWithEvent` が
   * 積んだイベントもここから読めるようにするため）。以前は独立した配列を持っており
   * `FakeBackingStore` に載っていなかった——`FakeOutboxStore` が `backing.outboxJobs` を
   * 共有するのと同じ形に揃えた。`stores.eventStore.events` という既存の参照の仕方
   * （`runtime.test.ts` 等）を壊さないよう、`events` は `backing.events` を指す getter。
   */
  constructor(private readonly backing: FakeBackingStore) {}

  get events(): MemoryEvent[] {
    return this.backing.events;
  }

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    // 外部キー相当（ADR 0047）: `memory_events.memory_id → memories(id)`（nullable。
    // `kind = 'events_purged'` の場合のみ NULL が正当）。**NULL は拒まない**——kind を
    // 問わず、`memoryId` が非 null のときだけ実在を要求する。
    if (event.memoryId !== null && !this.backing.memories.has(event.memoryId)) {
      throw new Error(`FakeEventStore: memory not found: ${event.memoryId}`);
    }
    const stored = buildStoredEvent(ctx, event);
    this.backing.events.push(stored);
    return stored;
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    return this.backing.events.find((e) => e.id === id && e.tenantId === ctx.tenantId) ?? null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    const matched = this.backing.events.filter((e) => {
      if (e.tenantId !== ctx.tenantId) return false;
      if (filter.memoryId !== undefined && e.memoryId !== filter.memoryId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.since !== undefined && e.at < filter.since) return false;
      if (filter.until !== undefined && e.at > filter.until) return false;
      return true;
    });
    // EventStore.list の契約（../interfaces/event-store.ts）どおり `at` 昇順に並べ替えてから
    // `limit` を適用する。`filter()` は新しい配列を返すので、その配列を sort() すれば
    // `this.backing.events`（ADR 0031: FakeMemoryStore.updateStatusWithEvent と共有、
    // `store.events` getter 経由で runtime.test.ts が直接読む）を in-place で破壊しない
    // （`packages/testkit` の `InMemoryEventStore.list` と同じ形・同じ理由）。
    const sorted = matched.sort((a, b) => a.at.getTime() - b.at.getTime());
    return filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted;
  }
}

// `getEventRetention`/`setEventRetention` は `TenantSettingsStore` interface が必須にした
// ため（ADR 0050）、型を満たすためだけに足した最小実装。このファイル以外の既存テストは
// `getDefaultHalfLifeHours` しか使わず、これら2メソッドを呼ぶ既存テストは無い——
// `packages/testkit` の `InMemoryTenantSettingsStore`（適合スイートの対象）とは異なり、
// `FakeTenantSettingsStore` は適合スイートの対象外（ADR 0047 が明記した「core 専用の
// Fake は testkit の適合テストが届かない」構造と同じ）ため、ここに置いた実装を
// 独立に検査する歯は無い。
export class FakeTenantSettingsStore implements TenantSettingsStore {
  private eventRetention: EventRetention = { kind: "unset" };

  constructor(private readonly halfLifeHours = 720) {}

  async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
    return this.halfLifeHours;
  }

  async getEventRetention(_ctx: Ctx): Promise<EventRetention> {
    return this.eventRetention;
  }

  async setEventRetention(_ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
    }
    this.eventRetention = retention;
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = { provider: "fake", model: "fake-model", dimensions: 2 };
  shouldFail = false;

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (this.shouldFail) {
      throw new Error("simulated embedding provider failure");
    }
    // 決定的: 文字列長から機械的にベクトルを作る。
    return texts.map((text) => [text.length, [...text].filter((c) => c === "a").length]);
  }
}

export function createFakeRuntimeStores(): {
  memoryStore: FakeMemoryStore;
  outboxStore: FakeOutboxStore;
  vectorStore: FakeVectorStore;
  /**
   * 語彙チャンネル（ADR 0084、Issue #106）。**常に生成する**が、`RuntimeDeps.lexicalStore` へ
   * 配線するかどうかは呼び出し側（各テストの `createRuntime` 呼び出し）の裁量——
   * 配線しない歯（`recall-channels.test.ts` 歯④）は、この値を単に渡さないだけでよい。
   */
  lexicalStore: FakeLexicalStore;
  eventStore: FakeEventStore;
  tenantSettingsStore: FakeTenantSettingsStore;
  embeddingProvider: FakeEmbeddingProvider;
} {
  const backing = new FakeBackingStore();
  return {
    memoryStore: new FakeMemoryStore(backing),
    outboxStore: new FakeOutboxStore(backing),
    vectorStore: new FakeVectorStore(backing),
    lexicalStore: new FakeLexicalStore(backing),
    eventStore: new FakeEventStore(backing),
    tenantSettingsStore: new FakeTenantSettingsStore(),
    embeddingProvider: new FakeEmbeddingProvider(),
  };
}
