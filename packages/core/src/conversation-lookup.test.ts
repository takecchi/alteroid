import { describe, expect, it } from 'vitest';

import { lookupConversation, resolveConversationId } from './conversation-lookup.js';
import type { JournalQuery, JournalStore } from './store.js';
import { createMemoryStores } from './testing.js';

// 在る会話は、その会話の行だけを1行引いて答える（#5140）。無い・前方一致は今までどおり頁送りで読む

async function journalWith(conversations: readonly string[]) {
  const { journal } = createMemoryStores();
  for (const conversationId of conversations) {
    await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: `${conversationId} への発言`,
      conversationId,
    });
  }
  return journal;
}

function counting(journal: JournalStore): {
  journal: Pick<JournalStore, 'listPage'>;
  queries: JournalQuery[];
} {
  const queries: JournalQuery[] = [];
  return {
    journal: {
      listPage: (query = {}) => {
        queries.push(query);
        return journal.listPage(query);
      },
    },
    queries,
  };
}

const OLD = 'aaaa1111-0000-0000-0000-000000000000';

describe('lookupConversation（#5140）', () => {
  it('⭐ 古い会話でも、新しい側の他の会話を読み切らずに、その会話を名指した1回の読みで在ると答える', async () => {
    const newer = Array.from({ length: 1200 }, (_, i) => `conv-${String(i)}`);
    const base = await journalWith([OLD, ...newer]);
    const { journal, queries } = counting(base);

    expect(await lookupConversation(journal, OLD)).toEqual({ found: true });
    expect(queries).toEqual([
      { types: ['exchange'], with: ['human'], conversationId: OLD, limit: 1 },
    ]);
  });

  it('無い会話は、今までどおり人間との往復を最後まで読み、前方一致の候補を返す', async () => {
    const base = await journalWith([OLD, 'conv-x']);
    const { journal, queries } = counting(base);

    expect(await lookupConversation(journal, 'aaaa1111')).toEqual({
      found: false,
      candidates: [OLD],
      moreCandidates: false,
    });
    // 名指した1回の後に、頁送りへ落ちている
    expect(queries.length).toBeGreaterThan(1);
    expect(queries[0]).toMatchObject({ conversationId: 'aaaa1111', limit: 1 });
  });

  it('クローンの道具の前方一致（8 文字以上で1つに決まる）は、今までどおり読み替える', async () => {
    const base = await journalWith([OLD, 'conv-x']);
    expect(await resolveConversationId(base, 'aaaa1111')).toEqual({ kind: 'prefix', id: OLD });
  });

  it('文字どおりの id の会話が在れば、前方一致より先にそれと答える（#4150 の事故の形）', async () => {
    const base = await journalWith(['bf63fd3d', 'bf63fd3d-93d2-0000-0000-000000000000']);
    expect(await resolveConversationId(base, 'bf63fd3d')).toEqual({
      kind: 'exact',
      id: 'bf63fd3d',
    });
  });
});
