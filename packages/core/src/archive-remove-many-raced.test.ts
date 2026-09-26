import { describe, expect, it } from 'vitest';

import type { ManagerPool } from './manager.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';

/**
 * **選んだ後に他経路が先に消していた行は、`raced` に数え、この呼びが消したことにしない。**
 *
 * `remove()` は行を消さずに本文だけを墓標にするので、他経路が先に消していた回は
 * `missing` ではなく `already` を返すのが普通である。以前の実行ループは `missing` だけを
 * `raced` に数え、`already` の行を「この呼びが消した」として応答の件数と日誌に載せていた。
 * 同じ形が `POST /archive/remove`（`apps/daemon/src/app.ts`）と自動の畳み
 * （`apps/daemon/src/archive-folder.ts`）にもあり、同じく直した。
 *
 * 競合は、`archive_remove_many` 自身がその id に `remove()` を呼ぶ瞬間に、本物の
 * `remove()` を1回先に打つラッパーで作る（`kind` を手で組み立てない）。
 */
const NO_ONE_RUNNING = { runningManagerOwning: () => undefined } as unknown as ManagerPool;

function remover(stores: Stores, managers: ManagerPool | null = NO_ONE_RUNNING) {
  const context: ToolContext = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(managers === null ? {} : { managers }),
  };
  const tools = createCloneTools(context);
  const found = tools.find((entry) => entry.name === 'archive_remove_many');
  expect(found, 'archive_remove_many という道具が無い').toBeDefined();
  return async (args: Record<string, unknown>) => {
    const result = await found?.handler(args as never, {} as never);
    return (result?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

/** 日誌に積まれた `decision` の本文だけを取り出す。 */
async function decisionTexts(stores: Stores): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => (entry.type === 'decision' ? entry.decision : ''));
}

/**
 * 同じセッションへ、前方一致で連なる2行を積む（`archive-remove-many.test.ts`
 * の `seedRemovableSession` と同じ形——雛形をそのまま踏襲する）。
 */
async function seedRemovableSession(
  stores: Stores,
  sessionId: string,
): Promise<{ oldId: string; newId: string }> {
  const oldRow = await stores.archive.archive(sessionId, 'AAA');
  const newRow = await stores.archive.archive(sessionId, 'AAABBB');
  expect(newRow.continuity, '前方一致の前提が崩れている（テストの組み立てミス）').toBe('continues');
  return { oldId: oldRow.id, newId: newRow.id };
}

describe('archive_remove_many は、選んだ後に他経路が消していた行（remove() が already を返す）を raced に数える', () => {
  it(
    '別経路が list() の後・remove() の前に同じ id を tombstone していると' +
      '（remove() は `already` を返す）、raced に数え、' +
      '触っていない id を「自分が消した」件数・日誌に載せない',
    async () => {
      const stores = createMemoryStores();
      const { oldId, newId } = await seedRemovableSession(stores, 'sess-race');

      // **「別経路が先に消していた」を、本物の remove() 実装だけで再現する。**
      // list() の時点（archive_remove_many の呼び出しの最初）ではまだ生きて
      // いる必要があるので、ここでは stores.archive.remove を直接1回叩いて
      // 「事前に」消すのではなく、archive_remove_many 自身が remove() を
      // 呼ぶ、その1回の呼びを横取りして、内側でもう1回 remove() を先打ちする
      // ラッパーに差し替える。これは実際の競合と区別が付かない形——
      // 「list() の後・自分の remove() の前に他経路が消した」を、本物の
      // ArchiveStore.remove() の返り値だけで作っている（フェイクの `kind` を
      // 手で組み立ててはいない）。
      const originalRemove = stores.archive.remove.bind(stores.archive);
      let armed = true;
      stores.archive.remove = async (id: string) => {
        if (id === oldId && armed) {
          armed = false;
          // 「別の経路」が先に同じ id を tombstone した、を１回だけ模す。
          await originalRemove(id);
        }
        return originalRemove(id);
      };

      const call = remover(stores);
      const reply = await call({
        sessionIds: ['sess-race'],
        summary: 'まとめて掃除',
        dryRun: false,
      });

      // 実状態: oldId は（他経路によって）確かに tombstone されている。
      expect(await stores.archive.read(oldId)).toMatchObject({ kind: 'removed' });
      expect(await stores.archive.read(newId)).toEqual({ kind: 'body', body: 'AAABBB' });

      // ⟹ 期待する挙動（あるべき姿）: この呼びは oldId を1件も自分では
      // tombstone していない（別経路が先に消していた）ので、競合として
      // raced に数えられるべきである。
      const racedMatch = /(\d+) 件は消せなかった/.exec(reply);
      const racedCount = racedMatch === null ? 0 : Number(racedMatch[1]);
      expect(
        racedCount,
        'raced が競合を検知していない。実際には raced=0 のまま' + '応答が返る（発見の本体）。',
      ).toBeGreaterThan(0);

      // ⟹ 期待する挙動: 応答の「消した」件数は、この呼びが実際に tombstone
      // した件数（0件）を言うべきである。
      expect(
        reply,
        '実際には触っていない oldId を「1 件の本文を tombstone' + 'した」に数えて応答する。',
      ).toContain('**0 件の本文を tombstone した**');

      // ⟹ 期待する挙動: 日誌の decision は、実際に自分が tombstone した行
      // だけを主張するべきで、他経路が消した oldId を「自分が消した」とは
      // 書かないはずである。
      const texts = await decisionTexts(stores);
      const entry = texts.find((t) => t.includes(oldId));
      expect(
        entry,
        '実際には行っていない tombstone を「行った」と日誌へ書く' +
          '（このプロセスは oldId に対して remove() を呼んだが、既に他経路が' +
          '消していたので `already` が返っただけである）。',
      ).toBeUndefined();
    },
  );
});
