import type { JournalStore } from './store.js';

/**
 * `JournalStore` の `q`（本文を語で探す）の契約を、実装1つに対して測る
 * （issue #250）。
 *
 * **なぜ vitest に依存しない素の非同期関数にしてあるか**は
 * `journal-with-contract.ts` の doc と同じ（`packages/storage-fs` /
 * `packages/storage-pg` へ vitest を持ち込まないため）。食い違ったら `throw`
 * する。
 *
 * **測る6性質。3実装（`packages/core/src/testing.ts` のインメモリ /
 * `packages/storage-fs/src/journal.ts` / `packages/storage-pg/src/journal.ts`）
 * すべてがこれを呼ぶこと。呼んでいない実装が増えたら
 * `scripts/journal-store-with-contract-registry.test.ts` が落ちる。**
 *
 * 1. **未指定 = 絞らない**（既存の挙動を1文字も変えない）
 * 2. **指定 = 本文にその語を含む行だけ**（部分一致。語の途中にも当たる）
 * 3. **大文字小文字を区別しない**
 * 4. **`%` / `_` はワイルドカードではない。** pg だけが `ILIKE` を使うので、
 *    **この1本だけが実装ごとに落ち方が違う** —— fs / インメモリでは素の
 *    `includes` なので自明に通り、pg でエスケープを外すと全件が返る。
 *    **「3実装で揃える」がいちばん効いているのがここである**
 * 5. **`''`（空文字列）= 絞らない**（`matchesJournalSearch` の doc）
 * 6. **`limit` より前に効く**（`with` の契約4と同じ形。#418 の穴の本体）
 *
 * そして**対象外の欄が本当に対象外であること**（`tool_use` の `input`）も
 * 測る。ここが実装ごとに違うと、「当たらない」の意味が実装ごとに変わる。
 *
 * `append` した行は呼び出し側のストアへ実際に残る（後始末はしない）。
 * 使い捨てのストアを渡すこと。
 */
export type JournalStoreSearchContractSubject = Pick<JournalStore, 'append' | 'list'>;

/** この契約が積む行を、同じストアの他の行と混ぜないための目印。 */
const TAG = 'journal-search-contract';

export async function verifyJournalStoreSearchContract(
  journal: JournalStoreSearchContractSubject,
): Promise<void> {
  // **積む順序が契約6（limit より前に効く）の要である。** 狙いの行を先に積み、
  // その後に当たらない行を複数積む。new→old で返るストアでは後者のほうが
  // 「新しい」ので、q を limit の後ろで絞る実装だと狙いの行は既に切り落とされる。
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
  // 契約4（ワイルドカードではない）のための行。`%` / `_` を1つも含まない。
  const literal = await journal.append({
    type: 'decision',
    decision: `${TAG}: 進捗は50%だった`,
    grounds: `${TAG}: 実測`,
  });
  // 対象外の欄（`tool_use` の `input`）に語を置く。**ここに当たってはいけない。**
  await journal.append({
    type: 'tool_use',
    actor: 'clone',
    tool: 'Bash',
    input: { command: `${TAG}: ナスの育て方` },
  });

  const ids = async (q: string, extra: { limit?: number } = {}): Promise<string[]> =>
    (await journal.list({ q, ...extra })).map((entry) => entry.id);

  // --- 契約1: 未指定 = 絞らない ---
  const unfiltered = await journal.list({});
  if (!unfiltered.some((entry) => entry.id === target.id)) {
    throw new Error(
      'JournalStore の q 契約（1: 未指定=絞らない）が破れている — ' +
        `q 未指定の list({}) が、積んだ行（id=${target.id}）を返さなかった。`,
    );
  }

  // --- 契約2: 指定 = 本文にその語を含む行だけ（部分一致） ---
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

  // --- 契約3: 大文字小文字を区別しない ---
  // 語の途中に当たること（前方一致でないこと）も同時に測る — `VERBATIM` は
  // `…をVERBATIMで…` の中にあり、語の境界に立っていない。
  const lowered = await ids('verbatim');
  if (!lowered.includes(target.id)) {
    throw new Error(
      'JournalStore の q 契約（3: 大文字小文字を区別しない部分一致）が破れている — ' +
        `本文に 'VERBATIM' を含む行（id=${target.id}）が、q: 'verbatim' で返らなかった。` +
        '（前方一致・語単位の照合になっている疑いもある）',
    );
  }

  // --- 契約4: `%` / `_` はワイルドカードではない（pg の ILIKE 由来） ---
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

  // --- 契約5: '' = 絞らない ---
  const emptyQ = await ids('');
  if (!emptyQ.includes(target.id)) {
    throw new Error(
      "JournalStore の q 契約（5: ''=絞らない）が破れている — " +
        `q: '' が、積んだ行（id=${target.id}）を返さなかった（0件へ倒している疑い）。`,
    );
  }

  // --- 契約6: limit より前に効く（#418 と同じ穴） ---
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

  // --- 対象外の欄（`tool_use` の `input`）に当たらない ---
  // **これは「まだ実装していない」ではなく、そう決めた線である**
  // （`journal-search.ts` の「対象にしていない欄」）。3実装で揃っていないと、
  // 「当たらない」の意味が実装ごとに変わる。
  const outOfScope = await ids('ナス');
  if (outOfScope.length !== 0) {
    throw new Error(
      'JournalStore の q 契約（対象外の欄）が破れている — ' +
        `tool_use の input にだけ 'ナス' を置いた行が、q: 'ナス' で ${outOfScope.length} 件返った。` +
        '照合の対象は journal-search.ts の SEARCHABLE_FIELDS_BY_TYPE が持つ欄だけである。',
    );
  }
}
