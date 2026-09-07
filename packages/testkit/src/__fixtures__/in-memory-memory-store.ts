import {
  defaultDecayStrategy,
  isEmbeddingStatusRollback,
  MemoryStatusConflictError,
  resolveIdempotentCreate,
} from "@mnemora/core";
import type { IdempotentCreateResult, NotIndexedReason } from "@mnemora/core";
import type {
  Ctx,
  EmbeddingStatus,
  Memory,
  MemoryEvent,
  MemoryId,
  MemoryStatus,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  NewObservation,
  NewRecallRecord,
  Observation,
  ObservationId,
  OutboxJobKind,
  OutboxJobRecord,
  RecallId,
  RecallScope,
  ScopeAggregate,
} from "@mnemora/core";
import { buildStoredMemoryEvent } from "./in-memory-event-store.js";
import { nextId } from "./id.js";

/**
 * `MemoryStore` のインメモリ・プレースホルダ実装。
 *
 * **本番用途ではない。** `packages/testkit` の適合テストが実際に実行できることを示す
 * ためだけの最小実装であり、`packages/postgres`（段階2）が実装すべき振る舞いの
 * 完全な参照ではない。特に索引・永続化・トランザクションは一切模していない。
 *
 * roadmap.md 段階3で `outboxJobs` を公開した。`InMemoryOutboxStore`
 * （`./in-memory-outbox-store.js`）にこの配列をそのまま渡すことで、`createObservationWithOutbox` /
 * `createMemoryWithOutbox` が積んだジョブを `OutboxStore` 側から claim/complete/fail できる
 * （`packages/postgres` が同一 DB・同一トランザクションで両方を実装するのと対応する、
 * ADR 0005・0003）。
 *
 * ADR 0031 で `events` を同じ理由で公開した。`InMemoryEventStore`
 * （`./in-memory-event-store.js`）のコンストラクタにこの配列をそのまま渡すことで、
 * `updateStatusWithEvent` が積んだイベントを `EventStore` 側からも `get`/`list` できる。
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly observations = new Map<string, Observation>();
  private readonly memories = new Map<string, Memory>();
  /** `(tenant_id, source_observation_id, extractor_version, content_hash)` の冪等キー。 */
  private readonly extractionIndex = new Map<string, MemoryId>();
  /** `(tenant_id, recall_id, memory_id)` の使用報告の冪等キー。 */
  private readonly usages = new Set<string>();
  /** roadmap.md 段階4/5: recall 段6（記録）が書き込む `recalls` 相当のインメモリ表。 */
  readonly recalls = new Map<string, NewRecallRecord & { tenantId: string }>();
  /** `InMemoryEventStore` と共有する memory_events 相当の配列（ADR 0031、同一プロセス内の参照共有）。 */
  readonly events: MemoryEvent[] = [];
  /** `InMemoryOutboxStore` と共有する outbox ジョブの配列（同一プロセス内の参照共有）。 */
  readonly outboxJobs: OutboxJobRecord[] = [];

  /**
   * ADR 0054: 「既存を引く」と「挿入する」を1つの同期区間に閉じ、`created` をその判定
   * そのものから出す。**`await` を挟まない**——挟むと判定と挿入の間に他の呼び出しの
   * 同期区間が入り、`created` が別の書き込みの影響を受ける。
   */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
  ): IdempotentCreateResult<Observation> {
    const existing = input.externalId
      ? [...this.observations.values()].find(
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
      this.observations.set(observation.id, observation);
      return observation;
    });
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    return this.createObservationIdempotent(ctx, input).value;
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    const observation = this.observations.get(id);
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return observation;
  }

  private enqueueOutboxJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
  ): OutboxJobRecord {
    const job: OutboxJobRecord = {
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
    this.outboxJobs.push(job);
    return job;
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
      this.enqueueOutboxJob(ctx, kind, { observationId: observation.id }),
    );
    return { observation, created: true, jobs };
  }

  /**
   * ADR 0054: 冪等キーの判定と挿入を1つの同期区間に閉じ、`created` をその判定そのものから
   * 出す（`createObservationIdempotent` と同じ理由）。
   */
  private createMemoryIdempotent(ctx: Ctx, input: NewMemory): IdempotentCreateResult<Memory> {
    const idemKey = this.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    const existingId = input.sourceObservationId ? this.extractionIndex.get(idemKey) : undefined;
    const existing = existingId !== undefined ? this.memories.get(existingId) : undefined;

    return resolveIdempotentCreate(existing, () => {
      // 外部キー相当（0001_init.sql）: `memories.source_observation_id` /
      // `superseded_by_id` / `contested_with_id` は、非 null なら実在する行を指さなければ
      // ならない。`packages/postgres` は実際の外部キー制約でこれを強制するが、この
      // in-memory 実装は `Map` の生成物にすぎず、参照整合性を放置すると「本番では起きない
      // 書き込みが手元では黙って成功する」（ADR 0047）。**「存在」だけを見る——一対一等の
      // 整合までは踏み込まない（`contested_with_id` が双方向かどうかはここでは見ない）。**
      if (input.sourceObservationId && !this.observations.has(input.sourceObservationId)) {
        throw new Error(
          `InMemoryMemoryStore: source observation not found: ${input.sourceObservationId}`,
        );
      }
      if (input.supersededById && !this.memories.has(input.supersededById)) {
        throw new Error(
          `InMemoryMemoryStore: superseded-by memory not found: ${input.supersededById}`,
        );
      }
      if (input.contestedWithId && !this.memories.has(input.contestedWithId)) {
        throw new Error(
          `InMemoryMemoryStore: contested-with memory not found: ${input.contestedWithId}`,
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
      this.memories.set(memory.id, memory);
      if (input.sourceObservationId) {
        this.extractionIndex.set(idemKey, memory.id);
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
    const jobs = jobKinds.map((kind) => this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }));
    return { memory, created: true, jobs };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    const memory = this.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  /**
   * ADR 0028: `reextract` が既存 Memory のうち今回作られなかったものを判定するための列挙
   * （**SELECT のみ**）。`extractorVersion: null` は `extractor_version IS NULL`
   * （postgres 実装の `IS NOT DISTINCT FROM` と同じ規約）を意味する。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== observationId) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
      results.push(memory);
    }
    return results;
  }

  /** ADR 0030: `opts.expectedStatus` があるときだけ compare-and-swap にする（postgres 実装と同じ意味論）。 */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts?.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: `supersededById` を渡すなら実在する Memory を指さなければ
    // ならない（`memories.superseded_by_id → memories(id)`）。
    if (opts?.supersededById !== undefined && !this.memories.has(opts.supersededById)) {
      throw new Error(
        `InMemoryMemoryStore: superseded-by memory not found: ${opts.supersededById}`,
      );
    }
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0031: `updateStatus` と同じ CAS 判定のあと、通ったときだけイベントも積む
   * （postgres 実装の `db.transaction()` に対応する意味論——CAS に弾かれたら status も
   * イベントも一切変わらない）。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: updateStatus と同じ理由・同じ検査。
    if (opts.supersededById !== undefined && !this.memories.has(opts.supersededById)) {
      throw new Error(
        `InMemoryMemoryStore: superseded-by memory not found: ${opts.supersededById}`,
      );
    }
    memory.status = status;
    if (opts.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    const storedEvent = buildStoredMemoryEvent(ctx, event);
    this.events.push(storedEvent);
    return { memory, event: storedEvent };
  }

  /**
   * ADR 0053: `ready` を `failed` へ巻き戻さない。
   *
   * `PostgresMemoryStore.setEmbeddingStatus`（`packages/postgres/src/memory-store.ts`）の
   * `WHERE ... AND embedding_status <> 'ready'`（`status` が `'failed'` のときだけ付く
   * 条件片）と同じ意味論。**禁じる遷移そのものの判定は共有の
   * {@link isEmbeddingStatusRollback} に固定する**——実装ごとに条件式を書き直すと、
   * どの遷移を禁じるかが実装間でずれる余地を作る（Postgres 側だけは比較を SQL の1文の
   * `WHERE` に置く必要があるためこの関数を呼べず、比較の形が2箇所に書かれる。
   * ADR 0053「引き受けた負債」）。
   *
   * 巻き戻しを**例外にはしない**——唯一の `failed` の呼び出し口は `runtime.tick` の
   * `catch` の中であり、そこで投げると元の埋め込みエラーが握り潰されて別の例外に
   * すり替わる。呼び出し側の次の一手も無いので、no-op のまま現在の（更新されなかった）
   * 行を返す（ADR 0048 の `reinforce` と同じ理由の形）。
   * `failed → ready` は妨げない（片側だけの規則）。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
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
   * ADR 0048（Postgres）/ ADR 0049（本実装）: 減衰の起点を巻き戻さない。
   *
   * `PostgresMemoryStore.reinforce`（`packages/postgres/src/memory-store.ts`）の
   * `WHERE ... AND (last_reinforced_at IS NULL OR last_reinforced_at < ${at})` と
   * 同じ意味論——**狭義の `<`**（同じ `at` は no-op）で、`lastReinforcedAt` と
   * `decayFloorAt` を同じ条件でまとめて動かす。古い `at` を**例外にはしない**——
   * 呼び出し側（`runtime.observe` の使用報告ループ）の次の一手が無いため、
   * no-op のまま現在の（更新されなかった）行を返す。
   */
  async reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (
      memory.lastReinforcedAt !== null &&
      memory.lastReinforcedAt !== undefined &&
      memory.lastReinforcedAt.getTime() >= at.getTime()
    ) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
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
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    // 外部キー相当（ADR 0047）: `recall_usages.recall_id → recalls(id)` /
    // `recall_usages.memory_id → memories(id)`。Postgres は単一の
    // `INSERT ... SELECT ... FROM unnest(...)` で全件をまとめて書くため、どれか1件でも
    // 外部キーに違反すれば文全体が失敗し、部分挿入は起きない——ここでも「全件の存在を
    // 先に確かめてから挿入する」ことで同じ全体原子性を再現する。
    //
    // ⚠ `memoryIds` が空配列なら、Postgres 実装（`packages/postgres/src/memory-store.ts`）は
    // クエリを一切発行せず即座に空の結果を返す——`recallId` の実在は問われない。
    // ここでもその早期リターンより後ろで検査することで、同じ非対称を再現する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    if (!this.recalls.has(recallId)) {
      throw new Error(`InMemoryMemoryStore: recall not found: ${recallId}`);
    }
    for (const memoryId of memoryIds) {
      if (!this.memories.has(memoryId)) {
        throw new Error(`InMemoryMemoryStore: memory not found: ${memoryId}`);
      }
    }

    const insertedMemoryIds: MemoryId[] = [];
    for (const memoryId of memoryIds) {
      const key = `${ctx.tenantId}:${recallId}:${memoryId}`;
      if (!this.usages.has(key)) {
        this.usages.add(key);
        insertedMemoryIds.push(memoryId);
      }
    }
    return { insertedMemoryIds };
  }

  /**
   * roadmap.md 段階4/5: `countByGroup` を置き換える単一集約（`ScopeAggregate`、
   * docs/recall.md §5・packages/core の recall.ts の doc コメント参照）。
   *
   * インメモリ実装なので「単一クエリ」という概念自体は無いが、契約として重要なのは
   * 「groups の総和が totalInScope と一致すること」——ここでは同じ1回のループで
   * 両方を積み上げることでそれを保証する（postgres 実装は単一 SQL 文でこれを保証する）。
   */
  async aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate> {
    const inScopeBySubject = new Map<string | null, number>();
    let totalInScope = 0;
    const notIndexed: Record<NotIndexedReason, number> = { pending: 0, failed: 0, skipped: 0 };
    let filteredArchived = 0;
    let filteredSuperseded = 0;
    let filteredForgotten = 0;
    let filteredPeriod = 0;

    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) {
        continue;
      }
      if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) {
        continue;
      }

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
      // ここに来るのは status IN ('active','contested') のみ。

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
    }

    const groups: ScopeAggregate["groups"] = [...inScopeBySubject.entries()].map(
      ([key, count]) => ({
        axis: "subject" as const,
        key,
        count,
        countKind: "exact" as const,
      }),
    );

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
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    const id = nextId("rcl");
    this.recalls.set(id, { ...record, tenantId: ctx.tenantId });
    return id;
  }

  private extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    return `${tenantId}:${sourceObservationId ?? ""}:${extractorVersion ?? ""}:${contentHash}`;
  }
}
