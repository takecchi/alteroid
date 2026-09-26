import { PGlite } from '@electric-sql/pglite';
import { createCloneTools } from '@alteroid/core';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * Issue #1662（pg 実装で赤を取る）。
 *
 * `packages/storage-fs/src/memory-tool-slug-validation-1662.test.ts` の doc を
 * 見よ。ここでは同じ入力を pg 実装（PGlite = インプロセスの実 PostgreSQL）へ
 * 当てる。`PgPersonaStore#slug()`（`packages/storage-pg/src/persona.ts`）が
 * `memorySlugSchema` の検査に落ちた slug に対して同じ `Error: 記憶のスラッグが
 * 不正: …` を投げる——fs / pg のどちらの実装でも同じ形で赤くなる
 * （`practice_*` の非対称——fs は無検査・pg だけ throw——とは違い、
 * `memory_*` は fs も pg も両方が throw する）。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

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

describe('memory_* — 形式不正な slug の扱い（pg 実装。issue #1662。main では赤い）', () => {
  const invalidSlug = 'Invalid Slug!';

  it('memory_read: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await callRaw(tools, 'memory_read', { slug: invalidSlug });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_write: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await callRaw(tools, 'memory_write', {
      slug: invalidSlug,
      content: '本文',
      summary: '要約',
    });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });

  it('memory_delete: 形式不正な slug は生の例外を投げず、読める文で断る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await callRaw(tools, 'memory_delete', { slug: invalidSlug, summary: '要約' });
    expect(result.ok, result.ok ? '' : `生の例外が漏れた: ${String(result.error)}`).toBe(true);
    if (result.ok) expect(result.text).toContain('スラッグが不正');
  });
});
