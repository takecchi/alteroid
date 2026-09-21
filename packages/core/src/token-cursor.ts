import { z } from 'zod';

import type { AgentToken } from './token-pool.js';

/**
 * `token_list` の継続点（issue #662）。
 *
 * ## なぜ要るか
 *
 * 一覧が予算（`TOKEN_LIST_BUDGET`、`tools.ts`）で切れると、この道具は
 * **到達手段が無いことを自分で申告していた**——逐語（#662 以前）:
 * 「**残りを見る手はこの道具に無い** — 全件は `alteroid token list` か
 * `GET /tokens` で読む。」
 *
 * 🔴 **黙ってはいないが、案内先は人間の口である。** `alteroid token list`
 * は CLI、`GET /tokens` は HTTP で、**どちらもクローンからは叩けない。**
 * ⟹ 予算で切れた行は、クローンにとって到達不能のまま残る。
 *
 * ## 錨は `id`（位置の探索）＋ `order`（比較の保険）
 *
 * `TokenPoolStore.list()` は「`order` 昇順。」で並ぶ契約を持つ（逐語で
 * 当たる: `grep -Fn -- '`order` 昇順。' packages/core/src/store.ts`）。
 * ⚠️ **`order` は一意ではない**——同値は入力順で安定させる、という契約に
 * 留まる（逐語: `grep -Fn -- '`order` 昇順で返し、同値は入力順で安定させる' packages/core/src/token-pool.ts`）。
 * ⟹ **`order` 単体を錨にすると、同値の行を飛ばしうる。**
 *
 * だから `schedule-cursor.ts` と同じ2段にしたうえで、段ごとに別の鍵を使う:
 *
 * 1. **第一の手段は位置の探索（鍵は `id`）。** `id` は一意なので、当たれば
 *    `slice(index + 1)` が過不足なく続きになる。**ストアの並びをそのまま
 *    使うので、`order` の同値にも照合順序にも晒されない。**
 * 2. **錨の行が消えていたときだけ比較へ落とす（鍵は `order`）。**
 *    ⚠️ **`>=` で残す**——`>` にすると、錨と同じ `order` を持つ別の行が
 *    静かに飛ぶ。`>=` なら錨と同値の行が次の頁へもう一度出るが、**1行も
 *    失われない。** ⟹ 「欠落と重複が両立しないなら、欠落しない側へ倒す」
 *    （`memory-cursor.ts` が木の順で同じ判断をしている）。
 *
 * ## ⛔ 値（`value`）はここに入れない
 *
 * カーソルは応答の本文に**平文で出る**。`AgentToken.value` を錨にしたら、
 * 一覧が「値を返さない」という性質（`AgentTokenView` の doc）を、継続点
 * という裏口から破ることになる。⟹ 錨は `id` と `order` だけである。
 *
 * ## `index.ts` へ export しない
 *
 * `schedule-cursor.ts` と同じ理由——`token_list` にはカーソル付きの HTTP
 * 対応物が無いので、**出す先が無い export を足さない**。
 */
const tokenCursorSchema = z.object({ id: z.string().min(1), order: z.number().int() });

export type TokenCursor = z.infer<typeof tokenCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeTokenCursor(cursor: TokenCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeTokenCursorResult = { ok: true; cursor: TokenCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば `{ ok: false }`。** 実在検査はしない
 * ——`resolveTokenCursor` が「位置の探索 → 比較」の順で辿る。
 */
export function decodeTokenCursor(raw: string): DecodeTokenCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = tokenCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries`（`TokenPoolStore.list()` の契約どおり
 * `order` 昇順で来ているもの）から、その位置より後ろだけを残す。**純関数。**
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）
 * - decode できない: `{ kind: 'malformed' }`——**黙って先頭からへは倒さない**
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（＝最後の頁）
 */
export function resolveTokenCursor(
  entries: readonly AgentToken[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: AgentToken[] } | { kind: 'malformed' } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeTokenCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const { id, order } = decoded.cursor;
  // 第一の手段: 位置の探索（鍵は一意な `id`）。
  const index = entries.findIndex((entry) => entry.id === id);
  if (index !== -1) return { kind: 'ok', view: entries.slice(index + 1) };
  // 第二の手段: 錨の行が消えていた（トークンが外された等）。上の doc のとおり
  // `>=` で残す——`>` は `order` の同値を飛ばす。
  return { kind: 'ok', view: entries.filter((entry) => entry.order >= order) };
}
