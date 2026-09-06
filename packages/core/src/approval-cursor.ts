import { z } from 'zod';

import type { PendingApproval } from './schema.js';

/**
 * `approvals_list`（一覧モード）の継続点（issue #640 — 一覧モードから予算で
 * あふれた分へ到達できない）。
 *
 * **形は HTTP の `GET /approvals` に既にある `cursor` へ合わせた。** 意味は
 * 「件数」ではなく**不透明な位置（keyset）**である——`apps/daemon/src/app.ts`
 * の `approvalsCursorSchema` の doc（逐語）:
 *
 * > **なぜ位置で辿らないか。** `packages/storage-fs` の `putApproval` は既存の id
 * > への書き込みで配列の末尾へ移動する（`grep -Fn -- 'putApproval' packages/storage-fs/src/jobs.ts`
 * > — filter して除いてから push するので、答えた行が末尾へ動く）。
 *
 * **`packages/core` は `apps/daemon` に依存できない**（依存の向きが逆——
 * `apps/daemon` が `@alteroid/core` を使う側）。台帳の側（`commitment-cursor.ts`）
 * は同じ契約を独立に2度実装して「歯で見張る」形にしたが、**その PR（#641）自身が
 * 「両側の歯はそれぞれ自分の実装しか見ていないので、片方だけを直しても赤くならない
 * ＝見張りとして成立していない」と結論して、位置と比較の2関数を core へ寄せた。**
 * ここではその結論を最初から採る——`ApprovalPagingKey` と2つの比較関数は
 * `apps/daemon/src/app.ts` から**移設したもので、中身は1バイトも変えていない。**
 * app.ts はこのファイルから import する側になった。
 *
 * **`offset` という名前は使わない。** `approvals_list` の `offset` は既に
 * 「`id` で全文を読むとき、何文字目から読むか」という別の単位（文字数）を
 * 持っている（`tools.ts` の `offset` の doc、逐語: 「id で全文を読むとき、
 * 何文字目から読むか」）。同じ名前に2つの単位を持たせないため、HTTP と同じく
 * `cursor` という別名を使う。
 */

/** `(createdAt, id)` で表した承認待ち1件の位置。 */
export type ApprovalPagingKey = { id: string; createdAt: string };

/**
 * `(createdAt, id)` の昇順比較。同時刻は `id` で決める。
 *
 * `apps/daemon/src/app.ts` から移設した（移設の時点で中身は1バイトも変えて
 * いない）。`createdAt` を文字列のまま比較するのは、`new Date().toISOString()`
 * が返す固定形式（UTC・ミリ秒3桁・`Z` 終端）に乗っているためである——理由の
 * 全文は `apps/daemon/src/app.ts` の `approvalsCursorSchema` の doc に在る。
 */
export function compareApprovalPagingKeyAsc(a: ApprovalPagingKey, b: ApprovalPagingKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** `order` に応じた向きの比較。`desc` は昇順比較を反転しただけ（別の比較関数を書かない）。 */
export function compareApprovalPagingKey(
  order: 'asc' | 'desc',
): (a: ApprovalPagingKey, b: ApprovalPagingKey) => number {
  return order === 'asc'
    ? compareApprovalPagingKeyAsc
    : (a, b) => compareApprovalPagingKeyAsc(b, a);
}

/**
 * カーソルの中身。
 *
 * **`order` を持たない。** HTTP の `approvalsCursorSchema` は `order` を持ち、
 * リクエストの `order` と食い違えば 400 にする——**錨は刷られた一覧の中でしか
 * 意味を持たない**ためである。`approvals_list`（道具）の一覧モードには向きの
 * 引数が無く、常に古い順（`asc`）の1通りしかない。**⟹ 食い違いようが無いので、
 * 錨に持たせる軸が無い。** 台帳側（`CommitmentCursor`）が `includeClosed` を
 * 持っているのは、あちらに `includeClosed` という軸が実在するからであって、
 * 「カーソルには軸を持たせるもの」という規則があるからではない。**持たない軸を
 * 錨へ書くと、決して起きない食い違いの検査と、それを測れない歯が増える。**
 *
 * **⚠️ そのぶん `.strict()` が要る。この repo で `.strict()` を使うのはここが
 * 初めてである**（この PR の前は、`packages` と `apps` の実装（テストを含む）
 * のどこにも1件も無かった）。理由は、台帳の側がただで手に入れている安全が
 * ここでは手に入らないからである——
 *
 * - **台帳**: HTTP の `commitmentsCursorSchema` は `includeClosed` を
 *   `'true' | 'false'`（**文字列**）で持ち、core の `CommitmentCursor` は
 *   `boolean` で持つ。⟹ HTTP のカーソルを道具へ渡すと**型が合わずに弾かれる。**
 * - **承認待ち**: HTTP の `approvalsCursorSchema` は `{ id, createdAt, order }` で、
 *   ここが要求するのは `{ id, createdAt }` の2欄だけである。⟹ **既定（非 strict）
 *   の zod は余分な `order` を黙って捨てるので、`order: 'desc'` の HTTP カーソルが
 *   そのまま通る。** 通った先でこの道具は昇順で辿るので、**降順の頁の続きを
 *   求めた呼び手には「もう読んだ分」が返る**（黙って重複する。呼び手からは
 *   気づきようが無い）。
 *
 * ⟹ **不透明な合図は、自分が刷ったとおりの形のときだけ受け取る。** 形が違えば
 * `malformed` へ倒す（AGENTS.md「判定できないという3つ目の状態を持つ」）。
 */
const approvalCursorSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

export type ApprovalCursor = z.infer<typeof approvalCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeApprovalCursor(cursor: ApprovalCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeApprovalCursorResult = { ok: true; cursor: ApprovalCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、または
 * schema に合わない）`{ ok: false }`。** 実在検査はしない——
 * `resolveApprovalCursor` が比較（keyset）で辿るので、錨が指していた件に人間が
 * 答えて一覧（回答待ちのみ）から消えていても、続きは正しく決まる。HTTP 側も
 * 同じ理由で実在を見ていない（`apps/daemon/src/app.ts` の `/approvals` の
 * ハンドラ、逐語: 「**id の実在は検査しない。**」）。
 */
export function decodeApprovalCursor(raw: string): DecodeApprovalCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = approvalCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries` を **`(createdAt, id)` の昇順へ並べ直したうえで**
 * その位置より後ろだけを残す。**純関数。I/O を持たない**（`PendingApproval[]` の
 * 配列を渡すだけで呼べる——`approval-cursor.test.ts` はストアを1つも作らずに
 * これを直接叩く）。
 *
 * **⚠️ 並べ直しをこの関数の中に置いてあるのは、頁の境目を壊さないためである。**
 * `JobStore.listApprovals` は**並び順を契約していない**（`store.ts` の
 * `JobStore`）。実装3つの生の並びは実際に食い違う——`packages/storage-pg` は
 * `orderBy(asc(approvals.createdAt))`（`id` の同着は未定義）、`packages/storage-fs`
 * と `packages/core/src/testing.ts` は挿入順である。keyset のカーソルは
 * 「並びが決まっていること」の上でしか意味を持たないので、**呼び出し側で
 * 「cursor が来たときだけ並べ直す」形にすると、1頁目（cursor 無し）と2頁目
 * （cursor 有り）で並びが変わり、頁の境目で飛ばす／重複する。** HTTP 側は
 * `order` / `limit` / `cursor` のどれかを明示した呼びだけを opt-in として
 * 並べ直せる（頁を繰る呼び手は1頁目から `limit` を渡す）が、**道具の側には
 * 呼び手が握れる `limit` が無い**——切るのは文字数の予算で、呼び手からは
 * 見えない。⟹ **常に並べ直す。**
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）。`{ kind: 'ok', view: 並べ直しただけ }`
 * - decode できない: `{ kind: 'malformed' }`——**黙って先頭からへは倒さない**
 *   （AGENTS.md「判定できないという3つ目の状態を持つ」と同じ理由。倒すと呼び手は
 *   「続きを読んだつもり」で同じ行を繰り返し読み、気づきようが無い）
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（カーソルが一覧の
 *   末尾を指していた＝最後の頁）——これは呼び出し側が「もう続きは無い」として
 *   扱う、正常な終端であってエラーではない
 */
export function resolveApprovalCursor(
  entries: readonly PendingApproval[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: PendingApproval[] } | { kind: 'malformed' } {
  const sorted = [...entries].sort(compareApprovalPagingKeyAsc);
  if (cursorRaw === undefined) return { kind: 'ok', view: sorted };
  const decoded = decodeApprovalCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const pivot = decoded.cursor;
  return {
    kind: 'ok',
    view: sorted.filter((entry) => compareApprovalPagingKeyAsc(entry, pivot) > 0),
  };
}
