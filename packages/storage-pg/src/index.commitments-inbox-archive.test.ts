import {
  captureStderr,
  verifyCommitmentFoldContract,
  verifyTranscriptArchiveContract,
} from '@alteroid/core';
import type { Commitment, InboxEvent } from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, type PgStores } from './index.js';
import { archive, commitments } from './schema.js';
import { createMigratedTestDb, type TestDbHandle } from './test-db.test-support.js';

let client: TestDbHandle;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  ({ client, db } = await createMigratedTestDb());
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('PgCommitmentStore の畳み込みの索引（#1041。pg だけが持つ段）', () => {
  const managerEntry = (id: string, body: string, source = 'mgr-1'): Commitment => ({
    id,
    at: '2026-09-17T00:00:00.000Z',
    origin: 'manager',
    source,
    body,
  });

  const rawInsert = async (entry: Commitment): Promise<void> => {
    await db.insert(commitments).values({
      id: entry.id,
      at: new Date(entry.at),
      closedAt: null,
      commitment: entry,
    });
  };

  // `open()` を経由しない素の insert で測る: PGlite は単一接続で同時の2件を再現できず、素の insert が同時に来た2件目の見る世界と同じになるため。
  const reasonChain = (error: unknown): string => {
    const lines: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause)
      lines.push(current.message);
    return lines.join('\n');
  };

  it('⭐ 同一マネージャー×同一本文×未了の2件目は、素の insert なら DB が拒む', async () => {
    await stores.commitments.open(managerEntry('idx-a', '同じ一言'));
    const rejection = await rawInsert(managerEntry('idx-b', '同じ一言')).then(
      () => null,
      (error: unknown) => error,
    );
    if (rejection === null) throw new Error('素の insert が通ってしまった（索引が効いていない）');
    // 索引の名前まで見る: 主キー（id）で弾かれたのでは、本文の重複を拒んだことにならないため。
    expect(reasonChain(rejection)).toContain('commitments_open_manager_body_idx');
  });

  it('⭐ 陰性対照: source が違う同文は、素の insert でも通る', async () => {
    await stores.commitments.open(managerEntry('idx-a', '同じ一言'));
    await rawInsert(managerEntry('idx-c', '同じ一言', 'mgr-2'));
    expect((await stores.commitments.list()).entries).toHaveLength(2);
  });

  it('⭐ 陰性対照: 閉じた行と同文は、素の insert でも通る', async () => {
    await stores.commitments.open(managerEntry('idx-a', '同じ一言'));
    await stores.commitments.close('idx-a', '2026-09-18T00:00:00.000Z', '片付けた', 'clone');
    await rawInsert(managerEntry('idx-d', '同じ一言'));
    expect((await stores.commitments.list()).entries).toHaveLength(1);
  });

  it('⭐ 陰性対照: origin が manager でなければ、同文でも素の insert で通る', async () => {
    await stores.commitments.open({
      id: 'idx-h1',
      at: '2026-09-17T00:00:00.000Z',
      origin: 'human',
      source: 'conv-1',
      body: '人間の同じ一言',
    });
    await rawInsert({
      id: 'idx-h2',
      at: '2026-09-17T00:00:00.000Z',
      origin: 'human',
      source: 'conv-1',
      body: '人間の同じ一言',
    });
    expect((await stores.commitments.list()).entries).toHaveLength(2);
  });

  // 索引の鍵を全文に直さない: btree の行サイズ上限（約2.7KB）で、長い報告だけが記帳できなくなるため。
  // 索引を落として契約を当てる: 索引が在ると `where not exists` を1行も踏まずに契約が通ってしまうため。
  it('⭐ 索引を落としても、畳み込みの契約は満たされる（where not exists が索引と独立に効いている）', async () => {
    await db.execute(sql.raw('drop index commitments_open_manager_body_idx'));
    // 同時の2件（性質 7）を測らない: 索引が無い DB では本物の PostgreSQL の並行は両方開き、PGlite は単一接続で重ならないため。
    await verifyCommitmentFoldContract(stores.commitments, { concurrent: false });
  });

  it('⭐ 8000 文字の本文でも開ける（鍵が md5 でなければ落ちる）', async () => {
    const long = 'x'.repeat(8_000);
    expect(await stores.commitments.open(managerEntry('idx-long', long))).toEqual({
      opened: true,
      folded: false,
    });
    expect((await stores.commitments.get('idx-long'))?.body).toHaveLength(8_000);
  });
});

describe('PgCommitmentStore', () => {
  const commitment = (id: string, at: string, body: string): Commitment => ({
    id,
    at,
    origin: 'human',
    source: 'conv-1',
    body,
  });

  it('開いた仕事は未了として読み戻せる（fs 版と同じ振る舞い）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(await stores.commitments.list()).toEqual({
      entries: [commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す')],
      unreadable: [],
      trimmedClosed: 0,
    });
    expect((await stores.commitments.get('c-1'))?.body).toBe('PR を出す');
    expect(await stores.commitments.get('しらない')).toBeNull();
  });

  it('閉じたものは未了から外れ、includeClosed でだけ読める（行は消さない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した', 'clone'),
    ).toBe(true);

    expect(await stores.commitments.list()).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
    const all = (await stores.commitments.list({ includeClosed: true })).entries;
    expect(all).toHaveLength(1);
    expect(all[0]?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(all[0]?.closedReason).toBe('#99 で出した');
    expect(all[0]?.closedBy).toBe('clone');
  });

  it('close は closedBy を記録し、既存の（closedBy の無い）行は undefined のままで既定へ倒れない', async () => {
    await stores.commitments.open({
      id: 'c-legacy',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '導入前に片付いた仕事',
      closedAt: '2026-08-02T00:00:00.000Z',
      closedReason: '当時は書き手を記録していなかった',
    });
    const legacy = await stores.commitments.get('c-legacy');
    expect(legacy?.closedBy).toBeUndefined();

    await stores.commitments.open(commitment('c-new', '2026-08-13T00:00:00.000Z', '新しい依頼'));
    await stores.commitments.close('c-new', '2026-08-14T00:00:00.000Z', '片付けた', 'human');
    const fresh = await stores.commitments.get('c-new');
    expect(fresh?.closedBy).toBe('human');

    const stillLegacy = await stores.commitments.get('c-legacy');
    expect(stillLegacy?.closedBy).toBeUndefined();
  });

  describe('closeMany（複数件を1回でまとめて閉じる）', () => {
    it('実際に閉じた id だけを返す（存在しない id・既に閉じた id を混ぜても、新たに閉じた分だけ）', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      await stores.commitments.open(commitment('c-2', '2026-08-11T00:00:00.000Z', '2'));
      await stores.commitments.open(commitment('c-3', '2026-08-12T00:00:00.000Z', '3'));
      await stores.commitments.close('c-2', '2026-08-13T00:00:00.000Z', '先に片付けた', 'human');

      const closed = await stores.commitments.closeMany(
        ['c-1', 'c-2', 'c-3', 'しらない'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      expect([...closed].sort()).toEqual(['c-1', 'c-3']);
    });

    it('空配列を渡すと何も書かずに [] を返す（読み直した台帳の状態が1つも変わらないことで測る）', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      const before = await stores.commitments.list({ includeClosed: true });

      const closed = await stores.commitments.closeMany(
        [],
        '2026-08-14T00:00:00.000Z',
        '対象なし',
        'clone',
      );

      expect(closed).toEqual([]);
      const after = await stores.commitments.list({ includeClosed: true });
      expect(after).toEqual(before);
    });

    it('closeMany の後、includeClosed で closedAt/closedReason/closedBy が正しく入る', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      await stores.commitments.open(commitment('c-2', '2026-08-11T00:00:00.000Z', '2'));

      await stores.commitments.closeMany(
        ['c-1', 'c-2'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      const all = (await stores.commitments.list({ includeClosed: true })).entries;
      for (const id of ['c-1', 'c-2']) {
        const entry = all.find((e) => e.id === id);
        expect(entry?.closedAt).toBe('2026-08-14T00:00:00.000Z');
        expect(entry?.closedReason).toBe('まとめて片付けた');
        expect(entry?.closedBy).toBe('clone');
      }
    });

    it('同じ id を重複して渡しても、返る id は重複せず二重に閉じない', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));

      const closed = await stores.commitments.closeMany(
        ['c-1', 'c-1', 'c-1'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      expect(closed).toEqual(['c-1']);
      const entry = await stores.commitments.get('c-1');
      expect(entry?.closedReason).toBe('まとめて片付けた');
    });

    it('未了の行は1件も消えない・状態も変わらない（pg 版は保持上限を持たないので trimmedClosed は常に0）', async () => {
      await stores.commitments.open(commitment('open-1', '2026-08-01T00:00:00.000Z', '未了1'));
      await stores.commitments.open(commitment('open-2', '2026-08-01T00:00:01.000Z', '未了2'));
      await stores.commitments.open(commitment('c-1', '2026-08-10T00:00:00.000Z', '1'));
      await stores.commitments.open(commitment('c-2', '2026-08-11T00:00:00.000Z', '2'));

      await stores.commitments.closeMany(
        ['c-1', 'c-2'],
        '2026-08-14T00:00:00.000Z',
        'まとめて片付けた',
        'clone',
      );

      const list = await stores.commitments.list({ includeClosed: true });
      const open = list.entries.filter((entry) => entry.closedAt === undefined);
      expect(open.map((entry) => entry.id).sort()).toEqual(['open-1', 'open-2']);
      expect(list.trimmedClosed).toBe(0);
    });
  });

  describe('editBody（本文を後から直す）', () => {
    it('未了の行は書き換えられる（body/editedAt/editedBy が入り、jsonb 側にも反映される）', async () => {
      await stores.commitments.open({
        id: 'c-1',
        at: '2026-08-12T00:00:00.000Z',
        origin: 'human',
        source: 'conv-1',
        body: 'もとの依頼',
      });

      expect(
        await stores.commitments.editBody('c-1', '直した依頼', '2026-08-13T00:00:00.000Z', 'human'),
      ).toBe(true);

      const entry = await stores.commitments.get('c-1');
      expect(entry?.body).toBe('直した依頼');
      expect(entry?.editedAt).toBe('2026-08-13T00:00:00.000Z');
      expect(entry?.editedBy).toBe('human');
      expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
      expect(entry?.origin).toBe('human');
      expect(entry?.source).toBe('conv-1');
      expect(entry?.closedAt).toBeUndefined();
      const listed = (await stores.commitments.list()).entries.find((e) => e.id === 'c-1');
      expect(listed?.body).toBe('直した依頼');
    });

    it('片付いた行は書き換えられない（false を返し、body はそのまま）', async () => {
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'もとの依頼'));
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '片付けた', 'human');

      expect(
        await stores.commitments.editBody(
          'c-1',
          '後から直したい',
          '2026-08-14T00:00:00.000Z',
          'human',
        ),
      ).toBe(false);

      const entry = await stores.commitments.get('c-1');
      expect(entry?.body).toBe('もとの依頼');
      expect(entry?.editedAt).toBeUndefined();
      expect(entry?.editedBy).toBeUndefined();
      expect(entry?.closedAt).toBe('2026-08-13T00:00:00.000Z');
      expect(entry?.closedReason).toBe('片付けた');
    });

    it('存在しない id は false（勝手に行を作らない）', async () => {
      expect(
        await stores.commitments.editBody(
          'しらない',
          '直したい',
          '2026-08-13T00:00:00.000Z',
          'human',
        ),
      ).toBe(false);

      expect(await stores.commitments.list({ includeClosed: true })).toEqual({
        entries: [],
        unreadable: [],
        trimmedClosed: 0,
      });
    });
  });

  // `open()` を経由しない: スキーマ検証を通ると未知の値の行を作れず、厳密な enum へ戻す変異で setup が先に落ちて症状が再現されないため。生 SQL で直接 insert する。
  it('未知の closedBy を持つ行があっても list() は落ちない（closedBy は台帳の完全性を担わない）', async () => {
    await db.execute(
      sql`insert into commitments (id, at, closed_at, commitment)
          values (
            'c-unknown-closedby',
            '2026-08-01T00:00:00.000Z',
            '2026-08-02T00:00:00.000Z',
            ${JSON.stringify({
              id: 'c-unknown-closedby',
              at: '2026-08-01T00:00:00.000Z',
              origin: 'human',
              body: '未知の closedBy を持つ行',
              closedAt: '2026-08-02T00:00:00.000Z',
              closedReason: '将来の書き手を模す',
              closedBy: 'manager',
            })}::jsonb
          )`,
    );

    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries).toHaveLength(1);
    expect(listed.unreadable).toEqual([]);

    const all = listed.entries;
    expect(all[0]?.closedBy).toBe('manager');

    const single = await stores.commitments.get('c-unknown-closedby');
    expect(single?.closedBy).toBe('manager');
  });

  it('未知の origin を1行混ぜても list() は落ちず、健全な行は全部返る（未知の1行は unreadable へ、id 付きで）', async () => {
    await stores.commitments.open(commitment('c-ok-1', '2026-08-10T00:00:00.000Z', '健全な行1'));
    await stores.commitments.open(commitment('c-ok-2', '2026-08-11T00:00:00.000Z', '健全な行2'));

    await db.execute(
      sql`insert into commitments (id, at, commitment)
          values (
            'c-unknown-origin',
            '2026-08-12T00:00:00.000Z',
            ${JSON.stringify({
              id: 'c-unknown-origin',
              at: '2026-08-12T00:00:00.000Z',
              origin: 'future-origin',
              body: '未知の origin を持つ行',
            })}::jsonb
          )`,
    );

    // 素の `await` だけにしない: 行ごとの `safeParse` をやめる変異が例外でテストを殺し、測っている性質を名指ししないため。`.resolves` を使う。
    await expect(stores.commitments.list()).resolves.toBeDefined();

    const listed = await stores.commitments.list();
    expect(listed.entries.map((entry) => entry.id)).toEqual(['c-ok-1', 'c-ok-2']);

    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]?.id).toBe('c-unknown-origin');
    expect(listed.unreadable[0]?.at).toBe('2026-08-12T00:00:00.000Z');
    expect(listed.unreadable[0]?.reason).not.toContain('未知の origin を持つ行');

    await expect(stores.commitments.get('c-unknown-origin')).rejects.toThrow(/読めない形/);
  });

  it('同じ id で二度 open しても上書きされない（1回目の本文が残る）', async () => {
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '最初の依頼')),
    ).toEqual({ opened: true, folded: false });

    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-14T00:00:00.000Z', '別の本文')),
    ).toEqual({ opened: false, folded: false });

    const entry = await stores.commitments.get('c-1');
    expect(entry?.body).toBe('最初の依頼');
    expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
    expect((await stores.commitments.list()).entries).toHaveLength(1);
  });

  it('閉じた id を open し直しても開き直らない（片付いた仕事が蘇らない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));
    await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '#99 で出した', 'clone');

    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す')),
    ).toEqual({ opened: false, folded: false });

    expect(await stores.commitments.list()).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
    expect((await stores.commitments.get('c-1'))?.closedAt).toBe('2026-08-13T00:00:00.000Z');
  });

  it('close は二度目に false を返す（二重に「いま片付けた」と報告させない）', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    expect(
      await stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '出した', 'clone'),
    ).toBe(true);
    expect(
      await stores.commitments.close('c-1', '2026-08-14T00:00:00.000Z', 'また出した', 'clone'),
    ).toBe(false);

    const entry = await stores.commitments.get('c-1');
    expect(entry?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(entry?.closedReason).toBe('出した');
  });

  it('存在しない id の close は false（勝手に行を作らない）', async () => {
    expect(
      await stores.commitments.close('しらない', '2026-08-13T00:00:00.000Z', '片付けた', 'clone'),
    ).toBe(false);

    expect(await stores.commitments.list({ includeClosed: true })).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
  });

  it('未了は古い順に返り、閉じたものは新しく片付いた順で後ろに続く', async () => {
    await stores.commitments.open(commitment('c-new', '2026-08-14T00:00:00.000Z', '新しい'));
    await stores.commitments.open(commitment('c-old', '2026-08-10T00:00:00.000Z', '古い'));
    await stores.commitments.open(commitment('c-a', '2026-08-11T00:00:00.000Z', 'A'));
    await stores.commitments.open(commitment('c-b', '2026-08-12T00:00:00.000Z', 'B'));
    await stores.commitments.close('c-a', '2026-08-15T00:00:00.000Z', 'A を片付けた', 'clone');
    await stores.commitments.close('c-b', '2026-08-16T00:00:00.000Z', 'B を片付けた', 'clone');

    expect((await stores.commitments.list()).entries.map((entry) => entry.id)).toEqual([
      'c-old',
      'c-new',
    ]);
    expect(
      (await stores.commitments.list({ includeClosed: true })).entries.map((entry) => entry.id),
    ).toEqual(['c-old', 'c-new', 'c-b', 'c-a']);
  });

  it('同じ id の並行 open は1件しか入らない（読んでから書く形にしていない）', async () => {
    const bodies = ['最初の依頼', '二度目', '三度目'];
    const results = await Promise.all(
      bodies.map((body, index) =>
        stores.commitments.open(commitment('c-1', `2026-08-12T00:00:0${index}.000Z`, body)),
      ),
    );

    // `filter(Boolean)` で数えない: `open` の戻りはオブジェクトで、開けなかった回も truthy になるため。`opened` そのものを数える。
    expect(results.filter((result) => result.opened)).toHaveLength(1);
    expect(results.filter((result) => result.folded)).toHaveLength(0);
    const rows = (await stores.commitments.list()).entries;
    expect(rows).toHaveLength(1);
    // 勝つ1本を固定しない: 本物の並行では順序が不定なので、開いた1本の本文と比べる。
    const winner = results.findIndex((result) => result.opened);
    expect(rows[0]?.body).toBe(bodies[winner]);
  });

  it('同一マネージャー×同一本文の並行 open は1件しか入らず、負けた側は勝った行へ畳まれる', async () => {
    const manager = (id: string): Commitment => ({
      id,
      at: '2026-08-12T00:00:00.000Z',
      origin: 'manager',
      source: 'mgr-race',
      body: '同じ一言',
    });
    const ids = ['r-1', 'r-2', 'r-3'];
    const results = await Promise.all(ids.map((id) => stores.commitments.open(manager(id))));

    expect(results.filter((result) => result.opened)).toHaveLength(1);
    expect(results.filter((result) => result.folded)).toHaveLength(2);
    const winnerId = ids[results.findIndex((result) => result.opened)]!;
    expect((await stores.commitments.list()).entries.map((entry) => entry.id)).toEqual([winnerId]);
    for (const result of results.filter((r) => r.folded)) {
      if (result.foldedInto !== undefined) expect(result.foldedInto).toBe(winnerId);
    }
  });

  it('同じ id の並行 close で true は1回だけ返る', async () => {
    await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', 'PR を出す'));

    const results = await Promise.all([
      stores.commitments.close('c-1', '2026-08-13T00:00:00.000Z', '1本目', 'clone'),
      stores.commitments.close('c-1', '2026-08-13T00:00:01.000Z', '2本目', 'clone'),
      stores.commitments.close('c-1', '2026-08-13T00:00:02.000Z', '3本目', 'clone'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await stores.commitments.list()).toEqual({
      entries: [],
      unreadable: [],
      trimmedClosed: 0,
    });
  });

  it('読めない行を「片付いた」に潰さない（list() は丸ごと落ちず、その行だけ unreadable へ回る）', async () => {
    await db.execute(
      sql`insert into commitments (id, at, commitment)
          values ('broken', now(), '{"id":"broken"}'::jsonb)`,
    );
    await stores.commitments.open(commitment('c-ok', '2026-08-12T00:00:00.000Z', '健全な行'));

    await expect(stores.commitments.get('broken')).rejects.toThrow(/読めない形/);

    // 素の `await` で受けない: 行ごとの `safeParse` をやめる変異が例外で死に、実装の破損と足場の破損を区別できないため。`.resolves` を使う。
    await expect(stores.commitments.list({ includeClosed: true })).resolves.toBeDefined();

    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries.map((entry) => entry.id)).toEqual(['c-ok']);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]?.id).toBe('broken');
    expect(listed.unreadable[0]?.reason).toMatch(/./);

    expect(await stores.commitments.get('しらない')).toBeNull();
  });

  // fs 版の定数を共有せず値を複製する: パッケージを跨いで共有すると結合が生まれるため。
  it('片付いた行を fs 版の保持上限を超えて積んでも、1件も落ちず trimmedClosed は 0 のまま', async () => {
    const COUNT = 501;
    for (let index = 0; index < COUNT; index += 1) {
      const id = `closed-${String(index).padStart(4, '0')}`;
      await stores.commitments.open(
        commitment(id, '2026-08-01T00:00:00.000Z', `片付ける ${index}`),
      );
      await stores.commitments.close(
        id,
        new Date(Date.UTC(2026, 7, 2, 0, 0, 0) + index * 1000).toISOString(),
        `片付けた ${index}`,
        'clone',
      );
    }

    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries).toHaveLength(COUNT);
    expect(listed.trimmedClosed).toBe(0);
    expect(await stores.commitments.get('closed-0000')).not.toBeNull();
  }, 60_000);
});

describe('PgInboxStore', () => {
  const human = (id: string, at: string, text: string): InboxEvent => ({
    type: 'human_message',
    id,
    at,
    text,
    conversationId: 'conv-1',
  });

  it('put したものが claimPending で古い順に返る', async () => {
    await stores.inbox.put(
      human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
      '2026-08-11T00:00:00.000Z',
    );
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
      '2026-08-10T00:00:00.000Z',
    );

    const pending = await stores.inbox.claimPending();

    expect(pending.map((entry) => entry.event.id)).toEqual(['evt-1', 'evt-2']);
    expect(pending.every((entry) => entry.deliveries === 1)).toBe(true);
  });

  it('remove したものは返らない。無い id の remove は落ちない', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.remove('evt-1');

    expect(await stores.inbox.claimPending()).toEqual([]);
    await expect(stores.inbox.remove('しらない')).resolves.toBeUndefined();
  });

  it('claimPending を2回呼ぶと deliveries が 1 → 2 と進む（消していないものは何度でも返る）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
      '2026-08-10T00:00:00.000Z',
    );

    const first = await stores.inbox.claimPending();
    const second = await stores.inbox.claimPending();

    expect(first[0]?.deliveries).toBe(1);
    expect(second[0]?.deliveries).toBe(2);
  });

  it('同じ id で put し直しても deliveries が 0 に戻らない（本文だけ差し替わる）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', 'もとの本文'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.claimPending();

    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '直した本文'),
      '2026-08-10T00:00:00.000Z',
    );
    const pending = await stores.inbox.claimPending();

    expect(pending[0]?.deliveries).toBe(2);
    expect((pending[0]?.event as { text: string }).text).toBe('直した本文');
  });

  it('本文が欠けずに往復する（human_message の text、external の payload）', async () => {
    await stores.inbox.put(
      human('evt-1', '2026-08-10T00:00:00.000Z', '人間の発言'),
      '2026-08-10T00:00:00.000Z',
    );
    await stores.inbox.put(
      {
        type: 'external',
        id: 'evt-2',
        at: '2026-08-11T00:00:00.000Z',
        source: 'webhook',
        payload: { deep: { nested: [1, 2, 3] }, note: '日本語も' },
      },
      '2026-08-11T00:00:00.000Z',
    );

    const pending = await stores.inbox.claimPending();
    const humanEntry = pending.find((entry) => entry.event.id === 'evt-1');
    const externalEntry = pending.find((entry) => entry.event.id === 'evt-2');

    expect((humanEntry?.event as { text: string }).text).toBe('人間の発言');
    expect((externalEntry?.event as { payload: unknown }).payload).toEqual({
      deep: { nested: [1, 2, 3] },
      note: '日本語も',
    });
  });

  // `claimPending()` が投げる期待にしない: 読めない1行が起動時の未読の復元を丸ごと止め、ほかの正しい未読まで配られなくなるため。
  it('読めない行を「消された」に潰さない（fs 版と同じく失敗を表へ出す）', async () => {
    await db.execute(
      sql`insert into inbox_events (id, event, at, deliveries)
          values ('broken', '{"id":"broken"}'::jsonb, now(), 0)`,
    );

    let claimed: string[] = [];
    const stderr = (
      await captureStderr(async () => {
        claimed = (await stores.inbox.claimPending()).map((entry) => entry.event.id);
      })
    ).join('');

    expect(claimed).toEqual([]);
    expect(stderr).toContain('broken');
    expect((await stores.inbox.pending()).count).toBe(1);
  });

  describe('pending（#358。読むだけで配達回数を進めない）', () => {
    it('件数といちばん古い時刻を返す（0件のときは oldestAt を作らない）', async () => {
      expect(await stores.inbox.pending()).toEqual({ count: 0 });

      await stores.inbox.put(
        human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
        '2026-08-11T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
        '2026-08-10T00:00:00.000Z',
      );

      expect(await stores.inbox.pending()).toEqual({
        count: 2,
        oldestAt: '2026-08-10T00:00:00.000Z',
      });
    });

    it('pending() を何度呼んでも claimPending() の deliveries は動かない', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      await stores.inbox.pending();
      await stores.inbox.pending();
      await stores.inbox.pending();

      const claimed = await stores.inbox.claimPending();
      expect(claimed[0]?.deliveries).toBe(1);
    });
  });

  describe('peekPending（#783。本文まで返すが、配達回数は進めない）', () => {
    it('claimPending と同じ並び（古い順）で、本文まで返す', async () => {
      await stores.inbox.put(
        human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
        '2026-08-11T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
        '2026-08-10T00:00:00.000Z',
      );

      const { entries: rows } = await stores.inbox.peekPending();

      expect(rows.map((r) => r.event.id)).toEqual(['evt-1', 'evt-2']);
      expect((rows[0]?.event as { text: string }).text).toBe('1件目');
      expect(rows.every((r) => r.deliveries === 0)).toBe(true);
    });

    it('0件なら空配列を返す（読めない行も無い）', async () => {
      expect(await stores.inbox.peekPending()).toEqual({ entries: [], unreadable: [] });
    });

    it('peekPending() を2回呼んでも、その後の claimPending() の deliveries は1のまま', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      await stores.inbox.peekPending();
      await stores.inbox.peekPending();

      const claimed = await stores.inbox.claimPending();
      expect(claimed[0]?.deliveries).toBe(1);
    });
  });

  describe('removeMany（issue #972。絞り込んで一括で畳む口）', () => {
    it('渡した id をまとめて消し、実際に消えた id を返す', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '1件目'),
        '2026-08-10T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-2', '2026-08-11T00:00:00.000Z', '2件目'),
        '2026-08-11T00:00:00.000Z',
      );
      await stores.inbox.put(
        human('evt-3', '2026-08-12T00:00:00.000Z', '3件目'),
        '2026-08-12T00:00:00.000Z',
      );

      const removed = await stores.inbox.removeMany(['evt-1', 'evt-3']);

      expect([...removed].sort()).toEqual(['evt-1', 'evt-3']);
      const rest = (await stores.inbox.peekPending()).entries;
      expect(rest.map((r) => r.event.id)).toEqual(['evt-2']);
    });

    it('存在しない id は戻り値に含めない', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      const removed = await stores.inbox.removeMany(['evt-1', '居ない']);

      expect(removed).toEqual(['evt-1']);
    });

    it('重複した id を渡しても二重に数えない（戻り値にも1回しか現れない）', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      const removed = await stores.inbox.removeMany(['evt-1', 'evt-1']);

      expect(removed).toEqual(['evt-1']);
    });

    it('空配列を渡すと何も消さずに空配列を返す（SQL を撃たない）', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );

      expect(await stores.inbox.removeMany([])).toEqual([]);
      expect(await stores.inbox.pending()).toEqual({
        count: 1,
        oldestAt: '2026-08-10T00:00:00.000Z',
      });
    });

    it('消えた行は claimPending でも peekPending でも二度と返らない', async () => {
      await stores.inbox.put(
        human('evt-1', '2026-08-10T00:00:00.000Z', '本文'),
        '2026-08-10T00:00:00.000Z',
      );
      await stores.inbox.removeMany(['evt-1']);

      expect(await stores.inbox.claimPending()).toEqual([]);
      expect((await stores.inbox.peekPending()).entries).toEqual([]);
    });
  });
});

describe('PgTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = (await stores.archive.archive('session-1', '{"a":1}\n')).id;

    expect((await stores.archive.list()).map((entry) => entry.id)).toContain(id);
    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: '{"a":1}\n' });
  });

  it('無い id は missing（removed とは別物）', async () => {
    expect(await stores.archive.read('居ない')).toEqual({ kind: 'missing' });
  });

  it('TranscriptArchive の契約を満たす', async () => {
    await verifyTranscriptArchiveContract(stores.archive, {
      // 生 SQL を使う: drizzle 経由だと `.default` 等で値が入りうるため。
      seedFingerprintlessRow: async (sessionId, body) => {
        const id = `${sessionId}-fingerprintless-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await db.execute(
          sql`insert into archive (id, session_id, at, body) values (${id}, ${sessionId}, now(), ${body})`,
        );
        return id;
      },
    });
  });

  it('remove() は行を消さない（本文だけを落とす。list() に出続ける）', async () => {
    const id = (await stores.archive.archive('session-remove', 'BODY\n')).id;

    const removed = await stores.archive.remove(id);
    expect(removed).toEqual({ kind: 'removed', bytes: Buffer.byteLength('BODY\n', 'utf8') });

    expect((await stores.archive.list()).map((entry) => entry.id)).toContain(id);
    expect(await stores.archive.read(id)).toMatchObject({ kind: 'removed' });

    const rows = await db.select().from(archive).where(eq(archive.id, id));
    expect(rows[0]?.body).toBe('');
    expect(rows[0]?.removedAt).not.toBeNull();
  });

  it('存在しない id への remove() は黙って成功しない（missing）', async () => {
    expect(await stores.archive.remove('居ない')).toEqual({ kind: 'missing' });
  });

  it('id A を消しても id B は読める（巻き添えが無い）', async () => {
    const idA = (await stores.archive.archive('session-a', 'A\n')).id;
    const idB = (await stores.archive.archive('session-b', 'B\n')).id;

    await stores.archive.remove(idA);

    expect(await stores.archive.read(idA)).toMatchObject({ kind: 'removed' });
    expect(await stores.archive.read(idB)).toEqual({ kind: 'body', body: 'B\n' });
  });

  it('空の生ログを退避しただけの行は removed にならない（body の空文字を判定に使わない）', async () => {
    const id = (await stores.archive.archive('session-empty', '')).id;

    const rows = await db.select().from(archive).where(eq(archive.id, id));
    expect(rows[0]?.body).toBe('');
    expect(rows[0]?.removedAt).toBeNull();

    expect(await stores.archive.read(id)).toEqual({ kind: 'body', body: '' });
  });

  it('二重の remove() は冪等（removed → already。バイト数・removedAt は変わらない）', async () => {
    const id = (await stores.archive.archive('session-twice', 'TWICE\n')).id;

    const first = await stores.archive.remove(id);
    expect(first).toEqual({ kind: 'removed', bytes: Buffer.byteLength('TWICE\n', 'utf8') });

    const readAfterFirst = await stores.archive.read(id);
    if (readAfterFirst.kind !== 'removed') throw new Error('removed のはず');

    const second = await stores.archive.remove(id);
    expect(second).toEqual({
      kind: 'already',
      removedAt: readAfterFirst.removedAt,
      bytes: Buffer.byteLength('TWICE\n', 'utf8'),
    });
  });

  it('list()のstoredBytesはpg_column_size(body)と一致する（#698）', async () => {
    const id = (await stores.archive.archive('session-column-size', 'HELLO WORLD\n')).id;

    const entry = (await stores.archive.list()).find((e) => e.id === id);
    expect(entry).toBeDefined();

    const [row] = await db
      .select({ size: sql<number>`pg_column_size(${archive.body})` })
      .from(archive)
      .where(eq(archive.id, id));
    expect(entry?.storedBytes).toBe(row?.size);
  });

  it('sessions()は同一sessionIdの行数(tombstone済み込み)を正しく数える', async () => {
    // 1ミリ秒ずつ空ける: id がミリ秒精度で、同じミリ秒に積むと衝突するため。
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    const idA = (await stores.archive.archive('session-grouped', 'A\n')).id;
    await tick();
    await stores.archive.archive('session-grouped', 'BB\n');
    await tick();
    await stores.archive.archive('session-grouped', 'CCC\n');
    await stores.archive.remove(idA);

    const summaries = await stores.archive.sessions();
    const summary = summaries.find((s) => s.sessionId === 'session-grouped');
    expect(summary?.rows).toBe(3);
  });

  it('sessions()のcontinuityはfirst/continues/diverged/unknown/absentを正しく数える', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    const sessionId = 'session-continuity-tally';

    const writeFirst = await stores.archive.archive(sessionId, 'A\n');
    expect(writeFirst.continuity).toBe('first');
    await tick();
    const writeContinues = await stores.archive.archive(sessionId, 'A\nB\n');
    expect(writeContinues.continuity).toBe('continues');
    await tick();
    const writeDiverged = await stores.archive.archive(sessionId, 'X\n');
    expect(writeDiverged.continuity).toBe('diverged');
    await tick();

    const legacyId = `${sessionId}-legacy`;
    await db.execute(
      sql`insert into archive (id, session_id, at, body) values (${legacyId}, ${sessionId}, now(), ${'LEGACY\n'})`,
    );
    await tick();

    const writeAfterLegacy = await stores.archive.archive(sessionId, 'ANYTHING\n');
    expect(writeAfterLegacy.continuity).toBe('unknown');

    const summaries = await stores.archive.sessions();
    const summary = summaries.find((s) => s.sessionId === sessionId);
    expect(summary?.rows).toBe(5);
    expect(summary?.continuity).toEqual({
      first: 1,
      continues: 1,
      diverged: 1,
      unknown: 1,
      absent: 1,
    });
  });

  // 時計を `toFake: ['Date']` に絞る: `setTimeout` まで偽物にすると PGlite の待ちが止まるため。
  it('同じミリ秒に2回積むと archive に2行残り、body が2本とも別々（#905）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let first: string;
    let second: string;
    try {
      vi.setSystemTime(new Date('2026-09-12T03:04:05.678Z'));
      first = (await stores.archive.archive('session-collision', 'FIRST\n')).id;
      second = (await stores.archive.archive('session-collision', 'SECOND\n')).id;
    } finally {
      vi.useRealTimers();
    }

    expect(first).toBe('session-collision-2026-09-12T03-04-05-678Z.jsonl');
    expect(second).toBe('session-collision-2026-09-12T03-04-05-678Z-2.jsonl');

    const rows = await db.select().from(archive).where(eq(archive.sessionId, 'session-collision'));
    expect(rows).toHaveLength(2);
    const bodyById = new Map(rows.map((row) => [row.id, row.body]));
    expect(bodyById.get(first)).toBe('FIRST\n');
    expect(bodyById.get(second)).toBe('SECOND\n');
  });

  // 枝番を id の先頭側へ付けない: 前方一致 LIKE が主キーの btree に落ちなくなるため。
  it("where id like 'session-…%' の前方一致が枝番付きの2本目も拾う（#905）", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let first: string;
    let second: string;
    try {
      vi.setSystemTime(new Date('2026-09-12T03:04:05.678Z'));
      first = (await stores.archive.archive('session-collision', 'FIRST\n')).id;
      second = (await stores.archive.archive('session-collision', 'SECOND\n')).id;
    } finally {
      vi.useRealTimers();
    }

    const prefixed = await db
      .select({ id: archive.id })
      .from(archive)
      .where(sql`${archive.id} like ${'session-collision-%'}`);
    expect(new Set(prefixed.map((row) => row.id))).toEqual(new Set([first, second]));
  });
});
