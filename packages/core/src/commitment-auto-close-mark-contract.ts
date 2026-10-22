import type { CommitmentStore } from './store.js';

// vitest に依存しない素の関数にする（`verifyCommitmentFoldContract` と同じ理由）。
// 枠の知らせで開いた行の印（`autoCloseWhenBack`）を、3実装が書いて読み返せることを縛る（#5164）。
// 起動のときの組み直しは、この印を台帳から読んで候補へ戻す。落とす実装があると、再起動のたびに候補を失う。
export async function verifyCommitmentAutoCloseMarkContract(store: CommitmentStore): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`CommitmentStore の自動クローズの印の契約違反: ${message}`);
  };
  const base = { at: '2026-02-01T00:00:00.000Z', origin: 'manager', source: 'mgr-mark' } as const;

  const marked = await store.open({
    ...base,
    id: 'mark-1',
    body: '印のある行',
    autoCloseWhenBack: { managerId: 'mgr-mark' },
  });
  if (!marked.opened) fail('印のある行が開かない');
  const unmarked = await store.open({ ...base, id: 'mark-2', body: '印の無い行' });
  if (!unmarked.opened) fail('印の無い行が開かない');

  const readMarked = await store.get('mark-1');
  if (readMarked?.autoCloseWhenBack?.managerId !== 'mgr-mark')
    fail(`get が印を返さない: ${JSON.stringify(readMarked?.autoCloseWhenBack)}`);
  const readUnmarked = await store.get('mark-2');
  if (readUnmarked === null) fail('印の無い行が読めない');
  if (readUnmarked?.autoCloseWhenBack !== undefined) fail('印の無い行に印が付いた');

  const listed = (await store.list()).entries;
  const listedMarked = listed.find((entry) => entry.id === 'mark-1');
  if (listedMarked?.autoCloseWhenBack?.managerId !== 'mgr-mark')
    fail(`list が印を返さない: ${JSON.stringify(listedMarked?.autoCloseWhenBack)}`);
  if (listed.find((entry) => entry.id === 'mark-2')?.autoCloseWhenBack !== undefined)
    fail('list で印の無い行に印が付いた');

  // 閉じても印は残る（閉じた行を台帳から読み返す人が、なぜ器が閉じたのかを辿れる）
  if (!(await store.close('mark-1', '2026-02-01T00:01:00.000Z', '閉じた', 'daemon')))
    fail('印のある行が閉じられない');
  const closed = await store.get('mark-1');
  if (closed?.autoCloseWhenBack?.managerId !== 'mgr-mark') fail('閉じた行から印が消えた');
}
