/**
 * 冪等な作成の結果——「この呼び出し自身が行を作ったか」。
 *
 * `MemoryStore.createObservationWithOutbox` / `createMemoryWithOutbox` が返す
 * `created` の意味は interface（`interfaces/memory-store.ts`）が定めている:
 * **冪等キーに衝突して既存の行を返したときは `false`**、自分が新しい行を挿入したときだけ
 * `true`。呼び出し側（`runtime.ts` の `handleExtractableObservation` /
 * `createMemoriesFromCandidates`）はこの値だけを見て、outbox ジョブを積むか・
 * 抽出をやり直すか・`created` イベントを積むかを決める。
 */
export interface IdempotentCreateResult<T> {
  readonly value: T;
  /** この呼び出しが新しい行を挿入したなら `true`。既存の行を返したなら `false`。 */
  readonly created: boolean;
}

/**
 * ADR 0054: 擬似実装（`InMemoryMemoryStore` / `FakeMemoryStore`）が `created` を導くための
 * **唯一の形**。
 *
 * 🔴 守る不変条件: **`created` は、挿入するかどうかを決めたその判定そのものから出る。**
 * 「既存が見つかったか」と「`created` に何を入れるか」を別々の式にしない——別々にすると、
 * その2つの式の間に他の書き込みが割り込む余地が生まれる。
 *
 * 実 adapter（`PostgresMemoryStore`）はこの関数を使わない。あちらは
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING *` の**自分の文の戻り行数**から `created` を
 * 得ており、判定と挿入がそもそも1文である（`packages/postgres/src/memory-store.ts`）。
 * 擬似実装は `Map` の上に手で組むため、同じ性質を構造として持たせるのがこの関数の役目である。
 *
 * ⚠ **`insert` は同期でなければならない。**`await` を挟むと、判定と挿入の間に
 * 他のタスクの同期区間が入りうる（JS は `await` 境界でのみ制御を渡す）。戻り値を
 * `Promise` にしていないのは、その窓を型で塞ぐためである。
 *
 * @param existing 冪等キーで引いた既存の行。無ければ `null`/`undefined`。
 * @param insert   既存が無いときだけ呼ばれる、新しい行を挿入して返す**同期**関数。
 */
export function resolveIdempotentCreate<T>(
  existing: T | null | undefined,
  insert: () => T,
): IdempotentCreateResult<T> {
  if (existing !== null && existing !== undefined) {
    return { value: existing, created: false };
  }
  return { value: insert(), created: true };
}
