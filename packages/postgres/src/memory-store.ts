import { sql } from "drizzle-orm";
import { defaultDecayStrategy } from "@mnemora/core";
import { EMBEDDING_STATUS_ROLLBACK, MemoryStatusConflictError } from "@mnemora/core";
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
import type { Db } from "./client.js";
import {
  isUuidLike,
  rowToMemory,
  rowToMemoryEvent,
  rowToObservation,
  rowToOutboxJob,
  type MemoryEventRow,
  type MemoryRow,
  type ObservationRow,
  type OutboxJobRow,
} from "./mapping.js";

/**
 * `MemoryStore` の Postgres 実装（docs/architecture.md §5.1、docs/memory-model.md §10）。
 *
 * クエリは drizzle-orm の `sql` タグ付きテンプレートで書く。冪等な作成
 * （`createObservation` / `createMemory`）は `INSERT ... ON CONFLICT (...) WHERE ... DO NOTHING
 * RETURNING *` を使い、行が返らなかった場合（＝既存行と衝突した場合）だけ追加の SELECT で
 * 既存行を取得する。`ON CONFLICT` の衝突検出はテーブルの一意索引そのものが担うため、
 * 同時実行でも正しく機能する（先に commit した側の行だけが見える）。
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    const externalId = input.externalId ?? null;
    const inserted = await this.db.execute(sql`
      INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.subjectId ?? null},
        ${externalId},
        ${input.kind},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.occurredAt ?? null},
        ${input.recordedAt ?? new Date()}
      )
      ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `);
    if (inserted.rows.length > 0) {
      return rowToObservation(inserted.rows[0] as unknown as ObservationRow);
    }

    // externalId が null の場合は一意制約の対象外なので、ここに来るのは externalId が
    // 非 null で既存行と衝突したときだけである。
    const existing = await this.db.execute(sql`
      SELECT * FROM observations
      WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
      LIMIT 1
    `);
    return rowToObservation(existing.rows[0] as unknown as ObservationRow);
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    // id 列は uuid 型。UUID の形をしていない入力は「存在しない」と同じ扱いにする
    // （実 DB 検査で判明: 素通しすると invalid input syntax for type uuid で例外になる）。
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM observations WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0
      ? rowToObservation(result.rows[0] as unknown as ObservationRow)
      : null;
  }

  /**
   * transactional outbox（docs/architecture.md §3.4）: Observation の INSERT と outbox への
   * ジョブ書き込みを同一トランザクションで行う。`db.transaction()`（drizzle-orm が単一の
   * 接続上で `BEGIN`/`COMMIT` を発行する）を使う——`createObservation` と同じ
   * `ON CONFLICT ... DO NOTHING RETURNING *` の形を踏襲しつつ、新規作成が実際に起きた
   * ときだけ outbox 行を積む。
   */
  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    const externalId = input.externalId ?? null;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${input.subjectId ?? null},
          ${externalId},
          ${input.kind},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.occurredAt ?? null},
          ${input.recordedAt ?? new Date()}
        )
        ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `);

      if (inserted.rows.length === 0) {
        const existing = await tx.execute(sql`
          SELECT * FROM observations
          WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
          LIMIT 1
        `);
        return {
          observation: rowToObservation(existing.rows[0] as unknown as ObservationRow),
          created: false,
          jobs: [],
        };
      }

      const observation = rowToObservation(inserted.rows[0] as unknown as ObservationRow);
      const jobs: OutboxJobRecord[] = [];
      for (const kind of jobKinds) {
        const jobResult = await tx.execute(sql`
          INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${kind},
            ${JSON.stringify({ observationId: observation.id })}::jsonb,
            now(),
            0,
            now()
          )
          RETURNING *
        `);
        jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
      }
      return { observation, created: true, jobs };
    });
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const provenanceKind = input.provenance.kind;

    const inserted = await this.db.execute(sql`
      INSERT INTO memories (
        id, tenant_id, subject_id,
        source_observation_id, extractor_version,
        content, content_hash, digest, digest_source,
        provenance_kind, provenance,
        status, superseded_by_id, contested_with_id,
        tags,
        occurred_at, recorded_at, last_reinforced_at,
        strength, half_life_hours, decay_floor_at,
        embedding_status,
        created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
        ${sourceObservationId}, ${extractorVersion},
        ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
        ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
        ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
        ${sql.param(input.tags)},
        ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
        ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
        ${input.embeddingStatus},
        now(), now()
      )
      ON CONFLICT (tenant_id, source_observation_id, extractor_version, content_hash)
        WHERE source_observation_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `);
    if (inserted.rows.length > 0) {
      return rowToMemory(inserted.rows[0] as unknown as MemoryRow);
    }

    const existing = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${sourceObservationId}
        AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
        AND content_hash = ${input.contentHash}
      LIMIT 1
    `);
    return rowToMemory(existing.rows[0] as unknown as MemoryRow);
  }

  /**
   * transactional outbox（docs/architecture.md §3.4・memory-model.md §11 行3）: Memory の
   * INSERT と outbox への埋め込みジョブ書き込みを同一トランザクションで行う。抽出の
   * 冪等キーに衝突した場合（`created: false`）は埋め込みジョブを作らない——既に埋め込み済み
   * か、既に埋め込みジョブが積まれているはずの Memory に対して重複ジョブを積まない。
   */
  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const provenanceKind = input.provenance.kind;

    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO memories (
          id, tenant_id, subject_id,
          source_observation_id, extractor_version,
          content, content_hash, digest, digest_source,
          provenance_kind, provenance,
          status, superseded_by_id, contested_with_id,
          tags,
          occurred_at, recorded_at, last_reinforced_at,
          strength, half_life_hours, decay_floor_at,
          embedding_status,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
          ${sourceObservationId}, ${extractorVersion},
          ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
          ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
          ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
          ${sql.param(input.tags)},
          ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
          ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
          ${input.embeddingStatus},
          now(), now()
        )
        ON CONFLICT (tenant_id, source_observation_id, extractor_version, content_hash)
          WHERE source_observation_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `);

      if (inserted.rows.length === 0) {
        const existing = await tx.execute(sql`
          SELECT * FROM memories
          WHERE tenant_id = ${ctx.tenantId}
            AND source_observation_id = ${sourceObservationId}
            AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
            AND content_hash = ${input.contentHash}
          LIMIT 1
        `);
        return {
          memory: rowToMemory(existing.rows[0] as unknown as MemoryRow),
          created: false,
          jobs: [],
        };
      }

      const memory = rowToMemory(inserted.rows[0] as unknown as MemoryRow);
      const jobs: OutboxJobRecord[] = [];
      for (const kind of jobKinds) {
        const jobResult = await tx.execute(sql`
          INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${kind},
            ${JSON.stringify({ memoryId: memory.id })}::jsonb,
            now(),
            0,
            now()
          )
          RETURNING *
        `);
        jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
      }
      return { memory, created: true, jobs };
    });
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    // id 列は uuid 型。この口の契約は「無い == null」なので、形式が壊れた入力も
    // クエリを投げる前に同じ null へ寄せる（mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0 ? rowToMemory(result.rows[0] as unknown as MemoryRow) : null;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    // この口の契約は「無い id は静かに落とす」（D9）。形式が壊れた id も同じ扱いにする
    // ため、クエリを投げる前に取り除く——呼び出し全体を弾かない
    // （mapping.ts の isUuidLike の doc参照）。
    const wellFormedIds = ids.filter((id) => isUuidLike(id));
    if (wellFormedIds.length === 0) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(wellFormedIds)}::uuid[])
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * ADR 0028: `reextract` が「今回作られた content_hash の集合に含まれない既存 Memory」を
   * 判定するための列挙。**SELECT のみ**——索引は 0001_init.sql の一意索引
   * `uq_memories_extraction (tenant_id, source_observation_id, extractor_version, content_hash)`
   * が `(tenant_id, source_observation_id, extractor_version)` の前方一致で使える。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    // source_observation_id 列は uuid 型。この口の契約は「無い == []」なので、
    // 形式が壊れた observationId もクエリを投げる前に空配列へ寄せる
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(observationId)) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${observationId}
        AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * ADR 0030（安全弁3）: `opts.expectedStatus` を渡すと `AND status = ${expectedStatus}` を
   * 足した条件付き UPDATE になる（compare-and-swap）。**`expectedStatus` が無いときは
   * 今日と一字も変えない**——このメソッドの大半の呼び出し元（`archived`/`forgotten` への
   * 遷移等）は無条件更新のままでよい。
   *
   * 条件付き UPDATE が0行だった場合、それが「対象の id がそもそも無い」のか
   * 「id はあるが status が期待と違う」のかを、追加の `SELECT` で読み直して区別する
   * ——前者は今日と同じ「memory not found」の `Error`、後者は
   * {@link MemoryStatusConflictError}。**この読み直しは弾かれた後に行うため、
   * `observedStatus` は弾かれた瞬間の値ではない**（`MemoryStatusConflictError` の
   * doc コメント参照）。
   */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる——ドライバの
    // invalid input syntax for type uuid を呼び出し側に漏らさない
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const expectedStatus = opts?.expectedStatus;
    const statusCondition =
      expectedStatus !== undefined ? sql`AND status = ${expectedStatus}` : sql``;
    const result = await this.db.execute(sql`
      UPDATE memories
      SET status = ${status},
          superseded_by_id = COALESCE(${opts?.supersededById ?? null}, superseded_by_id),
          updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id} ${statusCondition}
      RETURNING *
    `);
    if (result.rows.length > 0) {
      return rowToMemory(result.rows[0] as unknown as MemoryRow);
    }

    if (expectedStatus === undefined) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    // 0行だった理由を切り分けるための読み直し（上記 doc コメント参照）。
    const current = await this.db.execute(sql`
      SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    if (current.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
    throw new MemoryStatusConflictError(id, expectedStatus, observedStatus);
  }

  /**
   * ADR 0031: `updateStatus` の UPDATE と `EventStore.append`（`packages/postgres/src/
   * event-store.ts`）の INSERT を**同一トランザクション**で行う。この2つが別コミット
   * だったこと自体が直された不具合——前者だけ成功し後者が失敗すると、行は永久に
   * 新しい status のまま、対応するイベントは永久に存在しないという永続化された
   * 不整合が残っていた（PR「supersede-status-and-event-in-one-transaction」）。
   *
   * `db.transaction()` のコールバック内で throw すると自動的にロールバックされる
   * （`createObservationWithOutbox`/`createMemoryWithOutbox` と同じ形——ADR 0012
   * D-ingest-1）。CAS に弾かれた場合・対象が存在しない場合は、UPDATE が0行のまま
   * この関数を抜けて例外を投げるだけなので、`memory_events` への INSERT は実行されない
   * ——ロールバックを待つまでもなく、そもそも書き込みコマンド自体を発行しない。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力は
    // トランザクションを開く前に同じ「memory not found」の Error へ寄せる——
    // トランザクション内で投げても結果（イベントが積まれない）は同じだが、そもそも
    // 開かないほうが意図が明確（mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const expectedStatus = opts.expectedStatus;
    const statusCondition =
      expectedStatus !== undefined ? sql`AND status = ${expectedStatus}` : sql``;

    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE memories
        SET status = ${status},
            superseded_by_id = COALESCE(${opts.supersededById ?? null}, superseded_by_id),
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id} ${statusCondition}
        RETURNING *
      `);

      if (result.rows.length === 0) {
        if (expectedStatus === undefined) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
        // 0行だった理由を切り分けるための読み直し（`updateStatus` の doc コメント参照）。
        const current = await tx.execute(sql`
          SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
        `);
        if (current.rows.length === 0) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
        const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
        throw new MemoryStatusConflictError(id, expectedStatus, observedStatus);
      }

      const memory = rowToMemory(result.rows[0] as unknown as MemoryRow);

      const eventResult = await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${event.memoryId},
          ${event.kind},
          ${event.at ?? new Date()},
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null},
          ${event.sizeBeforeBytes ?? null},
          ${JSON.stringify(event.meta)}::jsonb
        )
        RETURNING *
      `);
      const storedEvent = rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);

      return { memory, event: storedEvent };
    });
  }

  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる（mapping.ts の
    // isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    // 🔴 `ready` を `failed` へ巻き戻さない（ADR 0053）。`ready` は VectorStore.upsert が
    // 返った*後*にしか書かれない＝「ベクトル行が在る」の主張であり、リースを失った古い
    // ワーカーの catch から来る `failed`（ADR 0032 の at-least-once）に負けてはならない。
    //
    // 書こうとしている値（引数 `status`）は*読んだ状態*ではないので JS 側で見てよい。
    // WHERE に入れなければならないのは *読んだ状態* のほう（現在の embedding_status）だけ
    // ——アプリ側で現在値を読んで比べてから書くと、読みと書きの間に入った別の書き込みを
    // 上書きしうる（ADR 0048 の reinforce と同じ形。updateStatus の compare-and-swap
    // （ADR 0030）と同じ条件片の組み立て方をここでも使う）。
    //
    // ⚠ **共有述語 `isEmbeddingStatusRollback` はここでは呼べない。**比較そのものを DB の
    // 1文へ入れる必要があるため、値（`from`/`to`）だけを EMBEDDING_STATUS_ROLLBACK から
    // 取り、比較の形は SQL 側にもう一度書かれる（ADR 0053「引き受けた負債」）。
    const rollbackGuard =
      status === EMBEDDING_STATUS_ROLLBACK.to
        ? sql` AND embedding_status <> ${EMBEDDING_STATUS_ROLLBACK.from}`
        : sql``;

    // ⚠ **更新できなかったときに返す行も、同じ1文の中で読む。**1文なら、更新できた場合も
    // できなかった場合も同じスナップショットを通る（`reinforce`（ADR 0048）と同じ形）。
    //
    // 🔴 **⚠ ただしこの選択は歯で守られていない——負債である。「歯で捕まる」と読まないこと。**
    // **実測: この1文を「`UPDATE ... RETURNING *` → 0 行なら別の `SELECT`」の2文へ割る
    // 変異を撃つと、`test:db` 182 件は1件も赤くならなかった**（ADR 0053 の変異 Mu5a が生存）。
    // ⟹ **後から「2文のほうが読みやすい」で戻されても、門は気付かない。**
    //
    // ⚠ `reinforce` から借りた理由づけ（「上で読んだ古い値をそのまま返す」実装との差が
    // 外から観測できなくなる）は、**そのままでは当たらない**——`reinforce` は本体の手前で
    // `SELECT` を打つが、**`setEmbeddingStatus` には手前の `SELECT` が無い**（存在検査は
    // `isUuidLike` だけ）ので、その取り違えは今日のコードからは書けない。
    //
    // **⚠ 歯が抜けているのは、置かないと決めたからではない。塞いでよい。**
    // ただし実測した限りでは今の口では置けない: 1文と2文の差は**並行時にだけ**出る
    // （2文のあいだに他の接続のコミットが landing すると、2文の側は新しいスナップショットの
    // 行を返す——実測した）が、**ガードで弾かれる `UPDATE` は行ロックを取らない**
    // （これも実測した。他の接続が未コミットで同じ行のロックを保持していても 0 行で即座に
    // 返る）ので、外からこの実装をその窓で止める手段が無く、窓は sub-millisecond である。
    // ⟹ **塞ぐには、この実装の中に待ちを差し込める口が要る。**ADR 0053「引き受けた負債」。
    const result = await this.db.execute(sql`
      WITH updated AS (
        UPDATE memories
        SET embedding_status = ${status}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}${rollbackGuard}
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
        AND NOT EXISTS (SELECT 1 FROM updated)
    `);
    if (result.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory> {
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる（mapping.ts の
    // isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const current = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    if (current.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const memory = rowToMemory(current.rows[0] as unknown as MemoryRow);
    const decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: at,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });

    // 🔴 減衰の起点を巻き戻さない（ADR 0048）。**この条件は WHERE 句に置く**——
    // 上の SELECT で読んだ値をアプリ側で比べて書くかどうか決めると、読みと書きの間に
    // 入った別の強化を上書きしうる（同じ形を `updateStatus` は ADR 0030 の
    // compare-and-swap で塞いでいる）。ここは比較そのものを DB の1文へ入れる。
    //
    // ⚠ 古い `at` は**失敗にしない。**呼び出し側から見れば「すでにもっと新しい強化が
    // 入っている」だけであり、例外にすると `runtime.observe` の使用報告ループが
    // 途中で止まる（`updateStatus` の CAS とはここが違う——あちらは status の
    // 取り違えなので呼び出し側の次の一手が変わる）。
    //
    // ⚠ **更新できなかったときに返す行も、同じ1文の中で読む。**別の `SELECT` に分けると、
    // 「上で読んだ古い値をそのまま返す」実装との差が**外から観測できない枝**になる
    // （実際に変異を撃って確かめた。PR 本文参照）。1文なら、更新できた場合も
    // できなかった場合も同じ経路を通るので、その取り違えは歯で捕まる。
    const result = await this.db.execute(sql`
      WITH updated AS (
        UPDATE memories
        SET last_reinforced_at = ${at}, decay_floor_at = ${decayFloorAt}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          AND (last_reinforced_at IS NULL OR last_reinforced_at < ${at})
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
        AND NOT EXISTS (SELECT 1 FROM updated)
    `);
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  async recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    const result = await this.db.execute(sql`
      INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at)
      SELECT ${ctx.tenantId}, ${recallId}, m, now()
      FROM unnest(${sql.param(memoryIds)}::uuid[]) AS m
      ON CONFLICT (tenant_id, recall_id, memory_id) DO NOTHING
      RETURNING memory_id
    `);
    return {
      insertedMemoryIds: result.rows.map(
        (row) => (row as unknown as { memory_id: string }).memory_id,
      ),
    };
  }

  /**
   * roadmap.md 段階4/5・docs/recall.md §5「スコープの外延」（マネージャー決定、
   * packages/core の recall.ts の `ScopeAggregate` doc コメント参照）。
   *
   * **単一の集約クエリ**で、群カウント（第3階）・スコープ内総数・スコープを定義する
   * フィルタ（status/period）で落ちた件数・not_indexed 件数のすべてを返す。
   * ADR 0011 が段1から締め出した `count(*) OVER ()` と同じ理由——**別々のクエリから
   * 出すと、その間の書き込みで総和が一致しなくなる**——を、段5でも同じ形で守る。
   *
   * `status` の4分岐（scope 内 / archived / superseded / forgotten）と period の内外は、
   * すべて `FILTER (WHERE ...)` による条件付き集約として同じ `GROUP BY subject_id` の
   * 1回のスキャンで計算する。**superseded と forgotten は別々の列として数える**
   * （ADR 0027）——前者は機構の都合（より良い抽出に置き換えられた）、後者は製品の振る舞い
   * （利用者が意図して忘れさせた）であり、束ねると呼び出し側がどちらだったか判定できない。
   */
  async aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate> {
    const subjectFilter =
      scope.subjectId !== undefined ? sql`AND subject_id = ${scope.subjectId}` : sql``;
    const occurredAfter = scope.occurredAfter ?? null;
    const occurredBefore = scope.occurredBefore ?? null;

    // period 条件: 未指定側は常に真になる（フィルタなしを表す）。
    // occurred_at が NULL の Memory は recorded_at を代替の実効時刻として扱う
    // （docs/recall.md §7 の freshness 計算が occurred_at ?? recorded_at を使うのと同じ規約）。
    const inPeriod = sql`(
      ${occurredAfter}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) >= ${occurredAfter}::timestamptz
    ) AND (
      ${occurredBefore}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) <= ${occurredBefore}::timestamptz
    )`;

    const result = await this.db.execute(sql`
      SELECT
        subject_id AS key,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod}
        )::int AS in_scope,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND embedding_status = 'pending'
        )::int AS not_indexed_pending,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND embedding_status = 'failed'
        )::int AS not_indexed_failed,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND embedding_status = 'skipped'
        )::int AS not_indexed_skipped,
        count(*) FILTER (WHERE status = 'archived')::int AS archived,
        count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
        count(*) FILTER (WHERE status = 'forgotten')::int AS forgotten,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND NOT (${inPeriod})
        )::int AS period_filtered
      FROM memories
      WHERE tenant_id = ${ctx.tenantId} ${subjectFilter}
      GROUP BY subject_id
    `);

    const rows = result.rows.map(
      (row) =>
        row as unknown as {
          key: string | null;
          in_scope: number;
          not_indexed_pending: number;
          not_indexed_failed: number;
          not_indexed_skipped: number;
          archived: number;
          superseded: number;
          forgotten: number;
          period_filtered: number;
        },
    );

    const groups = rows
      .filter((row) => row.in_scope > 0)
      .map((row) => ({
        axis: "subject" as const,
        key: row.key,
        count: row.in_scope,
        countKind: "exact" as const,
      }));

    const sum = (
      field:
        | "in_scope"
        | "not_indexed_pending"
        | "not_indexed_failed"
        | "not_indexed_skipped"
        | "archived"
        | "superseded"
        | "forgotten"
        | "period_filtered",
    ) => rows.reduce((total, row) => total + row[field], 0);

    return {
      groups,
      totalInScope: sum("in_scope"),
      countKind: "exact",
      notIndexed: {
        pending: { count: sum("not_indexed_pending"), countKind: "exact" },
        failed: { count: sum("not_indexed_failed"), countKind: "exact" },
        skipped: { count: sum("not_indexed_skipped"), countKind: "exact" },
      },
      filteredArchived: { count: sum("archived"), countKind: "exact" },
      filteredSuperseded: { count: sum("superseded"), countKind: "exact" },
      filteredForgotten: { count: sum("forgotten"), countKind: "exact" },
      filteredPeriod: { count: sum("period_filtered"), countKind: "exact" },
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    const result = await this.db.execute(sql`
      INSERT INTO recalls (
        id, tenant_id, subject_id, query, budget, omitted, usage, index_band, explain,
        returned_memory_ids, created_at
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}, ${record.subjectId ?? null},
        ${JSON.stringify(record.query)}::jsonb,
        ${record.budget !== undefined && record.budget !== null ? JSON.stringify(record.budget) : null}::jsonb,
        ${JSON.stringify(record.omitted)}::jsonb,
        ${JSON.stringify(record.usage)}::jsonb,
        ${JSON.stringify(record.indexBand)}::jsonb,
        ${JSON.stringify(record.explain)}::jsonb,
        ${sql.param(record.returnedMemoryIds)}::uuid[],
        now()
      )
      RETURNING id
    `);
    return (result.rows[0] as unknown as { id: string }).id;
  }
}
