import { describe, expect, it } from 'vitest';

import { buildActivityDigest } from './digest.js';
import { createManagerPool } from './manager.js';
import { describeProgress } from './progress-describe.js';
import { readProgress } from './progress-read.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { UnreadableJob } from './schema.js';
import { describeUnreadableJobs } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

function withUnreadable(rows: UnreadableJob[]): Stores {
  const stores = createMemoryStores();
  stores.jobs = { ...stores.jobs, listUnreadableJobs: async () => rows };
  return stores;
}

function managerList(stores: Stores): () => Promise<string> {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'clone',
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
  const tool = tools.find((entry) => entry.name === 'manager_list');
  if (!tool) throw new Error('manager_list が無い');
  return async () => {
    const result = await tool.handler({} as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe('describeUnreadableJobs', () => {
  it('0件は null（0 の行を作らない）', () => {
    expect(describeUnreadableJobs([])).toBeNull();
  });

  it('id が取れた行は並べ、取れない行は件数だけで言う', () => {
    const text = describeUnreadableJobs([
      { id: 'a', reason: '不正な欄: status' },
      { reason: '不正な行' },
    ]);
    expect(text).toBe(
      '読めない委譲が 2 件ある（id: a。id が取れない行が 1 件）。' +
        '壊れた行であって、居ないのでも、畳まれたのでもない。この一覧には載っていない。',
    );
  });

  it('id が1つも取れないときは「id も取れない」', () => {
    expect(describeUnreadableJobs([{ reason: '不正な行' }])).toContain('（id も取れない）');
  });

  it('id の列挙には上限があり、切ったら言う', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `j${i}`, reason: 'x' }));
    const text = describeUnreadableJobs(rows) ?? '';
    expect(text).toContain('読めない委譲が 12 件ある');
    expect(text).toContain('j9');
    expect(text).not.toContain('j10');
    expect(text).toContain('ほか 2 件');
  });

  it('reason（不正な欄名）は文に載せない', () => {
    expect(describeUnreadableJobs([{ id: 'a', reason: '不正な欄: request' }])).not.toContain(
      '不正な欄',
    );
  });
});

describe('manager_list（読めた委譲が在るとき）', () => {
  it('読めた委譲の一覧に加えて、件数の行と同じ場所で「読めない委譲」を言う', async () => {
    const stores = withUnreadable([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    await stores.jobs.putJob({
      id: 'mgr-good',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'done',
      summary: '要旨',
      request: '依頼',
    });

    const reply = await managerList(stores)();

    expect(reply).toContain('mgr-good');
    expect(reply).toContain('読めない委譲が 1 件ある（id: mgr-bad）');
    expect(reply).not.toContain('マネージャーは1本も居ない');
  });

  it('対照: 読めない行が0件なら、読めない委譲の文言は出ない', async () => {
    const stores = withUnreadable([]);
    await stores.jobs.putJob({
      id: 'mgr-good',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'done',
      summary: '要旨',
      request: '依頼',
    });

    expect(await managerList(stores)()).not.toContain('読めない委譲');
  });
});

describe('digest と進捗', () => {
  it('digest: 読めない委譲の件数の行と、マネージャー節の末尾の1文', async () => {
    const stores = withUnreadable([{ id: 'mgr-bad', reason: '不正な欄: status' }]);
    const digest = await buildActivityDigest(stores, { since: new Date(Date.now() - 60_000) });
    expect(digest).toContain('- 読めない委譲（壊れた行。上の本数には入っていない）: 1 件');
    expect(digest).toContain('- 読めない委譲が 1 件ある（id: mgr-bad）');
  });

  it('readProgress / describeProgress: completeness.unreadableJobs と但し書き', async () => {
    const stores = withUnreadable([{ reason: '不正な行' }, { id: 'b', reason: 'x' }]);
    const view = await readProgress(stores, { now: new Date() });
    expect(view.backlog.completeness.unreadableJobs).toBe(2);
    expect(describeProgress(view)).toContain('※ 読めない委譲の行が 2 件ある');
  });

  it('対照: 読めない行が0件なら、unreadableJobs は 0 で但し書きは出ない', async () => {
    const stores = withUnreadable([]);
    const view = await readProgress(stores, { now: new Date() });
    expect(view.backlog.completeness.unreadableJobs).toBe(0);
    expect(describeProgress(view)).not.toContain('読めない委譲');
  });

  it('describeProgress: 欄が無い古いデーモンの応答では、「undefined」を書かず、読めない委譲について何も言わない（#2382）', async () => {
    const view = await readProgress(withUnreadable([]), { now: new Date() });
    const { unreadable, trimmedClosed } = view.backlog.completeness;
    const text = describeProgress({
      ...view,
      backlog: { ...view.backlog, completeness: { unreadable, trimmedClosed } },
    });
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('読めない委譲');
  });
});
