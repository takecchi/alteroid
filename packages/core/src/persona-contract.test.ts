import { describe, expect, it } from 'vitest';

import { MemoryConflictError, ensureTrailingNewline, memoryVersion } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * `PersonaStore` の契約（`store.ts` の `write` / `append` の doc）を、
 * **インメモリ実装（`testing.ts`）に対して**測る。
 *
 * **同じ形の歯が3つ在る。1つで測って3つとも測ったことにしない**（#370 の主題
 * そのものである）:
 *
 * - fs — `packages/storage-fs/src/index.test.ts`
 * - pg — `packages/storage-pg/src/index.persona.test.ts`
 * - インメモリ — このファイル
 *
 * **なぜ3つに分けて書いてあり、1本の共有スイートにしていないか。** 共有スイート
 * にすると `vitest` を `@alteroid/core` の実行時の依存へ持ち込むことになる
 * （`storage-fs` / `storage-pg` は core を `dist/index.js` 経由で読むので、
 * 参照させるにはその口へ載せるしかない）。core の `dist` はデーモン・runner・
 * CLI とブラウザ向けの軽い口が読むものである。**共有したのは歯ではなく、歯が
 * 測っている当のもの（`ensureTrailingNewline`）のほうである** — 3実装が同じ
 * 関数を通っているので、実装が食い違うには誰かがその呼びを外すしかない。
 */
describe('PersonaStore の契約（インメモリ実装）', () => {
  describe('write の前提の版 ifMatch（Issue #2743。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ版と同じなら書ける。違えば書かずに MemoryConflictError（current は書かれている文書）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const read = await stores.persona.read('values');
      const v1 = memoryVersion(read?.content ?? '');
      // 読んだ後に別の書き手（クローン）が書く
      await stores.persona.write('values', '# 価値観\n\nV1\n\nクローンの判断\n');

      const error = await stores.persona
        .write('values', '# 価値観\n\n人間の編集\n', { ifMatch: v1 })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current?.content).toContain('クローンの判断');
      expect((await stores.persona.read('values'))?.content).toContain('クローンの判断');

      const latest = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const ok = await stores.persona.write('values', '# 価値観\n\n人間の編集\n', {
        ifMatch: latest,
      });
      expect(ok.content).toBe('# 価値観\n\n人間の編集\n');
    });

    it('null は「無かった」: 無ければ作れ、在れば書かない。在るものを null 前提で書かない', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# A\n', { ifMatch: null });
      const error = await stores.persona
        .write('values', '# B\n', { ifMatch: null })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((await stores.persona.read('values'))?.content).toBe('# A\n');
    });

    it('文書が無いのに版を指定したら 409（current は null）。書かれない', async () => {
      const stores = createMemoryStores();
      const error = await stores.persona
        .write('values', '# B\n', { ifMatch: memoryVersion('# 昔あった\n') })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current).toBeNull();
      expect(await stores.persona.read('values')).toBeNull();
    });

    it('同じ版を前提にした2つの書き込みが重なっても、勝つのは1つだけ', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const results = await Promise.allSettled([
        stores.persona.write('values', '# 一\n', { ifMatch: v }),
        stores.persona.write('values', '# 二\n', { ifMatch: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('ifMatch を付けなければ従来どおり後勝ち（後方互換）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      await stores.persona.write('values', '# 価値観\n\nV2\n');
      await stores.persona.write('values', '# 価値観\n\nV3\n', {});
      expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n\nV3\n');
    });
  });
  it('write した本文は、末尾の改行が正規化されて読み戻る', async () => {
    const stores = createMemoryStores();

    // 末尾に改行を持たない形で渡す（呼び手の側では正規化しない）。
    const written = await stores.persona.write('values', '# 価値観');

    expect(written.content).toBe('# 価値観\n');
    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n');
  });

  it('既に改行で終わっている本文へは、改行を足さない', async () => {
    const stores = createMemoryStores();

    const written = await stores.persona.write('values', '# 価値観\n');

    expect(written.content).toBe('# 価値観\n');
  });

  /**
   * **`bytes` は正規化した後の本文を数える。** fs は `stat` が返す
   * `stats.size`（＝ ファイルに書いた正規化後のバイト数）なので、インメモリが
   * 正規化前の長さを数えていると、同じ `write` に対して `list()` の出す数が
   * 1バイトずれる。
   */
  it('bytes は正規化した後の本文を数える', async () => {
    const stores = createMemoryStores();

    await stores.persona.write('values', '# X');

    expect((await stores.persona.read('values'))?.bytes).toBe(4);
  });

  /**
   * fs / pg と同じ性質をインメモリでも測る（#354 の歯の3つ目）。
   * `memory_append` の説明文（`tools.ts`）が言い切っている「消えた見出しは常に
   * 0 件のはずである」は、**追記が既存の本文を行の境界を保ったまま前置きする
   * こと**にしか依っていない。
   *
   * **インメモリもこれを二重に守っている**（`testing.ts`）: `append` が
   * `ensureTrailingNewline(existing.content)` を通すことと、`write` が書き込みの
   * たびに `ensureTrailingNewline(content)` を通すこと。**片方だけ外してもこの歯
   * は落ちない**——落ちないことは「守られていない」ではなく、もう片方が効いて
   * いるという意味である（fs / pg で #354 が実測した形と同じ）。
   */
  it('末尾の行が見出しの文書へ追記しても、その見出しの行が壊れない', async () => {
    const stores = createMemoryStores();

    await stores.persona.write('log', '# ログ\n\n## 最後の節');
    const doc = await stores.persona.append('log', '追記した1行');

    expect(doc.content.split('\n')).toContain('## 最後の節');
    expect(doc.content).toContain('追記した1行');
  });

  it('append は既存の本文との間に空行を1つ挟む（既存が改行で終わっていなくても）', async () => {
    const stores = createMemoryStores();

    await stores.persona.write('log', '# ログ');
    const doc = await stores.persona.append('log', '- 追記された学び');

    expect(doc.content).toBe('# ログ\n\n- 追記された学び\n');
  });
});

/**
 * 契約を満たすための共有の出所そのもの（`store.ts`）。
 *
 * **ここが1本になっている必要がある。** かつては `storage-fs` と `storage-pg`
 * に逐語で複製されていて、3つ目（インメモリ）はそれを持たないまま書かれた
 * （#370）。
 */
describe('ensureTrailingNewline', () => {
  it('改行で終わっていない文字列の末尾へ改行を1つ足す', () => {
    expect(ensureTrailingNewline('# X')).toBe('# X\n');
  });

  it('既に改行で終わっている文字列は変えない（改行を増やさない）', () => {
    expect(ensureTrailingNewline('# X\n')).toBe('# X\n');
    expect(ensureTrailingNewline('# X\n\n')).toBe('# X\n\n');
  });

  it('空文字は改行1つになる', () => {
    expect(ensureTrailingNewline('')).toBe('\n');
  });
});
