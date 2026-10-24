import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
// 時刻の待ちは使わない: 同じミリ秒に積まれても成り立つよう、期待値は `list` が返した行から自分で導く。
// 口は省略可能（`JournalStore.countHumanInboundTurns`）だが、3実装は持つので、持たないことを契約の破れとして扱う
export type JournalStoreHumanInboundCountContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'countHumanInboundTurns'
>;

const MARKER = 'journal-human-inbound-count-contract';

function fail(property: string, detail: string): never {
  throw new Error(
    `JournalStore の人間からの発言の件数の契約（${property}）が破れている — ${detail}`,
  );
}

function plusMs(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

export async function verifyJournalStoreHumanInboundCountContract(
  journal: JournalStoreHumanInboundCountContractSubject,
): Promise<void> {
  const count = journal.countHumanInboundTurns?.bind(journal);
  if (count === undefined) fail('口', 'countHumanInboundTurns を持っていない');

  const exchange = (
    withWhom: 'human' | 'manager' | 'self',
    role: 'inbound' | 'outbound',
    label: string,
    conversationId: string,
  ) =>
    journal.append({
      type: 'exchange',
      with: withWhom,
      role,
      text: `${MARKER}: ${label}`,
      conversationId,
    });

  const keptConversation = `${MARKER}-kept`;
  const deletedConversation = `${MARKER}-deleted`;

  const i1 = await exchange('human', 'inbound', 'i1', keptConversation);
  // 他の種別の行を挟む: 種別で絞らない実装が、窓の中の行を全部数えないため
  await journal.append({ type: 'decision', decision: `${MARKER}: 別の種別`, grounds: 'g' });
  // outbound・マネージャーとの往復・自分との往復は数えない
  const o1 = await exchange('human', 'outbound', 'o1', keptConversation);
  const m1 = await exchange('manager', 'inbound', 'm1', keptConversation);
  const s1 = await exchange('self', 'inbound', 's1', keptConversation);
  const i2 = await exchange('human', 'inbound', 'i2', keptConversation);
  const named = await exchange('human', 'inbound', 'named', keptConversation);
  const gone = await exchange('human', 'inbound', 'gone', deletedConversation);
  const i3 = await exchange('human', 'inbound', 'i3', keptConversation);
  await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: deletedConversation,
    deletedBy: 'operator',
    hiddenCount: 1,
    hiddenEntryIds: [named.id],
  });

  const rows = [i1, o1, m1, s1, i2, named, gone, i3];
  const earliest = rows.map((row) => row.at).sort()[0] ?? i1.at;
  const latest = rows.map((row) => row.at).sort()[rows.length - 1] ?? i3.at;

  // 期待値は `list` の答えから導く（口は「`list` で数えた答えと同じ」を契約する）
  const expected = async (since: string, until: string): Promise<number> => {
    const listed = await journal.list({ types: ['exchange'], with: ['human'], since, until });
    return listed.filter((row) => row.type === 'exchange' && row.role === 'inbound').length;
  };

  // 墓標で外れる行（`named`・`gone`）が `list` で外れていること自体を前提として確かめる: ここが崩れると、下の一致が意味を持たない
  const listedMine = (
    await journal.list({ types: ['exchange'], with: ['human'], since: earliest, until: latest })
  ).filter((row) => row.type === 'exchange' && row.text.startsWith(MARKER));
  const mineInbound = listedMine.filter((row) => row.type === 'exchange' && row.role === 'inbound');
  if (mineInbound.length !== 3) {
    fail(
      '前提',
      `list が返す自分の inbound は i1・i2・i3 の3件のはずが ${mineInbound.length} 件（墓標が外すべき行が残っている）`,
    );
  }

  const whole = await count({ since: earliest, until: latest });
  const wholeExpected = await expected(earliest, latest);
  if (whole !== wholeExpected) {
    fail(
      '窓の内',
      `窓の内の人間からの発言は ${wholeExpected} 件のはずが ${whole} 件（outbound・マネージャー・自分との往復・他の種別・墓標が外した行のどれかを数えた、または数え漏らした）`,
    );
  }

  // since・until ちょうどの行を含む（`listPage` と同じ境界）。同じミリ秒に複数の行が在っても期待値は `list` から導く
  for (const row of rows) {
    const exact = await count({ since: row.at, until: row.at });
    const exactExpected = await expected(row.at, row.at);
    if (exact !== exactExpected) {
      fail(
        '境界',
        `since = until = ${row.at} の答えが ${exact}、期待は ${exactExpected}（両端を含まないか、境界の外を数えている）`,
      );
    }
  }

  // 窓を1ms ずらしても `list` と揃う（片端だけ含む実装を落とす）
  for (const row of [i1, i2, i3]) {
    for (const [since, until] of [
      [row.at, latest],
      [earliest, row.at],
      [plusMs(row.at, 1), latest],
      [earliest, plusMs(row.at, -1)],
    ] as const) {
      if (since > until) continue;
      const got = await count({ since, until });
      const want = await expected(since, until);
      if (got !== want) {
        fail('境界', `[${since}, ${until}] の答えが ${got}、期待は ${want}`);
      }
    }
  }

  const late = await count({ since: plusMs(latest, 1), until: plusMs(latest, 1000) });
  const lateExpected = await expected(plusMs(latest, 1), plusMs(latest, 1000));
  if (late !== lateExpected)
    fail('since', `最後の行より後ろの窓で ${late} 件、期待は ${lateExpected}`);
  const early = await count({ since: plusMs(earliest, -1000), until: plusMs(earliest, -1) });
  const earlyExpected = await expected(plusMs(earliest, -1000), plusMs(earliest, -1));
  if (early !== earlyExpected) {
    fail('until', `最初の行より前の窓で ${early} 件、期待は ${earlyExpected}`);
  }
}
