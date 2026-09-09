import type { Ctx } from "../ctx.js";
import type { MemoryEvent, NewMemoryEvent } from "../event.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { NewRecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { OutboxJobKind } from "./scheduler.js";

/**
 * `updateStatus` に `opts.expectedStatus` を渡したとき、書き込み時点の実際の status が
 * それと一致しなかったことを表す（PR「update-status-compare-and-swap」、ADR 0030）。
 * `packages/postgres/src/advisory-lock.ts` の型付きエラー階層（`AdvisoryLockTimeoutError` /
 * `AdvisoryLockUnavailableError`）に倣い、`Error` を継承した専用の型として定義する
 * ——呼び出し側が `instanceof` で「対象が無かった」と区別できることが目的。
 *
 * **`observedStatus` は「弾かれた後に読み直した値」であり、弾かれた瞬間の値とは限らない。**
 * adapter（`packages/postgres`）は `UPDATE ... WHERE status = expectedStatus` が0行だった
 * ときに追加の `SELECT` で読み直して詰めるため、その `SELECT` と実際に条件が破れた瞬間の
 * 間にも別の書き込みが割り込む余地がある。「衝突があったこと」は確実だが、「衝突した
 * 相手が何だったか」の正確な値としては読まないこと。
 */
export class MemoryStatusConflictError extends Error {
  constructor(
    readonly memoryId: MemoryId,
    readonly expectedStatus: MemoryStatus,
    readonly observedStatus: MemoryStatus | null,
  ) {
    super(
      `MemoryStore.updateStatus: expected status "${expectedStatus}" for memory ${memoryId}, ` +
        `but observed ${observedStatus === null ? "(memory disappeared)" : `"${observedStatus}"`}`,
    );
    this.name = "MemoryStatusConflictError";
  }
}

/**
 * `setEmbeddingStatus` が**唯一禁じる遷移**
 * （`docs/decisions/0053-set-embedding-status-does-not-roll-back-ready.md`）。
 * `ready` は `VectorStore.upsert` が返った*後*にしか書かれない——すなわち
 * 「ベクトル行が在る」という主張である。それを `failed` で上書きすると、ベクトル行が
 * 在るのに `memories.embedding_status = 'failed'` になり、`recall` がその Memory を
 * `notIndexed.failed` に計上して利用者に「埋め込みを疑え」と出す。
 *
 * ⚠ **禁じるのはこの1本だけである。**遷移表を全面的に固定したわけではない
 * （`skipped` を含む他の遷移の意味を今日決める根拠が無い。ADR 0053「採らなかった案」参照）。
 */
export const EMBEDDING_STATUS_ROLLBACK = { from: "ready", to: "failed" } as const satisfies {
  from: EmbeddingStatus;
  to: EmbeddingStatus;
};

/**
 * 現在の状態 `current` に `next` を書くことが {@link EMBEDDING_STATUS_ROLLBACK} の
 * 巻き戻しに当たるかを判定する。`packages/testkit` の in-memory 実装と `packages/core` の
 * Fake がこの関数を呼ぶことで、**禁じる遷移を1箇所に固定する**——実装ごとに条件式を
 * 書き直すと、どの遷移を禁じるかが実装間でずれる余地を作る
 * （`assertValidEventRetentionDays`（`./tenant-settings-store.js`）と同じ形）。
 *
 * ⚠ **`PostgresMemoryStore` はこの関数を呼べない。**比較を SQL の1文の `WHERE` の中に
 * 置かないと、読みと書きの間が空く（ADR 0048 と同じ理由）。**そのため `from`/`to` の値だけを
 * {@link EMBEDDING_STATUS_ROLLBACK} から取り、比較の形だけが SQL 側にもう一度書かれる。**
 * この二重化は、適合スイート（`packages/testkit/src/memory-store-conformance.ts`）の歯が
 * 両実装に走ることで押さえる。
 */
export function isEmbeddingStatusRollback(
  current: EmbeddingStatus,
  next: EmbeddingStatus,
): boolean {
  return current === EMBEDDING_STATUS_ROLLBACK.from && next === EMBEDDING_STATUS_ROLLBACK.to;
}

/**
 * `aggregateScope` の第3引数（任意）。目次帯（`IndexBand.digestBand`）を組むための
 * 帯候補を、群カウント等と**同一の集約クエリから**取得したい場合に渡す（本 PR、
 * docs/recall.md §5）。
 *
 * **任意引数にしてある**——既存の3実装（`packages/postgres`・`packages/testkit` の
 * in-memory 実装・本 PR より前の呼び出し元）が第3引数を無視してもコンパイルが通る形にし、
 * `digestBand` 対応を段階的に入れられるようにするため（`packages/postgres`/`packages/testkit`
 * 側の実装は次段で別の作業者が行う）。
 */
export interface AggregateScopeOptions {
  digestBand?: {
    /** 取得する上限件数。 */
    limit: number;
    /** 帯から除外する memoryId（`memories` として返したもの）。 */
    excludeMemoryIds: readonly MemoryId[];
  };
}

/**
 * MemoryStore — Phase 1（docs/architecture.md §5.1）。
 *
 * 実装は adapter 側（`packages/postgres` 等）に置く。ここは型のみ。
 *
 * 契約（振る舞い。型からは読み取れないため、`packages/testkit` の適合テストで検査する）:
 * - `createMemory` は `(tenant_id, source_observation_id, extractor_version, content_hash)` の
 *   一意制約により冪等（docs/architecture.md §3.5）。
 * - `reinforce` は挿入が実際に起きたときだけ `last_reinforced_at` を更新し、
 *   `decay_floor_at` を再計算する。**`strength` は動かさない**
 *   （[ADR 0041](../../../../docs/decisions/0041-reinforce-does-not-change-strength.md)。
 *   以前この行は `strength` も更新すると名乗っていたが、3つの実装のどれも更新しておらず、
 *   **増分の式はどこにも決まっていない**）。
 * - `status = 'contested'` の Memory を単独で返してはならない。対向する Memory を
 *   スコアに関係なく必ず一緒に取得できなければならない（mandatory companion retrieval）。
 * - `aggregateScope` の返り値は近似を許すが、`countKind` を必ず伴う（Phase 1 は常に厳密。
 *   PR 本文の「設計上の疑義」参照）。`groups` の総和は必ず `totalInScope` と一致する。
 * - テナント分離: すべてのメソッドは `ctx.tenantId` に一致しない行を返してはならない。
 *   `testkit` は2テナントを同時に投入し、クロステナントの取得が0件になることを検査する。
 *
 * D9（マネージャー決定）で以下2メソッドを追加した。理由は docs/architecture.md §5.1 に
 * 追記済み:
 * - `getMany` — recall 段3の mandatory companion retrieval が `get` の連続呼び出し
 *   （N+1）にならないようにするため。
 * - `recordUsage` — 「実際に挿入が起きたときだけ強化する」という契約
 *   （docs/memory-model.md §6）を呼び出し側が知るための戻り値
 *   （`insertedMemoryIds`）を持つ。`reinforce` 単体では「実際に挿入されたか」を
 *   呼び出し側は知れない。
 *
 * roadmap.md 段階3（取り込み）で以下4メソッドを追加した:
 * - `getObservation` — `runtime.tick`（`extract: 'deferred'` の消化・ADR 0005）が
 *   outbox ジョブの payload から `observationId` だけを受け取り、本文を取り直すために使う。
 * - `createObservationWithOutbox` / `createMemoryWithOutbox` — transactional outbox
 *   （docs/architecture.md §3.4）を実現するための書き込み口。`observe()` の DB コミットと
 *   「抽出/埋め込みジョブを outbox に積む」を同一トランザクションで行うには、
 *   Observation/Memory の作成そのものにジョブ書き込みを同居させる必要がある
 *   （PR 本文の「決めたこと」参照）。**新規に行を作成できたとき（`created: true`）だけ
 *   ジョブを積む**——冪等な再送（`created: false`）でジョブを重複させない。
 * - `setEmbeddingStatus` — `embeddingStatus` の `pending → ready | failed` 遷移
 *   （roadmap.md 段階3の完了条件）を書き込む。**ただし `ready → failed` の巻き戻しだけは
 *   起きない**（現在が `ready` のとき `failed` を書く呼び出しは no-op。例外にはしない。
 *   ADR 0053。下記 `setEmbeddingStatus` の doc 参照）。
 *
 * ADR 0028（`runtime.reextract`）で以下1メソッドを追加した:
 * - `listBySourceObservation` — ある Observation から、ある版の抽出器で作られた Memory を
 *   列挙する（**SELECT のみ**）。`reextract` が「今回作られた content_hash の集合に
 *   含まれない既存 Memory」を判定するために使う。マイグレーション・索引の追加は伴わない
 *   ——`(tenant_id, source_observation_id, extractor_version, content_hash)` の一意索引
 *   （0001_init.sql）は既に `source_observation_id` を先頭から使える形をしている。
 *
 * roadmap.md 段階4/5（想起・説明）で以下2メソッドを追加した（本 PR）:
 * - `aggregateScope` — `countByGroup` を置き換える。旧 `countByGroup` は群カウント
 *   （`GroupCount[]`）しか返さず、`totalInScope`・`filtered` 系の件数を別のクエリで
 *   取らざるを得なかった。マネージャー決定（docs/recall.md §5 の「スコープの外延」
 *   補完）により、群カウント・スコープ内総数・スコープを定義するフィルタ（period/status）
 *   で落ちた件数・`not_indexed` 件数を**単一の集約クエリ**から返す必要が生じたため、
 *   戻り値を `ScopeAggregate` に拡張した契約として置き換えた。
 * - `createRecall` — recall 段6（記録）の書き込み口。`recallId` を発行して `recalls`
 *   テーブルへ1行残す（docs/recall.md §2 段6、ADR 0008）。この段は省略可能な段ではない
 *   ——`recallId` が発行されないと `observe({kind:'memory_usage'})` が recall を
 *   参照できなくなる。
 *
 * PR「update-status-compare-and-swap」（ADR 0030）で `updateStatus` に `opts.expectedStatus`
 * を足した: `reextract` の「`status !== 'active'` なら触らない」という安全弁が、読み（
 * `listBySourceObservation`）と書き（`updateStatus`）の間に別の書き込みが割り込む
 * TOCTOU で破れる穴を塞ぐ。省略時の振る舞いは変えていない。
 *
 * ADR 0031 で `updateStatusWithEvent` を追加した: `updateStatus` の呼び出しと
 * `EventStore.append` の呼び出しを別々のコミットとして行うと、前者が成功し後者が失敗した
 * 場合に「行は `superseded` のまま、対応する `superseded` イベントは永久に存在しない」という
 * *永続化された*不整合が残る（docs/memory-model.md §11 行5・docs/architecture.md §3.2 が
 * 要求する「同一トランザクション」に実装が違反していた）。`updateStatusWithEvent` は
 * status の更新とイベントの追記を1回の呼び出し・1トランザクションにまとめる。
 * **`updateStatus` は変更していない**——status だけを更新したい呼び出し元
 * （`archived`/`forgotten` への遷移等、イベントを別の理由で別途書く場合）はそのまま使える。
 */
export interface MemoryStore {
  createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
  /** roadmap.md 段階3: outbox ジョブから observationId を渡された側が本文を取り直すための読み出し。 */
  getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
  /**
   * roadmap.md 段階3: Observation の作成と outbox ジョブ書き込みを同一トランザクションで行う。
   * `jobKinds` の各要素につき1件のジョブを作る。ジョブの `payload` は
   * `{ observationId: <作成された Observation の id> }` に固定される（adapter が作成後の
   * id を使って組み立てる。呼び出し側が id をまだ知らない時点で呼ぶための設計）。
   * 冪等な再送（`externalId` が既存行と衝突）の場合は `created: false` を返し、
   * ジョブは一切作らない（`jobs` は空配列）。
   */
  createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }>;
  createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
  /**
   * roadmap.md 段階3: Memory の作成と outbox ジョブ書き込み（主に `embed`）を
   * 同一トランザクションで行う。`createObservationWithOutbox` と対になる契約。
   * 抽出の冪等性（`(tenant_id, source_observation_id, extractor_version, content_hash)`）で
   * 既存行に衝突した場合は `created: false` を返し、ジョブは作らない
   * （同じ内容に対して埋め込みジョブを重複させない）。
   */
  createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
  /**
   * `id` が adapter の期待する形式でない場合も「存在しない」と同じ `null` を返す
   * （例外を投げない）。core の `MemoryId` は単なる `string` であり形式を強制しないため、
   * ある adapter が主キーに特定の形式（例: UUID）を要求していても、その形式に合わない
   * `id` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   */
  get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
  /**
   * D9: recall 段3の mandatory companion retrieval のための一括取得。**呼び出し全体を
   * 弾かない**——`ids` のうち adapter の期待する形式でないものは、無い id と同じく
   * 静かに結果から落とす（該当する id 以外は通常どおり返す）。全件が形式に合わなければ
   * 空配列を返す。
   */
  getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
  /**
   * ADR 0028: ある Observation から、ある版の抽出器で作られた Memory を列挙する
   * （**SELECT のみ**。マイグレーション・索引を追加しない）。`extractorVersion` は
   * `NULLS NOT DISTINCT`（0001_init.sql）と同じ規約で `null` を1つの値として扱う
   * ——`extractorVersion: null` を渡すと `extractor_version IS NULL` の行を返す。
   * `observationId` が adapter の期待する形式でない場合も「存在しない」と同じ空配列を
   * 返す（例外を投げない）。
   */
  listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]>;
  /**
   * PR「update-status-compare-and-swap」（安全弁3、docs/decisions/0030-*.md）:
   * `opts.expectedStatus` を渡すと、書き込み時点で対象 Memory の `status` が
   * その値と一致するときだけ更新する（compare-and-swap）。**省略時は今日と同じ振る舞い**
   * ——status を条件にせず常に更新する。
   *
   * `expectedStatus` と実際の status が食い違っていた場合は {@link MemoryStatusConflictError}
   * を投げる。対象の Memory がそもそも存在しない場合は（`expectedStatus` の有無に関わらず）
   * 今日と同じ「memory not found」の例外のまま——「対象が無い」と「status が期待と
   * 違った」は別の例外で区別できる。
   *
   * `id` が adapter の期待する形式でない場合も、この「memory not found」の例外と
   * 同じ結果になる。core の `MemoryId` は単なる `string` であり形式を強制しないため、
   * ある adapter が主キーに特定の形式（例: UUID）を要求していても、その形式に合わない
   * `id` は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   *
   * `expectedStatus` を**単数**にしている理由: 現時点の唯一の呼び出し元
   * （`runtime.ts` の `reextract`）が要る条件は `"active"` の1つだけであり、
   * 集合（配列）にする理由が無い。採らなかった案は ADR 0030 参照。
   */
  updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory>;
  /**
   * ADR 0031: `updateStatus` と同じ status 更新を行い、**同一トランザクションで**
   * `event` を `memory_events` へ追記する。命名は `createObservationWithOutbox` /
   * `createMemoryWithOutbox`（ADR 0012 D-ingest-1: 「同一トランザクションで行う必要がある
   * 2つの書き込みを、その組み合わせに特化したメソッドとして `MemoryStore` に持たせる」）に
   * 揃えた。
   *
   * 🔴 守る不変条件: **`memories.status` の更新が永続化されたことと、対応するイベントが
   * 永続化されたことは、同値である。** 一方だけが起きて他方が起きない状態を作らない。
   *
   * 契約（`updateStatus` と共通の部分は同じ意味論）:
   * - `opts.expectedStatus` を渡すと compare-and-swap になる。書き込み時点の実際の status が
   *   一致しなければ {@link MemoryStatusConflictError} を投げ、**status の更新もイベントの
   *   追記も一切起きない**（両方とも起きないか、両方とも起きるかのどちらかであり、
   *   片方だけ起きることはない）。
   * - `opts.expectedStatus` を省略すると、`updateStatus` の省略時と同じく status を条件に
   *   せず常に更新し、イベントを追記する。
   * - 対象の Memory がそもそも存在しない場合は、`expectedStatus` の有無に関わらず今日と
   *   同じ「memory not found」の `Error` を投げる（イベントは積まれない）。
   * - `id` が adapter の期待する形式でない場合も、この「memory not found」の例外と
   *   同じ結果になる（イベントは積まれない）。core の `MemoryId` は単なる `string` で
   *   あり形式を強制しないため、adapter が主キーに要求する形式に合わない `id` は
   *   「存在しない」の一種として扱う（`updateStatus` の doc コメント・
   *   `packages/postgres/src/mapping.ts` の `isUuidLike` の doc コメント参照）。
   *
   * 🔴 **買わない不変条件**（呼び出し側の `reextract` ループが対象1件ごとにこのメソッドを
   * 呼ぶ場合）: 「複数回の呼び出しをまとめて全部成功させるか全部失敗させるか」は買わない。
   * このメソッド自体は単一の Memory 1件・イベント1件の原子性しか保証しない
   * ——複数の Memory にまたがる操作全体の原子性は呼び出し側の責務（ADR 0031「採らなかった案」
   * 参照）。
   *
   * また、docs/memory-model.md §11 行5 が規定する「旧行の status 更新と*新 Memory の作成*も
   * 1トランザクション」は**このメソッドの範囲外**——新しい Memory の作成（`createMemory`/
   * `createMemoryWithOutbox`）は別の呼び出しのままであり、このメソッドは既存 Memory の
   * status 更新とイベント追記の対だけを扱う（ADR 0031「これが覆るとしたら」参照）。
   */
  updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  /**
   * roadmap.md 段階3: `embeddingStatus` の `pending → ready | failed` 遷移を書き込む。
   * 対象の Memory が存在しない場合は「memory not found」の `Error` を投げる。`id` が
   * adapter の期待する形式でない場合も同じ結果になる——core の `MemoryId` は単なる
   * `string` であり形式を強制しないため、adapter が主キーに要求する形式に合わない `id`
   * は「存在しない」の一種として扱う（`packages/postgres/src/mapping.ts` の
   * `isUuidLike` の doc コメント参照）。
   *
   * 🔴 **`ready` を `failed` へ巻き戻さない**
   * （[ADR 0053](../../../../docs/decisions/0053-set-embedding-status-does-not-roll-back-ready.md)。
   * 判定は {@link isEmbeddingStatusRollback}）。現在の `embeddingStatus` が `ready` の
   * ときに `failed` を書く呼び出しは **no-op** である:
   *
   * - **例外を投げない。**唯一の `failed` の呼び出し口は `runtime.tick` の
   *   `catch (err) { await setEmbeddingStatus(..., "failed"); throw err; }` の中であり、
   *   ここで投げると**元の埋め込みエラー `err` が握り潰されて別の例外にすり替わる**
   *   （呼び出し側の次の一手も無い。ADR 0048 の `reinforce` と同じ理由の形）。
   * - **返すのは、更新されなかった現在の行そのもの**である（`embeddingStatus` は
   *   `ready` のまま）。
   * - **`updatedAt` も動かない。**「べき等」を「同じ値になる」ではなく
   *   **「行を触らない」**の意味で固定する。
   *
   * それ以外の遷移は今日どおり無条件である。**`failed → ready` は許す**——片側だけの
   * 規則であり、後から成功した埋め込みは正しく反映される。
   */
  setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
  /**
   * docs/memory-model.md §7、ADR 0010: `last_reinforced_at`/`decay_floor_at` を更新する。
   * 対象の Memory が存在しない場合は「memory not found」の `Error` を投げる。`id` が
   * adapter の期待する形式でない場合も同じ結果になる（`setEmbeddingStatus` の doc
   * コメント・`packages/postgres/src/mapping.ts` の `isUuidLike` の doc コメント参照）。
   */
  reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory>;
  /**
   * D9: 使用報告を記録する。`(recall_id, memory_id)` の挿入が実際に起きたものだけを
   * `insertedMemoryIds` として返す（再送は空配列になりうる）。
   */
  recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  /**
   * roadmap.md 段階4/5: 群カウント・スコープ内総数・スコープを定義するフィルタ
   * （status/period）で落ちた件数・not_indexed 件数を単一の集約クエリから返す
   * （`ScopeAggregate` の doc コメント、docs/recall.md §5 参照）。
   * 契約: 返り値の `groups` の総和は必ず `totalInScope` と一致する
   * （同一クエリから導出するため、並行する書き込みがあっても構造的に崩れない）。
   *
   * `opts.digestBand` を渡すと、`ScopeAggregate.digests`/`digestEligible` も
   * **同じ集約クエリから**埋めて返す（`ScopeAggregate` の doc コメント参照）。
   * 渡さない場合は `digests: []`・`digestEligible: { count: 0, countKind: 'exact' }`。
   */
  aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate>;
  /** roadmap.md 段階4/5: recall 段6（記録）。`recalls` へ1行書き込み、発行した recallId を返す。 */
  createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
}
