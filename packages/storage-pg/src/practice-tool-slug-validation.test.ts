import { createCloneTools } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { createMigratedTestDb } from './test-db.test-support.js';

let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ db } = await createMigratedTestDb());
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
