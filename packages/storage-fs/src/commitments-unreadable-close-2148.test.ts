import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { UnreadableCommitmentError } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createFsStores } from './index.js';

const BAD_ID = 'bad-commitment';
const BAD_AT = '2026-09-02T00:00:00.000Z';
const BAD_BODY = '壊れた約束の本文（跡に出てはいけない）';

let root: string;

beforeEach(async () => {
  root = await makeTempDir('alteroid-test-');
});

async function writeBadRow(): Promise<void> {
  const stores = createFsStores(root);
  // ファイルを作ってから壊れた行を追記する: `open()` は正常な行しか書けないため
  await stores.commitments.open({ id: 'seed', at: BAD_AT, origin: 'self', body: '正常な行' });
  const path = join(root, 'jobs', 'commitments.json');
  const raw = JSON.parse(await readFile(path, 'utf8')) as { commitments: unknown[] };
  raw.commitments.push({ id: BAD_ID, at: BAD_AT, origin: 'bogus', body: BAD_BODY });
  await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
}

describe('FsCommitmentStore.close() が読めない行を閉じられる（issue #2148）', () => {
  it('close() は読めない行の id で true を返す', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    const result = await stores.commitments.close(
      BAD_ID,
      '2026-09-03T00:00:00.000Z',
      '閉じた',
      'human',
    );
    expect(result).toBe(true);
  });

  it('同じ読めない行をもう一度 close() すると false（「いま自分が閉じた」ではない）', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    await stores.commitments.close(BAD_ID, '2026-09-03T00:00:00.000Z', '閉じた', 'human');
    const again = await stores.commitments.close(
      BAD_ID,
      '2026-09-04T00:00:00.000Z',
      'もう一度',
      'human',
    );
    expect(again).toBe(false);
  });

  it('close() は本当に無い id では引き続き false（読めない行にも entries にも無い）', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    const result = await stores.commitments.close(
      'never-existed',
      '2026-09-03T00:00:00.000Z',
      '閉じた',
      'human',
    );
    expect(result).toBe(false);
  });

  it('get() は閉じた後も UnreadableCommitmentError を投げ続ける（中身が読めるようになったわけではない）', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    await stores.commitments.close(BAD_ID, '2026-09-03T00:00:00.000Z', '閉じた', 'human');
    await expect(stores.commitments.get(BAD_ID)).rejects.toThrow(UnreadableCommitmentError);
  });

  it('list()（既定）は閉じた読めない行を出さない。includeClosed=true でだけ出る（entries には出ない）', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    await stores.commitments.close(BAD_ID, '2026-09-03T00:00:00.000Z', '閉じた', 'human');

    const defaultList = await stores.commitments.list();
    expect(defaultList.unreadable.map((row) => row.id)).not.toContain(BAD_ID);

    const withClosed = await stores.commitments.list({ includeClosed: true });
    expect(withClosed.unreadable.map((row) => row.id)).toContain(BAD_ID);
    expect(withClosed.entries.map((entry) => entry.id)).not.toContain(BAD_ID);
    expect(JSON.stringify(withClosed.unreadable)).not.toContain(BAD_BODY);
  });

  it('list()（既定）はまだ閉じていない読めない行を常に出す（issue #296 の安全側は変わらない）', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    const defaultList = await stores.commitments.list();
    expect(defaultList.unreadable.map((row) => row.id)).toContain(BAD_ID);
  });

  it('閉じた印はプロセスを跨いで（新しい FsCommitmentStore インスタンスでも）残る', async () => {
    await writeBadRow();
    const first = createFsStores(root);
    await first.commitments.close(BAD_ID, '2026-09-03T00:00:00.000Z', '閉じた', 'human');

    const second = createFsStores(root);
    const list = await second.commitments.list({ includeClosed: true });
    expect(list.unreadable.map((row) => row.id)).toContain(BAD_ID);
    await expect(second.commitments.get(BAD_ID)).rejects.toThrow(UnreadableCommitmentError);
  });

  it('ディスク上、読めない行の生の値（value）自体は close() で書き換わらない', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    await stores.commitments.close(BAD_ID, '2026-09-03T00:00:00.000Z', '閉じた', 'human');

    const path = join(root, 'jobs', 'commitments.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      commitments: { id: string; origin: string; body: string }[];
      closedUnreadable: { id: string; at: string; reason: string; by: string }[];
    };
    const badRow = raw.commitments.find((row) => row.id === BAD_ID);
    expect(badRow).toEqual({ id: BAD_ID, at: BAD_AT, origin: 'bogus', body: BAD_BODY });
    expect(raw.closedUnreadable.some((row) => row.id === BAD_ID && row.by === 'human')).toBe(true);
  });

  it('closeMany（issue #844）は読めない行を、close() と同じく閉じる（#3096 で反転。元は「対象にしない」）', async () => {
    await writeBadRow();
    const stores = createFsStores(root);
    const closed = await stores.commitments.closeMany(
      [BAD_ID],
      '2026-09-03T00:00:00.000Z',
      '一括で閉じたつもり',
      'human',
    );
    expect(closed).toEqual([BAD_ID]);
    await expect(stores.commitments.get(BAD_ID)).rejects.toThrow(UnreadableCommitmentError);
  });
});
