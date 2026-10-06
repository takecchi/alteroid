import { describe, expect, it, vi } from 'vitest';

import { practiceKindSchema } from './schema.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, formatPracticeKindRangeJa } from './tools.js';

/**
 * issue #2450。`practice_write` の `kind` は道具の側で検査されておらず、
 * 空文字や129字以上の `kind` を渡すと保存層の `parse` が投げた生の ZodError
 * がそのままクローンへ返っていた（`PUT /practices/:slug` は `practiceBody`
 * の検査で 400 を返す）。
 *
 * ここでは (1) 範囲外の `kind` では commitment 系と同じ形の読める文
 * （`kind は使えない（…のみ）。`）が返り、`write()` が呼ばれず日誌も増えない
 * こと (2) 境界値そのもの（1字・上限の字数）は今までどおり書けること、を測る。
 *
 * 入力スキーマ側の検査（SDK の `tool()` がハンドラより前に見る）は
 * `tool-non-numeric-args-handler-validation-1752.test.ts` の往復で見ている
 * 形と同じで、`kind` の入力スキーマはこの PR で変えていない（`z.string()`
 * のまま）。ここはハンドラを直接叩く。
 */

function harness() {
  const stores = createMemoryStores();
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  const found = tools.find((entry) => entry.name === 'practice_write');
  if (!found) throw new Error('ツール practice_write が無い');
  return {
    stores,
    async call(args: Record<string, unknown>): Promise<string> {
      const result = await found.handler(args as never, {});
      return (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    },
  };
}

const max = practiceKindSchema.maxLength ?? 128;

describe('practice_write の kind — 範囲外は読める文で断り、書かない（issue #2450）', () => {
  it.each([
    { label: '空文字', kind: '' },
    { label: `${max + 1}字`, kind: 'あ'.repeat(max + 1) },
  ])('$label の kind は「kind は使えない」で断り、write() を呼ばない', async ({ kind }) => {
    const h = harness();
    const write = vi.spyOn(h.stores.practices, 'write');
    const journalBefore = (await h.stores.journal.list()).length;

    const body = await h.call({ slug: 'ok', kind, title: 't', content: 'c' });

    expect(body).toBe(`kind は使えない（${formatPracticeKindRangeJa()}のみ）。`);
    expect(write).not.toHaveBeenCalled();
    expect(await h.stores.practices.read('ok')).toBeNull();
    expect((await h.stores.journal.list()).length).toBe(journalBefore);
  });

  it.each([
    { label: '1字', kind: 'x' },
    { label: `${max}字`, kind: 'あ'.repeat(max) },
  ])('境界値（$label）の kind は今までどおり書ける', async ({ kind }) => {
    const h = harness();
    const body = await h.call({ slug: 'ok', kind, title: 't', content: 'c' });

    expect(body).not.toContain('は使えない');
    const stored = await h.stores.practices.read('ok');
    expect(stored?.kind).toBe(kind);
  });
});

describe('practice_write の kind — NUL だけの値は読める文で断り、書かない（issue #3361）', () => {
  it('NUL だけの kind は理由の読める文で断り、write() を呼ばず日誌も増えない（生の ZodError を投げない）', async () => {
    const h = harness();
    const write = vi.spyOn(h.stores.practices, 'write');
    const journalBefore = (await h.stores.journal.list()).length;

    const body = await h.call({ slug: 'ok', kind: '\u0000', title: 't', content: 'c' });

    expect(body).toBe(
      `kind は使えない（NUL（\\u0000）だけの値は空と同じ。${formatPracticeKindRangeJa()}のみ）。`,
    );
    expect(write).not.toHaveBeenCalled();
    expect(await h.stores.practices.read('ok')).toBeNull();
    expect((await h.stores.journal.list()).length).toBe(journalBefore);
  });

  it('NUL を含んでも落とした後に残る kind は、今までどおり落として書ける', async () => {
    const h = harness();
    const body = await h.call({ slug: 'ok', kind: '調\u0000査', title: 't', content: 'c' });

    expect(body).not.toContain('は使えない');
    expect((await h.stores.practices.read('ok'))?.kind).toBe('調査');
  });
});
