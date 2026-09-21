import { z } from 'zod';

import type { MemoryDocumentMeta } from './schema.js';

/**
 * `memory_list` の継続点（issue #662）。
 *
 * ## なぜ要るか
 *
 * 一覧が予算（`MEMORY_LISTING_BUDGET`、`memory.ts`）で切れると、**落ちた
 * 文書の `slug` はこの一覧以外のどこからも得られない。** 断り書きは
 * `memory_read slug=<slug>` を案内していたが（逐語:
 * `grep -Fn -- '狙った文書が出ていなければ memory_read slug=<slug> で直接開けること。' packages/core/src/memory.ts`）、
 * **その `slug` の出所がこの一覧しか無いので、案内は空振りする。**
 *
 * 🔴 **そしてこれはクローンにとって「文書が消えた」と同じである**——
 * 索引に載っていない記憶は、読む側にとって存在しない。⟹ 予算で切れた
 * 瞬間に、その文書は到達不能になる。
 *
 * ## 錨は `slug` 単体（昇順）
 *
 * `PersonaStore.list()` は「**slug の昇順。**」で並ぶという契約を持つ
 * （逐語で当たる: `grep -Fn -- '**slug の昇順。**（#662 の継続点が依拠する契約）' packages/core/src/store.ts`）。
 * ⚠️ **その契約は #662 で書き足したものである**——3実装（fs / pg /
 * in-memory）は宣言の前から満たしていたが、interface には1行も無く、
 * **偶然揃っているだけの状態だった。** 継続点はその偶然に乗れないので、
 * 先に契約にした。
 *
 * `slug` は一意（`memorySlugSchema`、`PersonaStore.read(slug)` が単一の
 * 文書を返す契約）なので、`commitment-cursor.ts` のような複数軸の錨は
 * 要らない。
 *
 * ## `schedule-cursor.ts` と同じ2段（位置の探索 → 比較）
 *
 * 1. **第一の手段は位置の探索。** `entries` は契約どおり `slug` 昇順で
 *    来ているので、`findIndex` が当たれば `slice(index + 1)` を返す。
 *    **ストア自身の並びをそのまま使うので、照合順序（collation）の差に
 *    晒されない。**
 * 2. **錨の行が消えていたときだけ比較へ落とす**（`memory_forget` 等で
 *    文書が消えることは普通に起きる）。ここでエラーにはしない。
 *
 * **⚠️ 第二の手段の限界**（`schedule-cursor.ts` と同じ）: 比較は JS の
 * 文字列比較（コードポイント順）で、in-memory の `localeCompare` / pg の
 * `asc(memory.slug)` が使う照合順序と厳密に一致する保証は無い。**だから
 * 比較は保険に留める**——通常経路はストアが返した並びをそのまま使う。
 *
 * ## ⚠️ `schedule-cursor.ts` とあえて違えた点 —— 「後ろから」ではなく「ここから（含む）」
 *
 * `schedule_list` は**出す順と錨の順が同じ**（どちらも `kind` 昇順）なので、
 * 「最後に出した行の後ろから」で過不足なく続きが決まる。**`memory_list` は
 * そうではない**——描くのは `parent` から組んだ木の順（DFS。
 * `grep -Fn -- 'const flat = flattenMemoryToc(resolveMemoryHierarchy(tocEntries));' packages/core/src/memory.ts`）
 * で、錨はストアの `slug` 昇順である。⟹ **2つの順は一致しない。**
 *
 * 具体例: 根が `a` と `b`、`a` の子が `z` のとき、描く順は `a, z, b`
 * だが slug 順は `a, b, z`。予算がここで切れて `b` が落ちると:
 *
 * - 「**最後に出した行（`z`）の後ろから**」⟹ 🔴 **`b` が永久に飛ぶ**
 * - 「**落ちた中でいちばん小さい slug（`b`）から（含む）**」⟹ ⚠️ `z` が
 *   次の頁にもう一度出るが、**1件も失われない**
 *
 * ⟹ ⭐ **後者を採る。** この継続点が在る理由は「落ちた文書が到達不能に
 * ならないこと」であって、重複を避けることではない。**欠落と重複が
 * 両立しないなら、欠落しない側へ倒す。**
 *
 * ## `index.ts` へ export しない
 *
 * `schedule-cursor.ts` と同じ理由——`memory_list` にはカーソル付きの HTTP
 * 対応物（`GET /memory` 相当）が無いので、**出す先が無い export を足さない**。
 */
const memoryCursorSchema = z.object({ from: z.string().min(1) });

export type MemoryCursor = z.infer<typeof memoryCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeMemoryCursor(cursor: MemoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeMemoryCursorResult = { ok: true; cursor: MemoryCursor } | { ok: false };

/**
 * カーソルを decode する。**壊れていれば（base64/JSON として読めない、
 * または schema に合わない）`{ ok: false }`。** 実在検査はしない——
 * `resolveMemoryCursor` が「位置の探索 → 比較」の順で辿るので、ここで
 * 錨の実在を確かめる必要が無い。
 */
export function decodeMemoryCursor(raw: string): DecodeMemoryCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = memoryCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/**
 * `cursor` を受け取り、`entries`（`PersonaStore.list()` の契約どおり `slug`
 * 昇順で来ているもの）から、その位置より後ろだけを残す。**純関数。I/O を
 * 持たない**（`MemoryDocumentMeta[]` を渡すだけで呼べる）。
 *
 * - `cursorRaw` が `undefined`: 絞らない（先頭から）
 * - decode できない: `{ kind: 'malformed' }`——**黙って先頭からへは倒さない**
 *   （倒すと、呼び手は「続きを読んだつもり」で同じ行を繰り返し読む）
 * - それ以外: `{ kind: 'ok', view }`。`view` は0件のこともある（＝最後の頁。
 *   正常な終端であってエラーではない）
 */
export function resolveMemoryCursor(
  entries: readonly MemoryDocumentMeta[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: MemoryDocumentMeta[] } | { kind: 'malformed' } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeMemoryCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const pivotSlug = decoded.cursor.from;
  // 第一の手段: 位置の探索（ストアの並びをそのまま使う）。
  const index = entries.findIndex((entry) => entry.slug === pivotSlug);
  if (index !== -1) return { kind: 'ok', view: entries.slice(index) };
  // 第二の手段: 錨が消えていた（文書が消された等）ので比較へ落ちる。
  return { kind: 'ok', view: entries.filter((entry) => entry.slug >= pivotSlug) };
}
