import type { JournalStore } from './store.js';
import { UnreadableJournalEntryError } from './store.js';

/**
 * `JournalStore.get` の「在るが読めない」の契約を、実装1つに対して測る（issue #3288）。
 *
 * **契約:** 読めない行（`journalEntrySchema` に合わない。未知の `type`・版ずれ・手編集）の id を
 * `get` で引くと `UnreadableJournalEntryError`（`id` はその id）。**無い id は `null`**。
 * 読めない行が在っても、読める行の `get` は変わらず、`list()` は投げずにその行を飛ばす。
 * `get` は行を書き換えない（2回引いても同じ）。
 *
 * **読めない行は `append` では作れない**（`append` は `journalEntrySchema` で断る）ので、呼ぶ側が
 * 実装ごとの手（fs はファイルへ1行足す、pg は行を直に挿す）で作り、その id を返す関数を
 * `plantUnreadableRow` として渡す。
 *
 * **インメモリ実装（`testing.ts`）はこの契約の対象外である。** `append` が形を断り、行は private な
 * 配列にしか入らないので、読めない行を持てない（`UnreadableJournalEntryError` の doc）。
 * だから `scripts/journal-store-with-contract-registry.test.ts` は、この契約を fs・pg にだけ要求する
 * （`REQUIRED_CONTRACTS` ではなく `READABILITY_CONTRACTS`）。
 *
 * vitest に依存しない素の非同期関数にしてある（`journal-query-edge-contract.ts` の doc と同じ理由）。
 */
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

  // 1. 読めない行の get は UnreadableJournalEntryError（id 付き）。2回引いても同じ（読んだだけで行は変わらない）。
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

  // 2. 無い id は null（読めない行の存在で「無い」が崩れない）。
  const missing = await outcomeOf(`${badId}-no-such-id`);
  if (missing !== null) {
    fail('2: 無い id の get は null', {
      実際: missing instanceof Error ? missing.name : typeof missing,
    });
  }

  // 3. 読める行の get は変わらない。
  const again = await outcomeOf(readable.id);
  if (again === null || again instanceof Error || (again as { id?: unknown }).id !== readable.id) {
    fail('3: 読める行の get は読めない行に巻き込まれない', {
      実際: again instanceof Error ? again.name : again === null ? 'null' : typeof again,
    });
  }

  // 4. list() は投げず、読めない行を飛ばす（従来どおり。`get` だけが「在る」を言う）。
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
