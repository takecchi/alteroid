import { expectNulRejected } from './nul-contract-support.js';
import type { JobStore } from './store.js';

export async function verifyJobNulContract(store: JobStore): Promise<void> {
  function fail(message: string): never {
    throw new Error(`JobStore の NUL の契約違反: ${message}`);
  }
  const at = '2026-10-06T00:00:00.000Z';
  const later = '2026-10-06T01:00:00.000Z';
  const nulId = 'job-nul-c\u0000ontract';

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

  // 断らず落として残す: 自分の行を指す鍵ではなく、記録が丸ごと落ちるほうが害が大きいため
  await store.putJob({
    id: 'job-nul-refs',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: 's',
    conversationId: 'c\u0000onv',
    managerId: 'm\u0000gr',
    sessionId: 's\u0000ess',
    projectKey: 'p\u0000roj',
    runnerId: 'r\u0000unner',
  });
  const refJob = (await store.listJobs()).find((entry) => entry.id === 'job-nul-refs');
  if (
    refJob?.conversationId !== 'conv' ||
    refJob.managerId !== 'mgr' ||
    refJob.sessionId !== 'sess' ||
    refJob.projectKey !== 'proj' ||
    refJob.runnerId !== 'runner'
  ) {
    fail(`ジョブの参照キーの NUL が残る・記録が落ちる: ${JSON.stringify(refJob)}`);
  }
  await store.putApproval({
    id: 'approval-nul-refs',
    createdAt: at,
    question: 'q',
    jobId: 'j\u0000ob',
    requestId: 'r\u0000eq',
    questions: [
      {
        id: 'q\u00001',
        prompt: '問\u0000い',
        options: [{ id: 'o\u00001', label: '選\u0000択', description: '説\u0000明' }],
      },
    ],
    selections: [{ questionId: 'q\u00001', optionIds: ['o\u00001'], other: '他\u0000' }],
  });
  const refApproval = await store.getApproval('approval-nul-refs');
  if (
    refApproval?.jobId !== 'job' ||
    refApproval.requestId !== 'req' ||
    refApproval.questions?.[0]?.id !== 'q1' ||
    refApproval.questions[0].prompt !== '問い' ||
    refApproval.questions[0].options[0]?.id !== 'o1' ||
    refApproval.questions[0].options[0].label !== '選択' ||
    refApproval.questions[0].options[0].description !== '説明' ||
    refApproval.selections?.[0]?.questionId !== 'q1' ||
    refApproval.selections[0].optionIds[0] !== 'o1' ||
    refApproval.selections[0].other !== '他'
  ) {
    fail(
      `承認待ちの参照・構造化された欄の NUL が残る・記録が落ちる: ${JSON.stringify(refApproval)}`,
    );
  }

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
