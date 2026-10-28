import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

// #5388: `archive_remove` の summary と `schedule_create` の request は、空・空白だけを消す・日誌を書く・仕込むより前に断る。

const NO_ONE_RUNNING = { runningManagerOwning: () => undefined } as unknown as ManagerPool;

function tool(stores: Stores, name: 'archive_remove' | 'schedule_create') {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: NO_ONE_RUNNING,
  };
  const found = createCloneTools(context).find((entry) => entry.name === name);
  expect(found, `${name} という道具が無い`).toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

const SUMMARY_EMPTY = 'summary は使えない（1文字以上のみ）。';
const SUMMARY_BLANK = 'summary は使えない（空白だけの値は空と同じ。1文字以上のみ）。';
const REQUEST_EMPTY = 'request が空文字は使えない（依頼の本文を渡すこと）。';
const REQUEST_BLANK = 'request は使えない（空白だけの値は空と同じ。1文字以上のみ）。';

describe('archive_remove — summary が空・空白だけのとき', () => {
  const cases: [string, string, string][] = [
    ['空文字', '', SUMMARY_EMPTY],
    ['NUL だけ', '\u0000', SUMMARY_EMPTY],
    ['空白だけ', '   ', SUMMARY_BLANK],
    ['改行と空白だけ', ' \n\t ', SUMMARY_BLANK],
  ];
  for (const [label, summary, expected] of cases) {
    it(`${label}は断り、本文も日誌も変えない`, async () => {
      const stores = createMemoryStores();
      const id = (await stores.archive.archive('sess-blank', 'BODY\n')).id;

      const reply = await tool(stores, 'archive_remove')({ archiveId: id, summary });

      expect(reply).toBe(expected);
      expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: 'BODY\n' });
      expect(await stores.journal.list({})).toEqual([]);
    });
  }

  it('通常の summary は従来どおり消し、日誌に理由を残す', async () => {
    const stores = createMemoryStores();
    const id = (await stores.archive.archive('sess-ok', 'BODY\n')).id;

    const reply = await tool(
      stores,
      'archive_remove',
    )({ archiveId: id, summary: '要らないので消す' });

    expect(reply).toContain('本文を消した');
    expect(await stores.archive.read(id)).toMatchObject({ kind: 'removed' });
    expect((await stores.journal.list({})).length).toBeGreaterThan(0);
  });
});

describe('schedule_create — request が空白だけのとき', () => {
  const cases: [string, string, string][] = [
    ['空文字', '', REQUEST_EMPTY],
    ['空白だけ', '  ', REQUEST_BLANK],
    ['改行と空白だけ', ' \n\t ', REQUEST_BLANK],
    ['NUL と空白だけ', ' \u0000 ', REQUEST_BLANK],
  ];
  for (const [label, request, expected] of cases) {
    it(`${label}は断り、何も仕込まず日誌も書かない`, async () => {
      const stores = createMemoryStores();

      const reply = await tool(
        stores,
        'schedule_create',
      )({
        kind: 'probe',
        request,
        everyMinutes: 60,
      });

      expect(reply).toBe(expected);
      await expect(stores.schedules.get('probe')).resolves.toBeNull();
      expect(await stores.journal.list({})).toEqual([]);
    });
  }

  it('置き換えでも空白だけは断り、既存の依頼を変えない', async () => {
    const stores = createMemoryStores();
    const create = tool(stores, 'schedule_create');
    await create({ kind: 'probe', request: '最初の本文', everyMinutes: 60 });

    const reply = await create({ kind: 'probe', request: '   ', everyMinutes: 30 });

    expect(reply).toBe(REQUEST_BLANK);
    const stored = await stores.schedules.get('probe');
    expect(stored?.request).toBe('最初の本文');
  });

  it('通常の request は従来どおり仕込む', async () => {
    const stores = createMemoryStores();

    const reply = await tool(
      stores,
      'schedule_create',
    )({
      kind: 'probe',
      request: '毎時 issue を見る',
      everyMinutes: 60,
    });

    expect(reply).toContain('probe を');
    expect((await stores.schedules.get('probe'))?.request).toBe('毎時 issue を見る');
  });
});
