import { beforeEach, describe, expect, it } from 'vitest';

import { createCloneTools } from '@alteroid/core';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createFsStores } from './index.js';

/**
 * Issue #1662（fs 実装で赤を取る）。
 *
 * #1651 で直した `schedule_create` / `practice_*` と**同じ形の穴**が
 * `memory_*`（スラッグを受ける道具全部）にも残っている——`packages/core/src/
 * tools.ts` は `memorySlugSchema` を1箇所も import/使用していない
 * （`grep -n "memorySlugSchema" packages/core/src/tools.ts` が0ヒット）。
 *
 * `FsPersonaStore#path()`（`packages/storage-fs/src/persona.ts:147-151`）は
 * `memorySlugSchema.safeParse` に落ちる slug に対して
 * `throw new Error('記憶のスラッグが不正: …')` する——**これは `read()` /
 * `write()`（内部で `#writeNow` 経由）/ `append()`（内部で `read()` 経由）/
 * `remove()` のすべてで、`await` の手前・同期的に投げる。** クローンの道具
 * （`memory_read` / `memory_write` / `memory_append` / `memory_delete` /
 * `memory_frontmatter_set` / `memory_outline` / `memory_section_read` /
 * `memory_section_move`）はどれも `practiceSlugSchema` 相当の事前検査を
 * 持たないので、形式不正な slug を渡すと**この生の例外がハンドラの外へ
 * そのまま抜ける**——`MCP_INPUT_VALIDATION_ERROR_MARKER` を含まない、
 * クローンには読めない例外である。
 *
 * ここでは `entry.handler(args)` を直接叩く（#1651 の `practice-tools.test.ts`
 * と同じ最小の足場）。**スキーマレベルの検査ではなくハンドラ内で先に断る
 * 設計にする予定なので、直接呼びで測って構わない**（`schedule_create` の
 * `.min(1)` のようにスキーマ側で断る設計にするなら、この歯は本物の MCP
 * 往復に差し替える必要があるが、practice_* の前例（ハンドラ先頭で
 * `safeParse`）に揃えるならこのままで測れる）。
 */

function toolHandler(tools: ReturnType<typeof createCloneTools>, name: string) {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`ツール ${name} が無い`);
  return found.handler;
}

async function callRaw(
  tools: ReturnType<typeof createCloneTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; error: unknown }> {
  try {
    const result = await toolHandler(tools, name)(args as never, {} as never);
    const responseText = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    return { ok: true, text: responseText };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('memory_* — 形式不正な slug の扱い（fs 実装。issue #1662。main では赤い）', () => {
  const invalidSlug = 'Invalid Slug!';
  let stores: ReturnType<typeof createFsStores>;
  let tools: ReturnType<typeof createCloneTools>;

  beforeEach(async () => {
    const root = await makeTempDir('alteroid-test-');
    stores = createFsStores(root);
    tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
  });

  it('memory_read: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_read', { slug: invalidSlug });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_write: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_write', {
      slug: invalidSlug,
      content: '本文',
      summary: '要約',
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_append: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_append', {
      slug: invalidSlug,
      content: '追記',
      summary: '要約',
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_delete: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_delete', { slug: invalidSlug, summary: '要約' });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_frontmatter_set: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_frontmatter_set', {
      slug: invalidSlug,
      description: '要旨',
      summary: '要約',
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_outline: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_outline', { slug: invalidSlug });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_section_read: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_section_read', {
      slug: invalidSlug,
      sections: ['dummy'],
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_section_move: fromSlug が形式不正でも生の例外を投げず、読める文で断る', async () => {
    const result = await callRaw(tools, 'memory_section_move', {
      fromSlug: invalidSlug,
      sections: ['dummy'],
      toSlug: 'valid-dest',
      summary: '要約',
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_section_move: toSlug が形式不正でも生の例外を投げず、読める文で断る', async () => {
    // fromSlug 側を実在させ、本物の節id を用意してから toSlug だけ不正にする。
    await toolHandler(tools, 'memory_write')(
      { slug: 'valid-source', content: '# 節1\n\n本文\n', summary: '準備' } as never,
      {} as never,
    );
    const outline = await toolHandler(tools, 'memory_outline')(
      { slug: 'valid-source' } as never,
      {} as never,
    );
    const outlineText = (outline.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    const sectionId = /\[([^\]]+)\]/.exec(outlineText)?.[1];
    expect(sectionId, `節idが取れなかった: ${outlineText}`).toBeDefined();

    const result = await callRaw(tools, 'memory_section_move', {
      fromSlug: 'valid-source',
      sections: [sectionId],
      toSlug: invalidSlug,
      summary: '要約',
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('比較対象: 形式が正しい slug は今までどおり通る（memory_read）', async () => {
    await toolHandler(tools, 'memory_write')(
      { slug: 'investigate', content: '本文', summary: '準備' } as never,
      {} as never,
    );
    const result = await callRaw(tools, 'memory_read', { slug: 'investigate' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('本文');
  });
});
