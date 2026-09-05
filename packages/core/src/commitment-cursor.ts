import { z } from 'zod';

import type { Commitment } from './schema.js';

/**
 * `commitment_list`（一覧モード）の継続点（issue: 一覧モードから予算で
 * あふれた分へ到達できない）。
 *
 * **形は HTTP の `GET /commitments` に既にある `cursor` へ合わせた。**
 * 意味は「件数」ではなく「不透明な位置（keyset）」——`apps/daemon/src/app.ts`
 * の `commitmentsCursorSchema` の doc（逐語）:
 *
 * > 一覧は2段でできている（`CommitmentStore.list` の契約）: 未了
 * > （`closedAt === undefined`）を `at` の**昇順**、片付き
 * > （`closedAt !== undefined`）を `closedAt` の**降順**で、その順に連結
 * > したもの。2段を跨ぐ錨は作らない。代わりに**錨が自分の段を名乗る**
 * > （`segment`）。
 *
 * **`packages/core` は `apps/daemon` に依存できない**（依存の向きが逆—
 * `apps/daemon` が `@alteroid/core` を使う側）ので、このファイルは
 * `apps/daemon/src/cursor.ts` / `apps/daemon/src/app.ts` の実装を import
 * せず、同じ**契約**（`CommitmentStore.list` の順序）を独立に実装する。
 * 2箇所の実装が指す契約は同じなので、片方だけがずれたら
 * `packages/core/src/commitment-cursor.test.ts` と
 * `apps/daemon/src/app.test.ts`（`/commitments` の cursor まわり）の
 * どちらかが赤くなる——揃っているかどうかは歯で見張る形で、コードの共有
 * ではなく契約の一致で持たせている。
 *
 * **`offset` という名前は使わない。** `commitment_list` の `offset` は
 * 既に「`id` で全文を読むとき、何文字目から読むか」という別の単位
 * （文字数）を持っている（`tools.ts` の `offset` の doc、逐語:
 * 「id で全文を読むとき、何文字目から読むか」）。同じ名前に2つの単位を
 * 持たせると、`apps/daemon/src/cursor.ts` が HTTP 側で既に踏んだのと
 * 同じ形の紛れが道具の側にも生まれる——だから HTTP と同じく `cursor`
 * という別名を使う。
 */

/** 台帳の1行を、並び替えのための位置へ写す。 */
export interface CommitmentPosition {
  segment: 'open' | 'closed';
  /** `open` は `at`、`closed` は `closedAt`。 */
  key: string;
  id: string;
}

/**
 * `Commitment` から位置を取り出す。
 *
 * `apps/daemon/src/app.ts` の `commitmentPos` と同じ規則
 * （逐語で当たる: `grep -Fn -- 'function commitmentPos' apps/daemon/src/app.ts`）。
 */
export function commitmentPosition(
  entry: Pick<Commitment, 'id' | 'at' | 'closedAt'>,
): CommitmentPosition {
  return entry.closedAt === undefined
    ? { segment: 'open', key: entry.at, id: entry.id }
    : { segment: 'closed', key: entry.closedAt, id: entry.id };
}

/**
 * 段（segment）を持つ keyset の比較。**未了(open) が先、片付き(closed) が後。**
 * `open` の中は `key`（`at`）昇順 → 同値は `id` 昇順。`closed` の中は `key`
 * （`closedAt`）降順 → 同値は `id` 昇順。
 *
 * `apps/daemon/src/app.ts` の `compareCommitmentPos` と同じ規則
 * （逐語で当たる: `grep -Fn -- 'function compareCommitmentPos' apps/daemon/src/app.ts`）。
 */
export function compareCommitmentPosition(a: CommitmentPosition, b: CommitmentPosition): number {
  if (a.segment !== b.segment) return a.segment === 'open' ? -1 : 1;
  if (a.segment === 'open') {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  } else {
    if (a.key !== b.key) return a.key > b.key ? -1 : 1;
  }
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * カーソルの中身。**`includeClosed` を含める。**
 *
 * 錨は「刷られた一覧の `includeClosed`」を持つ——HTTP の
 * `commitmentsCursorSchema` と同じ理由（逐語: 「錨を刷った一覧がどちらだった
 * かを持つ。錨は刷られた一覧の中でしか意味を持たないので、リクエストの
 * `includeClosed` と食い違えば 400 にする」）。**MCP 側は 400 を返せない
 * ので text で明示のエラーを返す**（`resolveCommitmentCursor` の
 * `'includeClosed-mismatch'`）。
 */
const commitmentCursorSchema = z.object({
  segment: z.enum(['open', 'closed']),
  key: z.string().min(1),
  id: z.string().min(1),
  includeClosed: z.boolean(),
});

export type CommitmentCursor = z.infer<typeof commitmentCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeCommitmentCursor(cursor: CommitmentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeCommitmentCursorResult = { ok: true; cursor: CommitmentCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、また
 * は schema に合わない）`{ ok: false }`。** 実在検査はしない——
 * `resolveCommitmentCursor` が比較（keyset）で辿るので、錨が指していた行が
 * 別の段へ移っていても（未了→片付き）続きは正しく決まる。HTTP の
 * `decodeCursor` の doc と同じ理由（逐語: 「位置ではなく比較（keyset）で
 * 辿る口では、この実在検査は要らない」）。
 */
export function decodeCommitmentCursor(raw: string): DecodeCommitmentCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = commitmentCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries`（すでに固定順——`CommitmentStore.list` の
 * 契約に加え、呼び出し側で `origin` を絞った後のもの）から、その位置より
 * 後ろだけを残す。**純関数。I/O を持たない**（`Commitment[]` の配列を渡す
 * だけで呼べる——`commitment-cursor.test.ts` はストアを1つも作らずにこれを
 * 直接叩く）。
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）。`{ kind: 'ok', view:
 *   [...entries] }`
 * - decode できない: `{ kind: 'malformed' }`
 * - `includeClosed` が食い違う: `{ kind: 'includeClosed-mismatch',
 *   cursorIncludeClosed }`——**黙って先頭からへは倒さない**（AGENTS.md
 *   「判定できないという3つ目の状態を持つ」と同じ理由）
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（カーソルが
 *   一覧の末尾を指していた＝最後の頁）——これは呼び出し側が「もう続きは
 *   無い」として扱う、正常な終端であってエラーではない
 */
export function resolveCommitmentCursor(
  entries: readonly Commitment[],
  includeClosed: boolean,
  cursorRaw: string | undefined,
):
  | { kind: 'ok'; view: Commitment[] }
  | { kind: 'malformed' }
  | { kind: 'includeClosed-mismatch'; cursorIncludeClosed: boolean } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeCommitmentCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  if (decoded.cursor.includeClosed !== includeClosed) {
    return { kind: 'includeClosed-mismatch', cursorIncludeClosed: decoded.cursor.includeClosed };
  }
  const pivot: CommitmentPosition = decoded.cursor;
  const view = entries.filter(
    (entry) => compareCommitmentPosition(commitmentPosition(entry), pivot) > 0,
  );
  return { kind: 'ok', view };
}
