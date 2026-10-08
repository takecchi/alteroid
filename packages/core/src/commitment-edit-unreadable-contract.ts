import { UnreadableCommitmentError } from './store.js';
import type { CommitmentStore } from './store.js';

/**
 * 読めない形で入っている台帳の行への `CommitmentStore.editBody` の契約（Issue #4064）を、実装1つに対して測る。
 * 読めない行は `ifMatch` の有無を問わず `UnreadableCommitmentError` で断り、書き換えない。
 * 読めない行を持てるのは fs・pg だけ（インメモリは `open` が形を断る）。
 * `plantUnreadableRow` は、その id の読めない（片付いていない）行を器へ直に置く。**空のストアに対して呼ぶこと。**
 */
export async function verifyCommitmentEditUnreadableContract(
  store: CommitmentStore,
  plantUnreadableRow: (id: string) => Promise<void>,
): Promise<void> {
  function fail(message: string): never {
    throw new Error(`台帳の器の契約違反（読めない行への editBody）: ${message}`);
  }
  const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const bad = 'contract-edit-unreadable';
  const good = 'contract-edit-unreadable-good';

  async function expectUnreadable(label: string, run: () => Promise<unknown>): Promise<void> {
    let outcome: unknown;
    try {
      outcome = await run();
    } catch (error) {
      outcome = error;
    }
    if (!(outcome instanceof UnreadableCommitmentError)) {
      fail(
        `${label} が UnreadableCommitmentError でない: ${outcome instanceof Error ? outcome.name : JSON.stringify(outcome)}`,
      );
    }
  }

  await store.open({ id: good, at: t(0), origin: 'human', body: '読める行' });
  await plantUnreadableRow(bad);

  await expectUnreadable('editBody（ifMatch 省略）', () => store.editBody(bad, 'x', t(1), 'human'));
  await expectUnreadable('editBody（ifMatch: 文字列）', () =>
    store.editBody(bad, 'x', t(1), 'human', { ifMatch: t(0) }),
  );
  await expectUnreadable('断られた後の get', () => store.get(bad));
  const listed = await store.list();
  if (!listed.unreadable.some((row) => row.id === bad)) {
    fail('断られた後、読めない行が list().unreadable から消えた');
  }

  if (!(await store.editBody(good, '直した', t(2), 'human'))) {
    fail('読めない行が在ると、読める行の editBody が通らない');
  }
  if ((await store.get(good))?.body !== '直した') fail('読める行の editBody が書けていない');
  if (await store.editBody('contract-edit-unreadable-ghost', 'x', t(1), 'human')) {
    fail('無い行への editBody が true を返した');
  }

  await store.clear();
}
