import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratedTemplate } from './pglite-template.test-support.js';

// 雛形（WASM の起動 + migrate）を前払いする（#3034）: 下の補助は印の差し替えの後に動的に読むので、静的な import の前払いが掛からない
beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

// ループの停止の見張りの印だけを差し替えて読む（見張りの本体は使わない）
const phases = vi.hoisted(() => [] as string[]);
vi.mock('@alteroid/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alteroid/core')>()),
  notePhase: (label: string) => {
    phases.push(label);
  },
}));

const { PgJournalStore } = await import('./journal.js');
const { createMigratedTestDb } = await import('./test-db.test-support.js');

type Handle = Awaited<ReturnType<typeof createMigratedTestDb>>;
let handle: Handle;

beforeEach(async () => {
  handle = await createMigratedTestDb();
});

afterEach(async () => {
  await handle.client.close();
});

// 日誌書きの同期の処理（NUL 落とし・検査・JSON 化）は行の大きさに比例するので、止まった窓がそこに掛かったかを印で分ける（#4485）
describe('日誌の書き込みの前後に印を打つ（#4485）', () => {
  it('⭐ 種別と本文の長さの見当を添えた印を書く前に打ち、組み立て終えた印を問い合わせより前に打つ', async () => {
    const store = new PgJournalStore(handle.db);
    phases.length = 0;
    await store.append({
      type: 'tool_use',
      actor: 'manager:mgr-1',
      tool: 'Write',
      input: { file_path: '/w/a.txt', content: 'x'.repeat(1000) },
    });
    const ours = phases.filter((label) => label.startsWith('journal-append'));
    // 1段目の文字列（type・actor・tool）と input の1段目の文字列（file_path・content）を足した長さ
    const expected =
      'tool_use'.length + 'manager:mgr-1'.length + 'Write'.length + '/w/a.txt'.length + 1000;
    expect(ours).toEqual([`journal-append:tool_use:${String(expected)}ch`, 'journal-append-built']);
  });
});
