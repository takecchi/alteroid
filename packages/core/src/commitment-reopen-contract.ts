import type { CommitmentStore } from './store.js';

// vitest に依存しない素の関数にする（`verifyCommitmentFoldContract` と同じ理由）。
// 閉じた行を開き直す口（`reopen`）の契約を3実装で揃える（#5176）。
export async function verifyCommitmentReopenContract(store: CommitmentStore): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`CommitmentStore の開き直しの契約違反: ${message}`);
  };
  const base = { at: '2026-03-01T00:00:00.000Z', origin: 'manager', source: 'mgr-reopen' } as const;
  const closedAt = '2026-03-01T00:05:00.000Z';

  const opened = await store.open({
    ...base,
    id: 'reopen-1',
    body: '開き直す行',
    bodyMarkup: 'markdown',
    autoCloseWhenBack: { managerId: 'mgr-reopen' },
  });
  if (!opened.opened) fail('行が開かない');

  const notClosed = await store.reopen('reopen-1');
  if (notClosed.kind !== 'not-closed') fail(`未了の行が not-closed にならない: ${notClosed.kind}`);
  const untouched = await store.get('reopen-1');
  if (untouched?.autoCloseWhenBack === undefined || untouched.autoCloseDeclined !== undefined)
    fail('not-closed の呼び出しが行を書き換えた');

  const missing = await store.reopen('reopen-missing');
  if (missing.kind !== 'not-found') fail(`無い id が not-found にならない: ${missing.kind}`);
  const nul = await store.reopen('reopen\u0000-1');
  if (nul.kind !== 'not-found') fail(`NUL を含む id が not-found にならない: ${nul.kind}`);

  if (!(await store.close('reopen-1', closedAt, '片付けた', 'daemon'))) fail('行が閉じられない');
  const closed = await store.get('reopen-1');
  if (closed === null) fail('閉じた行が読めない');

  const result = await store.reopen('reopen-1');
  if (result.kind !== 'reopened') return fail(`閉じた行が開き直せない: ${result.kind}`);
  if (
    result.before.closedAt !== closedAt ||
    result.before.closedReason !== '片付けた' ||
    result.before.closedBy !== 'daemon'
  )
    fail(`before が閉じた行の写しでない: ${JSON.stringify(result.before)}`);

  const after = await store.get('reopen-1');
  if (after === null) return fail('開き直した行が読めない');
  if (
    after.closedAt !== undefined ||
    after.closedReason !== undefined ||
    after.closedBy !== undefined
  )
    fail(`閉じた記録が残った: ${JSON.stringify(after)}`);
  if (after.autoCloseWhenBack !== undefined) fail('autoCloseWhenBack が残った');
  if (after.autoCloseDeclined !== true)
    fail(`開き直した行に autoCloseDeclined: true が付かない: ${JSON.stringify(after)}`);
  if (
    after.id !== 'reopen-1' ||
    after.at !== base.at ||
    after.origin !== base.origin ||
    after.source !== base.source ||
    after.body !== '開き直す行' ||
    after.bodyMarkup !== 'markdown'
  )
    fail(`受け取った時刻・起点・本文が変わった: ${JSON.stringify(after)}`);
  if (!(await store.list()).entries.some((entry) => entry.id === 'reopen-1'))
    fail('開き直した行が未了の一覧に出ない');

  // 開き直した行は未了なので、もう一度開き直すのは not-closed
  const again = await store.reopen('reopen-1');
  if (again.kind !== 'not-closed')
    fail(`開き直した行の再度の reopen が not-closed にならない: ${again.kind}`);

  // `open` は冪等のまま: 開き直した後も同じ id の open は何もしない（本文で上書きしない）
  const reopened = await store.open({ ...base, id: 'reopen-1', body: '別の本文' });
  if (reopened.opened || reopened.folded) fail('開き直した行の同じ id の open が何かをした');
  if ((await store.get('reopen-1'))?.body !== '開き直す行')
    fail('同じ id の open が本文を上書きした');

  // 開き直した後に閉じ直せる
  if (!(await store.close('reopen-1', '2026-03-01T00:10:00.000Z', '閉じ直した', 'human')))
    fail('開き直した行が閉じ直せない');
  const reclosed = await store.get('reopen-1');
  if (reclosed?.closedBy !== 'human' || reclosed.closedReason !== '閉じ直した')
    fail(`閉じ直した記録が残らない: ${JSON.stringify(reclosed)}`);

  // 閉じた行へ同じ id の open は何もしない（冪等）。閉じ直した行は閉じたまま
  const reopenedClosed = await store.open({ ...base, id: 'reopen-1', body: '別の本文' });
  if (reopenedClosed.opened) fail('閉じ直した行の同じ id の open が行を蘇らせた');

  // 同一マネージャー×同一本文の未了が在る間は、閉じた manager 起点の行を開き直さない（`open` の畳み込みと同じ規則。pg は部分一意索引にも当たる）
  const dup = { at: '2026-03-02T00:00:00.000Z', origin: 'manager', source: 'mgr-dup' } as const;
  if (!(await store.open({ ...dup, id: 'dup-old', body: '同じ本文' })).opened)
    fail('重複の試験の行が開かない');
  if (!(await store.close('dup-old', closedAt, '片付けた', 'clone')))
    fail('重複の試験の行が閉じられない');
  if (!(await store.open({ ...dup, id: 'dup-new', body: '同じ本文' })).opened)
    fail('閉じた後の同文の manager 行が開かない');
  const duplicate = await store.reopen('dup-old');
  if (duplicate.kind !== 'duplicate-open' || duplicate.openId !== 'dup-new')
    fail(`重複になる開き直しが duplicate-open にならない: ${JSON.stringify(duplicate)}`);
  const stillClosed = await store.get('dup-old');
  if (stillClosed?.closedAt !== closedAt) fail('duplicate-open が行を書き換えた');

  // 未了の相手が閉じれば開き直せる
  if (!(await store.close('dup-new', closedAt, '片付けた', 'clone'))) fail('相手が閉じられない');
  if ((await store.reopen('dup-old')).kind !== 'reopened') fail('相手が閉じた後も開き直せない');

  // origin が manager でない行・source の違う行は、本文が同じでも開き直せる
  const other = [
    { id: 'dup-human-a', origin: 'human', source: undefined },
    { id: 'dup-human-b', origin: 'human', source: undefined },
  ] as const;
  for (const entry of other) {
    if (
      !(await store.open({ at: dup.at, origin: entry.origin, id: entry.id, body: '人間の同文' }))
        .opened
    )
      fail('人間起点の行が開かない');
    if (!(await store.close(entry.id, closedAt, '片付けた', 'human')))
      fail('人間起点の行が閉じられない');
  }
  if ((await store.reopen('dup-human-a')).kind !== 'reopened') fail('人間起点の行が開き直せない');
  if ((await store.reopen('dup-human-b')).kind !== 'reopened')
    fail('同文の未了が在っても、manager でない行は開き直せるはず');

  const srcA = { at: dup.at, origin: 'manager', body: '出所違いの同文' } as const;
  if (!(await store.open({ ...srcA, id: 'src-a', source: 'mgr-a' })).opened)
    fail('src-a が開かない');
  if (!(await store.open({ ...srcA, id: 'src-b', source: 'mgr-b' })).opened)
    fail('src-b が開かない');
  if (!(await store.close('src-a', closedAt, '片付けた', 'clone'))) fail('src-a が閉じられない');
  if ((await store.reopen('src-a')).kind !== 'reopened')
    fail('source が違う同文の未了が在っても、開き直せるはず');
}
