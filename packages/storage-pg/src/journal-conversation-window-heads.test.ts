import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readConversationPage, type JournalStore } from '@alteroid/core';

import type { Db } from './db.js';
import { createPgStoresFromDb } from './index.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 会話の一覧が、本文を運ばない細い窓（conversationWindowHeads + exchangeTextHeads）で読んでも、
// 本文ごと読む今までの道（listPage）と1つの欄も違わない答えを返すこと

let client: TestDbHandle;
let db: Db;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
});

afterEach(async () => {
  await client.close();
});

const ATTACHMENT = { id: 'att-1', name: 'a.png', mediaType: 'image/png', size: 1, sha256: 'x' };
const EMOJI = '😀';

type Store = ReturnType<typeof createPgStoresFromDb>;

/** 本文ごと読む今までの道: 細い窓の口を持たない器として見せる */
function fullTextOnly(
  store: Store['journal'],
): Pick<JournalStore, 'listPage' | 'get' | 'withdrawnClientMessageIds' | 'conversationIdsAfter'> {
  return {
    listPage: (query) => store.listPage(query),
    get: (id) => store.get(id),
    ...(store.withdrawnClientMessageIds === undefined
      ? {}
      : { withdrawnClientMessageIds: (query) => store.withdrawnClientMessageIds!(query) }),
    ...(store.conversationIdsAfter === undefined
      ? {}
      : { conversationIdsAfter: (query) => store.conversationIdsAfter!(query) }),
  };
}

async function seed(stores: Store): Promise<void> {
  const say = (
    conversationId: string,
    role: 'inbound' | 'outbound',
    text: string,
    extra: Record<string, unknown> = {},
  ) =>
    stores.journal.append({
      type: 'exchange',
      with: 'human',
      role,
      text,
      conversationId,
      ...extra,
    } as never);
  const internal = (text: string) =>
    stores.journal.append({ type: 'exchange', with: 'self', role: 'outbound', text } as never);

  // 会話 A: 普通の往復と、長い本文（題は 80 字で切れる）
  await say('conv-a', 'inbound', 'A の最初の発言', { clientMessageId: 'cm-a1' });
  await internal('内部ターン');
  await say('conv-a', 'outbound', `長い返答 ${'あ'.repeat(3000)}`);
  // 会話 B: 編集（supersedes）で古い発言を隠す
  const b1 = await say('conv-b', 'inbound', 'B の書き損じ', { clientMessageId: 'cm-b1' });
  await say('conv-b', 'inbound', 'B の書き直し', { supersedes: b1.id, clientMessageId: 'cm-b2' });
  // 会話 C: 最後が失敗の知らせ（題はその前の発言から取る）
  await say('conv-c', 'inbound', 'C の質問', { clientMessageId: 'cm-c1' });
  await say('conv-c', 'outbound', 'ターンが失敗した', { turnFailure: 'failed' });
  // 会話 D: 本文が空で添付だけ
  await say('conv-d', 'inbound', '', { attachments: [ATTACHMENT, { ...ATTACHMENT, id: 'att-2' }] });
  // 会話 E: 取り下げた発言（題にも件数にも入れない）
  await say('conv-e', 'inbound', 'E の残る発言', { clientMessageId: 'cm-e1' });
  await say('conv-e', 'inbound', 'E の取り下げた発言', { clientMessageId: 'cm-e2' });
  await stores.journal.append({
    type: 'exchange',
    with: 'self',
    role: 'outbound',
    text: '取り下げた',
    conversationId: 'conv-e',
    withdrawnClientMessageId: 'cm-e2',
  } as never);
  // 会話 F: 先頭の空白が長く、DB の先頭だけでは題に届かない（その1件だけ全文を引き直す）
  await say('conv-f', 'outbound', `${' '.repeat(600)}F の本文 ${'い'.repeat(300)}`);
  // 会話 G: 絵文字が題の切れ目をまたぐ
  await say('conv-g', 'outbound', `${'う'.repeat(79)}${EMOJI}${'え'.repeat(500)}`);
  // 会話 H: 消した会話（一覧に出ない）
  await say('conv-h', 'inbound', 'H は消す');
  await stores.journal.append({
    type: 'conversation_deleted',
    deletedConversationId: 'conv-h',
    deletedBy: 'operator',
    hiddenCount: 1,
  } as never);
  // 会話 A に新しい発言を足して、一覧の並びを入れ替える
  await say('conv-a', 'inbound', 'A の続き', { clientMessageId: 'cm-a2' });
  // 型の合わない行（role が無い）: listPage は読み出しで落とす
  await db.insert(journal).values({
    id: 'row-bad-role',
    at: new Date(),
    type: 'exchange',
    entry: { with: 'human', text: 'role が無い', conversationId: 'conv-x' },
  });
}

describe('会話の一覧の細い窓（conversationWindowHeads / exchangeTextHeads）', () => {
  it('⭐ 本文ごと読む道と、会話・件数・題・未読・継続点・位置まで同じ答えを返す', async () => {
    const stores = createPgStoresFromDb(db);
    await seed(stores);

    for (const options of [
      { limit: 30, scan: 2000 },
      { limit: 3, scan: 2000 },
      { limit: 30, scan: 4 },
      { limit: 2, scan: 5 },
    ]) {
      const slim = await readConversationPage(stores.journal, options);
      const full = await readConversationPage(fullTextOnly(stores.journal), options);
      expect({ options, ...slim, positions: [...slim.positions] }).toEqual({
        options,
        ...full,
        positions: [...full.positions],
      });
    }
  });

  it('⭐ 継続点（cursor）で辿った2頁目も、本文ごと読む道と同じ答えを返す', async () => {
    const stores = createPgStoresFromDb(db);
    await seed(stores);
    const first = await readConversationPage(stores.journal, { limit: 2, scan: 2000 });
    expect(first.next).not.toBeNull();
    const cursor = first.next!;
    const slim = await readConversationPage(stores.journal, { limit: 2, scan: 2000, cursor });
    const full = await readConversationPage(fullTextOnly(stores.journal), {
      limit: 2,
      scan: 2000,
      cursor,
    });
    expect({ ...slim, positions: [...slim.positions] }).toEqual({
      ...full,
      positions: [...full.positions],
    });
  });

  it('⭐ 細い窓は本文を運ばない（窓の SQL は entry 列を丸ごと選ばず、題の SQL は載せる会話の数の行だけを返す）', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({
        logQuery: (text, params) => {
          queries.push({ sql: text, params });
        },
      }),
    );
    await seed(createPgStoresFromDb(db));

    const page = await readConversationPage(logged.journal, { limit: 3, scan: 2000 });

    const windowQuery = queries.find(
      (entry) => entry.sql.includes(`->>'with'`) && entry.sql.includes('order by'),
    );
    if (windowQuery === undefined) throw new Error('窓の SQL を捕まえられなかった');
    expect(windowQuery.sql).not.toMatch(/select [^]*"entry"(,| from)/);
    const headQuery = queries.find((entry) => entry.sql.includes('left('));
    if (headQuery === undefined) throw new Error('題の SQL を捕まえられなかった');
    expect(page.conversations).toHaveLength(3);
  });
});
