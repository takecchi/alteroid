import { PGlite } from '@electric-sql/pglite';
import { createCloneTools } from '@alteroid/core';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';

/**
 * Issue #1651（pg 実装に対する確認）。
 *
 * `packages/core/src/practice-tools.test.ts`（「形式不正な slug は保存層を
 * 呼ぶ前に断る」の節）と同じ入力を、**pg 実装（PGlite = インプロセスの実
 * PostgreSQL）**に対して当てる。
 *
 * 直す前は、`PgPracticeStore#slug()`（`packages/storage-pg/src/practices.ts`）が
 * `practiceSlugSchema` の検査に落ちた slug に対して
 * `Error: やり方のスラッグが不正: …` を素で投げていた——道具
 * （`tools.ts` の `practice_read` / `practice_history` / `practice_remove` /
 * `practice_write`）はそれを一切捕まえず、クローンには読めない生の例外が
 * 返っていた（`packages/storage-pg/src/practices-invalid-slug.test.ts` が
 * 保存層そのものに対してこれを固定している。**あちらは直さない**——
 * マネージャーの判断で `#slug()` の throw はそのまま残す）。
 *
 * ここでは「道具として呼んだときに、その生の例外が外へ漏れないこと」を
 * 確かめる——直した後は道具の側で先に断るので、`PgPracticeStore#slug()`
 * まで呼び出しが届かない。
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

async function textOf(
  result: Awaited<ReturnType<ReturnType<typeof toolHandler>>>,
): Promise<string> {
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join('');
}

describe('practice_* — 形式不正な slug の扱い（pg 実装。issue #1651 の道具側の確認）', () => {
  const invalidSlug = 'Invalid Slug!';

  it('practice_read: PgPracticeStore#slug() の生の例外が返らず、「スラッグが不正」と返る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await toolHandler(tools, 'practice_read')(
      { slug: invalidSlug } as never,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    expect(await textOf(result)).toContain('スラッグが不正');
  });

  it('practice_history: PgPracticeStore#slug() の生の例外が返らず、「スラッグが不正」と返る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await toolHandler(tools, 'practice_history')(
      { slug: invalidSlug } as never,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    expect(await textOf(result)).toContain('スラッグが不正');
  });

  it('practice_remove: PgPracticeStore#slug() の生の例外が返らず、「スラッグが不正」と返る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await toolHandler(tools, 'practice_remove')(
      { slug: invalidSlug } as never,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    expect(await textOf(result)).toContain('スラッグが不正');
  });

  it('practice_write: PgPracticeStore#slug() の生の例外が返らず、「スラッグが不正」と返る', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const result = await toolHandler(tools, 'practice_write')(
      { slug: invalidSlug, kind: '調査', title: '題', content: '本文' } as never,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    expect(await textOf(result)).toContain('スラッグが不正');
  });

  it('比較対象: 形式が正しい slug は今までどおり通る（pg 実装）', async () => {
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    await toolHandler(tools, 'practice_write')(
      { slug: 'investigate', kind: '調査', title: '題', content: '本文' } as never,
      {} as never,
    );
    const result = await toolHandler(tools, 'practice_read')(
      { slug: 'investigate' } as never,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    expect(await textOf(result)).toContain('本文');
  });
});
