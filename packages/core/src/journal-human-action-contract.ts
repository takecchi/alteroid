import type { HumanAction } from './schema.js';
import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
export type JournalStoreHumanActionContractSubject = Pick<JournalStore, 'append' | 'list'>;

const SAMPLES: readonly HumanAction[] = [
  { kind: 'manager_message', target: 'mgr-1', via: { kind: 'operator', auth: 'operator-token' } },
  { kind: 'commitment_close', target: 'c-1', via: { kind: 'operator', auth: 'disabled' } },
  { kind: 'task_close', target: 't-1', via: { kind: 'operator', auth: 'disabled' } },
  { kind: 'task_reopen', target: 't-1', via: { kind: 'operator', auth: 'disabled' } },
  { kind: 'task_move', target: 't-1', via: { kind: 'account', accountId: 'acc-1' } },
  { kind: 'schedule_remove', target: 'daily-x', via: { kind: 'account', accountId: 'acc-1' } },
  { kind: 'practice_remove', target: 'daily', via: { kind: 'account', accountId: 'acc-1' } },
  { kind: 'practice_write', target: 'daily', via: { kind: 'operator', auth: 'operator-token' } },
];

export async function verifyJournalStoreHumanActionContract(
  journal: JournalStoreHumanActionContractSubject,
): Promise<void> {
  const fail = (label: string, detail: unknown): never => {
    throw new Error(
      `JournalStore の decision.humanAction の契約（${label}）が破れている — ${JSON.stringify(detail)}`,
    );
  };

  const plain = await journal.append({
    type: 'decision',
    decision: 'journal-human-action-contract: 印なし',
    grounds: 'journal-human-action-contract',
  });
  const ids: string[] = [];
  for (const humanAction of SAMPLES) {
    const written = await journal.append({
      type: 'decision',
      decision: `journal-human-action-contract: ${humanAction.kind}`,
      grounds: 'journal-human-action-contract',
      humanAction,
    });
    ids.push(written.id);
  }

  const listed = await journal.list({ types: ['decision'] });
  const byId = new Map(listed.map((entry) => [entry.id, entry]));

  SAMPLES.forEach((humanAction, index) => {
    const entry = byId.get(ids[index] ?? '');
    const actual =
      entry !== undefined && entry.type === 'decision' ? entry.humanAction : '行が読み戻せない';
    if (JSON.stringify(actual) !== JSON.stringify(humanAction)) {
      fail(`1: ${humanAction.kind} が欄ごと返る`, { 期待: humanAction, 実際: actual });
    }
  });

  const plainBack = byId.get(plain.id);
  if (
    plainBack === undefined ||
    plainBack.type !== 'decision' ||
    plainBack.humanAction !== undefined
  ) {
    fail('2: 印の無い行は印なしのまま読める', { id: plain.id });
  }
}
