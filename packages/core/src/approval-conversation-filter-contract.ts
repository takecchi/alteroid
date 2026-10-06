import type { PendingApproval } from './schema.js';
import type { Stores } from './store.js';

/**
 * `JobStore.listApprovals({ conversationId })` の契約（#3290）。**3実装（fs / pg /
 * インメモリ）で、会話の絞りが同じ結果になること**を測る。
 *
 * ## 何を測るか
 * - **絞った結果 = 絞らない結果を `conversationId` の一致で絞ったもの**（`pendingOnly` の
 *   有無の両方で）。`GET /approvals` が全件を取ってメモリで絞っていた頃の答えそのもの
 *   なので、これが揃っていれば応答（`total` / `nextCursor` もその集合から数える）は変わらない。
 * - 期待する id の集合を固定でも見る（「絞らない結果」と同じ壊れ方をしても落ちるように）。
 * - 一致は**完全一致**（前方一致・大小無視・`LIKE` のワイルドカードにならない）。会話 id を
 *   持たない承認は、どの会話にも一致しない。
 * - NUL を含む会話 id は、投げずに「一致なし」になる。
 * - 会話で絞った `unreadable` は、絞らない呼びの `unreadable` の部分集合である（#3319。
 *   生の `conversationId` が一致する行だけ。インメモリは常に空）。
 *
 * 読めない行（壊れた jsonb）の入れ方は実装ごとに違うので、中身はここでは測らない
 * （fs / pg の `approval-conversation-filter-contract.test.ts` と
 * `apps/daemon/src/approval-conversation-filter.test.ts` が測る）。
 *
 * ## 呼び方
 * **空の器に対して呼ぶこと**（承認は消さずに足すだけ）。vitest に依存しない素の非同期関数
 * にしてあるのは、他の `*-contract.ts` と同じ理由。
 */
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

  // 挿入順はわざと会話をまぜる。`conv-a` の前方一致・大小違い・ワイルドカード・引用符を置く。
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
      // 「絞らない結果を一致で絞ったもの」と、並びまで同じ。
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

  // NUL を含む会話 id は、投げずに「一致なし」。
  for (const conversationId of ['conv-a\u0000', '\u0000']) {
    const filtered = await stores.jobs.listApprovals({ conversationId });
    if (filtered.entries.length !== 0) fail('NUL を含む会話 id が一致した');
  }
}
