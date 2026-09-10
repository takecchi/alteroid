import { z } from 'zod';

import type { ScheduledRequest } from './schema.js';

/**
 * `schedule_list`（一覧モード）の継続点（issue #662 段1）。
 *
 * ## なぜ要るか
 *
 * 一覧が予算（`SCHEDULE_LIST_BUDGET`、`tools.ts`）で切れると、**落ちた
 * `kind` の綴りはこの一覧以外のどこからも得られない。** `schedule_list
 * kind=<kind>`（全文モード）も `schedule_remove` も `kind` の一致を要求
 * するので、「もう要らない依頼を片付けたい」と思った瞬間に、**片付けら
 * れない依頼だけが残る。** プロンプトへ焼かれる継続依頼の一覧は無い
 * （継続中の依頼は `schedule_list` を呼ばない限りどこにも出てこない）ので、
 * この道具そのものが唯一の到達口であり、予算で落ちた分は完全に迷子になる。
 *
 * ## 錨は `kind` 単体（昇順）
 *
 * `ScheduleStore.list()` は「kind の昇順。」で並ぶという契約を持つ（逐語で
 * 当たる: `grep -Fn -- 'kind の昇順。' packages/core/src/store.ts`）。fs /
 * pg / インメモリの3実装ともこれを満たす。1軸の錨で足りるのは、この一覧が
 * `commitment_list` のような複数段（open/closed）を持たないからである
 * （kind ごとに高々1本しかなく、`schedule_list` には `order` /
 * `includeClosed` に相当する引数も無い——下の「持たせない状態」を見ること）。
 *
 * ## `commitment-cursor.ts` とあえて違えた箇所（`resolveScheduleCursor` の2段）
 *
 * `resolveCommitmentCursor` は常に比較（keyset フィルタ）だけで辿るが、
 * こちらは**2段**にした:
 *
 * 1. **第一の手段は位置の探索。** `entries` は既にストアの契約どおり
 *    `kind` 昇順で来ているので、`entries.findIndex((e) => e.kind ===
 *    pivot.kind)` が当たれば `entries.slice(index + 1)` を返す。**これは
 *    ストア自身の並びをそのまま使うので、照合順序（collation）の差に
 *    晒されない。**
 * 2. **錨の行が消えていたとき（`findIndex` が `-1`）だけ、比較へ落とす**
 *    （`entries.filter((e) => e.kind > pivot.kind)`）。`schedule_remove` で
 *    錨そのものが外されることは普通に起きるので、ここでエラーにはしない
 *    （実在検査をしない、という点は `commitment-cursor.ts` と同じ）。
 *
 * **⚠️ 第二の手段の限界を認めておく。** 比較は JS の文字列比較（コード
 * ポイント順）であって、pg 実装の `asc(schedules.kind)` が使う照合順序と
 * 厳密に一致する保証は無い（`kind` は英小文字・数字・`. _ -` を許すので、
 * 記号混じりの並びがロケール依存の照合と食い違う余地がある）。**だから
 * 比較は第二の手段（錨が消えていたときの保険）に留める**——通常経路
 * （第一の手段）はストアが返した並びをそのまま使うので、この限界には
 * 晒されない。
 *
 * ## `index.ts` へ export しない
 *
 * `commitment-cursor.ts` / `approval-cursor.ts` が `index.ts` の公開 API に
 * 出ているのは、**`apps/daemon` の HTTP 側に対応する口が在り、同じ契約を
 * 2箇所（MCP と HTTP）で独立に実装しているから**である。`schedule_list` に
 * はその対応物（カーソル付きの `GET /schedules` 相当）が無いので、**出す先
 * が無い export を足さない**——#661 が「本番の呼び出し元が0件の関数を
 * 作って歯だけ緑にした」形を、ここで繰り返さないため。
 *
 * ## `includeClosed` / `order` に相当する状態を持たない
 *
 * `CommitmentCursor` は「刷られた一覧の `includeClosed` / `order`」を持ち、
 * 食い違えば明示のエラーにする。`schedule_list` にはその2つに相当する
 * 引数（片付いた／未了の区別、並び順を変える指定）がそもそも無いので、
 * その状態もここでは作らない——存在しない引数のための mismatch 分岐を
 * 作ると、道具に無い機能を仄めかすことになる。
 */
const scheduleCursorSchema = z.object({ kind: z.string().min(1) });

export type ScheduleCursor = z.infer<typeof scheduleCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeScheduleCursor(cursor: ScheduleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeScheduleCursorResult = { ok: true; cursor: ScheduleCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、また
 * は schema に合わない）`{ ok: false }`。** 実在検査はしない——
 * `resolveScheduleCursor` が「位置の探索 → 比較」の順で辿るので、ここで
 * 錨の実在を確かめる必要が無い（`commitment-cursor.ts` の
 * `decodeCommitmentCursor` と同じ理由）。
 */
export function decodeScheduleCursor(raw: string): DecodeScheduleCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = scheduleCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries`（`ScheduleStore.list()` の契約どおり
 * `kind` 昇順で来ているもの）から、その位置より後ろだけを残す。**純関数。
 * I/O を持たない**（`ScheduledRequest[]` の配列を渡すだけで呼べる——
 * `schedule-cursor.test.ts` はストアを1つも作らずにこれを直接叩く）。
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）。`{ kind: 'ok', view:
 *   [...entries] }`
 * - decode できない: `{ kind: 'malformed' }`——**黙って先頭からへは倒さない**
 *   （AGENTS.md「判定できないという3つ目の状態を持つ」と同じ理由。黙って
 *   先頭へ戻すと、呼び手は「続きを読んだつもり」で同じ行を繰り返し読む）
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（カーソルが
 *   一覧の末尾を指していた＝最後の頁）——これは呼び出し側が「もう続きは
 *   無い」として扱う、正常な終端であってエラーではない
 */
export function resolveScheduleCursor(
  entries: readonly ScheduledRequest[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: ScheduledRequest[] } | { kind: 'malformed' } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeScheduleCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const pivotKind = decoded.cursor.kind;
  // 第一の手段: 位置の探索（ストアの並びをそのまま使う）。
  const index = entries.findIndex((entry) => entry.kind === pivotKind);
  if (index !== -1) return { kind: 'ok', view: entries.slice(index + 1) };
  // 第二の手段: 錨が消えていた（schedule_remove で外された等）ので比較へ
  // 落ちる。上の doc「第二の手段の限界」を参照。
  const view = entries.filter((entry) => entry.kind > pivotKind);
  return { kind: 'ok', view };
}
