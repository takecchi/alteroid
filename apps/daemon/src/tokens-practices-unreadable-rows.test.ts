import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { captureStderr, createCloneTools, createTokenPoolService } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb, tables } from '@alteroid/storage-pg';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * issue #2346。トークンプールの行とやり方の一覧は、読めない行を stderr に1行書くだけで
 * 黙って飛ばしていたので、上の層はどれも「登録されていません」「1件も無い。正常」と言い
 * 切れた（同じ応答の `settings` は `settingsUnreadable` で言い分けていた）。今は読めない
 * 行を別欄で運び、各層が「読めない N 件」を出す（`ScheduleList` #2343 と同じ形）。
 *
 * **実物のストアに不正な行を1行だけ置いた状態から**、次の層を通す。
 *
 * やり方（fs / pg）:
 * - `PracticeStore.list()` — `unreadable` に slug と不正な欄名だけ（題・本文は載せない）
 * - 道具 `practice_list` — 「読めないやり方が 1 件ある」。読めた行が0件でも
 *   「1件も無い」「正常」と言わない
 * - `GET /practices` — `unreadable` を載せる
 *
 * トークン（fs のみ。**pg は正規化された列を持ち、形の合わない行を作れない**ので
 * `listUnreadable()` は常に空——その事実だけを pg 側の歯にする）:
 * - `TokenPoolStore.listUnreadable()` — id・ラベル・不正な欄名だけ（**値は載せない**）
 * - 道具 `token_list` — 「読めないトークンの行が 1 件ある」。「プールは空である」と言わない
 * - `GET /tokens` — `rowsUnreadable` を載せる。値は応答のどこにも出ない
 *
 * 対照: 本当に0件なら従来どおり言い、鍵も出さない。
 *
 * CLI と Web は HTTP の応答を描くだけなので、それぞれ `token.test.ts` / `practice.test.ts` /
 * `tokens.test.tsx` / `practices.test.tsx` が応答の形を差して測る。
 */

const BAD_PRACTICE_TITLE = '壊れたやり方の題（この文字列はどの出力にも出てはいけない）';
const BAD_PRACTICE_CONTENT = '壊れたやり方の本文（この文字列もどの出力にも出てはいけない）\n';
const GOOD_PRACTICE = {
  slug: 'good-practice',
  kind: '実装',
  title: '読めるやり方の題',
  content: '読めるやり方の本文\n',
};

/** トークンの値（**偽の値**）。どの出力にも出てはいけない。 */
const BAD_TOKEN_VALUE = 'fake-secret-value-of-the-broken-row-never-print';
const GOOD_TOKEN_VALUE = 'fake-secret-value-of-the-good-row-never-print';
// order が文字列——版ずれ・手編集を模す。
const BAD_TOKEN_RAW = {
  id: 'tok-bad',
  label: 'broken-label',
  value: BAD_TOKEN_VALUE,
  order: 'not-a-number',
};

interface Seeded {
  stores: Stores;
  /** 不正なやり方の行を1行だけ足す。 */
  addBadPracticeRow(): Promise<void>;
  /** 不正なトークンの行を1行だけ足す（pg は足せない——`null`）。 */
  addBadTokenRow: (() => Promise<void>) | null;
}

async function seedFs(): Promise<Seeded> {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  return {
    stores,
    async addBadPracticeRow() {
      const path = join(root, 'jobs', 'practices.json');
      let raw: { practices: unknown[]; practiceVersions: unknown[] } = {
        practices: [],
        practiceVersions: [],
      };
      try {
        raw = JSON.parse(await readFile(path, 'utf8')) as typeof raw;
      } catch {
        // まだファイルが無い（0件から始めるとき）。
      }
      // kind が無い（必須欄の欠落）。
      raw.practices.push({
        slug: 'bad-practice',
        title: BAD_PRACTICE_TITLE,
        content: BAD_PRACTICE_CONTENT,
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
      await mkdir(join(root, 'jobs'), { recursive: true });
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    },
    async addBadTokenRow() {
      const path = stores.paths.tokens;
      let raw: { tokens: unknown[] } = { tokens: [] };
      try {
        raw = JSON.parse(await readFile(path, 'utf8')) as typeof raw;
      } catch {
        // まだファイルが無い。
      }
      raw.tokens.push(BAD_TOKEN_RAW);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
    },
  };
}

async function seedPg(): Promise<Seeded> {
  const { db } = await createMigratedPglite();
  const stores = createPgStoresFromDb(db);
  return {
    stores,
    async addBadPracticeRow() {
      // kind が空文字列（`workKindSchema.min(1)` 違反）。アプリの `write()` は通さないので
      // 直接 insert する。
      await db.insert(tables.practices).values({
        slug: 'bad-practice',
        kind: '',
        title: BAD_PRACTICE_TITLE,
        content: BAD_PRACTICE_CONTENT,
        createdAt: new Date('2026-09-02T00:00:00.000Z'),
        updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      });
    },
    addBadTokenRow: null,
  };
}

function stubCloneHost(): CloneHost {
  return {
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

async function getJson(stores: Stores, path: string): Promise<Record<string, unknown>> {
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    tokens: createTokenPoolService({ stores }),
  });
  const response = await app.request(path, { headers: { authorization: 'Bearer test-token' } });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function tool(stores: Stores, name: string): () => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
  });
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} が無い`);
  return async () => {
    const result = await found.handler({} as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe.each([
  ['fs', seedFs],
  ['pg', seedPg],
] as const)(
  'やり方の一覧が読めない行を「無い」「正常」と言わない（%s 実装。#2346）',
  (_label, seed) => {
    it('list(): 読めた行は entries、読めない行は unreadable に slug と不正な欄名だけで返る', async () => {
      const { stores, addBadPracticeRow } = await seed();
      await stores.practices.write(GOOD_PRACTICE);
      await addBadPracticeRow();

      let list: Awaited<ReturnType<Stores['practices']['list']>> | undefined;
      await captureStderr(async () => {
        list = await stores.practices.list();
      });

      expect(list?.entries.map((entry) => entry.slug)).toEqual(['good-practice']);
      expect(list?.unreadable).toEqual([{ slug: 'bad-practice', reason: '不正な欄: kind' }]);
      const serialized = JSON.stringify(list?.unreadable);
      expect(serialized).not.toContain(BAD_PRACTICE_TITLE);
      expect(serialized).not.toContain(BAD_PRACTICE_CONTENT);
    });

    it('practice_list: 読めた行に加えて「読めないやり方が 1 件ある」と言う', async () => {
      const { stores, addBadPracticeRow } = await seed();
      await stores.practices.write(GOOD_PRACTICE);
      await addBadPracticeRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await tool(stores, 'practice_list')();
      });

      expect(reply).toContain('読めるやり方の題');
      expect(reply).toContain('読めないやり方が 1 件ある（slug: bad-practice）');
      expect(reply).toContain('消されたやり方ではない');
      expect(reply).not.toContain(BAD_PRACTICE_TITLE);
      expect(reply).not.toContain(BAD_PRACTICE_CONTENT);
    });

    it('practice_list: 読めた行が0件でも「1件も無い」「正常」と言わない', async () => {
      const { stores, addBadPracticeRow } = await seed();
      await addBadPracticeRow();

      let reply = '';
      await captureStderr(async () => {
        reply = await tool(stores, 'practice_list')();
      });

      expect(reply).toContain('読めないやり方が 1 件ある（slug: bad-practice）');
      expect(reply).toContain('読めたやり方は無い');
      expect(reply).not.toContain('まだ1件も無い');
      expect(reply).not.toContain('これは正常な状態である');
      expect(reply).not.toContain(BAD_PRACTICE_TITLE);
    });

    it('GET /practices: unreadable を載せる。読めた行は今までどおり practices に出る', async () => {
      const { stores, addBadPracticeRow } = await seed();
      await stores.practices.write(GOOD_PRACTICE);
      await addBadPracticeRow();

      let body: Record<string, unknown> = {};
      await captureStderr(async () => {
        body = await getJson(stores, '/practices');
      });

      expect((body.practices as { slug: string }[]).map((p) => p.slug)).toEqual(['good-practice']);
      expect(body.unreadable).toEqual([{ slug: 'bad-practice', reason: '不正な欄: kind' }]);
      expect(JSON.stringify(body)).not.toContain(BAD_PRACTICE_TITLE);
      expect(JSON.stringify(body)).not.toContain(BAD_PRACTICE_CONTENT);
    });

    it('対照: 本当に0件なら「1件も無い」「正常」と言い、unreadable の鍵は出ない', async () => {
      const { stores } = await seed();

      expect(await stores.practices.list()).toEqual({ entries: [], unreadable: [] });
      const reply = await tool(stores, 'practice_list')();
      expect(reply).toContain('やり方はまだ1件も無い');
      expect(reply).toContain('これは正常な状態である');
      expect(reply).not.toContain('読めない');

      const body = await getJson(stores, '/practices');
      expect(body).toEqual({ practices: [] });
      expect('unreadable' in body).toBe(false);
    });
  },
);

describe('トークンプールが読めない行を「登録されていない」と言わない（fs 実装。#2346）', () => {
  it('listUnreadable(): id・ラベル・不正な欄名だけが返る。値は載らない', async () => {
    const { stores, addBadTokenRow } = await seedFs();
    await stores.tokens.replace([
      { id: 'tok-good', label: 'good', value: GOOD_TOKEN_VALUE, source: 'stored', order: 0 },
    ]);
    await addBadTokenRow!();

    let rows: Awaited<ReturnType<Stores['tokens']['listUnreadable']>> = [];
    let entries: Awaited<ReturnType<Stores['tokens']['list']>> = [];
    await captureStderr(async () => {
      rows = await stores.tokens.listUnreadable();
      entries = await stores.tokens.list();
    });

    expect(entries.map((token) => token.id)).toEqual(['tok-good']);
    expect(rows).toEqual([{ id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' }]);
    expect(JSON.stringify(rows)).not.toContain(BAD_TOKEN_VALUE);
    expect(JSON.stringify(rows)).not.toContain(GOOD_TOKEN_VALUE);
  });

  it('token_list: 読めた行が0件でも「プールは空である」と言わない。値は出ない', async () => {
    const { stores, addBadTokenRow } = await seedFs();
    await addBadTokenRow!();

    let reply = '';
    await captureStderr(async () => {
      reply = await tool(stores, 'token_list')();
    });

    expect(reply).toContain('読めないトークンの行が 1 件ある（id tok-bad / ラベル broken-label）');
    expect(reply).toContain('消されたトークンではない');
    expect(reply).toContain('読めたトークンの行は無い');
    expect(reply).not.toContain('プールは空である');
    expect(reply).not.toContain('この状態では回らない');
    expect(reply).not.toContain(BAD_TOKEN_VALUE);
  });

  it('token_list: 読めた行が在れば、一覧の頭に件数を足す', async () => {
    const { stores, addBadTokenRow } = await seedFs();
    await stores.tokens.replace([
      { id: 'tok-good', label: 'good', value: GOOD_TOKEN_VALUE, source: 'stored', order: 0 },
    ]);
    await addBadTokenRow!();

    let reply = '';
    await captureStderr(async () => {
      reply = await tool(stores, 'token_list')();
    });

    expect(reply).toContain('読めないトークンの行が 1 件ある');
    expect(reply).toContain('good');
    expect(reply).not.toContain(BAD_TOKEN_VALUE);
    expect(reply).not.toContain(GOOD_TOKEN_VALUE);
  });

  it('GET /tokens: rowsUnreadable を載せる（件数と id・ラベル・欄名）。値は応答のどこにも出ない', async () => {
    const { stores, addBadTokenRow } = await seedFs();
    await addBadTokenRow!();

    let body: Record<string, unknown> = {};
    await captureStderr(async () => {
      body = await getJson(stores, '/tokens');
    });

    expect(body.tokens).toEqual([]);
    expect(body.rowsUnreadable).toEqual({
      count: 1,
      rows: [{ id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' }],
    });
    // 設定は別の軸。読めている。
    expect(body.settingsUnreadable).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(BAD_TOKEN_VALUE);
  });

  it('対照: 本当に0件なら「プールは空である」と言い、rowsUnreadable の鍵は出ない', async () => {
    const { stores } = await seedFs();

    expect(await stores.tokens.listUnreadable()).toEqual([]);
    const reply = await tool(stores, 'token_list')();
    expect(reply).toContain('プールは空である');
    expect(reply).not.toContain('読めない');

    const body = await getJson(stores, '/tokens');
    expect('rowsUnreadable' in body).toBe(false);
    expect(body.tokens).toEqual([]);
  });
});

describe('トークンプール（pg 実装。#2346）', () => {
  it('listUnreadable() は常に空——正規化された列で持つので、形の合わない行を作れない', async () => {
    const { stores } = await seedPg();
    await stores.tokens.replace([
      { id: 'tok-good', label: 'good', value: GOOD_TOKEN_VALUE, source: 'stored', order: 0 },
    ]);
    expect(await stores.tokens.listUnreadable()).toEqual([]);
    const body = await getJson(stores, '/tokens');
    expect('rowsUnreadable' in body).toBe(false);
    expect((body.tokens as { id: string }[]).map((token) => token.id)).toEqual(['tok-good']);
  });
});
