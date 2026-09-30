import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeProgress } from './progress-describe.js';
import {
  DEFAULT_PROGRESS_WINDOW_HOURS,
  PROGRESS_WINDOW_HOURS_INVALID_MESSAGE,
  readProgress,
} from './progress-read.js';
import { createCloneTools, qualifiedToolName, CLONE_ALLOWED_TOOLS } from './tools.js';
import { createMemoryStores } from './testing.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

async function seed() {
  const stores = createMemoryStores();
  await stores.commitments.open({
    id: 'c1',
    at: '2026-08-01T00:00:00.000Z',
    origin: 'self',
    body: '未了の1件',
  });
  await stores.commitments.open({
    id: 'c2',
    at: '2026-09-29T00:00:00.000Z',
    origin: 'human',
    body: '未了の2件目',
  });
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
    expect(reply).toContain('積み上がり（台帳の未了）: 2 件');
    expect(reply).toContain('実行中 1 /');
    expect(reply).toContain('観測時刻: 2026-09-30T12:00:00.000Z');
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
    const list = stores.commitments.list.bind(stores.commitments);
    stores.commitments.list = async (options) => {
      listed = true;
      return list(options);
    };
    const call = progressTool(stores);
    for (const windowHours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(call({ windowHours })).rejects.toThrow(PROGRESS_WINDOW_HOURS_INVALID_MESSAGE);
    }
    expect(listed).toBe(false);
  });

  it('github は観測していない（0 件ではない）と書く', async () => {
    const reply = await progressTool(await seed())({});
    expect(reply).toContain('GitHub: 観測していない（0 件ではない）');
    expect(reply).not.toMatch(/GitHub: 0/);
  });

  it('取れない値を 0 と書かない（空の台帳の見込みは時間を作らず、齢は —）', async () => {
    const reply = await progressTool(createMemoryStores())({});
    expect(reply).toContain('積み上がり（台帳の未了）: 0 件');
    expect(reply).toContain('最古 —');
    expect(reply).toContain('中央値 —');
    expect(reply).toContain('unavailable');
    expect(reply).not.toContain('あと約');
    expect(reply).not.toContain('%');
  });
});
