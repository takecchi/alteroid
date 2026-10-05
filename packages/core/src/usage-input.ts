import { stripNul } from './nul-guard.js';
import type { UsageSnapshot } from './usage.js';

/**
 * NUL だけの `tokenId`（落とすと空文字になるもの）を記録するときの目印（issue #3011。teto の判断）。
 *
 * pg の `usage_daily.tokenId` などは `not null default ''` で、空文字は「帰属なし」の行を表す。
 * NUL だけの値を落として空文字にすると、帰属なしの行に混ざる。記録は残しつつ、帰属なしとは区別が
 * つくように、この固定の値に置き換えて記録する（読む側の絞り込みも同じ置き換えを通す）。
 *
 * **本物のトークン id と衝突しない値であること。** 本物の id は `randomUUID()`
 * （`token-pool-service.ts`。16進とハイフンだけ）で作られ、呼び出し側が新しい id を指定することは
 * できない（`normalizeTokenPool` は既存の行に無い id を断る）。丸括弧は UUID に現れないので衝突しない。
 */
export const USAGE_NUL_ONLY_TOKEN_ID = '(nul-only)';

/**
 * 消費の台帳（`UsageStore`）の入口で、鍵列と本文の NUL を落とす（issue #2927。
 * teto の判断、2026-10-05）。3実装（インメモリ / fs / pg）が同じ関数を通す。
 *
 * **ここだけは鍵でも断らず、落として残す。** `managerId`・`model`・`tokenId`・
 * `provider` は集計の切り口で、特定の1行を指して書き換える鍵ではない。`model` は SDK の
 * `modelUsage` のキー（外から来る）で、断ると消費の記録が丸ごと消える（呼び出し側は失敗を
 * 握りつぶして日誌に残すだけ）。害が大きいのは記録を失うほうである。pg は元から落として
 * 記録を残していた（`stripNulls`）ので、fs とインメモリがそれに揃える。
 *
 * 落とした結果、同じ名前になるモデル（`a\0b` と `ab`）は1つに畳まれる（後のものが残る）。
 * 実際には起きない入力なので、足し合わせはしていない。
 */
export function stripNulFromUsageSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  return {
    ...snapshot,
    ...(snapshot.sessionId === undefined ? {} : { sessionId: stripNul(snapshot.sessionId) }),
    models: Object.fromEntries(
      Object.entries(snapshot.models).map(([model, totals]) => [stripNul(model), totals]),
    ),
  };
}

/** `record` の入力の鍵列（managerId・tokenId・model・sessionId）の NUL を落とす。 */
export function stripNulFromUsageRecord<
  T extends { managerId: string; tokenId?: string; snapshot: UsageSnapshot },
>(input: T): T {
  return {
    ...input,
    managerId: stripNul(input.managerId),
    ...(input.tokenId === undefined ? {} : { tokenId: stripNul(input.tokenId) }),
    snapshot: stripNulFromUsageSnapshot(input.snapshot),
  };
}

/** `recordUnmetered` の入力の鍵列（managerId・tokenId・provider）の NUL を落とす。 */
export function stripNulFromUnmeteredRecord<
  T extends { managerId: string; tokenId?: string; provider: string },
>(input: T): T {
  return {
    ...input,
    managerId: stripNul(input.managerId),
    provider: stripNul(input.provider),
    ...(input.tokenId === undefined ? {} : { tokenId: stripNul(input.tokenId) }),
  };
}

/**
 * `aggregate` の絞り込み（`managerId`・`tokenId`）の NUL を落とす（issue #3005）。書き込み
 * （{@link stripNulFromUsageRecord}）が鍵列を落として残すので、引くほうも落としてから引くと対称になる。
 * 3実装（インメモリ / fs / pg）が同じ関数を通す。pg は NUL を含む text を DB に投げると
 * エラーになるので、これを通さないと pg だけ投げる。
 */
export function stripNulFromUsageQuery<T extends { managerId?: string; tokenId?: string }>(
  query: T,
): T {
  return {
    ...query,
    ...(query.managerId === undefined ? {} : { managerId: stripNul(query.managerId) }),
    ...(query.tokenId === undefined ? {} : { tokenId: stripNul(query.tokenId) }),
  };
}
