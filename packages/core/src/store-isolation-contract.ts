import type { Commitment, Job, PendingApproval } from './schema.js';
import type { Stores } from './store.js';

// vitest に依存しない素の非同期関数にする: storage-fs / storage-pg へ vitest を持ち込まないため
export async function verifyStoreIsolationContract(stores: Stores): Promise<void> {
  const fail = (message: string): never => {
    throw new Error(`ストアの参照の隔離の契約違反: ${message}`);
  };

  const job: Job = {
    id: 'isolation-job',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    summary: '隔離の確認',
  };
  await stores.jobs.putJob(job);
  job.summary = '書いた側で書き換えた';
  const storedJob = (await stores.jobs.listJobs()).find((entry) => entry.id === 'isolation-job');
  if (storedJob?.summary !== '隔離の確認') {
    fail(`putJob の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedJob?.summary}`);
  }
  if (storedJob !== undefined) storedJob.summary = '読んだ側で書き換えた';
  const reread = (await stores.jobs.listJobs()).find((entry) => entry.id === 'isolation-job');
  if (reread?.summary !== '隔離の確認') {
    fail(`listJobs が返した値を書き換えたら、ストアの中身が動いた: ${reread?.summary}`);
  }

  const approval: PendingApproval = {
    id: 'isolation-approval',
    createdAt: '2026-01-01T00:00:00.000Z',
    question: '隔離の確認',
  };
  await stores.jobs.putApproval(approval);
  approval.question = '書いた側で書き換えた';
  const storedApproval = await stores.jobs.getApproval('isolation-approval');
  if (storedApproval?.question !== '隔離の確認') {
    fail(
      `putApproval の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedApproval?.question}`,
    );
  }

  const commitment: Commitment = {
    id: 'isolation-commitment',
    at: '2026-01-01T00:00:00.000Z',
    origin: 'human',
    body: '隔離の確認',
  };
  await stores.commitments.open(commitment);
  commitment.body = '書いた側で書き換えた';
  const storedCommitment = await stores.commitments.get('isolation-commitment');
  if (storedCommitment?.body !== '隔離の確認') {
    fail(`open の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedCommitment?.body}`);
  }
  const appended = await stores.journal.append({
    type: 'decision',
    decision: '隔離の確認',
    grounds: '隔離の確認',
  });
  if (appended.type !== 'decision') fail('append が別の枝を返した');
  else appended.decision = '返された行を書き換えた';
  const storedEntry = (await stores.journal.list({ types: ['decision'] })).find(
    (entry) => entry.id === appended.id,
  );
  if (storedEntry?.type === 'decision' && storedEntry.decision !== '隔離の確認') {
    fail(`append が返した行を書き換えたら、日誌の中身が動いた: ${storedEntry.decision}`);
  }

  const plan = {
    kind: 'isolation_check',
    spec: { type: 'daily' as const, at: '10:00' },
    request: '隔離の確認',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await stores.schedules.put(plan);
  plan.request = '書いた側で書き換えた';
  const storedPlan = await stores.schedules.get('isolation_check');
  if (storedPlan?.request !== '隔離の確認') {
    fail(`put の後に呼び出し元が書き換えた値が、ストアへ漏れた: ${storedPlan?.request}`);
  }
}
