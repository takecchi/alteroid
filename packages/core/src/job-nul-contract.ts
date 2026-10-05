import { expectNulRejected } from './nul-contract-support.js';
import type { JobStore } from './store.js';

/**
 * `JobStore`（ジョブと承認待ち）の NUL の約束（issue #3011。teto の判断、2026-10-06）を、**実装1つに対して**測る。
 * 3実装（インメモリ / fs / pg）が同じ関数を呼ぶ。
 *
 * - **読むだけの口**（`getApproval`・`updateJob`・`updateApproval` の id）: NUL を含む id で引かれたら、断らず
 *   「無い」と同じ結果（`null`。`mutate` は呼ばない）を返す。pg は DB に投げる前に短絡する
 * - **書き込みの口**: `putJob`・`putApproval` の `id`（鍵）の NUL は `NulNotAllowedError` で断る（値は文に載せない）。
 *   本文（ジョブの `summary`・`request`・`lastReport`、承認待ちの `question`・`context`・`answer`）の NUL は落として残す
 * - 参照キー（`conversationId`・`managerId`・`jobId` など）の NUL の扱いは未決なので、ここでは測らない
 *
 * 書いたものは残さない（`clear` はしない。使い捨てのストアを渡すこと）。vitest に依存しない。
 */
export async function verifyJobNulContract(store: JobStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`JobStore の NUL の契約違反: ${message}`);
  }
  const at = '2026-10-06T00:00:00.000Z';
  const later = '2026-10-06T01:00:00.000Z';
  const nulId = 'job-nul-c\u0000ontract';

  // 書き込み: 鍵は断る。何も書かない。
  await expectNulRejected(
    fail,
    'putJob(NULを含むid)',
    () =>
      store.putJob({ id: nulId, createdAt: at, updatedAt: at, status: 'running', summary: 's' }),
    'job-nul-c',
  );
  await expectNulRejected(
    fail,
    'putApproval(NULを含むid)',
    () => store.putApproval({ id: nulId, createdAt: at, question: 'q' }),
    'job-nul-c',
  );

  // 本文は落として残す。
  await store.putJob({
    id: 'job-nul-body',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: '要\u0000約',
    request: '依\u0000頼',
    lastReport: '報\u0000告',
  });
  const job = (await store.listJobs()).find((entry) => entry.id === 'job-nul-body');
  if (job?.summary !== '要約' || job.request !== '依頼' || job.lastReport !== '報告') {
    fail(`ジョブの本文の NUL が残る: ${JSON.stringify(job)}`);
  }
  const updated = await store.updateJob('job-nul-body', (current) => ({
    ...current,
    updatedAt: later,
    summary: '更\u0000新',
  }));
  if (updated?.summary !== '更新')
    fail(`updateJobの返り値に NUL が残る: ${JSON.stringify(updated)}`);
  if ((await store.listJobs()).find((entry) => entry.id === 'job-nul-body')?.summary !== '更新') {
    fail('updateJobの本文の NUL が残る');
  }

  await store.putApproval({
    id: 'approval-nul-body',
    createdAt: at,
    question: '問\u0000い',
    context: '文\u0000脈',
  });
  const approval = await store.getApproval('approval-nul-body');
  if (approval?.question !== '問い' || approval.context !== '文脈') {
    fail(`承認待ちの本文の NUL が残る: ${JSON.stringify(approval)}`);
  }
  const answered = await store.updateApproval('approval-nul-body', (current) => ({
    ...current,
    answeredAt: later,
    answer: '答\u0000え',
  }));
  if (answered?.answer !== '答え')
    fail(`updateApprovalの返り値に NUL が残る: ${JSON.stringify(answered)}`);
  if ((await store.getApproval('approval-nul-body'))?.answer !== '答え') {
    fail('updateApprovalの本文の NUL が残る');
  }

  // 読むだけの口: 「無い」と同じ結果。投げない。mutate も呼ばない。
  let called = false;
  const readOutcomes: Array<[string, () => Promise<unknown>]> = [
    ['getApproval(NULを含むid)はnull', () => store.getApproval(nulId)],
    [
      'updateJob(NULを含むid)はnull',
      () =>
        store.updateJob(nulId, (current) => {
          called = true;
          return current;
        }),
    ],
    [
      'updateApproval(NULを含むid)はnull',
      () =>
        store.updateApproval(nulId, (current) => {
          called = true;
          return current;
        }),
    ],
  ];
  for (const [label, call] of readOutcomes) {
    let outcome: unknown;
    try {
      outcome = await call();
    } catch (error) {
      fail(`${label}（投げた: ${error instanceof Error ? error.name : typeof error}）`);
    }
    if (outcome !== null) fail(`${label}（実際: ${JSON.stringify(outcome)}）`);
  }
  if (called) fail('NULを含むidで mutate を呼んだ');
  if ((await store.listJobs()).some((entry) => entry.id.includes('\u0000'))) {
    fail('断ったはずの NUL を含む id のジョブが在る');
  }
}
