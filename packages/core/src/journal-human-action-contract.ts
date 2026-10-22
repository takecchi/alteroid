import type { HumanAction } from './schema.js';
import type { JournalStore } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため。
// 時刻の待ちは使わない: 順序ではなく id で行を引く。
export type JournalStoreHumanActionContractSubject = Pick<JournalStore, 'append' | 'list'>;

const MARKER = 'journal-human-action-contract';

function fail(property: string, detail: string): never {
  throw new Error(`JournalStore の人間の操作の印の契約（${property}）が破れている — ${detail}`);
}

function sameAction(actual: HumanAction | undefined, expected: HumanAction): boolean {
  if (actual === undefined) return false;
  if (actual.kind !== expected.kind || actual.target !== expected.target) return false;
  if (actual.via.kind !== expected.via.kind) return false;
  if (actual.via.kind === 'account' && expected.via.kind === 'account') {
    return actual.via.accountId === expected.via.accountId;
  }
  if (actual.via.kind === 'operator' && expected.via.kind === 'operator') {
    return actual.via.auth === expected.via.auth;
  }
  return false;
}

export async function verifyJournalStoreHumanActionContract(
  journal: JournalStoreHumanActionContractSubject,
): Promise<void> {
  const actions: readonly HumanAction[] = [
    { kind: 'manager_message', target: 'mgr-1', via: { kind: 'operator', auth: 'disabled' } },
    { kind: 'commitment_close', target: 'c-1', via: { kind: 'operator', auth: 'operator-token' } },
    { kind: 'schedule_remove', target: 'daily', via: { kind: 'account', accountId: 'acct-1' } },
    { kind: 'practice_remove', target: 'p-slug', via: { kind: 'account', accountId: 'acct-2' } },
    { kind: 'practice_write', target: 'p-slug', via: { kind: 'operator', auth: 'disabled' } },
  ];

  const marked = new Map<string, HumanAction>();
  for (const humanAction of actions) {
    const written = await journal.append({
      type: 'decision',
      decision: `${MARKER}: ${humanAction.kind}`,
      grounds: `${MARKER}: 印あり`,
      humanAction,
    });
    marked.set(written.id, humanAction);
  }
  const plain = await journal.append({
    type: 'decision',
    decision: `${MARKER}: 印なし`,
    grounds: `${MARKER}: 古い行の形`,
  });

  const back = await journal.list({ types: ['decision'] });
  for (const [id, expected] of marked) {
    const row = back.find((entry) => entry.id === id);
    if (row === undefined || row.type !== 'decision') {
      fail('書き戻し', `${expected.kind} の行が list で読み戻せない`);
    }
    // 鍵の順で比べない: jsonb は鍵の順を並べ替えて返す
    if (!sameAction(row.humanAction, expected)) {
      fail(
        '書き戻し',
        `${expected.kind} の humanAction が落ちた・変わった（読み戻し: ${JSON.stringify(row.humanAction)}）`,
      );
    }
  }
  const plainBack = back.find((entry) => entry.id === plain.id);
  if (plainBack === undefined || plainBack.type !== 'decision') {
    fail('印なし', '印の無い行が list で読み戻せない');
  }
  if ('humanAction' in plainBack) {
    fail('印なし', '印の無い行に humanAction が湧いている（無い行は無いまま読める）');
  }
}
