import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr } from '@alteroid/core';
import type { Practice } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

describe('FsPracticeStore — practices.json の不正な1行を読み飛ばす（issue #1967）', () => {
  let root: string;
  let practicesPath: string;

  const GOOD_PRACTICE = {
    slug: 'good-practice',
    kind: '実装',
    title: '正常なやり方（この文字列がそのまま跡に出てはいけない）',
    content: '正常な本文\n',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };

  const BAD_PRACTICE_RAW = {
    slug: 'bad-practice',
    title: '壊れたやり方（この文字列も跡に出てはいけない）',
    content: '壊れた本文（跡に出てはいけない）\n',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
  };

  const GOOD_VERSION = {
    slug: 'good-practice',
    version: 1,
    kind: '実装',
    title: '正常な版',
    content: '正常な版の本文\n',
    at: '2026-09-01T00:00:00.000Z',
  };

  const BAD_VERSION_RAW = {
    slug: 'bad-version-practice',
    version: 'not-a-number',
    kind: '実装',
    title: '壊れた版（跡に出てはいけない）',
    content: '壊れた版の本文（跡に出てはいけない）\n',
    at: '2026-09-02T00:00:00.000Z',
  };

  beforeEach(async () => {
    root = await makeTempDir('alteroid-test-');
    practicesPath = join(root, 'jobs', 'practices.json');
  });

  async function writeRawPracticesFile(): Promise<void> {
    const stores = createFsStores(root);
    await stores.practices.write({
      slug: GOOD_PRACTICE.slug,
      kind: GOOD_PRACTICE.kind,
      title: GOOD_PRACTICE.title,
      content: GOOD_PRACTICE.content,
    });
    const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as {
      practices: unknown[];
      practiceVersions: unknown[];
    };
    raw.practices = raw.practices.filter(
      (row) => (row as { slug?: unknown }).slug !== GOOD_PRACTICE.slug,
    );
    raw.practices.push(GOOD_PRACTICE, BAD_PRACTICE_RAW);
    raw.practiceVersions = raw.practiceVersions.filter(
      (row) => (row as { slug?: unknown }).slug !== GOOD_PRACTICE.slug,
    );
    raw.practiceVersions.push(GOOD_VERSION, BAD_VERSION_RAW);
    await writeFile(practicesPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  function findRowBySlug(rows: unknown[], slug: string): unknown[] {
    return rows.filter(
      (row) => typeof row === 'object' && row !== null && (row as { slug?: unknown }).slug === slug,
    );
  }

  it('list() は不正な行を飛ばし、正しい行だけを返す（直す前は例外で赤）', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    let found: Awaited<ReturnType<typeof stores.practices.list>> = { entries: [], unreadable: [] };
    await captureStderr(async () => {
      found = await stores.practices.list();
    });

    expect(found.entries.map((p) => p.slug)).toEqual(['good-practice']);
  });

  it('list() の unreadable に slug と不正な欄名だけが返る。題・本文は載らない（issue #2346）', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    let found: Awaited<ReturnType<typeof stores.practices.list>> = { entries: [], unreadable: [] };
    await captureStderr(async () => {
      found = await stores.practices.list();
    });

    expect(found.unreadable).toEqual([{ slug: 'bad-practice', reason: '不正な欄: kind' }]);
    const serialized = JSON.stringify(found.unreadable);
    expect(serialized).not.toContain(BAD_PRACTICE_RAW.title);
    expect(serialized).not.toContain(BAD_PRACTICE_RAW.content);
  });

  it('壊れた行しか無くても entries は空・unreadable は1件。対照: 壊れた行が無ければ unreadable は空（issue #2346）', async () => {
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(
      practicesPath,
      `${JSON.stringify({ practices: [BAD_PRACTICE_RAW], practiceVersions: [] }, null, 2)}\n`,
    );
    const broken = createFsStores(root);
    let onlyBroken: Awaited<ReturnType<typeof broken.practices.list>> = {
      entries: [],
      unreadable: [],
    };
    await captureStderr(async () => {
      onlyBroken = await broken.practices.list();
    });
    expect(onlyBroken.entries).toEqual([]);
    expect(onlyBroken.unreadable).toHaveLength(1);

    const empty = createFsStores(await makeTempDir('alteroid-test-'));
    expect(await empty.practices.list()).toEqual({ entries: [], unreadable: [] });
  });

  it('read() は正しい slug をちゃんと返す（直す前は list 経由でなくても例外で赤）', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    let found: Practice | null = null;
    await captureStderr(async () => {
      found = await stores.practices.read('good-practice');
    });

    expect(found).not.toBeNull();
    expect(found).toMatchObject({ slug: 'good-practice', content: GOOD_PRACTICE.content });
  });

  it('listVersions() は不正な版の行を飛ばし、正しい版だけを返す（直す前は例外で赤）', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    let found: Awaited<ReturnType<typeof stores.practices.listVersions>> = [];
    await captureStderr(async () => {
      found = await stores.practices.listVersions('good-practice');
    });

    expect(found.map((v) => `${v.slug}#${v.version}`)).toEqual(['good-practice#1']);
  });

  it('跡: 飛ばした行を stderr へ1行出す。本文（title/content）の値は絶対に含めない', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    const lines = await captureStderr(async () => {
      await stores.practices.list();
      await stores.practices.listVersions('bad-version-practice');
    });
    const joined = lines.join('');

    expect(joined).toContain('bad-practice');
    expect(joined).toContain('bad-version-practice');
    expect(joined).not.toContain(GOOD_PRACTICE.title);
    expect(joined).not.toContain(GOOD_PRACTICE.content);
    expect(joined).not.toContain(BAD_PRACTICE_RAW.title);
    expect(joined).not.toContain(BAD_PRACTICE_RAW.content);
    expect(joined).not.toContain(BAD_VERSION_RAW.title);
    expect(joined).not.toContain(BAD_VERSION_RAW.content);
  });

  it('write() は投げない。書いた後のファイルに不正な行が元の形のまま残っている', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    await captureStderr(async () => {
      await expect(
        stores.practices.write({
          slug: 'new-practice',
          kind: '実装',
          title: '新しいやり方',
          content: '新しい本文',
        }),
      ).resolves.toBeDefined();
    });

    const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as { practices: unknown[] };
    const badRows = findRowBySlug(raw.practices, 'bad-practice');

    expect(badRows).toEqual([BAD_PRACTICE_RAW]);

    let found: Awaited<ReturnType<typeof stores.practices.list>> = { entries: [], unreadable: [] };
    await captureStderr(async () => {
      found = await stores.practices.list();
    });
    expect(found.entries.map((p) => p.slug).sort()).toEqual(['good-practice', 'new-practice']);
    expect(found.unreadable.map((row) => row.slug)).toEqual(['bad-practice']);
  });

  it('clear() は正しい行も壊れた行も両方消す——practices.json にやり方が1つも残らない', async () => {
    await writeRawPracticesFile();
    const stores = createFsStores(root);

    let removed = -1;
    await captureStderr(async () => {
      removed = await stores.practices.clear();
    });
    expect(removed).toBe(2);

    const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as {
      practices: unknown[];
      practiceVersions: unknown[];
    };
    expect(raw.practices).toEqual([]);
    expect(raw.practiceVersions).toEqual([]);

    let found: Awaited<ReturnType<typeof stores.practices.list>> = { entries: [], unreadable: [] };
    await captureStderr(async () => {
      found = await stores.practices.list();
    });
    expect(found).toEqual({ entries: [], unreadable: [] });
  });

  it('write() は、壊れた版の行の version 番号とも重ねずに番号を振る（issue #1967 のフォローアップ）', async () => {
    const slug = 'version-collision';
    const now = '2026-09-01T00:00:00.000Z';
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeFile(
      practicesPath,
      `${JSON.stringify(
        {
          practices: [
            {
              slug,
              kind: '実装',
              title: '衝突のやり方',
              content: '本文1\n',
              createdAt: now,
              updatedAt: now,
            },
          ],
          practiceVersions: [
            {
              slug,
              version: 1,
              kind: '実装',
              title: '版1',
              content: '本文1\n',
              at: now,
            },
            {
              slug,
              version: 2,
              kind: '実装',
              title: '版2（壊れている）',
              at: now,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const stores = createFsStores(root);
    let written: Practice | undefined;
    await captureStderr(async () => {
      written = await stores.practices.write({
        slug,
        kind: '実装',
        title: '版3',
        content: '本文3',
      });
    });
    expect(written).toMatchObject({ slug });

    const raw = JSON.parse(await readFile(practicesPath, 'utf8')) as {
      practiceVersions: { slug?: unknown; version?: unknown }[];
    };
    const versionNumbers = raw.practiceVersions
      .filter((row) => row.slug === slug)
      .map((row) => row.version)
      .sort((a, b) => (a as number) - (b as number));
    expect(versionNumbers).toEqual([1, 2, 3]);

    let versions: Awaited<ReturnType<typeof stores.practices.listVersions>> = [];
    await captureStderr(async () => {
      versions = await stores.practices.listVersions(slug);
    });
    expect(versions.map((v) => v.version)).toEqual([1, 3]);

    const readV3 = await stores.practices.readVersion(slug, 3);
    expect(readV3?.content).toBe('本文3\n');

    await captureStderr(async () => {
      await expect(stores.practices.readVersion(slug, 2)).rejects.toThrow();
    });
  });
});
