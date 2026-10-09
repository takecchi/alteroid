import { z } from 'zod';

import type { MemoryDocumentMeta } from './schema.js';

/**
 * `memory_list` の継続点。一覧が予算で切れると、落ちた文書の `slug` はこの一覧以外のどこからも得られず、
 * 索引に載らない記憶は読む側にとって存在しない（`memory_read slug=<slug>` の案内も空振りする）。
 * 錨は `slug` 単体（昇順）: `PersonaStore.list()` が slug 昇順を契約としていて、継続点はそれに依拠する。
 *
 * ## ⚠️ `schedule-cursor.ts` とあえて違えた点 —— 「後ろから」ではなく「ここから（含む）」
 *
 * 描く順（`parent` の木の DFS）と錨の順（`slug` 昇順）が一致しない。根が `a` と `b`、`a` の子が `z` なら
 * 描く順は `a, z, b` で、`b` が落ちたとき「最後に出した行（`z`）の後ろから」だと `b` が永久に飛ぶ。
 * 「落ちた中でいちばん小さい slug から（含む）」なら `z` が重複するだけで欠落しない。
 * **欠落と重複が両立しないなら、欠落しない側へ倒す。**
 *
 * ## 🔴 頁が必ず進むこと
 *
 * 「含む」だけだと同じ cursor が返り続けることがある（子 `b`・親 `z` の前に予算を食う root が並ぶと `b` が毎回落ちる）。
 * view の先頭（錨）を親から切り離して必ず先頭に描くことで、`from` が頁ごとに厳密に進む。
 * 「落ちた中の最初」は JS の文字列比較でなく view（ストア順）で取る: 食い違うと間の文書が飛ぶ。
 *
 * 第二の手段（比較）は保険に留める: JS の文字列比較は in-memory の `localeCompare` / pg の
 * 照合順序と一致する保証が無く、通常経路はストアの並びをそのまま使う。
 * `index.ts` へ export しない: カーソル付きの HTTP 対応物が無く、出す先が無い。
 */
const memoryCursorSchema = z.object({ from: z.string().min(1) });

export type MemoryCursor = z.infer<typeof memoryCursorSchema>;

export function encodeMemoryCursor(cursor: MemoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeMemoryCursorResult = { ok: true; cursor: MemoryCursor } | { ok: false };

// 錨の実在は検査しない: `resolveMemoryCursor` が位置の探索から比較の順で辿るので、ここで確かめる必要が無い。
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

// decode できなければ黙って先頭からへは倒さない（倒すと、呼び手は続きを読んだつもりで同じ行を繰り返し読む）。
export function resolveMemoryCursor(
  entries: readonly MemoryDocumentMeta[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: MemoryDocumentMeta[]; anchor?: string } | { kind: 'malformed' } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeMemoryCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const pivotSlug = decoded.cursor.from;
  const index = entries.findIndex((entry) => entry.slug === pivotSlug);
  const view =
    index !== -1 ? entries.slice(index) : entries.filter((entry) => entry.slug >= pivotSlug);
  // `renderMemoryListing` が anchor を必ず先頭に描く（頁が進むことの保証。冒頭 doc「頁が必ず進むこと」）。
  return { kind: 'ok', view, anchor: view[0]?.slug };
}
