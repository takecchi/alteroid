import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * `PersonaStore.markHumanTouched()` / `markCreatedAt()` の3実装の食い違いを
 * 塞ぐ（issue #1700。#1675 が報告した形とは向きが逆だった——詳細は #1700）。
 *
 * 直す前の実測:
 *
 * - **pg**: `#slug()`（`memorySlugSchema.safeParse`）を直接通してから
 *   `UPDATE` する——形式不正な slug を渡すと `Error: 記憶のスラッグが不正` を
 *   throw する。
 * - **fs**: 直接の slug 検査を持たず、`markHumanTouched` / `markCreatedAt`
 *   はどちらも「index にエントリが無ければ `this.read(slug)` で実体の有無を
 *   確かめる」という分岐（`if (entry === undefined && (await
 *   this.read(slug)) === null) return;`）を経由して**間接的に** throw して
 *   いた——実体が既にある slug（あり得ないが）に対しては効かない、という
 *   偶然の穴を持っていた。
 * - **インメモリ**: 同じ分岐はあるが `this.read(slug)` を呼ばず、
 *   `documents.has(slug)` / `humanTouchedAt.has(slug)` という `Map` の有無
 *   だけで判定していたので、slug の形式を一度も検査せず no-op で正常終了
 *   していた。
 *
 * ⟹ いまは3実装とも `memorySlugSchema` を直接通す（fs は間接検査をやめ、
 * インメモリは pg / fs と同じ検査を新しく持つ）ので、3実装とも throw する。
 *
 * ⚠️ **到達経路は確認済み——直接は届かない。** `markHumanTouched` の
 * 呼び出し元は `apps/daemon/src/app.ts` の `PUT /memory/:slug`
 * （`memorySlugSchema.safeParse` で先に断る）と `apps/daemon/src/storage.ts`
 * の起動時 backfill（journal から導出した slug——journal へ書く経路
 * （HTTP / クローンの道具）はどちらも書き込み前に検査済みなので、形式不正な
 * slug が journal に載ることはまず無い）だけである。`markCreatedAt` の
 * 呼び出し元は backfill だけ。
 */
describe('PersonaStore.markHumanTouched() / markCreatedAt() — 形式不正な slug の扱い（インメモリ実装）', () => {
  const invalidSlug = 'Invalid Slug!';
  const at = new Date().toISOString();

  it('markHumanTouched() は fs / pg と同じく、形式不正な slug を拒む（throw する）ことを期待する', async () => {
    const stores = createMemoryStores();
    await expect(stores.persona.markHumanTouched(invalidSlug, at)).rejects.toThrow();
  });

  it('markCreatedAt() は fs / pg と同じく、形式不正な slug を拒む（throw する）ことを期待する', async () => {
    const stores = createMemoryStores();
    await expect(stores.persona.markCreatedAt(invalidSlug, at)).rejects.toThrow();
  });
});
