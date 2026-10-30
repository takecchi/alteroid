import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeProgress } from './progress-describe.js';
import { summarizeProgress } from './progress.js';
import {
  DEFAULT_PROGRESS_WINDOW_HOURS,
  PROGRESS_WINDOW_HOURS_INVALID_MESSAGE,
  readProgress,
  readRepliesByConversation,
} from './progress-read.js';
import { taskRespondedAt, type Task } from './schema.js';
import { createCloneTools, qualifiedToolName, CLONE_ALLOWED_TOOLS } from './tools.js';
import { createMemoryStores } from './testing.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

function task(id: string, createdAt: string, over: Partial<Task> = {}): Task {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    status: 'queued',
    origin: 'human',
    title: `title ${id}`,
    body: `body ${id}`,
    ...over,
  };
}

async function seed() {
  const stores = createMemoryStores();
  await stores.tasks.add(task('c1', '2026-08-01T00:00:00.000Z', { origin: 'self' }));
  await stores.tasks.add(task('c2', '2026-09-29T00:00:00.000Z'));
  await stores.jobs.putJob({
    id: 'm1',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    status: 'running',
    summary: '走行中',
  });
  return stores;
}

function progressTool(stores: ReturnType<typeof createMemoryStores>) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'progress_read');
  if (!found) throw new Error('progress_read が登録されていない');
  return async (args: { windowHours?: number }) => {
    const result = await found.handler(args as never, {});
    return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
}

describe('progress_read — 作業の進捗を読む道具（#2241 の 3）', () => {
  it('クローンの許可名簿に載っている', () => {
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('progress_read'));
  });

  it('出力は readProgress の結果を describeProgress で文にしたものと一致する（数がずれない）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const stores = await seed();
    const reply = await progressTool(stores)({});
    const view = await readProgress(stores, { now: NOW });
    expect(reply).toBe(describeProgress(view));
    expect(reply).toContain('積み上がり（task の未了）: 2 件');
    expect(reply).toContain('実行中 1 /');
    expect(reply).toContain('観測時刻: 2026-09-30T12:00:00.000Z');
  });

  it('読めない委譲の行の断りは unreadableJobs が 0 のとき出さず、1件以上のとき件数つきで出す（#5723）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const view = await readProgress(await seed(), { now: NOW });
    const withJobs = (unreadableJobs: number) => ({
      ...view,
      backlog: {
        ...view.backlog,
        completeness: { ...view.backlog.completeness, unreadableJobs },
      },
    });
    expect(describeProgress(withJobs(0))).not.toContain('読めない委譲の行');
    expect(describeProgress(withJobs(2))).toContain('読めない委譲の行が 2 件ある');
  });

  it('状態別の「判定できない」は 0 件でも数つきで出す（#5773）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const view = await readProgress(await seed(), { now: NOW });
    const withUnjudgeable = (unjudgeable: number) => ({
      ...view,
      backlog: { ...view.backlog, byState: { ...view.backlog.byState, unjudgeable } },
    });
    expect(describeProgress(withUnjudgeable(0))).toContain('判定できない（会話に結んでいない） 0');
    expect(describeProgress(withUnjudgeable(3))).toContain('判定できない（会話に結んでいない） 3');
  });

  it('windowHours の既定は 168、指定するとその窓になる', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const call = progressTool(await seed());
    expect(DEFAULT_PROGRESS_WINDOW_HOURS).toBe(168);
    expect(await call({})).toContain('直近 168 時間');
    expect(await call({ windowHours: 24 })).toContain('直近 24 時間');
  });

  it('不正な windowHours は道具のエラーとして返し、集計を作らない', async () => {
    const stores = await seed();
    let listed = false;
    const list = stores.tasks.list.bind(stores.tasks);
    stores.tasks.list = async (options) => {
      listed = true;
      return list(options);
    };
    const call = progressTool(stores);
    for (const windowHours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(call({ windowHours })).rejects.toThrow(PROGRESS_WINDOW_HOURS_INVALID_MESSAGE);
    }
    expect(listed).toBe(false);
  });

  it('github の記録が1件も無い間は GitHub の段を出さない（0 とも書かない。#2970）', async () => {
    const reply = await progressTool(await seed())({});
    expect(reply).not.toContain('GitHub');
    expect(reply).not.toMatch(/GitHub: 0/);
  });

  it('github の記録が1件以上あれば GitHub の段を出す（#2970）', async () => {
    const stores = await seed();
    await stores.journal.append({
      type: 'github_observation',
      observedBy: 'clone',
      repo: 'x/y',
      query: 'gh issue list --state open',
      result: { status: 'ok', openIssues: 2, openPulls: 1, truncated: false },
    });
    const reply = await progressTool(stores)({});
    expect(reply).toContain('GitHub: 観測した側の申告');
    expect(reply).toContain('open Issue 2 件 / open PR 1 件');
  });

  it('⭐ 片付いた行を導出しなくても、全部の行を導出したときと集計が同じ（#5089）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const stores = await seed();
    for (const [id, originConversationId] of [
      ['h-replied', 'conv-r'],
      ['h-delegated', 'conv-d'],
      ['h-untouched', 'conv-u'],
      ['h-closed', 'conv-r'],
    ] as const) {
      await stores.tasks.add(task(id, '2026-09-28T00:00:00.000Z', { originConversationId }));
    }
    await stores.tasks.setStatus('h-closed', 'done', {
      at: '2026-09-29T00:00:00.000Z',
      by: 'human',
      reason: '済んだ',
    });
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '返答',
      conversationId: 'conv-r',
    });
    await stores.jobs.putJob({
      id: 'm-d',
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
      status: 'running',
      summary: '委譲中',
      taskId: 'h-delegated',
    });

    const view = await readProgress(stores, { now: NOW });

    const all = await stores.tasks.list({ includeClosed: true });
    const jobs = await stores.jobs.listJobs();
    const replies = await readRepliesByConversation(stores);
    const reference = summarizeProgress({
      tasks: {
        ...all,
        entries: all.entries.map((entry) => ({
          ...entry,
          respondedAt: taskRespondedAt(entry, replies),
        })),
      },
      jobs,
      unreadableJobs: (await stores.jobs.listUnreadableJobs()).length,
      now: NOW,
      windowHours: DEFAULT_PROGRESS_WINDOW_HOURS,
    });
    expect(view).toEqual({ ...reference, observedAt: view.observedAt, github: view.github });
    expect(view.backlog.byState).toMatchObject({
      responded: 1,
      delegated: 1,
      untouched: 2,
      unjudgeable: 1,
    });
  });

  it('返事したかは、task の originConversationId の会話の日誌から、createdAt より後の返答で導く', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'outbound',
      text: '古い返答',
      conversationId: 'conv-a',
    });
    await stores.tasks.add(
      task('after', new Date(Date.now() + 60_000).toISOString(), {
        originConversationId: 'conv-a',
      }),
    );
    await stores.tasks.add(
      task('other-conv', '2026-01-01T00:00:00.000Z', {
        originConversationId: 'conv-b',
      }),
    );
    const view = await readProgress(stores, { now: new Date(Date.now() + 120_000) });
    expect(view.backlog.byState).toMatchObject({ responded: 0, untouched: 2 });
  });

  it('未了の人間の task が無ければ、返答の一覧を読まない（片付いた task のために読まない。#5089）', async () => {
    const stores = await seed();
    await stores.tasks.add(
      task('h-closed', '2026-09-28T00:00:00.000Z', { originConversationId: 'conv-x' }),
    );
    await stores.tasks.setStatus('h-closed', 'done', {
      at: '2026-09-29T00:00:00.000Z',
      by: 'human',
      reason: '済んだ',
    });
    const humanReplies = vi.fn(async () => []);
    stores.journal.humanReplies = humanReplies;
    await readProgress(stores, { now: NOW });
    expect(humanReplies).not.toHaveBeenCalled();
  });

  it('取れない値を 0 と書かない（空の台帳の見込みは時間を作らず、齢は —）', async () => {
    const reply = await progressTool(createMemoryStores())({});
    expect(reply).toContain('積み上がり（task の未了）: 0 件');
    expect(reply).toContain('最古 —');
    expect(reply).toContain('中央値 —');
    expect(reply).toContain('unavailable');
    expect(reply).not.toContain('あと約');
    expect(reply).not.toContain('%');
  });
});
