import { buildCommitmentDerivations, captureStderr } from '@alteroid/core';
import type { Commitment, JournalStore, Stores } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { journal } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

// 台帳の「返答済み」の材料を、人間との往復を本文ごと全部読まずに作る（#5089）。
// 器の口（`humanReplies`）から作った材料が、口を持たない器と同じ作り方（`readConversationWindow` で全部読む）と一致することを測る

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

/** 口を持たない器（従来の作り方へ倒れる） */
function withoutHumanReplies(base: Stores): Stores {
  const journalWithout = new Proxy(base.journal, {
    get(target, property, receiver) {
      if (property === 'humanReplies') return undefined;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as JournalStore;
  return { ...base, journal: journalWithout };
}

// 導出の対象になる行が1件あれば、材料は全会話ぶん作られる
const ENTRIES = [{ origin: 'human', source: 'conv-a' }] as unknown as Commitment[];

describe('JournalStore.humanReplies（pg。#5089）', () => {
  it('⭐ 返答済みの材料は、口を持たない器の作り方と同じ（削除した会話・名指しされた行・人間以外・向き・会話の無い行を外す）', async () => {
    const append = (entry: Parameters<JournalStore['append']>[0]) => stores.journal.append(entry);
    await append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '頼む',
      conversationId: 'conv-a',
    });
    await append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '返答1',
      conversationId: 'conv-a',
    });
    await append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '返答2',
      conversationId: 'conv-a',
    });
    await append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '別の会話',
      conversationId: 'conv-c',
    });
    await append({ type: 'exchange', with: 'human', role: 'outbound', text: '会話なし' });
    await append({
      type: 'exchange',
      with: 'manager',
      role: 'outbound',
      text: '担当へ',
      conversationId: 'conv-a',
    });
    await append({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: '自分へ',
      conversationId: 'conv-a',
    });
    await append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '消す会話',
      conversationId: 'conv-gone',
    });
    const hidden = await append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '名指しで外す',
      conversationId: 'conv-c',
    });
    await append({
      type: 'conversation_deleted',
      deletedConversationId: 'conv-gone',
      deletedBy: 'human',
      hiddenCount: 1,
      hiddenEntryIds: [hidden.id],
    });

    const viaStore = await buildCommitmentDerivations(stores, ENTRIES, async () => []);
    const viaWindow = await buildCommitmentDerivations(
      withoutHumanReplies(stores),
      ENTRIES,
      async () => [],
    );

    expect(viaStore.repliesByConversation).toEqual(viaWindow.repliesByConversation);
    expect([...viaStore.repliesByConversation.keys()].sort()).toEqual(['conv-a', 'conv-c']);
    expect(viaStore.repliesByConversation.get('conv-a')).toHaveLength(2);
    expect(viaStore.repliesByConversation.get('conv-c')).toHaveLength(1);
  });

  it('本文の型が崩れた往復は、list と同じく数えない', async () => {
    await db.insert(journal).values({
      id: 'broken',
      at: new Date('2026-10-01T00:00:00.000Z'),
      type: 'exchange',
      entry: { with: 'human', role: 'outbound', conversationId: 'conv-a', text: 42 },
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '読める',
      conversationId: 'conv-a',
    });
    let viaStore: Awaited<ReturnType<typeof buildCommitmentDerivations>> | undefined;
    let viaWindow: Awaited<ReturnType<typeof buildCommitmentDerivations>> | undefined;
    await captureStderr(async () => {
      viaStore = await buildCommitmentDerivations(stores, ENTRIES, async () => []);
      viaWindow = await buildCommitmentDerivations(
        withoutHumanReplies(stores),
        ENTRIES,
        async () => [],
      );
    });
    expect(viaStore?.repliesByConversation).toEqual(viaWindow?.repliesByConversation);
    expect(viaStore?.repliesByConversation.get('conv-a')).toHaveLength(1);
  });

  // 返答の覚え（#5089 の続き）で、墓標の件数を見る軽い問い合わせが1本増えた。返答を読む問い合わせが本文の列を選ばないことを測る
  it('本文を読まない（選ぶのは seq・時刻・会話 id だけ）', async () => {
    const queries: string[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({
        logQuery: (text) => {
          queries.push(text);
        },
      }),
    );
    await logged.journal.humanReplies?.();
    // #5264 で行を `jsonb_to_record` で1回だけ開く形にしたので、読みの見分けと選ぶ列の形をそれに合わせた（測るものは同じ: 選ぶのは seq・時刻・会話 id だけで、本文の列を運ばない）
    const reads = queries.filter((text) => text.includes('jsonb_to_record('));
    expect(reads).toHaveLength(1);
    expect(reads[0]?.trim()).toMatch(
      /^select "journal"\."seq" as seq, "journal"\."at" as at, r\."conversationId" #>> '\{\}' as "conversationId"\s+from "journal"/,
    );
  });

  // 欄ごとに `entry->'…'` を書くと、TOAST に出た返答の本文を欄の数だけ展開し直す（#5264。偽の日誌で全部読み1回 62,242 → 26,437 ページ）。
  // `entry` に直に触ってよいのは、部分索引 `journal_human_replies_idx` の述語に合わせる `with`・`role` の2か所だけ（他の欄は `jsonb_to_record` で開いた値から読む）
  it('返答を読む SQL は、行を1回だけ開く（entry に直に触るのは索引の述語の with・role だけ）', async () => {
    const queries: string[] = [];
    const logged = createPgStoresFromDb(
      client.withLogger({
        logQuery: (text) => {
          queries.push(text);
        },
      }),
    );
    await logged.journal.humanReplies?.();
    const read = queries.find((text) => text.includes('jsonb_to_record('));
    if (read === undefined) throw new Error('返答を読む SQL を捕まえられなかった');
    const direct = [...read.matchAll(/"journal"\."entry"\s*->>?\s*'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(direct.sort()).toEqual(['role', 'with']);
  });
});
