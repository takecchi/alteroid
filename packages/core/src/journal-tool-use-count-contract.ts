import type { JournalEntry } from './schema.js';
import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
// 時刻の待ちは使わない: 同じミリ秒に積まれても成り立つよう、期待値は積んだ行の `at` から自分で導く。
// 口は省略可能（`JournalStore.countToolUsesByActor`）だが、3実装は持つので、持たないことを契約の破れとして扱う
export type JournalStoreToolUseCountContractSubject = Pick<
  JournalStore,
  'append' | 'countToolUsesByActor'
>;

const MARKER = 'journal-tool-use-count-contract';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の tool_use の件数の契約（${property}）が破れている — ${detail}`);
}

function plusMs(at: string, ms: number): string {
  return new Date(Date.parse(at) + ms).toISOString();
}

export async function verifyJournalStoreToolUseCountContract(
  journal: JournalStoreToolUseCountContractSubject,
): Promise<void> {
  const count = journal.countToolUsesByActor?.bind(journal);
  if (count === undefined) fail('口', 'countToolUsesByActor を持っていない');

  const actorA = `${MARKER}:a`;
  const actorB = `${MARKER}:b`;
  const toolUse = (actor: string) =>
    journal.append({ type: 'tool_use', actor, tool: 'Bash', input: { command: 'ls' } });

  const a1 = await toolUse(actorA);
  // 他の種別の行を挟む: 種別で絞らない実装が、窓の中の行を全部数えないため
  await journal.append({ type: 'decision', decision: `${MARKER}: 別の種別`, grounds: 'g' });
  const b1 = await toolUse(actorB);
  const a2 = await toolUse(actorA);
  const named = await toolUse(actorA);
  const a3 = await toolUse(actorA);
  await journal.append({
    type: 'conversation_deleted',
    deletedConversationId: `${MARKER}-conv`,
    deletedBy: 'operator',
    hiddenCount: 0,
    hiddenEntryIds: [named.id],
  });

  // 墓標が名指しした行（`named`）は外れる: `list` と同じ行が数えられないと、digest の件数が詳細と食い違う
  const visible: Extract<JournalEntry, { type: 'tool_use' }>[] = [a1, b1, a2, a3].flatMap((row) =>
    row.type === 'tool_use' ? [row] : [],
  );

  // 同じ actor が2行に割れて返る（group が壊れている）ことも、他の器の行が混ざることも契約の破れ。自分の actor だけを見る
  const tally = async (since: string, until: string): Promise<string> => {
    const rows = (await count({ since, until })).filter((row) => row.actor.startsWith(MARKER));
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.actor)) fail('group', `actor ${row.actor} が2行に割れて返った`);
      seen.add(row.actor);
    }
    return rows
      .filter((row) => row.count > 0)
      .map((row) => `${row.actor}=${row.count}`)
      .sort()
      .join(', ');
  };
  const expected = (since: string, until: string): string => {
    const counts = new Map<string, number>();
    for (const row of visible) {
      if (row.at >= since && row.at <= until)
        counts.set(row.actor, (counts.get(row.actor) ?? 0) + 1);
    }
    return [...counts]
      .map(([actor, n]) => `${actor}=${n}`)
      .sort()
      .join(', ');
  };

  const whole = await tally(a1.at, a3.at);
  if (whole !== `${actorA}=3, ${actorB}=1`) {
    fail(
      '窓の内',
      `actor ごとに窓の内の tool_use だけが数えられるはずが [${whole}]（別の種別を数えた・墓標が名指しした行を数えた・actor が混ざった）`,
    );
  }

  // since・until ちょうどの行を含む（`listPage` と同じ境界）。同じミリ秒に複数の行が在っても期待値は `at` から導く
  for (const row of [a1, b1, a2, a3]) {
    const exact = await tally(row.at, row.at);
    if (exact !== expected(row.at, row.at)) {
      fail(
        '境界',
        `since = until = ${row.at} の答えが [${exact}]、期待は [${expected(row.at, row.at)}]（両端を含まないか、境界の外を数えている）`,
      );
    }
  }

  const late = await tally(plusMs(a3.at, 1), plusMs(a3.at, 1000));
  if (late !== '') fail('since', `最後の行より後ろの窓に行が数えられている [${late}]`);
  const early = await tally(plusMs(a1.at, -1000), plusMs(a1.at, -1));
  if (early !== '') fail('until', `最初の行より前の窓に行が数えられている [${early}]`);
}
