import type { JournalStore } from './store.js';
import { UnreadableJournalEntryError } from './store.js';

// インメモリ実装（`testing.ts`）は対象外: `append` が形を断り、行は private な配列にしか入らないので、読めない行を持てない。
// 読めない行は `append` では作れないので、呼ぶ側が実装ごとの手で作り、その id を返す関数を `plantUnreadableRow` として渡す。
// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
export type JournalStoreUnreadableGetContractSubject = Pick<
  JournalStore,
  'append' | 'list' | 'get'
>;

export async function verifyJournalStoreUnreadableGetContract(
  journal: JournalStoreUnreadableGetContractSubject,
  plantUnreadableRow: () => Promise<string>,
): Promise<void> {
  const fail = (label: string, detail: unknown): never => {
    throw new Error(
      `JournalStore の「在るが読めない」の契約（${label}）が破れている — ${JSON.stringify(detail)}`,
    );
  };
  const outcomeOf = async (id: string): Promise<unknown> => {
    try {
      return await journal.get(id);
    } catch (error) {
      return error;
    }
  };

  const readable = await journal.append({
    type: 'decision',
    decision: 'journal-unreadable-get-contract: readable',
    grounds: 'journal-unreadable-get-contract',
  });
  const badId = await plantUnreadableRow();

  for (const round of ['1回目', '2回目']) {
    const outcome = await outcomeOf(badId);
    if (!(outcome instanceof UnreadableJournalEntryError) || outcome.id !== badId) {
      fail(`1: 読めない行の get は UnreadableJournalEntryError（${round}）`, {
        実際:
          outcome instanceof Error
            ? outcome.name
            : outcome === null
              ? 'null'
              : typeof outcome === 'object'
                ? '行を返した'
                : typeof outcome,
      });
    }
  }

  const missing = await outcomeOf(`${badId}-no-such-id`);
  if (missing !== null) {
    fail('2: 無い id の get は null', {
      実際: missing instanceof Error ? missing.name : typeof missing,
    });
  }

  const again = await outcomeOf(readable.id);
  if (again === null || again instanceof Error || (again as { id?: unknown }).id !== readable.id) {
    fail('3: 読める行の get は読めない行に巻き込まれない', {
      実際: again instanceof Error ? again.name : again === null ? 'null' : typeof again,
    });
  }

  let listed: Awaited<ReturnType<typeof journal.list>>;
  try {
    listed = await journal.list();
  } catch (error) {
    return fail('4: list() は読めない行を飛ばして投げない', {
      投げた: error instanceof Error ? error.name : typeof error,
    });
  }
  if (listed.some((entry) => entry.id === badId)) {
    fail('4: list() は読めない行を返さない', { id: badId });
  }
  if (!listed.some((entry) => entry.id === readable.id)) {
    fail('4: list() は読める行を返す', { id: readable.id });
  }
}
