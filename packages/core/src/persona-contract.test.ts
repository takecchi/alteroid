import { describe, expect, it } from 'vitest';

import { MemoryConflictError, ensureTrailingNewline, memoryVersion } from './store.js';
import { createMemoryStores } from './testing.js';

// 共有スイートにしない: `vitest` が `@alteroid/core` の実行時の依存になる（storage-fs / storage-pg は core を `dist/index.js` 経由で読む）。
// fs は `packages/storage-fs/src/index.test.ts`、pg は `packages/storage-pg/src/index.persona.test.ts` に同じ形の歯がある。
describe('PersonaStore の契約（インメモリ実装）', () => {
  describe('write の前提の版 ifMatch（Issue #2743。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ版と同じなら書ける。違えば書かずに MemoryConflictError（current は書かれている文書）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const read = await stores.persona.read('values');
      const v1 = memoryVersion(read?.content ?? '');
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

  describe('remove の前提の版 ifMatch（Issue #2881。fs・pg・インメモリで同じ挙動）', () => {
    it('読んだ後に別の書き手が書いたなら、消さずに MemoryConflictError（current は書かれている文書）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const v1 = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      await stores.persona.write('values', '# 価値観\n\nV1\n\nクローンの判断\n');

      const error = await stores.persona.remove('values', { ifMatch: v1 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current?.content).toContain('クローンの判断');
      expect((await stores.persona.read('values'))?.content).toContain('クローンの判断');
    });

    it('版が合えば消せる。無い文書に版を指定したら MemoryConflictError（current は null）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n\nV1\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      await stores.persona.remove('values', { ifMatch: v });
      expect(await stores.persona.read('values')).toBeNull();

      const error = await stores.persona.remove('values', { ifMatch: v }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoryConflictError);
      expect((error as MemoryConflictError).current).toBeNull();
    });

    it('同じ版を前提にした書き込みと削除が重なっても、勝つのは1つだけ', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n');
      const v = memoryVersion((await stores.persona.read('values'))?.content ?? '');
      const results = await Promise.allSettled([
        stores.persona.write('values', '# 一\n', { ifMatch: v }),
        stores.persona.remove('values', { ifMatch: v }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('ifMatch を付けなければ従来どおり無条件に消す（後方互換）', async () => {
      const stores = createMemoryStores();
      await stores.persona.write('values', '# 価値観\n');
      await stores.persona.remove('values');
      expect(await stores.persona.read('values')).toBeNull();
    });
  });

  it('write した本文は、末尾の改行が正規化されて読み戻る', async () => {
    const stores = createMemoryStores();

    const written = await stores.persona.write('values', '# 価値観');

    expect(written.content).toBe('# 価値観\n');
    expect((await stores.persona.read('values'))?.content).toBe('# 価値観\n');
  });

  it('既に改行で終わっている本文へは、改行を足さない', async () => {
    const stores = createMemoryStores();

    const written = await stores.persona.write('values', '# 価値観\n');

    expect(written.content).toBe('# 価値観\n');
  });

  it('bytes は正規化した後の本文を数える', async () => {
    const stores = createMemoryStores();

    await stores.persona.write('values', '# X');

    expect((await stores.persona.read('values'))?.bytes).toBe(4);
  });

  // `append` と `write` が二重に守っているので、片方だけ外してもこの歯は落ちない。
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
