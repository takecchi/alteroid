import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。食い違ったら throw する。
// 契約4（`%` / `_` はワイルドカードではない）は pg の `ILIKE` でだけ落ちうるが、3実装すべてで測る: pg でだけ測ると、照合を SQL から引き上げたときに誰も測らなくなる。
export type JournalStoreSearchContractSubject = Pick<JournalStore, 'append' | 'list'>;

const TAG = 'journal-search-contract';

export async function verifyJournalStoreSearchContract(
  journal: JournalStoreSearchContractSubject,
): Promise<void> {
  // 狙いの行を先に積み、その後に当たらない行を複数積む: new→old で返るストアで q を limit の後ろで絞ると、狙いの行が先に切り落とされる（契約6の要）。
  const target = await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: `${TAG}: トマトの育て方をVERBATIMで残す`,
  });
  const decoyCount = 5;
  for (let i = 0; i < decoyCount; i += 1) {
    await journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: `${TAG}: 当たらない行 ${i}`,
    });
  }
  const literal = await journal.append({
    type: 'decision',
    decision: `${TAG}: 進捗は50%だった`,
    grounds: `${TAG}: 実測`,
  });
  await journal.append({
    type: 'tool_use',
    actor: 'clone',
    tool: 'Bash',
    input: { command: `${TAG}: ナスの育て方` },
  });
  const failed = await journal.append({
    type: 'tool_use',
    actor: 'clone',
    tool: 'Bash',
    outcome: 'failed',
    error: `${TAG}: キュウリの育て方`,
  });

  const split = await journal.append({
    type: 'decision',
    decision: `${TAG}: alpha`,
    grounds: 'beta',
  });
  const oneField = await journal.append({
    type: 'exchange',
    with: 'human',
    role: 'inbound',
    text: `${TAG}: gamma\ndelta`,
  });
  const fieldless = await journal.append({
    type: 'worker_wait',
    openedAt: new Date().toISOString(),
    tasks: 1,
    turns: 1,
    byCause: { notification: 0, continuation: 0, input: 0 },
    toolless: 0,
    notifications: 0,
    submits: 0,
    settled: true,
  } as never);

  const ids = async (q: string, extra: { limit?: number } = {}): Promise<string[]> =>
    (await journal.list({ q, ...extra })).map((entry) => entry.id);

  const unfiltered = await journal.list({});
  if (!unfiltered.some((entry) => entry.id === target.id)) {
    throw new Error(
      'JournalStore の q 契約（1: 未指定=絞らない）が破れている — ' +
        `q 未指定の list({}) が、積んだ行（id=${target.id}）を返さなかった。`,
    );
  }

  const matched = await journal.list({ q: 'トマト' });
  if (!matched.some((entry) => entry.id === target.id)) {
    throw new Error(
      'JournalStore の q 契約（2: 部分一致で当たる）が破れている — ' +
        `q: 'トマト' が、本文にその語を含む行（id=${target.id}）を返さなかった。`,
    );
  }
  const wrong = matched.find(
    (entry) => entry.type !== 'exchange' || !entry.text.includes('トマト'),
  );
  if (wrong !== undefined) {
    throw new Error(
      'JournalStore の q 契約（2: 当たる行だけ）が破れている — ' +
        `q: 'トマト' が、本文にその語を含まない行を返した: ${JSON.stringify(wrong)}`,
    );
  }

  const lowered = await ids('verbatim');
  if (!lowered.includes(target.id)) {
    throw new Error(
      'JournalStore の q 契約（3: 大文字小文字を区別しない部分一致）が破れている — ' +
        `本文に 'VERBATIM' を含む行（id=${target.id}）が、q: 'verbatim' で返らなかった。` +
        '（前方一致・語単位の照合になっている疑いもある）',
    );
  }

  const percent = await ids('50%');
  if (!percent.includes(literal.id)) {
    throw new Error(
      'JournalStore の q 契約（4: % はワイルドカードではない）が破れている — ' +
        `本文に '50%' を含む行（id=${literal.id}）が、q: '50%' で返らなかった。`,
    );
  }
  if (percent.includes(target.id)) {
    throw new Error(
      'JournalStore の q 契約（4: % はワイルドカードではない）が破れている — ' +
        `q: '50%' が、本文に '50%' を含まない行（id=${target.id}）まで返した。` +
        'ILIKE のパターンで % がエスケープされていない疑いがある。',
    );
  }
  const underscore = await ids('50_');
  if (underscore.includes(literal.id)) {
    throw new Error(
      'JournalStore の q 契約（4: _ はワイルドカードではない）が破れている — ' +
        `q: '50_' が '50%' を含む行（id=${literal.id}）に当たった。` +
        'ILIKE のパターンで _ がエスケープされていない疑いがある。',
    );
  }

  const emptyQ = await ids('');
  if (!emptyQ.includes(target.id)) {
    throw new Error(
      "JournalStore の q 契約（5: ''=絞らない）が破れている — " +
        `q: '' が、積んだ行（id=${target.id}）を返さなかった（0件へ倒している疑い）。`,
    );
  }

  for (const crossing of [
    'alpha\nbeta',
    'alpha\n\nbeta',
    `${TAG}: alpha\nbeta`,
    `alpha\n\n\nbeta`,
  ]) {
    if ((await ids(crossing)).includes(split.id)) {
      throw new Error(
        'JournalStore の q 契約（欄ごとに当てる）が破れている — ' +
          `decision と grounds に分けて持つ行（id=${split.id}）が、欄をまたぐ q: ${JSON.stringify(crossing)} に当たった。`,
      );
    }
  }
  for (const word of ['alpha', 'beta']) {
    if (!(await ids(word)).includes(split.id)) {
      throw new Error(
        'JournalStore の q 契約（欄ごとに当てる）が破れている — ' +
          `decision と grounds に分けて持つ行（id=${split.id}）が、1つの欄の中の語 q: ${JSON.stringify(word)} に当たらなかった。`,
      );
    }
  }
  if (!(await ids('gamma\ndelta')).includes(oneField.id)) {
    throw new Error(
      'JournalStore の q 契約（欄ごとに当てる）が破れている — ' +
        `1つの欄の中の改行を含む q: 'gamma\\ndelta' が、その欄を持つ行（id=${oneField.id}）に当たらなかった。`,
    );
  }
  if ((await ids('\n')).includes(fieldless.id)) {
    throw new Error(
      'JournalStore の q 契約（欄ごとに当てる）が破れている — ' +
        `探す欄を持たない種別（worker_wait。id=${fieldless.id}）が、q: '\\n' に当たった。`,
    );
  }
  if (!(await ids('')).includes(fieldless.id)) {
    throw new Error(
      "JournalStore の q 契約（''=絞らない）が破れている — " +
        `q: '' が、探す欄を持たない種別（worker_wait。id=${fieldless.id}）を返さなかった。`,
    );
  }

  const windowed = await journal.list({ q: 'トマト', limit: 1 });
  if (windowed.length !== 1 || windowed[0]?.id !== target.id) {
    throw new Error(
      'JournalStore の q 契約（6: limit より前に効く）が破れている — ' +
        `狙いの行の後に当たらない行を${decoyCount}件積んだ状態で ` +
        `list({ q: 'トマト', limit: 1 }) を呼んだが、狙いの行（id=${target.id}）が ` +
        `1件返らなかった（実際に返った件数: ${windowed.length}）。` +
        'q の絞りが limit の後ろで効いている疑いがある。',
    );
  }

  const outOfScope = await ids('ナス');
  if (outOfScope.length !== 0) {
    throw new Error(
      'JournalStore の q 契約（対象外の欄）が破れている — ' +
        `tool_use の input にだけ 'ナス' を置いた行が、q: 'ナス' で ${outOfScope.length} 件返った。` +
        '照合の対象は journal-search.ts の SEARCHABLE_FIELDS_BY_TYPE が持つ欄だけである。',
    );
  }

  const inScope = await ids('キュウリ');
  if (!inScope.includes(failed.id)) {
    throw new Error(
      'JournalStore の q 契約（対象内の欄: tool_use.error）が破れている — ' +
        `tool_use の error に 'キュウリ' を置いた行（id=${failed.id}）が、` +
        `q: 'キュウリ' で返らなかった。照合の対象は journal-search.ts の ` +
        'SEARCHABLE_FIELDS_BY_TYPE が持つ欄だけである。',
    );
  }
}
