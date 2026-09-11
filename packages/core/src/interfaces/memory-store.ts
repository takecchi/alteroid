import type { Ctx } from "../ctx.js";
import type { MemoryEvent, NewMemoryEvent } from "../event.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { NewRecallRecord, NotIndexedReason, RecallScope, ScopeAggregate } from "../recall.js";
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
 * 帯候補を、群カウント等と**同一の集約クエリから**取得したい場合に渡す
 * （[ADR 0073](../../../../docs/decisions/0073-digest-band-bounded-without-taxonomy.md)、
 * docs/recall.md §5）。
 *
 * **任意引数にしてある理由は2つある。**
 *
 * 1. **渡さないことが「帯を組まない」という意味を持つ。**省略時は `digests: []`・
 *    `digestEligible: { count: 0, countKind: 'exact' }` を返す契約であり、実装は帯のための
 *    追加の仕事をしない（`packages/postgres` は CTE に帯用の列を足さない）。つまり任意性は
 *    移行の都合ではなく、**呼び出し側が費用を選ぶための軸**である。
 * 2. **`MemoryStore` は公開 API である**（`@mnemora/core` の `index.ts` から export され、
 *    README は adapter の自作を前提に `@mnemora/testkit` の導入を案内している）。第3引数を
 *    必須にすると、**この repo の外の呼び出し元**が `aggregateScope(ctx, scope)` と2引数で
 *    呼べなくなり、`TS2554: Expected 3 arguments, but got 2` で全部コンパイルエラーになる。
 *    ⚠ **壊れるのは呼び出し元であって、実装側ではない**——TypeScript は引数の少ない実装を
 *    引数の多い署名へ代入できるため、必須にしても `aggregateScope(ctx, scope)` としか
 *    書いていない外部実装は `implements` を通り続ける（tsc 5.9.3 / strict で実測した）。
 *
 * ⚠ **かつてここには「既存の3実装が第3引数を無視してもコンパイルが通る形にし、`digestBand`
 * 対応を段階的に入れられるようにするため（`packages/postgres`/`packages/testkit` 側の実装は
 * 次段で別の作業者が行う）」と書いてあったが、これは偽である。**同じ PR (#95) が
 * `packages/postgres` と `packages/testkit` の両方を同じ diff で実装しており、
 * 「段階導入の途中」という状態は存在しない。さらに上の 2 のとおり、段階導入を可能にするのは
 * 任意引数ではない（実装側は必須引数でも壊れない）。
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
  /**
   * ADR 0079: 索引に載っていない Memory を**列挙して、同時に `embed` ジョブを積み直す**。
   *
   * `recall` は `not_indexed` として「索引されていない N 件」を既に正しく名乗っている
   * （`packages/core/src/recall-runtime.ts` の `NOT_INDEXED_REASONS` ループ）。
   * docs/recall.md §4 はその `reason` ごとに利用側の次の一手まで案内している——
   * **`pending` は待つ・再試行する、`failed` は埋め込みパイプラインそのものを疑う。**
   * **このメソッドが足すのは、その「次の一手」を実際に打つ口である。**
   *
   * 契約:
   * - 対象は `status IN ('active','contested')` かつ `embeddingStatus` が
   *   `opts.statuses` のいずれかである Memory に限る。**`aggregateScope` が
   *   `notIndexed` に数える集合と同じ条件**であり、`recall` が「N 件ある」と言った
   *   ものをそのままこの口へ渡せる。
   * - `opts.memoryIds` を渡すと、その id の集合との積を取る（`opts.statuses` の条件は
   *   外れない——`ready` の行を `memoryIds` で名指ししても対象にならない）。
   * - 選ばれた行は `embeddingStatus` を `'pending'` へ戻し、**同一トランザクションで**
   *   `kind: 'embed'`・`payload: { memoryId }` の outbox 行を1件ずつ新規に積む。
   *   **片方だけ起きることはない。**
   * - 返すのは実際に積み直した件数と、その `memoryId`（`opts.limit` で切られた後の集合）。
   * - 対象が0件なら `{ requeued: 0, memoryIds: [] }` を返す（例外を投げない）。
   * - **べき等ではない。**同じ Memory に対して2回呼べば outbox 行は2件積まれる。
   *   処理そのものは at-least-once を前提に書かれている（ADR 0032）ので実害は無いが、
   *   「呼んだ回数だけ積む」ことは契約である。
   *
   * 🔴 **既に `failed_at` が付いた古い outbox 行は触らない。**`fail` は終端のままであり、
   * ADR 0032 の決定（Phase 1 では失敗したジョブの自動リトライを行わない）を覆さない。
   * 積み直しは**新しい行**であり、古い行は失敗の履歴として残る。これにより新しい行の
   * `attempts` は 0 から数え直される。
   *
   * ⚠ **`ready` は `opts.statuses` に指定できない**（型が `NotIndexedReason` であり
   * `ready` を含まない）。`ready` は「ベクトル行が在る」という主張であり（ADR 0053）、
   * それを `pending` へ戻すと `recall` が索引済みの Memory を `notIndexed.pending` に
   * 数え始める。埋め込みモデルを替えたときの再埋め込みは `VectorStore` の space が
   * 変わる別の問題であり、この口の主題ではない。
   *
   * 対象が `opts.limit` より多いときにどれが選ばれるかは
   * **`updatedAt` の古い順、同着は `id` の昇順**とする。積み直した行は `updatedAt` が
   * 動くので、繰り返し呼ぶと対象が一巡する（同じ行だけを取り続けて他が飢えることがない）。
   */
  requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult>;
  /**
   * Issue #134 / [ADR 0100](../../../../docs/decisions/0100-supersede-with-new-memories.md):
   * docs/memory-model.md §11 行5 が要求する「旧行の `status`/`superseded_by_id` 更新と
   * **新 Memory の作成**は1トランザクションで完結させる」の、後半（新 Memory の作成側）を
   * 満たすための口。`updateStatusWithEvent`（ADR 0031）は既存 Memory の status 更新と
   * イベント追記の対だけを扱い、新しい Memory の作成は範囲外だった——このメソッドは
   * その2つを1回の呼び出し・1トランザクションにまとめる。
   *
   * 🔴 **任意メソッドである。**必須にすると `MemoryStore` を実装する第三者の adapter を
   * 壊す破壊的変更になる（`@mnemora/core` は npm に 0.1.4 で公開済み、
   * `docs/autonomy.md:114`）。この口を実装しない adapter は今日どおり
   * `updateStatusWithEvent` + 別呼び出しの `createMemoryWithOutbox` の2段のままでよい。
   *
   * `news` が配列である理由: `runtime.consolidate`（N→1）は1件で足りるが、
   * `runtime.reextract` は候補ごとに `createMemoryWithOutbox` をループで呼び M件作る
   * （`runtime.ts` の `createMemoriesFromCandidates`）。1件しか受け取らない形にすると
   * `reextract` をこの口へ寄せられない。
   *
   * 意味論:
   * - `news` の各要素は {@link MemoryStore.createMemoryWithOutbox} と**同じ冪等経路**
   *   （ON CONFLICT。既存行と衝突したら `created: false` を返し、ジョブは一切積まない）。
   * - `supersede` の各要素は {@link MemoryStore.updateStatusWithEvent} と**同じ CAS 意味論**
   *   （`status` は常に `"superseded"` に固定——このメソッドは supersede 専用であり、
   *   任意の status への更新は今日どおり `updateStatus`/`updateStatusWithEvent` を使うこと）。
   * - 🔴 **CAS に弾かれた対象は例外にしない。** `conflicted` に `{ id, observedStatus }` として
   *   積み、**トランザクションはそのまま commit する**（条件付き UPDATE の0行はエラーでは
   *   ない）。ADR 0031「採らなかった案」（supersede ループ全体を1トランザクションにする案の
   *   却下）を本メソッドは覆さない——「1件の競合」を「全部やらなかった」に化けさせない。
   * - 🔴 **`supersede[].id` の行がそもそも存在しない場合は、`updateStatusWithEvent` と同じ
   *   「memory not found」の `Error` を投げる。**このときトランザクション全体がロール
   *   バックされ、**`news` の作成も巻き戻る**——⛔ **`conflicted` には混ぜない**
   *   （「CAS で弾かれた」と「行が無い」は別の「無い」であり、潰すとこの設計の要が壊れる）。
   * - 🔴 **`supersededByIndex` は `news` への索引である**（`MemoryId` ではない）。この口は
   *   「今まさに作る Memory へ寄せる」ためのものであり、その id は store が採番するまで
   *   存在しない——呼び出し側は渡すべき id を渡す前に知りえない（`NewMemory` は
   *   `Omit<Memory, "id" | ...>` で `id` を持たない）。ADR 0100「採らなかった案」参照。
   *   索引にしたことで `supersededById` の外部キー違反は**構造的に起こりえなくなった**
   *   （指す先は必ずこの呼び出しが作った/見つけた行である）——ADR 0047 の「存在」検査は
   *   下の範囲検査がその役目を引き継ぐ。
   * - 🔴 **`event.meta.supersededById` は、実装が解決したアンカーの id で埋める**（呼び出し
   *   側が渡した値があれば上書きする）。呼び出し側は索引しか持たないため、この欄を自分で
   *   埋められない——実装が埋めることで、**監査ログの中身がこの口を実装した adapter と
   *   実装していない adapter で同一になる。**⛔ 同じ論理操作が adapter ごとに別の監査記録を
   *   残す形にはしない。`event` の他の欄は一切変えない。
   * - ⚠ **`supersededByIndex` が指すのは `news[i]` に対応する Memory であって、それが
   *   今回作られたか既に在ったかは問わない**（冪等経路で既存行と衝突した場合も同じ行を
   *   指す。`created[i].created` がどちらかを名乗る）。
   * - 🔴 **`created` は `news` と同じ順序・同じ長さで返す。**`supersededByIndex` が正しい行を
   *   指せるのはこの対応が保たれているときだけであり、⚠ **並びがずれても型は何も言わない**
   *   ——`superseded_by_id` に別の記憶の id が書かれ、検査は緑のまま通る。適合テストが
   *   3件以上の `news` でこの対応を固定している（1件や2件では並びの入れ替えを検出できない）。
   * - 🔴 **範囲外の `supersededByIndex` は専用の失敗として落とす**（`RangeError`。
   *   メッセージは `supersededByIndex out of range`）。⛔ **黙って無視しない。⛔ `conflicted`
   *   にも「memory not found」にも混ぜない**——「呼び手が壊れた索引を渡した」「CAS で
   *   弾かれた」「対象の行が無い」は3つとも別の失敗であり、潰すとこの設計の要が壊れる。
   *   このときも何も書かれない（`news` の作成も巻き戻る）。
   *
   * ⚠ **これは振る舞いの変更である。** 今日（`updateStatusWithEvent` を単独で呼ぶ経路）は
   * 対象が存在しない場合、直前に別途呼んでいた `createMemoryWithOutbox` の作成はすでに
   * commit 済みで残る。このメソッドを経由すると、その作成も巻き戻る——ADR 0100
   * 「引き受ける負債」参照。
   *
   * 🔴 **原子性の証拠ではない。**この口が在ること自体は「adapter がこの口を実装したと
   * 宣言した」ことしか意味しない——`packages/testkit` の `InMemoryMemoryStore` のように、
   * 実装していても「トランザクションは一切模していない」adapter がありうる
   * （`InMemoryMemoryStore` クラス doc 参照）。実際に原子性を測るのは適合テストと
   * `packages/postgres` の並行の歯であって、この口の有無そのものではない。
   */
  supersedeWithNewMemories?(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededByIndex: number;
      expectedStatus?: MemoryStatus;
      event: NewMemoryEvent;
    }>,
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }>;
}

/**
 * {@link MemoryStore.requeueEmbedJobs} の引数（ADR 0079）。
 *
 * **`statuses` にも `limit` にも既定値を置かない。**`ClaimOutboxJobsOptions.leaseMs`
 * （ADR 0032）と同じ理由である——「どの `not_indexed` を積み直すか」「一度にいくつ
 * 積み直すか」は運用方針であり、`packages/core` が発明してよい値ではない。この口は
 * 1回の呼び出しで `memories` と `outbox` の両方へ書くので、既定値を置くとその影響範囲を
 * core が黙って決めることになる。
 */
export interface RequeueEmbedJobsOptions {
  /**
   * 対象にする現在の `embeddingStatus`。
   *
   * **型が `NotIndexedReason` なのは意図である**——`recall` が
   * `{ kind: 'not_indexed', reason }` として名乗った値を、そのままここへ渡せる。
   * 「見えているもの」と「積み直せるもの」を同じ語彙に固定する。
   *
   * ⚠ **`'pending'` も指定できる。**「待てば解ける」はずの `pending` に、
   * **待っても解けない行が混ざりうる**ためである: `runtime.tick` の `processEmbedJob` は
   * `memoryStore.get` を `try` の外で呼んでおり、また `catch` の中の
   * `setEmbeddingStatus(..., 'failed')` 自体も例外を投げうる。どちらを通っても
   * outbox 行だけが終端（`failed_at`）になり、Memory は `pending` のまま残る——
   * その行は `recall` が `notIndexed.pending`（＝「待て」）として数え続ける。
   * **⚠ これは構造から読める「起こりうる」であって、発生を観測したものではない**
   * （ADR 0079「確かめていないこと」）。
   */
  statuses: NotIndexedReason[];
  /** 対象をこの id の集合との積に絞る（任意）。省略時は `statuses` の条件だけで選ぶ。 */
  memoryIds?: MemoryId[];
  /** 1回の呼び出しで積み直す上限。**既定値なし**（上の doc コメント参照）。 */
  limit: number;
}

/** {@link MemoryStore.requeueEmbedJobs} の返り値（ADR 0079）。 */
export interface RequeueEmbedJobsResult {
  /** 実際に積み直した件数。`memoryIds.length` と必ず一致する。 */
  requeued: number;
  /** 積み直した Memory の id。`opts.limit` で切られた後の集合。 */
  memoryIds: MemoryId[];
}
