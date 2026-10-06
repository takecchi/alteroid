import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, createScheduler, UnreadableScheduleError } from '@alteroid/core';
import type { InboxEvent } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * cron を5欄だけにした（#3387）後の、**保存済みの6欄の式**の読み方。
 *
 * 5欄に閉じる前は `*&#47;5 * * * * *` のような式が保存できた。閉じた後にそれが
 * `schedules.json` に残っていても、読む側が落ちたり、秒の周期で起こし続けたり、
 * 行ごと消したりしてはいけない。読めない行（`unreadable`）として残し、ほかの依頼は仕込む。
 */
describe('FsScheduleStore — 保存済みの6欄の cron は読めない行として残る（#3387）', () => {
  let root: string;
  let schedulesPath: string;

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    schedulesPath = join(root, 'jobs', 'schedules.json');
  });

  const base = {
    request: '本文',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  /** 5欄で保存した行を、ファイル上だけ6欄へ書き換える（5欄に閉じる前に保存された状態を模す）。 */
  async function seed(): Promise<void> {
    const stores = createFsStores(root);
    await stores.schedules.put({
      ...base,
      kind: 'good',
      spec: { type: 'cron', expression: '0 10 * * 1' },
    });
    await stores.schedules.put({
      ...base,
      kind: 'old-six',
      spec: { type: 'cron', expression: '0 10 * * 1' },
    });
    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as {
      schedules: { kind: string; spec: { expression: string } }[];
    };
    const row = raw.schedules.find((entry) => entry.kind === 'old-six');
    if (row === undefined) throw new Error('old-six の行が無い');
    row.spec.expression = '*/5 * * * * *';
    await writeFile(schedulesPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  it('list() は落ちず、6欄の行を unreadable に返し、5欄の行は entries に返す', async () => {
    await seed();
    const stores = createFsStores(root);
    let list: Awaited<ReturnType<typeof stores.schedules.list>> | undefined;
    await captureStderr(async () => {
      list = await stores.schedules.list();
    });
    expect(list?.entries.map((entry) => entry.kind)).toEqual(['good']);
    expect(list?.unreadable.map((row) => row.kind)).toEqual(['old-six']);
  });

  it('get() は読めない行として投げる（消されたのとは区別する）。ファイルの行は消えない', async () => {
    await seed();
    const stores = createFsStores(root);
    await captureStderr(async () => {
      await expect(stores.schedules.get('old-six')).rejects.toBeInstanceOf(UnreadableScheduleError);
    });
    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(JSON.stringify(raw.schedules)).toContain('*/5 * * * * *');
  });

  it('起動時の読み直し（Scheduler.refresh）は落ちず、6欄の行は仕込まずに unreadable で持ち回る', async () => {
    await seed();
    const stores = createFsStores(root);
    const posted: InboxEvent[] = [];
    const scheduler = createScheduler({
      entries: [],
      post: (event) => posted.push(event),
      now: () => new Date('2026-09-12T08:00:00.000Z'),
      schedules: stores.schedules,
      onError: () => undefined,
    });
    await captureStderr(async () => {
      await scheduler.refresh();
    });
    expect(scheduler.list().map((item) => item.kind)).toEqual(['good']);
    expect(scheduler.unreadable().map((row) => row.kind)).toEqual(['old-six']);
    expect(posted).toEqual([]);
  });
});
