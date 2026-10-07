import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UnreadableScheduleError, captureStderr } from '@alteroid/core';
import type { ScheduledRequest } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsScheduleStore — schedules.json の不正な1行を読み飛ばす（issue #1944）', () => {
  let root: string;
  let schedulesPath: string;

  const GOOD_SCHEDULE: ScheduledRequest = {
    kind: 'good-kind',
    spec: { type: 'every', minutes: 60 },
    request: '正常な継続中の依頼の本文（この文字列がそのまま跡に出てはいけない）',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  const BAD_SCHEDULE_RAW = {
    kind: 'bad-kind',
    spec: { type: 'not-a-real-spec-type-from-a-newer-deploy' },
    request: '壊れた継続中の依頼の本文（この文字列も跡に出てはいけない）',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    schedulesPath = join(root, 'jobs', 'schedules.json');
  });

  async function writeRawSchedulesFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.schedules.put(GOOD_SCHEDULE);
    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as {
      schedules: unknown[];
      phases: unknown[];
    };
    raw.schedules.push(BAD_SCHEDULE_RAW);
    await writeFile(schedulesPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  function findRowByKind(rows: unknown[], kind: string): unknown {
    return rows.find(
      (row) => typeof row === 'object' && row !== null && (row as { kind?: unknown }).kind === kind,
    );
  }

  it('list() は、不正な行があっても落ちず、正しい依頼を entries に返す（直す前は例外で赤）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = (await stores.schedules.list()).entries;
    });

    expect(found.map((entry) => entry.kind)).toEqual(['good-kind']);
  });

  it('list() は、不正な行を消さず unreadable に返す（kind と不正な欄名だけ。本文は載せない）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let list: Awaited<ReturnType<typeof stores.schedules.list>> | undefined;
    await captureStderr(async () => {
      list = await stores.schedules.list();
    });

    expect(list?.unreadable).toEqual([{ kind: 'bad-kind', reason: '不正な欄: spec' }]);
    expect(JSON.stringify(list?.unreadable)).not.toContain(BAD_SCHEDULE_RAW.request);
  });

  it('list() は、不正な行が無ければ unreadable が空（対照）', async () => {
    const stores = createFsStores(root);
    await stores.schedules.put(GOOD_SCHEDULE);

    const list = await stores.schedules.list();

    expect(list.entries.map((entry) => entry.kind)).toEqual(['good-kind']);
    expect(list.unreadable).toEqual([]);
  });

  it('跡: 飛ばした行を stderr へ1行出す。本文（request）の値は絶対に含めない', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.schedules.list();
    });
    const joined = lines.join('');

    expect(joined).toContain('bad-kind');
    expect(joined).not.toContain(GOOD_SCHEDULE.request);
    expect(joined).not.toContain(BAD_SCHEDULE_RAW.request);
  });

  it('get() は、正しい kind は返し、不正な行を kind 指定すると投げる（消されたのとは区別する）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let good: ScheduledRequest | null = null;
    await captureStderr(async () => {
      good = await stores.schedules.get('good-kind');
    });
    expect(good).toEqual(GOOD_SCHEDULE);

    await expect(
      captureStderr(async () => {
        await stores.schedules.get('bad-kind');
      }),
    ).rejects.toThrow();
    await expect(stores.schedules.get('bad-kind')).rejects.toBeInstanceOf(UnreadableScheduleError);

    let missing: ScheduledRequest | null = 'sentinel' as unknown as ScheduledRequest | null;
    await captureStderr(async () => {
      missing = await stores.schedules.get('never-existed');
    });
    expect(missing).toBeNull();
  });

  it('put() は投げない。書いた後も不正な行が元の形のまま残る', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    const NEW_SCHEDULE: ScheduledRequest = {
      kind: 'new-kind',
      spec: { type: 'every', minutes: 30 },
      request: '新しい継続中の依頼',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:00.000Z',
    };

    await captureStderr(async () => {
      await expect(stores.schedules.put(NEW_SCHEDULE)).resolves.toBeUndefined();
    });

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    const badRow = findRowByKind(raw.schedules, 'bad-kind');
    expect(badRow).toEqual(BAD_SCHEDULE_RAW);

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = (await stores.schedules.list()).entries;
    });
    expect(found.map((entry) => entry.kind).sort()).toEqual(['good-kind', 'new-kind']);
  });

  it('put() は、書き込む kind と一致する不正な行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    await captureStderr(() =>
      stores.schedules.put({
        kind: 'bad-kind',
        spec: { type: 'every', minutes: 15 },
        request: '直した継続中の依頼',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      }),
    );

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    const rowsWithKind = raw.schedules.filter(
      (row) =>
        typeof row === 'object' && row !== null && (row as { kind?: unknown }).kind === 'bad-kind',
    );

    expect(rowsWithKind).toHaveLength(1);
    expect(rowsWithKind[0]).toMatchObject({ kind: 'bad-kind', request: '直した継続中の依頼' });

    let fixed: ScheduledRequest | null = null;
    const lines = await captureStderr(async () => {
      fixed = await stores.schedules.get('bad-kind');
    });
    // `as` を外さない: `fixed` は async クロージャの中でしか再代入していないので、tsc がここでの読みを `never` へ潰すため
    expect((fixed as ScheduledRequest | null)?.request).toBe('直した継続中の依頼');
    expect(lines).toHaveLength(0);
  });

  it('remove() は、不正な行も kind 指定で消せる（get() の throw で詰まない回復手段）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await stores.schedules.remove('bad-kind');
    });

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(findRowByKind(raw.schedules, 'bad-kind')).toBeUndefined();

    let after: ScheduledRequest | null = 'sentinel' as unknown as ScheduledRequest | null;
    const lines = await captureStderr(async () => {
      after = await stores.schedules.get('bad-kind');
    });
    expect(after).toBeNull();
    expect(lines).toHaveLength(0);
  });

  it('removeIfPresent() は不正な行も消せて「読めなかった」と返す（get() を経由しない）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let result: ScheduledRequest | 'unreadable' | null = 'sentinel' as unknown as
      ScheduledRequest | 'unreadable' | null;
    const lines = await captureStderr(async () => {
      result = await stores.schedules.removeIfPresent('bad-kind');
    });
    expect(result).toBe('unreadable');
    expect(lines).toHaveLength(1);

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(findRowByKind(raw.schedules, 'bad-kind')).toBeUndefined();

    const afterLines = await captureStderr(async () => {
      await expect(stores.schedules.get('bad-kind')).resolves.toBeNull();
    });
    expect(afterLines).toHaveLength(0);

    const removedGood = await stores.schedules.removeIfPresent('good-kind');
    expect(removedGood).toEqual(GOOD_SCHEDULE);

    const missing = await stores.schedules.removeIfPresent('never-existed');
    expect(missing).toBeNull();
  });

  it('clear() は正しい依頼も壊れた依頼も両方消す——schedules.json に依頼が1つも残らない', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let removed: { schedules: number; phases: number } = { schedules: -1, phases: -1 };
    await captureStderr(async () => {
      removed = await stores.schedules.clear();
    });
    expect(removed).toEqual({ schedules: 2, phases: 0 });

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(raw.schedules).toEqual([]);

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = (await stores.schedules.list()).entries;
    });
    expect(found).toEqual([]);
  });
});
