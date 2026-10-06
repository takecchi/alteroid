import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, createScheduler, UnreadableScheduleError } from '@alteroid/core';
import type { InboxEvent } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * `every` の分数に上限（1年 = 525600 分）を置いた（#3533）後の、**保存済みの上限超えの行**の読み方。
 *
 * 上限が無かったころは `minutes: 1e15` が保存できた。上限を置いた後にそれが `schedules.json` に
 * 残っていても、`list()` が投げたり、スケジューラが 1ms 周期で起こし続けたり、行を消したりしては
 * いけない。6欄の cron（`schedules-six-field-cron-stored.test.ts`）と同じく、読めない行（`unreadable`）として残す。
 */
describe('FsScheduleStore — 保存済みの上限超えの every は読めない行として残る（#3533）', () => {
  let root: string;
  let schedulesPath: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    schedulesPath = join(root, 'jobs', 'schedules.json');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const base = {
    request: '本文',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  /** 上限内で保存した行を、ファイル上だけ巨大な分数へ書き換える（上限を置く前に保存された状態を模す）。 */
  async function seed(): Promise<void> {
    const stores = createFsStores(root);
    await stores.schedules.put({ ...base, kind: 'good', spec: { type: 'every', minutes: 60 } });
    await stores.schedules.put({ ...base, kind: 'huge', spec: { type: 'every', minutes: 60 } });
    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as {
      schedules: { kind: string; spec: { minutes: number } }[];
    };
    const row = raw.schedules.find((entry) => entry.kind === 'huge');
    if (row === undefined) throw new Error('huge の行が無い');
    row.spec.minutes = 1e15;
    await writeFile(schedulesPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  it('put は上限超えを断る（525600 は通る）', async () => {
    const stores = createFsStores(root);
    await expect(
      stores.schedules.put({ ...base, kind: 'over', spec: { type: 'every', minutes: 525_601 } }),
    ).rejects.toThrow();
    await stores.schedules.put({
      ...base,
      kind: 'edge',
      spec: { type: 'every', minutes: 525_600 },
    });
    expect((await stores.schedules.list()).entries.map((entry) => entry.kind)).toEqual(['edge']);
  });

  it('list() は落ちず、上限超えの行を unreadable に返し、ほかは entries に返す', async () => {
    await seed();
    const stores = createFsStores(root);
    let list: Awaited<ReturnType<typeof stores.schedules.list>> | undefined;
    await captureStderr(async () => {
      list = await stores.schedules.list();
    });
    expect(list?.entries.map((entry) => entry.kind)).toEqual(['good']);
    expect(list?.unreadable.map((row) => row.kind)).toEqual(['huge']);
  });

  it('get() は読めない行として投げる。ファイルの行は消えない', async () => {
    await seed();
    const stores = createFsStores(root);
    await captureStderr(async () => {
      await expect(stores.schedules.get('huge')).rejects.toBeInstanceOf(UnreadableScheduleError);
    });
    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(JSON.stringify(raw.schedules)).toContain('1000000000000000');
  });

  it('スケジューラは仕込まず、10秒で timer を積まず、list() は投げず、unreadable() に見える', async () => {
    await seed();
    const stores = createFsStores(root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'));
    const posted: InboxEvent[] = [];
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      schedules: stores.schedules,
      onError: () => undefined,
    });
    await captureStderr(async () => {
      await scheduler.refresh();
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    scheduler.stop();
    expect(scheduler.list().map((item) => item.kind)).toEqual(['good']);
    expect(scheduler.unreadable().map((row) => row.kind)).toEqual(['huge']);
    expect(posted).toEqual([]);
  });
});
