import { describe, expect, it } from 'vitest';

import { createClone } from './clone.js';
import { fakeSdk, waitFor } from './clone-test-harness.js';
import type { ManagerSummary } from './manager.js';
import { createMemoryStores } from './testing.js';

// 人間の答えの案内文が、もう待たれていない確認にも「manager_send で返すと再開する」と書き、答えが担当へ届かない不具合。
// `manager_message` の枝と同じく、`managers.list()` で確認の決着を見て案内を変える。

const ANSWER_MARKER = '承認待ちにしていた質問に人間が答えた';
const RESUME_CLAIM = '止まっていたその仕事が再開する';
const SETTLED_NOTE = 'この確認はもう待たれていない';

function summary(waiting: { requestId: string }[]): ManagerSummary {
  const at = '2026-10-08T00:00:00.000Z';
  return {
    managerId: 'm1',
    status: 'running',
    live: true,
    cwd: '/work',
    request: '依頼',
    startedAt: at,
    updatedAt: at,
    waiting,
    runnerId: 'runner-a',
  } as unknown as ManagerSummary;
}

async function answerWith(list: () => Promise<ManagerSummary[]>): Promise<string> {
  const stores = createMemoryStores();
  const inputs: string[] = [];
  const { fn } = fakeSdk((input) => {
    inputs.push(input);
    return '進めた';
  });
  const clone = createClone({
    stores,
    queryFn: fn,
    env: {},
    managers: { list, stop: async () => undefined } as never,
  });
  await stores.jobs.putApproval({
    id: 'ap-1',
    createdAt: new Date().toISOString(),
    question: '本番へ出してよいか',
    jobId: 'm1',
    requestId: 'r1',
  });
  await clone.answerApproval('ap-1', 'はい');
  await waitFor(() => inputs.some((input) => input.includes(ANSWER_MARKER)));
  await clone.stop();
  return inputs.find((input) => input.includes(ANSWER_MARKER)) ?? '';
}

describe('人間の答えの案内: 確認がまだ待たれているか', () => {
  it('その確認がもう待たれていない（waiting が空）なら、「再開する」と書かず、待たれていないと伝える', async () => {
    const input = await answerWith(async () => [summary([])]);
    expect(input).toContain(SETTLED_NOTE);
    expect(input).not.toContain(RESUME_CLAIM);
    expect(input).toContain('manager_send');
  });

  it('まだ待たれているなら、今までどおり再開すると案内する', async () => {
    const input = await answerWith(async () => [summary([{ requestId: 'r1' }])]);
    expect(input).toContain(RESUME_CLAIM);
    expect(input).not.toContain(SETTLED_NOTE);
  });

  it('一覧が読めない（分からない）ときは、「待たれていない」と言わず今までどおり案内する', async () => {
    const input = await answerWith(async () => {
      throw new Error('一覧が取れない');
    });
    expect(input).toContain(RESUME_CLAIM);
    expect(input).not.toContain(SETTLED_NOTE);
  });
});
