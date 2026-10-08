import type { PendingApproval } from './schema.js';
import type { Stores } from './store.js';

export async function verifyApprovalConversationFilterContract(stores: Stores): Promise<void> {
  function fail(message: string): never {
    throw new Error(`承認の会話の絞りの契約違反: ${message}`);
  }

  const base = Date.parse('2026-03-01T00:00:00.000Z');
  let n = 0;
  async function put(
    id: string,
    extra: Partial<PendingApproval> & { conversationId?: string } = {},
  ): Promise<void> {
    n += 1;
    await stores.jobs.putApproval({
      id,
      createdAt: new Date(base + n * 1000).toISOString(),
      question: `q-${id}`,
      ...extra,
    });
  }
  const settled = {
    answeredAt: '2026-03-02T00:00:00.000Z',
    answer: 'はい',
  } satisfies Partial<PendingApproval>;

  await put('a1', { conversationId: 'conv-a' });
  await put('b1', { conversationId: 'conv-b' });
  await put('a2', { conversationId: 'conv-a', ...settled });
  await put('ab1', { conversationId: 'conv-ab' });
  await put('none1');
  await put('A1', { conversationId: 'Conv-A' });
  await put('pct1', { conversationId: 'conv-%' });
  await put('us1', { conversationId: 'conv_a' });
  await put('q1', { conversationId: `it's "x"\\` });
  await put('ja1', { conversationId: '会話-あ' });
  await put('a3', { conversationId: 'conv-a', withdrawnAt: '2026-03-03T00:00:00.000Z' });
  await put('a4', { conversationId: 'conv-a' });

  const cases: Array<{ conversationId: string; all: string[]; pending: string[] }> = [
    { conversationId: 'conv-a', all: ['a1', 'a2', 'a3', 'a4'], pending: ['a1', 'a4'] },
    { conversationId: 'conv-b', all: ['b1'], pending: ['b1'] },
    { conversationId: 'conv-ab', all: ['ab1'], pending: ['ab1'] },
    { conversationId: 'Conv-A', all: ['A1'], pending: ['A1'] },
    { conversationId: 'conv-%', all: ['pct1'], pending: ['pct1'] },
    { conversationId: 'conv_a', all: ['us1'], pending: ['us1'] },
    { conversationId: `it's "x"\\`, all: ['q1'], pending: ['q1'] },
    { conversationId: '会話-あ', all: ['ja1'], pending: ['ja1'] },
    { conversationId: 'conv-', all: [], pending: [] },
    { conversationId: 'conv-nothing', all: [], pending: [] },
    { conversationId: 'null', all: [], pending: [] },
  ];

  for (const pendingOnly of [false, true]) {
    const unfiltered = await stores.jobs.listApprovals(pendingOnly ? { pendingOnly } : {});
    for (const c of cases) {
      const label = `conversationId=${JSON.stringify(c.conversationId)} pendingOnly=${pendingOnly}`;
      const filtered = await stores.jobs.listApprovals({
        ...(pendingOnly ? { pendingOnly } : {}),
        conversationId: c.conversationId,
      });
      const expectedIds = pendingOnly ? c.pending : c.all;
      const ids = filtered.entries.map((e) => e.id);
      if (JSON.stringify([...ids].sort()) !== JSON.stringify([...expectedIds].sort())) {
        fail(
          `${label}: id が違う 実際 ${JSON.stringify(ids)} / 期待 ${JSON.stringify(expectedIds)}`,
        );
      }
      const reference = unfiltered.entries.filter((e) => e.conversationId === c.conversationId);
      if (JSON.stringify(filtered.entries) !== JSON.stringify(reference)) {
        fail(`${label}: 絞らない結果を一致で絞ったものと違う`);
      }
      const all = JSON.stringify(unfiltered.unreadable);
      if (filtered.unreadable.some((u) => !all.includes(JSON.stringify(u)))) {
        fail(`${label}: unreadable が絞らない呼びの部分集合でない`);
      }
    }
  }

  for (const conversationId of ['conv-a\u0000', '\u0000']) {
    const filtered = await stores.jobs.listApprovals({ conversationId });
    if (filtered.entries.length !== 0) fail('NUL を含む会話 id が一致した');
  }
}
