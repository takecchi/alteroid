import { describe, expect, it } from 'vitest';

import { createMemoryStores } from './testing.js';

/**
 * `PersonaStore.protectionStatus()` の3実装の食い違いを塞ぐ（issue #1700）。
 *
 * 形式不正な slug（`memorySlugSchema` に落ちる。例 `"Invalid Slug!"`）を
 * 渡すと、pg は `#slug()` で throw するが、**fs / インメモリは「一致する
 * 行が無い」として `{ kind: 'unknown' }` を返していた**（素通り）。
 *
 * #1634/#1635/#1640（`PersonaStore.read/write/append/remove` の slug 検査が
 * 実装ごとに違っていた）と同じ形——今回は `protectionStatus` で、pg だけが
 * 検査していた。
 *
 * pg を基準にした期待値（形式不正な slug は throw する）を fs / インメモリ
 * にも当てる——3実装とも `memorySlugSchema` の検査を通すようになったので
 * 緑になる（`packages/storage-fs/src/persona-protection-status-invalid-slug.test.ts` /
 * `packages/storage-pg/src/persona-protection-status-invalid-slug.test.ts`
 * と同じ形）。
 *
 * ⚠️ **到達経路は確認済み——直接は届かない。** `protectionStatus` を呼ぶのは
 * `packages/core/src/tools.ts` の `guardFullReplace()` だけで、その4つの
 * 呼び出し元（`memory_write` / `memory_delete` / `memory_frontmatter_set` /
 * `memory_section_move`）は全部、`guardFullReplace` を呼ぶより前に
 * `memorySlugSchema.safeParse(slug)` で断っている（issue #1662）。HTTP 層
 * （`apps/daemon/src/app.ts`）は `protectionStatus` を呼んでいない。
 */
describe('PersonaStore.protectionStatus() — 形式不正な slug の扱い（インメモリ実装）', () => {
  const invalidSlug = 'Invalid Slug!';

  it('protectionStatus() は pg と同じく、形式不正な slug を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.persona.protectionStatus(invalidSlug)).rejects.toThrow();
  });
});
