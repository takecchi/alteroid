import { z } from 'zod';

/**
 * カーソル（keyset paging）の共通の符号化（issue #432）。
 *
 * **口をまたいで形を揃える。** いま確実に使っているのは `GET /approvals` の
 * 1口だけである。`/journal` は別 PR で使う予定がある。`/commitments` と
 * `/conversations` はこの符号化を使わない（`.claude/skills/listing-and-detail/SKILL.md`
 * が言う理由でスコープから外れた）。`/reports` は口の形（不透明なカーソル＋
 * 応答を1バイトも変えない、を同時に満たせるか）がまだ決まっていない。
 * **「4口で揃える」だった時期があるが、いまはそう書けない** — 決まった口が
 * 増えるたびにここを更新すること。
 *
 * 中身のキーは口ごとに違う（`/approvals` は `{ id, createdAt, order }`）が、
 * 外から見た形はすべて「不透明な base64url 文字列」で揃えてある。呼ぶ側は
 * 前の応答に載った `nextCursor` をそのまま次のリクエストの `cursor` へ渡す
 * だけでよく、中身の構造を知らなくてよい（**カーソルは応答に載った値からしか
 * 得られない** — 自分で値を組み立てて渡しても、中身の構造は decode されるまで
 * 分からないので、でたらめな値は次の「存在しない・壊れたカーソルは 400」に
 * 落ちる。1頁目でも続きが在れば `nextCursor` は載るので、そこから始められる）。
 *
 * **存在しない・壊れたカーソルは 400 で断る。** 「判定できない」を黙って「先頭から」
 * へ倒さない（`AGENTS.md` の「判定できないという3つ目の状態を持つ」と同じ理由）。
 * この形式的な検査（decode できるか）はここが持つ。**「decode できた値が指す
 * 要素がいまの一覧に実在するか」は口によって要る／要らないが分かれる**——
 * 呼び出し側（`app.ts`）が口ごとの事情に合わせて決める。たとえば `/approvals`
 * は位置ではなく `(createdAt, id)` の比較で辿るので、指していた行が答えられて
 * 絞り込みから消えていても続きは正しく決まり、実在検査を要求しない（要求すると
 * 「答えたら続きが取れなくなる」という別の穴になる）。実在検査が要る口が
 * 増えたら、そちらは別に検査すること——ここでは検査できない（口ごとにデータが
 * 違うため）。
 *
 * **offset という名前を使わない。** `packages/core/src/tools.ts` の
 * `page()` 呼び出し10箇所（`memory_read` / `journal_read` / `approvals_list` /
 * `schedule_list` / `commitment_list` / `profile_read` / `self_read` /
 * `manager_report` / `conversation_read` / `manager_transcript`）に既にある
 * `offset` は「一覧のページング」ではなく「本文を何文字目から読むか」であって、
 * 意味が違う。**ただし例外が1つある** — `usage_summary` の `axis` モードの
 * `offset`（`renderUsage` の中で `entries.slice(offset, offset + USAGE_AXIS_PAGE)`
 * を通る。`grep -n 'entries.slice(offset' packages/core/src/tools.ts` で当たる）
 * は、本文ではなく**軸の一覧の配列そのもの**を切っている。**「1件も無い」とは
 * 言えない** — 名指しした10箇所は本文のオフセットで正しいが、この1件だけは
 * 一覧のオフセットである。同じ名前で違う意味を作らないため、HTTP 側の一覧
 * ページングには `cursor` という別の名前を使う。
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
 * 側は、口の性質によっては加えて「decode できた id/組が、いまの一覧に実在するか」
 * を確かめてよい（decode が通っても、指している要素が無ければ同じ
 * `InvalidCursorError` を投げて 400 にする）。**位置ではなく比較（keyset）で
 * 辿る口では、この実在検査は要らない** — 指していた行が消えていても、比較さえ
 * できれば続きは正しく決まる（`GET /approvals` がこの形）。
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
