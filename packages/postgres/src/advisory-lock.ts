import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * `pg_advisory_lock` を使ったプロセス間排他の共通部品（ADR 0017・ADR 0018）。
 *
 * 元は `migrate.ts` の `runMigrations()` 専用として書かれた（ADR 0017）。段階1の実測で
 * `registerEmbeddingSpace`（`./vector-space.ts`）にも同じ形の非アトミック性（`CREATE TABLE
 * IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` はどちらも並行では非アトミック）が実在する
 * ことを確認したため（ADR 0018）、「学ぶことが1つで済む」よう、ロックの取得・解放という
 * 機構そのものをここへ切り出し、`migrate.ts` と `vector-space.ts` の両方から使う。
 *
 * **切り出したのは機構だけ**——「待って取れた／時間切れ／ロック機構自体が使えなかった」の
 * 3状態を呼び出し側が `instanceof` で見分けられるという性質、専用コネクションを
 * pool から借り切る・`set_config('lock_timeout', ...)` を session に敷く・失敗時は必ず
 * release してから投げる・終了時に `lock_timeout` を `'0'` へ戻す、という個々の理由は
 * `migrate.ts` の元のコメントからそのまま運んである。
 *
 * **呼び出し元ごとに別のロックキーを使うこと。** `pg_advisory_lock` のキー空間は
 * **データベース全体で共有**される——`runMigrations` と `registerEmbeddingSpace` が
 * 同じキーを使うと、互いに無関係な処理同士が意図せずブロックし合う
 * （`MIGRATION_LOCK_KEY` と `REGISTER_EMBEDDING_SPACE_LOCK_KEY` を参照）。
 */

/** advisory lock を待つ既定の上限。呼び出し側が options で上書きできる（テストは短くする）。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** `pg_advisory_lock` が `lock_timeout` で中断されたときの SQLSTATE。 */
const PG_LOCK_TIMEOUT_SQLSTATE = "55P03";

/**
 * advisory lock の取得が「待ち時間切れで失敗した」ことを表す汎用の基底クラス。
 *
 * **「待って取れた」「待ったが時間切れ」「ロック機構自体が使えなかった」の3つを
 * 呼び出し側が区別できること**が段階2の要求（オーナーが引いた線1、ADR 0017）。
 * 呼び出し元（`runMigrations` / `registerEmbeddingSpace`）ごとに、メッセージへ
 * 関数名を埋め込んだサブクラス（`MigrationLockTimeoutError` /
 * `RegisterEmbeddingSpaceLockTimeoutError`）を作って使うこと——このクラスを
 * 直接 throw するのは想定していない。
 */
export class AdvisoryLockTimeoutError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AdvisoryLockTimeoutError";
  }
}

/**
 * advisory lock を取得する**操作自体**が失敗したことを表す汎用の基底クラス
 * （権限不足・接続不可など、待ち時間切れとは別原因）。
 *
 * `AdvisoryLockTimeoutError` と同様、呼び出し元ごとのサブクラスを作って使うこと。
 * **この区別が無いと、権限設定の誤りを「混んでいるだけ」と誤診してリトライし続けてしまう。**
 */
export class AdvisoryLockUnavailableError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AdvisoryLockUnavailableError";
  }
}

/**
 * 呼び出し元ごとに用意する、エラーの組み立て方。
 *
 * `acquireAdvisoryLock` はどの具象エラークラスを投げるべきか知らない
 * （それは呼び出し元——`migrate.ts` なら `MigrationLock*Error`、`vector-space.ts` なら
 * `RegisterEmbeddingSpaceLock*Error`——の役目）。そのためファクトリを渡してもらう。
 */
export interface AdvisoryLockErrorFactories {
  timeout: (waitedMs: number, cause: unknown) => Error;
  unavailable: (cause: unknown) => Error;
}

/**
 * advisory lock を取得し、保持用の専用コネクションを返す。
 *
 * **専用のコネクションを1本 pool から借り切って使う**（`pool.query` で都度別の
 * コネクションを使うと、session レベルの advisory lock がどの接続に紐付いているか
 * 制御できなくなるため）。`lock_timeout` もこのコネクションの session に対して設定する。
 *
 * 失敗時は必ずこのコネクションを pool へ返却してから例外を投げる
 * （呼び出し元がコネクションリークを心配しなくてよいように）。
 */
export async function acquireAdvisoryLock(
  pool: Pool,
  lockKey: bigint,
  lockTimeoutMs: number,
  errors: AdvisoryLockErrorFactories,
): Promise<{ client: PoolClient; waitedMs: number }> {
  const client = await pool.connect();

  try {
    // SET だとプレースホルダを使えないため set_config() 経由にする
    // （文字列結合で SQL を組み立てない）。false = セッションスコープ
    // （このコネクションが pool へ戻った後に他の用途で再利用されても
    // 悪影響が残らないよう、後で必ず '0' に戻す）。
    await client.query("SELECT set_config('lock_timeout', $1, false)", [String(lockTimeoutMs)]);
  } catch (err) {
    client.release();
    throw errors.unavailable(err);
  }

  const startedAt = Date.now();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey.toString()]);
  } catch (err) {
    await client.query("SELECT set_config('lock_timeout', '0', false)").catch(() => {});
    client.release();
    // 🔴 **この `.code` の直読みが効くのは、生の `PoolClient.query()` を使っているからである。**
    // 実測（PostgreSQL 17.9）: 生 query の例外は最初の1段目にそのまま `code` を持つ。
    //
    // ⚠ **drizzle の `db.execute()` では効かない。**あちらは pg のエラーを
    // `Error: Failed query: ...` で包むので、`.code` の直読みは `undefined` になる。
    // 実測では、1段目が包んだ `Error`、その `cause`（2段目）が pg のエラーで、
    // `code` はそちらに在る。**⟹ `db.execute()` の失敗から SQLSTATE を読むなら、
    // `cause` の連鎖を辿ること。**この形をそのままコピーすると静かに `undefined` になり、
    // **誤りは必ず「その SQLSTATE ではなかった」の向きに倒れる**——つまり黙って通る。
    // 辿る例は `foreign-key-violation.postgres.test.ts` の `sqlStateOf`。
    //
    // ⚠ **共有の helper は意図的に置いていない。**本番でこれを読む箇所はここ1つだけで、
    // 候補として挙がった2つはどちらも repo の決定が需要を消している——アダプタ間で
    // エラーの種別を揃えることは ADR 0047 が採らないと決めており（`memory-store-conformance.ts`
    // の `.rejects.toThrow()` の doc を参照）、不正な uuid（`22P02`）は例外を分類せず
    // `isUuidLike` の事前検査で弾く設計になっている。**必要になったら、そのとき作ればよい。**
    // ⟹ これは「helper が抜けている」ではなく「置かないと決めた」である。
    //
    // ⚠ **この注意書きには歯を置いていない。**これは警告であって安全性の主張ではなく、
    // drizzle が包み方を変えたら**この記述が古くなるだけで何も壊れない**。歯で固定すると
    // 「drizzle の挙動を変えてはいけない」を意味してしまう。
    // （なお `55P03` の側は歯が在る——定数が違えば `migrate-concurrency.test.ts` の
    // `MigrationLockTimeoutError` 検査が赤くなる。あちらは事故で変わる前提なので固定してよい。）
    const code = (err as { code?: string }).code;
    if (code === PG_LOCK_TIMEOUT_SQLSTATE) {
      throw errors.timeout(Date.now() - startedAt, err);
    }
    throw errors.unavailable(err);
  }

  return { client, waitedMs: Date.now() - startedAt };
}

/**
 * 固定文字列から advisory lock のキーを導出する（feat/dedicated-schema）。
 *
 * `MIGRATION_LOCK_KEY`（`./migrate.ts`）・`REGISTER_EMBEDDING_SPACE_LOCK_KEY`
 * （`./vector-space.ts`）の doc に書いてある導出手順——固定文字列の SHA-256 先頭8バイトを
 * 符号付き64bit整数として解釈する——と**同一**の計算をここへ切り出したもの。
 * 両定数はこの関数を使わずハードコードされたままにしてある（既存の値を変えないため）。
 * このリポジトリの規律の実測（`node -e 'const c=require("crypto");
 * console.log(c.createHash("sha256").update("mnemora:runMigrations:advisory-lock")
 * .digest().readBigInt64BE(0).toString())'` 等）で、この関数が両定数を再現することを
 * 確認済み——`schema-namespace.test.ts` の歯がそれを固定する。
 *
 * スキーマごとに別のロックキーを導出する用途（`migrationLockKeyFor` /
 * `registerEmbeddingSpaceLockKeyFor`、いずれも呼び出し元のファイルに置く）のために
 * ここへ切り出した。`deriveAdvisoryLockKey` 自体は「seed 文字列 → キー」という
 * 純粋な計算だけを担う——衝突回避のための値であり、値そのものに意味は無い。
 */
export function deriveAdvisoryLockKey(seed: string): bigint {
  return createHash("sha256").update(seed).digest().readBigInt64BE(0);
}

/** advisory lock を解放し、`lock_timeout` を元に戻してからコネクションを pool へ返す。 */
export async function releaseAdvisoryLock(client: PoolClient, lockKey: bigint): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [lockKey.toString()]);
  } finally {
    await client.query("SELECT set_config('lock_timeout', '0', false)").catch(() => {});
    client.release();
  }
}
