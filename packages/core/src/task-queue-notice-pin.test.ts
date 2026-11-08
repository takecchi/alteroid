import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setup, waitFor } from './clone-test-harness.js';
import { buildActivityDigest } from './digest.js';
import type { Task } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 待ち行列の節（断り書き `[system] 待ち行列（…` と digest の `## 待ち行列の先頭`）の「今の出力」を固定する pin。
// 全文の期待は仕様を先に書いたものではなく、今の作りの出力を `vitest run <path> -u` で生成して目で読んだ値である。
// 「滞留の件数と古さ」の行を足す改修（task-queue-backlog-age.test.ts）の前に置いた。
// 今は `waiting` / `needs_decision` の件数が内訳（`queued n / waiting n / needs_decision n`）にあるだけで、`updatedAt` も古さも出ていない。
// 時刻は `Date` だけを止める（実時間の待ちは足さない）。
// 動いた理由（滞留の行を足した実装のコミットで更新）: waiting / needs_decision が混ざる 2 本（断り書き・digest full 形）の全文に、
// 件数の行の次の 1 行 `- 滞留: needs_decision 1 件（最も古いのは 5日3時間前） / waiting 1 件（最も古いのは 1時間20分前）` が入った。
// 開いている件が 0 の 2 本・counts 形の 1 本は 1 字も動いていない（0 件のとき変わらないことの歯）。
// 動いた理由（waiting のしきい値の実装のコミットで更新）: 上の混在 2 本の waiting（w-1）は 1時間20分前で、24 時間を超えていないので数えなくなった。
// 滞留の行は `- 滞留: needs_decision 1 件（最も古いのは 5日3時間前）` だけになった（needs_decision は古さによらず出る）。件数の行・先頭の行・固定の1文は動いていない。

const FROZEN_AT = '2026-11-01T09:00:00.000Z';
const QUEUE_HEAD = '[system] 待ち行列（';
const NOTICE_END = '\n\n---\n';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

function task(id: string, status: Task['status'], updatedAt: string): Task {
  return {
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    status,
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
  };
}

/** queued / waiting / needs_decision を1件ずつと、閉じた1件。 */
async function seedMixed(stores: Stores): Promise<void> {
  await stores.tasks.add(task('q-1', 'queued', '2026-10-31T09:00:00.000Z'));
  await stores.tasks.add(task('w-1', 'waiting', '2026-11-01T07:40:00.000Z'));
  await stores.tasks.add(task('n-1', 'needs_decision', '2026-10-27T06:00:00.000Z'));
  await stores.tasks.add(task('d-1', 'done', '2026-10-01T00:00:00.000Z'));
}

function noticeOf(input: string): string {
  const start = input.indexOf(QUEUE_HEAD);
  expect(start).toBeGreaterThanOrEqual(0);
  return input.slice(start, input.indexOf(NOTICE_END, start) + NOTICE_END.length);
}

async function noticeForReportTurn(stores: Stores): Promise<string> {
  const s = setup(undefined, stores);
  s.clone.post({
    type: 'manager_message',
    id: 'evt-report',
    at: new Date().toISOString(),
    managerId: 'mgr-T',
    kind: 'report',
    text: '本文',
  });
  await waitFor(() => (s.calls[0]?.inputs.length ?? 0) >= 1, '報告のターン');
  const input = s.calls[0]?.inputs[0] ?? '';
  await s.clone.stop();
  return noticeOf(input);
}

function digestSectionOf(digest: string): string {
  const start = digest.indexOf('## 待ち行列の先頭');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = digest.indexOf('\n\n', start);
  return digest.slice(start, end < 0 ? undefined : end);
}

describe('待ち行列の節の今の出力（pin。今の作りで通る）', () => {
  it('断り書き: queued / waiting / needs_decision が混ざるとき、件数の内訳・先頭の行・固定の1文だけ（古さは出ない）', async () => {
    const stores = createMemoryStores();
    await seedMixed(stores);
    const notice = await noticeForReportTurn(stores);
    expect(notice).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 3 件（queued 1 / waiting 1 / needs_decision 1）
      - 滞留: needs_decision 1 件（最も古いのは 5日3時間前）
      - q-1（状態: queued（待ち行列） / origin: self）title-q-1
      - w-1（状態: waiting（待ち（外の返事・時間待ち）） / origin: self）title-w-1
      - n-1（状態: needs_decision（決めてほしい） / origin: self）title-n-1
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });

  it('断り書き: 開いている件が0なら、件数の行と固定の1文だけ（閉じた件は出ない）', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('d-1', 'done', '2026-10-01T00:00:00.000Z'));
    const notice = await noticeForReportTurn(stores);
    expect(notice).toMatchInlineSnapshot(`
      "[system] 待ち行列（09:00:00Z に数えた材料）
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）
      全文は \`task_list\`。並べ替えは \`task_move\`。

      ---
      "
    `);
  });

  it('digest（full 形）: 同じ並びの節の全文（古さは出ない）', async () => {
    const stores = createMemoryStores();
    await seedMixed(stores);
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });
    expect(digestSectionOf(digest)).toMatchInlineSnapshot(`
      "## 待ち行列の先頭
      - 待ち行列: 開いている 3 件（queued 1 / waiting 1 / needs_decision 1）
      - 滞留: needs_decision 1 件（最も古いのは 5日3時間前）
      - q-1（状態: queued（待ち行列） / origin: self）title-q-1
      - w-1（状態: waiting（待ち（外の返事・時間待ち）） / origin: self）title-w-1
      - n-1（状態: needs_decision（決めてほしい） / origin: self）title-n-1
      （先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）"
    `);
  });

  it('digest（full 形）: 開いている件が0なら件数の行だけ', async () => {
    const stores = createMemoryStores();
    await stores.tasks.add(task('d-1', 'done', '2026-10-01T00:00:00.000Z'));
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });
    expect(digestSectionOf(digest)).toMatchInlineSnapshot(`
      "## 待ち行列の先頭
      - 待ち行列: 開いている 0 件（queued 0 / waiting 0 / needs_decision 0）"
    `);
  });

  it('digest（counts 形）: waiting / needs_decision があっても件数の1行だけ', async () => {
    const stores = createMemoryStores();
    await seedMixed(stores);
    const counts = await buildActivityDigest(
      stores,
      { since: new Date(Date.now() - 60_000) },
      undefined,
      undefined,
      { shape: 'counts' },
    );
    const lines = counts.split('\n').filter((line) => line.includes('待ち行列'));
    expect(lines).toMatchInlineSnapshot(`
      [
        "- 待ち行列: 開いている 3 件（queued 1 / waiting 1 / needs_decision 1）",
        "（#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— 待ち行列は \`task_list\`、回答待ちは \`approvals_list\`、決めたこと・エスカレーション・記憶の更新・外部イベントは \`journal_read\`、使った分は \`usage_read\`）",
      ]
    `);
  });
});
