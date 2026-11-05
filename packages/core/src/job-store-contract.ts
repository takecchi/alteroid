import type { Job, PendingApproval } from './schema.js';
import type { JobStore } from './store.js';

// vitest に依存しない素の関数にする（storage-fs / storage-pg へ vitest を持ち込まないため）。
// 器の立て方の違いは `makeStore` で受ける: ケースごとに空の器を作り直す。
// 実装ごとにしか成り立たない期待（fs の壊れた承認の行を書く回にも消さない・排他の仕組みそのもの）はここへ置かず、各実装の試験に残す。
export type JobStoreFactory = () => JobStore | Promise<JobStore>;

function fail(property: string, detail: string): never {
  throw new Error(`JobStore の契約（${property}）が破れている — ${detail}`);
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner === undefined ? '<undefined>' : inner,
  );
}

function expectEqual(property: string, label: string, actual: unknown, expected: unknown): void {
  if (show(actual) !== show(expected)) {
    fail(property, `${label}（期待: ${show(expected)} / 実際: ${show(actual)}）`);
  }
}

async function expectRejects(
  property: string,
  label: string,
  run: () => Promise<unknown>,
): Promise<void> {
  let thrown = false;
  try {
    await run();
  } catch {
    thrown = true;
  }
  if (!thrown) fail(property, `${label}（throw しなかった）`);
}

const JOB: Job = {
  id: 'mgr-lost',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  status: 'lost',
  summary: '調べ物',
  sessionId: 'sess-old',
  runnerId: 'runner-primary',
};

const APPROVAL: PendingApproval = {
  id: 'ap-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  question: '本番に出してよいか',
};

async function findJob(store: JobStore, id: string): Promise<Job | undefined> {
  return (await store.listJobs()).find((job) => job.id === id);
}

export async function verifyJobStoreContract(makeStore: JobStoreFactory): Promise<void> {
  // putJob の入口の検査
  {
    const store = await makeStore();
    const invalidJob = {
      id: 'mgr-invalid',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'not-a-real-status',
      summary: '不正な job',
    } as unknown as Job;
    await expectRejects('putJob の検査', '未知の status を拒まない', () =>
      store.putJob(invalidJob),
    );
  }

  // updateJob は現在値を読み直し、互いの変更を消さない
  {
    const store = await makeStore();
    await store.putJob(JOB);
    await store.putJob({
      ...JOB,
      status: 'running',
      sessionId: 'sess-new',
      updatedAt: '2026-09-01T00:05:00.000Z',
    });
    const updated = await store.updateJob(JOB.id, (current) => ({
      ...current,
      lastReport: '外から先に割り込んだ報告',
    }));
    if (
      updated?.status !== 'running' ||
      updated.sessionId !== 'sess-new' ||
      updated.lastReport !== '外から先に割り込んだ報告'
    ) {
      fail('updateJob', `外から先に割り込んだ書き込みを消した: ${show(updated)}`);
    }
    expectEqual('updateJob', '返り値と保存された行が同じ', await findJob(store, JOB.id), updated);
  }
  {
    const store = await makeStore();
    let called = false;
    const result = await store.updateJob('no-such-job', (current) => {
      called = true;
      return current;
    });
    expectEqual('updateJob', '無い id は null', result, null);
    if (called) fail('updateJob', '無い id で mutate を呼んだ');
  }
  {
    const store = await makeStore();
    await store.putJob(JOB);
    const [a, b] = await Promise.all([
      store.updateJob(JOB.id, (current) => ({ ...current, summary: '1本目の書き込み' })),
      store.updateJob(JOB.id, (current) => ({ ...current, lastReport: '2本目の書き込み' })),
    ]);
    if (a === null || b === null)
      fail('updateJob', '同じ id への2本の updateJob のどちらかが null');
    const stored = await findJob(store, JOB.id);
    expectEqual('updateJob', '1本目の変更が残る', stored?.summary, '1本目の書き込み');
    expectEqual('updateJob', '2本目の変更が残る', stored?.lastReport, '2本目の書き込み');
  }
  {
    const store = await makeStore();
    await store.putJob(JOB);
    await expectRejects('updateJob の検査', 'jobSchema に合わない結果を書かせた', () =>
      store.updateJob(JOB.id, (current) => ({
        ...current,
        status: 'not-a-real-status' as unknown as Job['status'],
      })),
    );
  }

  // updateApproval（issue #2007）
  {
    const store = await makeStore();
    let called = false;
    const result = await store.updateApproval('nope', (current) => {
      called = true;
      return current;
    });
    expectEqual('updateApproval', '行が無ければ null', result, null);
    if (called) fail('updateApproval', '行が無いのに mutate を呼んだ');
  }
  {
    const store = await makeStore();
    await store.putApproval(APPROVAL);
    const result = await store.updateApproval('ap-1', (current) => ({
      ...current,
      answeredAt: '2026-09-01T00:05:00.000Z',
      answer: 'よい',
    }));
    expectEqual('updateApproval', '返り値は書いた値', result?.answer, 'よい');
    expectEqual(
      'updateApproval',
      '読み直すと書いた値が在る',
      (await store.getApproval('ap-1'))?.answer,
      'よい',
    );
    expectEqual(
      'updateApproval',
      '回答済みの行は pendingOnly の一覧から外れる',
      (await store.listApprovals({ pendingOnly: true })).entries,
      [],
    );
  }
  {
    const store = await makeStore();
    await store.putApproval(APPROVAL);
    const result = await store.updateApproval('ap-1', () => null);
    expectEqual('updateApproval', 'mutate が null を返したら null', result, null);
    expectEqual(
      'updateApproval',
      'mutate が null を返したら何も書かない',
      await store.getApproval('ap-1'),
      APPROVAL,
    );
  }
}
