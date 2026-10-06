import { z } from 'zod';

import { randomToken, sha256Hex } from './auth.js';
import { assertNoNul, stripNul } from './nul-guard.js';
import type { RemoveUnreadableRowsOptions, RemoveUnreadableRowsResult } from './store.js';

/**
 * **連携の鍵（integration key）。** 外のサービス（人間でない相手）へ渡す、権限を絞った鍵。
 *
 * **鍵の種類そのものが「固定の1つの `source` で外部イベントを送る」という1つの能力だけを表す。**
 * `scopes: [...]` のような「選べる許可の一覧」は持たない。持った瞬間に、地雷表の
 * `permissions.yaml`（確認が要る行為の一覧）と同じ形になる（`.claude/skills/auth-and-access/SKILL.md`）。
 *
 * **これは行為ごとのスコープではなく、「人間でない相手に渡す認証情報の配布範囲」の境界である**
 * （north_star 禁止2 が制限の表現方法として認めている「実行環境の境界」）。クローン・マネージャー・
 * 作業者の道具は1つも減らない。
 *
 * **素の値は保存しない**（sha256 だけ）。値は発行の応答で1度だけ返す。
 */

/** 発行する鍵の見た目。ログに出たとき何か分かるように、アクセストークン（`alt_`）と区別できる接頭辞を付ける。 */
export const INTEGRATION_KEY_PREFIX = 'altk_';

/** 本文の既定の上限（バイト）。鍵ごとの `maxBodyBytes` で上書きできる。 */
export const DEFAULT_INTEGRATION_MAX_BODY_BYTES = 1024 * 1024;

/** 1分あたりの受け付け回数の既定。鍵ごとの `ratePerMinute` で上書きできる。 */
export const DEFAULT_INTEGRATION_RATE_PER_MINUTE = 60;

/** `lastUsedAt` の書き戻しはこの間隔まで間引く（アクセストークンの `LAST_USED_THROTTLE_MS` と同じ値）。 */
export const INTEGRATION_KEY_LAST_USED_THROTTLE_MS = 60_000;

export const INTEGRATION_SOURCE_PATTERN = /^[a-z0-9._-]{1,64}$/;

const isoDateTime = z.string().datetime({ offset: true });

export const integrationSourceSchema = z.string().regex(INTEGRATION_SOURCE_PATTERN);

export const integrationKeyRecordSchema = z.object({
  id: z.string().min(1),
  /** 人間が見分けるためのラベル。 */
  name: z.string().min(1).max(200),
  /** この鍵が送れる唯一の source。 */
  source: integrationSourceSchema,
  sha256: z.string().length(64),
  createdAt: isoDateTime,
  /** 発行した資格（`describeActor` 相当の文字列）。 */
  createdBy: z.string().min(1),
  /** 無期限なら `null`（既定）。 */
  expiresAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  lastUsedAt: isoDateTime.nullable(),
  /** 無ければ {@link DEFAULT_INTEGRATION_MAX_BODY_BYTES}。 */
  maxBodyBytes: z.number().int().positive().max(2_147_483_647).nullable(),
  /** 無ければ {@link DEFAULT_INTEGRATION_RATE_PER_MINUTE}。 */
  ratePerMinute: z.number().int().positive().max(2_147_483_647).nullable(),
});

export type IntegrationKeyRecord = z.infer<typeof integrationKeyRecordSchema>;

/**
 * 連携の鍵の1行が {@link integrationKeyRecordSchema} として読めなかったときに、その行の代わりに外へ出すもの
 * （issue #3216。`UnreadablePermissionGrant` と同じ線）。**`list` が黙って飛ばすと、鍵が消えたのか読めないのか
 * が見えない。** 外へ返す形は `toRowsUnreadable`（`rowsUnreadable: { count, rows }`）。
 *
 * **⚠️ 行の中身（名前・source・sha256 など）を決して載せないこと。** 識別に使うのは id だけで、取れなければ
 * 載せない。`reason` は「どの欄が不正か」だけ。
 */
export interface UnreadableIntegrationKey {
  /** 行から取れた id（文字列のときだけ）。 */
  id?: string | undefined;
  /** なぜ読めなかったか（不正な欄名だけ。値は載せない）。 */
  reason: string;
}

export type RevokeIntegrationKeyOutcome =
  | { status: 'not_found' }
  | { status: 'already_revoked'; key: IntegrationKeyRecord }
  | { status: 'revoked'; key: IntegrationKeyRecord };

/**
 * 連携の鍵の置き場。fs / pg / インメモリの3実装が同じ IF を満たす。
 *
 * NUL（`AuthStore` と同じ線）: 読む口は NUL を含む鍵で引かれても断らず「無い」と同じ結果を返す。
 * 書く口は `id`・`source`・`sha256`・`createdBy` の NUL を `NulNotAllowedError` で断り、`name` の NUL は落として残す
 * （部品は {@link prepareIntegrationKeyForWrite}）。
 */
export interface IntegrationKeyStore {
  /** 新しい鍵を1行足す。**同じ id・同じ sha256 の行が既に在れば投げる**（上書きしない）。 */
  putIntegrationKey(key: IntegrationKeyRecord): Promise<void>;
  findIntegrationKeyBySha256(sha256: string): Promise<IntegrationKeyRecord | null>;
  getIntegrationKey(id: string): Promise<IntegrationKeyRecord | null>;
  /** `createdAt` の実時刻昇順、同着は `id`（バイト順）。 */
  listIntegrationKeys(): Promise<IntegrationKeyRecord[]>;
  /**
   * `lastUsedAt` だけを `at` にする（1操作）。**他の欄、とくに `revokedAt` に触らない。**
   * 失効済み・無い id では何もしない。
   */
  markIntegrationKeyUsed(id: string, at: string): Promise<void>;
  /** `revokedAt` が空のときだけ立てる（冪等。先に立った時刻は動かさない）。 */
  revokeIntegrationKey(id: string, at: string): Promise<RevokeIntegrationKeyOutcome>;
  /**
   * `listIntegrationKeys()` が飛ばした行（`integrationKeyRecordSchema` に合わない。版ずれ・手編集）を、中身を含まない
   * 形（id と不正な欄名だけ）で返す（issue #3216。`PermissionGrantStore.listUnreadable` と同じ線）。読めない行しか
   * 無いと `listIntegrationKeys()` は空で「鍵がまだ無い」と読める——その言い分けの元になる。
   * **読めない行の鍵は使えない（`find` にも `get` にも現れない）。** fail-closed で、誤って通ることは無い。
   */
  listUnreadableIntegrationKeys(): Promise<UnreadableIntegrationKey[]>;
  /**
   * **読めない行を、id で指して消す**（issue #3216。`PermissionGrantStore.removeUnreadable` と同じ契約）。
   * 指された id が**すべて**読めない行に在るときだけ消す（1つでも違えば何も消さず `unknown`。読める行・無い id・id が
   * 取れない行を指した場合を含む）。消すと決まったら {@link RemoveUnreadableRowsOptions.beforeRemove} を書き込みの
   * 排他区間の中で、消す前に呼ぶ（投げたら何も消さずに投げ直す）。読める行には触れない。NUL を含む id は「無い」。
   */
  removeUnreadableIntegrationKeys(
    ids: readonly string[],
    options?: RemoveUnreadableRowsOptions,
  ): Promise<RemoveUnreadableRowsResult>;
}

export function issueIntegrationKeyValue(): string {
  return `${INTEGRATION_KEY_PREFIX}${randomToken(32)}`;
}

export function looksLikeIntegrationKey(bearer: string): boolean {
  return bearer.startsWith(INTEGRATION_KEY_PREFIX);
}

/** 一覧で見分けるための sha256 の先頭12桁（`/credentials` の指紋と同じ考え方）。 */
export function integrationKeyFingerprint(sha256: string): string {
  return sha256.slice(0, 12);
}

/**
 * **判定できない期限は「使えない」に倒す**（`isAccessTokenUsable` と同じ。issue #1789）。
 * 比べる向きも「期限より前なら開く」にしてある（`NaN` との比較はどれも偽になり、閉じる側へ落ちる）。
 */
export function isIntegrationKeyUsable(key: IntegrationKeyRecord, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  if (key.expiresAt === null) return true;
  const expiresAt = Date.parse(key.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now.getTime();
}

export interface IntegrationLimits {
  maxBodyBytes: number;
  ratePerMinute: number;
}

export function integrationKeyLimits(key: IntegrationKeyRecord): IntegrationLimits {
  return {
    maxBodyBytes: key.maxBodyBytes ?? DEFAULT_INTEGRATION_MAX_BODY_BYTES,
    ratePerMinute: key.ratePerMinute ?? DEFAULT_INTEGRATION_RATE_PER_MINUTE,
  };
}

/** 書き込みの入口で NUL を整える（3実装が、スキーマを通した後・書く前に呼ぶ）。 */
export function prepareIntegrationKeyForWrite(key: IntegrationKeyRecord): IntegrationKeyRecord {
  assertNoNul('integrationKey.id', key.id);
  assertNoNul('integrationKey.source', key.source);
  assertNoNul('integrationKey.sha256', key.sha256);
  assertNoNul('integrationKey.createdBy', key.createdBy);
  return { ...key, name: stripNul(key.name) };
}

/** 一覧の並び（`createdAt` の実時刻 → `id` のコード単位順）。fs / インメモリが使う。 */
export function compareIntegrationKeyOrder(
  a: IntegrationKeyRecord,
  b: IntegrationKeyRecord,
): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/**
 * bearer（`altk_...`）から使える鍵を引く。**使えない（未知・失効・期限切れ）なら `null`。**
 * `lastUsedAt` は間引いて書く（行を丸ごと書き戻さず、その1欄だけの1操作で）。
 */
export async function resolveIntegrationKey(options: {
  store: IntegrationKeyStore;
  bearer: string;
  now: Date;
}): Promise<IntegrationKeyRecord | null> {
  const { store, bearer, now } = options;
  if (!looksLikeIntegrationKey(bearer)) return null;
  const found = await store.findIntegrationKeyBySha256(sha256Hex(bearer));
  if (found === null || !isIntegrationKeyUsable(found, now)) return null;
  const previous = found.lastUsedAt === null ? 0 : Date.parse(found.lastUsedAt);
  if (!(now.getTime() - previous < INTEGRATION_KEY_LAST_USED_THROTTLE_MS)) {
    await store.markIntegrationKeyUsed(found.id, now.toISOString());
  }
  return found;
}
