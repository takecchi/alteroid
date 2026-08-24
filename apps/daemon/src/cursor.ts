import { z } from 'zod';

/**
 * カーソル（keyset paging）の共通の符号化（issue #432）。
 *
 * **4口（`/conversations` `/approvals` `/commitments` `/reports`）で形を揃える。**
 * 中身のキーは口ごとに違う（`conversationId` / `id` / `date`＋`at` の組）が、外から
 * 見た形はすべて「不透明な base64url 文字列」で揃えてある。呼ぶ側は前の応答に
 * 載った `nextCursor` をそのまま次のリクエストの `cursor` へ渡すだけでよく、中身の
 * 構造を知らなくてよい（応答に返った値からしか組み立てられない — 1頁目には
 * `nextCursor` が載らないので、呼ぶ側が値を自分で捏造することはできない）。
 *
 * **存在しない・壊れたカーソルは 400 で断る。** 「判定できない」を黙って「先頭から」
 * へ倒さない（`AGENTS.md` の「判定できないという3つ目の状態を持つ」と同じ理由）。
 * この形式的な検査（decode できるか）はここが持ち、「その id / 組が実際にいまの
 * 一覧の中に在るか」は呼び出し側（`app.ts`）が持つ——後者は口ごとにデータが違う
 * ので、ここでは検査できない。
 *
 * **offset という名前を使わない。** `packages/core/src/tools.ts` の
 * `journal_read` / `conversation_read` / `approvals_list` / `commitment_list` に
 * 既にある `offset` は「一覧のページング」ではなく「`id` を指定した1件の本文を
 * 何文字目から読むか」であって、意味が違う。同じ名前で違う意味を作らないため、
 * HTTP 側の一覧ページングには `cursor` という別の名前を使う。
 */
export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** カーソルが壊れている・意味を持てないときに投げる。呼び出し側が 400 へ変換する。 */
export class InvalidCursorError extends Error {
  constructor(message = 'カーソルが不正') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/**
 * カーソルを decode し、`schema` で検査する。**壊れていれば（base64/JSON として
 * 読めない、または schema に合わない）`InvalidCursorError` を投げる。** 呼び出し
 * 側はこれに加えて「decode できた id/組が、いまの一覧に実在するか」を確かめること
 * （decode が通っても、指している要素が無ければ同じ `InvalidCursorError` を投げて
 * 400 にする）。
 */
export function decodeCursor<T extends z.ZodTypeAny>(raw: string, schema: T): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidCursorError();
  return parsed.data;
}
