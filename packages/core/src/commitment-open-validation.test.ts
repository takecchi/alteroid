import { describe, expect, it } from 'vitest';

import type { Commitment } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * `CommitmentStore.open()` の3実装の食い違い（issue #1652）。
 *
 * fs / pg の `open()` は `commitmentSchema.parse(entry)` を通してから書く
 * （`packages/storage-fs/src/commitments.ts` / `packages/storage-pg/src
 * /commitments.ts`）。**インメモリ実装だけが検査を持たなかった**
 * （`commitments.set(entry.id, isolate(entry))` を素通しで呼ぶだけ）。
 *
 * `commitmentSchema` の `at` は `isoDateTime`（`z.string().datetime({ offset:
 * true })`）——ISO 8601 の形式でなければ拒む。#1634/#1635/#1640 と同じ形。
 *
 * ここは fs / pg を基準にした期待値（`at` が ISO 8601 でない entry は拒む）を
 * インメモリにも当てる歯——`createMemoryStores()` の `commitmentStore.open`
 * が `commitmentSchema.parse` を通すようになったので緑になる
 * （`packages/storage-fs/src/commitment-open-validation.test.ts` /
 * `packages/storage-pg/src/commitment-open-validation.test.ts` と同じ形）。
 *
 * ⚠️ **到達経路は確かめていない。** `at` は通常 `Clone#commit` 側が
 * `new Date().toISOString()` で内部生成する値であり、外部入力がそのまま
 * ここへ渡る経路を実際に確認したわけではない。それでも3実装が同じ入力に
 * 対して同じ振る舞い（拒む）をすることは、それ自体独立した価値がある。
 */
describe('CommitmentStore.open() — at が ISO 8601 でない entry の扱い（インメモリ実装）', () => {
  const badEntry = {
    id: 'c1',
    at: 'not-a-date',
    origin: 'self',
    body: '何か頼まれた',
  } as unknown as Commitment;

  it('open() は fs / pg と同じく、at が ISO 8601 でない entry を拒む（throw する）', async () => {
    const stores = createMemoryStores();
    await expect(stores.commitments.open(badEntry)).rejects.toThrow();
  });
});
