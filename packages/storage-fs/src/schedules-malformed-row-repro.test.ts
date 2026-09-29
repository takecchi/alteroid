import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UnreadableScheduleError, captureStderr } from '@alteroid/core';
import type { ScheduledRequest } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

/**
 * issue #1944（#1868 / #1928 の線を継続中の依頼にそろえる）。`FsScheduleStore#read()`
 * は `schedules.json` の `schedules` 配列全体を `fileSchema.parse` で1回に検査して
 * いた。そのため、**1行でも `scheduledRequestSchema` に合わない行があると
 * `ZodError` が投げられ、`list()` だけでなく `get()` / `put()` / `editRequest()` /
 * `claimRun()` / `completeRun()` / `getPhase()` / `putPhase()` / `clear()` まで、
 * 同じ `schedules.json` を読む操作がすべて落ちる**——`#read()` が1回しかないため。
 *
 * pg 実装（`PgScheduleStore`）の `list()` も同じ形で、行ごとに `parsePlan()` を
 * 呼び1行でも失敗すると投げていた（`packages/storage-pg/src/schedules-malformed
 * -row-repro.test.ts` が対の歯を持つ）。
 *
 * **ただし `get(kind)` はこれまでどおり投げる**（issue #1944 の方針）。「消された」
 * （`null`）と「読めない」（throw）を区別できないと、`clone.ts` は発火した依頼を
 * 「人間が手で仕込んだ kind を起こした」と誤解し、本文なしの曖昧なターンを走らせる
 * ——pg 版の `parsePlan` の doc に書いてある理由と同じである。飛ばすのは `list()`
 * だけでよい（1件だけを引く操作は、その1件が読めないことを呼び出し側に伝える必要が
 * あるため）。
 */
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

  // `spec` が schema に合わない（`type` が既知の値ではない）——版ずれ・手編集を模す。
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

  /**
   * schedules.json を、正しい依頼1件・schema に合わない依頼1件で直接作る
   * （手編集・版ずれを模す）。
   */
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

  it('list() は、不正な行があっても落ちず、正しい依頼だけを返す（直す前は例外で赤）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = await stores.schedules.list();
    });

    expect(found.map((entry) => entry.kind)).toEqual(['good-kind']);
  });

  it('跡: 飛ばした行を stderr へ1行出す。本文（request）の値は絶対に含めない', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.schedules.list();
    });
    const joined = lines.join('');

    // 位置・kind は載ってよい。
    expect(joined).toContain('bad-kind');
    // **本文（request）は絶対に出ない**（正常行・壊れた行のどちらの値も）。
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
    // **issue #2177。** `instanceof` で見分けられる専用の型を投げる
    // （`schedule_list` の tools.ts の catch が使う契約）。文言は変えていない。
    await expect(stores.schedules.get('bad-kind')).rejects.toBeInstanceOf(UnreadableScheduleError);

    // 本当に消された kind（一度も書いていない）は、投げずに null。
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
    // **元の形のまま**——書き換えられず、消えてもいない（別の kind を put しただけ）。
    expect(badRow).toEqual(BAD_SCHEDULE_RAW);

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = await stores.schedules.list();
    });
    expect(found.map((entry) => entry.kind).sort()).toEqual(['good-kind', 'new-kind']);
  });

  it('put() は、書き込む kind と一致する不正な行を置き換える（元の壊れた行とは共存しない）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    // 壊れた行と同じ kind（bad-kind）で、正しい依頼を put する——「直した」つもり。
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

    // **その kind は1行だけ**（新しい値）——古い壊れた行と共存しない。
    expect(rowsWithKind).toHaveLength(1);
    expect(rowsWithKind[0]).toMatchObject({ kind: 'bad-kind', request: '直した継続中の依頼' });

    // 直したので、次の get('bad-kind') はもう投げない。
    let fixed: ScheduledRequest | null = null;
    const lines = await captureStderr(async () => {
      fixed = await stores.schedules.get('bad-kind');
    });
    // **`as` は挙動を変えない、型だけの回避。** `fixed` は async クロージャの中でしか
    // 再代入していないので、tsc がここでの読みを（narrow ではなく）`never` へ潰す
    // （`let x: T | null = null` を async closure 内で再代入し、閉じたあとに
    // プロパティへアクセスするだけで再現する tsc 自体の挙動——captureStderr 固有では
    // ない。実測: `tsc --noEmit --strict` に最小再現を通して確認した）。
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

    // 消えたので、以後の get() は例外ではなく null。
    let after: ScheduledRequest | null = 'sentinel' as unknown as ScheduledRequest | null;
    const lines = await captureStderr(async () => {
      after = await stores.schedules.get('bad-kind');
    });
    expect(after).toBeNull();
    expect(lines).toHaveLength(0);
  });

  /**
   * issue #1982。`get(kind)` が読めない行で投げる契約のまま、`DELETE
   * /schedule/:kind`（`apps/daemon/src/app.ts`）と `schedule_remove`
   * （`tools.ts`）は先に `get(kind)` を呼んでいたので、壊れた依頼を外そうと
   * すると `remove()` まで届かず例外になっていた。`removeIfPresent()` は
   * `get()` を経由せず、`remove()` と同じ排他区間で「無かった（`null`）／
   * 読めた（値そのもの）／在ったが読めなかった（`'unreadable'`）」を返す。
   */
  it('removeIfPresent() は不正な行も消せて「読めなかった」と返す（get() を経由しない）', async () => {
    await writeRawSchedulesFile();
    const stores = createFsStores(root);

    let result: ScheduledRequest | 'unreadable' | null = 'sentinel' as unknown as
      ScheduledRequest | 'unreadable' | null;
    const lines = await captureStderr(async () => {
      result = await stores.schedules.removeIfPresent('bad-kind');
    });
    expect(result).toBe('unreadable');
    // **`#update` は毎回 `#read()` からやり直す**（`list()` と同じ跡が1行出る
    // ——`bad-kind` はこの呼び出しの時点ではまだファイルに残っている）。
    expect(lines).toHaveLength(1);

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(findRowByKind(raw.schedules, 'bad-kind')).toBeUndefined();

    // 消えたので、以後の get() はもう跡を出さず、例外でもなく null。
    const afterLines = await captureStderr(async () => {
      await expect(stores.schedules.get('bad-kind')).resolves.toBeNull();
    });
    expect(afterLines).toHaveLength(0);

    // 読める行は、消した値そのものを返す。
    const removedGood = await stores.schedules.removeIfPresent('good-kind');
    expect(removedGood).toEqual(GOOD_SCHEDULE);

    // 本当に無い kind（一度も書いていない）は null（404 の材料）。
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
    // jobs 側（#1868 / #1892）と同じく、消えた行すべてを数える——正しい行だけを
    // 数えると、pg の `DELETE … RETURNING` の件数（壊れているかに関係なく消した
    // 行数）と食い違う。
    expect(removed).toEqual({ schedules: 2, phases: 0 });

    const raw = JSON.parse(await readFile(schedulesPath, 'utf8')) as { schedules: unknown[] };
    expect(raw.schedules).toEqual([]);

    let found: ScheduledRequest[] = [];
    await captureStderr(async () => {
      found = await stores.schedules.list();
    });
    expect(found).toEqual([]);
  });
});
