import { describe, expect, it } from 'vitest';

import { verifyPracticeStoreContract } from './practice-contract.js';
import { practiceSchema } from './schema.js';
import { createMemoryStores } from './testing.js';

describe('PracticeStore — 仕事のやり方を器に持つ（#1055 段3）', () => {
  it('インメモリ実装が契約を満たす（3実装のうちの1つ目）', async () => {
    const stores = createMemoryStores();
    await verifyPracticeStoreContract(stores.practices, { verifyClear: true });
  });

  it('⭐ やり方が1件も無いのは正常な状態である（空が前提を崩さない）', async () => {
    const stores = createMemoryStores();
    // 受け入れ基準「やり方が書かれていない仕事も普通に進む」。**空で落ちる器は
    // これを満たせない。** 「未設定」という異常状態を作らない。
    expect(await stores.practices.list()).toEqual([]);
    expect(await stores.practices.read('nothing-here')).toBeNull();
    expect(await stores.practices.clear()).toBe(0);
    await stores.practices.remove('nothing-here');
  });

  it('⭐ `kind` は自由文字列である（知らない種類を器が弾かない）', async () => {
    const stores = createMemoryStores();
    // ⛔ 列挙にした瞬間に「仕事の種類の一覧」を実装側が決めることになる
    // （`practiceKindSchema` の doc / north_star「実装専用に狭めるな」）。
    for (const kind of [
      '実装',
      '調査',
      '相談',
      'レビュー',
      '日報',
      '外部サービスの確認',
      'まだ名前の無い何か',
    ]) {
      const written = await stores.practices.write({
        slug: `k-${encodeURIComponent(kind).toLowerCase().replaceAll('%', '')}`,
        kind,
        title: kind,
        content: 'x',
      });
      expect(written.kind).toBe(kind);
    }
  });

  it('⭐ schema に「実行される」欄が無い（器が実行を強制しない）', () => {
    // ⛔ **この歯は、将来この器へ `steps` / `required` / `enforce` /
    // `commands` の類を足そうとしたときに赤くなるためだけに在る。**
    // 足した時点でクローンは「制限された自動化ジョブ」に戻る（north_star）。
    // 赤くなったら、直すのは歯ではなく足したほうである。
    const keys = Object.keys(practiceSchema.shape).sort();
    expect(keys).toEqual(['bytes', 'content', 'createdAt', 'kind', 'slug', 'title', 'updatedAt']);
  });

  it('上書きでは createdAt を引き継ぎ、updatedAt だけが進む', async () => {
    const stores = createMemoryStores();
    const first = await stores.practices.write({
      slug: 'review',
      kind: 'レビュー',
      title: 'レビューのやり方',
      content: 'a',
    });
    const second = await stores.practices.write({
      slug: 'review',
      kind: 'レビュー',
      title: 'レビューのやり方（改）',
      content: 'bbb',
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.title).toBe('レビューのやり方（改）');
    expect(second.bytes).toBe('bbb\n'.length);
  });

  it('不正な slug は書けない（経路要素を含めない）', async () => {
    const stores = createMemoryStores();
    await expect(
      stores.practices.write({ slug: '../escape', kind: '実装', title: 'x', content: 'y' }),
    ).rejects.toThrow();
  });
});
