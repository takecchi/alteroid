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

/**
 * pg ドライバの受け入れ確認。
 *
 * **偽物の DB では確かめたことにならない。** PGlite はインプロセスで動く実
 * PostgreSQL なので、SQL・索引・冪等性まで本番と同じ経路で通る（CI に外部 DB を
 * 要求せずに済む）。fs ドライバのテストと同じ振る舞いを、同じ IF に対して問う。
 *
 * **このファイルは `index.test.ts` から移した（分割元は git blame で辿れる）。**
 * 元の1本（5588行・262テスト）は単独で走らせると 564.75s かかり、作業者の
 * Bash の既定タイムアウト（300s）に収まらなかった（2026-09-29 実測、
 * `.claude/skills/test-in-chunks/SKILL.md`）。`vitest --shard` はファイル数で
 * 等分するので、1本のままでは分割にならない——だから最上位の `describe`
 * 単位でファイルを分けた。ここは `PgCommitmentStore の畳み込みの索引（#1041）` /
 * `PgCommitmentStore` / `PgInboxStore` / `PgTranscriptArchive` を持つ。
 * **`describe` / `it` の本文・順序は1文字も変えていない**——元ファイルの
 * 対応する範囲とこのファイルを突き合わせれば同一であることが確認できる。
 * 冒頭の足場（`beforeEach` で PGlite を都度立てて `migrate` する形、
 * `afterEach` で閉じる形）も元ファイルと同じものを複製している（分岐は
 * 生まない——共有モジュールへ切り出すほどの複雑さが無かったため、各ファイルへ
 * 同じ短い足場を複製する側を選んだ）。
 */
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

  /** `open()` の `where not exists` を経由しない、素の insert。 */
  const rawInsert = async (entry: Commitment): Promise<void> => {
    await db.insert(commitments).values({
      id: entry.id,
      at: new Date(entry.at),
      closedAt: null,
      commitment: entry,
    });
  };

  /**
   * **ここで測るのは `open()` の `where not exists` ではなく、DB の制約そのもの
   * である。**
   *
   * `open()` の中の `where not exists` は**直列に**来た同文しか畳めない。同時に来た
   * 2件は互いの行を読み取りスナップショットに持たないので、両方ともすり抜ける——
   * それが #1041 の欠陥であり、**トランザクションを張っても直らない**（READ
   * COMMITTED の select → insert は排他しない。`PgCommitmentStore.open` の doc）。
   * 最後に残るのは索引だけである。
   *
   * ⚠️ **その「同時」そのものは、この repo では再現できない。** PGlite は単一接続
   * なので2つのセッションを同時に走らせられない。**だから競合を再現する代わりに、
   * 制約が在ることを直接測る** —— `where not exists` を経由しない insert は、
   * 同時に来た2件目が見る世界とちょうど同じものである（相手の行がまだ見えない）。
   * ⟹ **「同時に来たら DB が拒む」は、この歯と `open()` の doc の読み合わせで
   * しか言えない。歯そのものが言えるのは「素の insert を DB が拒む」までである。**
   */
  /** drizzle は元の例外を `cause` に包む（外側は `Failed query: ...` の1行）。 */
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
    // **索引の名前まで見る。** 主キー（id）で弾かれたのでは、本文の重複を拒んだ
    // ことにならない —— 測りたいのは #1041 が足した索引そのものである。
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

  /**
   * **索引の鍵が `md5(body)` であることを、この歯が固定する。**
   *
   * 生の `body` を鍵にすると btree の索引行のサイズ上限（約2.7KB）を超え、
   * **長い報告だけが記帳できなくなる**（insert が落ちる）。⟹ 鍵を「素直に」
   * 全文へ直した瞬間にここが落ちる。代償（md5 の衝突）は
   * `PgCommitmentStore.open` の doc に全文で書いてある。
   */
  /**
   * **索引が無い DB でも、畳み込みそのものは効く（#1041）。**
   *
   * `migrate` は既存の重複行が在ると索引を作らずに進む（`ensureOpenManagerBodyIndex`
   * の doc）。⟹ **索引の在る DB と無い DB が両方ありうる。** そのとき台帳が
   * #1035 以前（畳み込みが1つも無い状態）へ戻るなら、重複を持つ DB だけが静かに
   * 悪化することになる。
   *
   * ⟹ **索引を落としたうえで、3実装に当てているのと同じ契約をもう一度当てる。**
   * ここが緑である限り、`open()` の中の `where not exists`（直列に来た同文の
   * 畳み込み）は索引と独立に効いている。
   *
   * ⚠️ **索引が在る状態では、この契約は `where not exists` を1行も踏まなくても
   * 通ってしまう**（索引が弾いた回を `on conflict do nothing` が吸い、`existing`
   * が畳んだ先を返すため）—— 実際に `where not exists` を消す実験をして、
   * 索引が在る側の歯は1本も落ちないことを確かめた。**この歯だけがそれを落とす。**
   */
  it('⭐ 索引を落としても、畳み込みの契約は満たされる（where not exists が索引と独立に効いている）', async () => {
    await db.execute(sql.raw('drop index commitments_open_manager_body_idx'));
    // **同時の2件（性質 7）は測らない。** 索引が無い DB では、本物の PostgreSQL の並行
    // は両方開く（同時の2件目を弾くのは索引だけ。`open` の doc）。PGlite は単一接続で
    // 重ならないので、これまで緑だった。同時の側は索引の在る状態で測っている。
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

/**
 * 引き受けたまま終わっていない仕事の台帳（fs 版と同じ振る舞いになることを問う）。
 */
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
    // 列だけ直しても読み出しは jsonb からなので、クローンが見る側に入っていること
    expect(all[0]?.closedAt).toBe('2026-08-13T00:00:00.000Z');
    expect(all[0]?.closedReason).toBe('#99 で出した');
    // closedBy も jsonb の中に一緒に書かれていること（列を持たない欄）
    expect(all[0]?.closedBy).toBe('clone');
  });

  it('close は closedBy を記録し、既存の（closedBy の無い）行は undefined のままで既定へ倒れない', async () => {
    // 既に閉じているが closedBy を持たない行 = この欄が導入される前の記録を模す。
    // open() はどんな Commitment も受け付けるので、そのまま insert できる。
    await stores.commitments.open({
      id: 'c-legacy',
      at: '2026-08-01T00:00:00.000Z',
      origin: 'human',
      body: '導入前に片付いた仕事',
      closedAt: '2026-08-02T00:00:00.000Z',
      closedReason: '当時は書き手を記録していなかった',
    });
    const legacy = await stores.commitments.get('c-legacy');
    // **既定（'clone' でも 'human' でもない）へ倒れず、そもそも無いままである。**
    expect(legacy?.closedBy).toBeUndefined();

    // 新しく close したものは closedBy を持つ。
    await stores.commitments.open(commitment('c-new', '2026-08-13T00:00:00.000Z', '新しい依頼'));
    await stores.commitments.close('c-new', '2026-08-14T00:00:00.000Z', '片付けた', 'human');
    const fresh = await stores.commitments.get('c-new');
    expect(fresh?.closedBy).toBe('human');

    // 導入前の行は close() を経由していないので、closedBy はやはり無いまま。
    const stillLegacy = await stores.commitments.get('c-legacy');
    expect(stillLegacy?.closedBy).toBeUndefined();
  });

  /**
   * `closeMany`（issue #844）。**`close()` を件数分ループしないための専用の口**
   * （`store.ts` の `CommitmentStore.closeMany` の doc、`commitments.ts` の
   * `closeMany` の doc）。pg 版は `inArray` を使った UPDATE 1本で、`close()` の
   * 条件付き UPDATE（`where ... and closed_at is null`）を複数 id へ広げただけ
   * ——`close()` 自体は書き換えず、別の実装として並べてある。
   *
   * ここで問うのは、語（メソッド名やコメント）ではなく `list()` で読み直した
   * 実状態で測ること（PR #826 の教訓）——戻り値だけでなく、ストアへ読み直した
   * ときの `closedAt` / `closedReason` / `closedBy`、そして未了行が無傷である
   * ことまで確かめる。
   */
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

      // c-2（既に閉じていた）・しらない（存在しない）は返らない
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
      // 語（「書かなかった」というコメント）ではなく、読み直した実状態が
      // 1つも変わっていないことで測る。
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
      // pg 版は close() の契約（行は消さない）をそのまま守る——`closeMany` も
      // 保持上限・削除経路を1つも持たないので `trimmedClosed` は常に 0
      // （`CommitmentList.trimmedClosed` の doc）。
      expect(list.trimmedClosed).toBe(0);
    });
  });

  /**
   * `editBody`（本 PR）。**まだ片付いていない行だけ書き換えられ、
   * `origin` / `at` / `source` など他の欄には触れないこと**を fs 版と同じ
   * 形で問う。`origin` が `'human'` かどうかの判定はストアの責務ではない
   * （`CommitmentStore.editBody` の doc）ので、ここでは問わない——その判定は
   * `apps/daemon/src/app.ts` の `PATCH /commitments/:id` のテストで別に問う。
   */
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
      // 他の欄は無傷
      expect(entry?.at).toBe('2026-08-12T00:00:00.000Z');
      expect(entry?.origin).toBe('human');
      expect(entry?.source).toBe('conv-1');
      expect(entry?.closedAt).toBeUndefined();
      // list() 側（jsonb から読む経路）でも同じ値が見える
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
      // close() の記録も無傷
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

  /**
   * **これがこの変更の本体である。** `commitmentSchema.closedBy` を
   * `z.string()` で緩く持っているのは、`parseCommitment`（本ファイルの
   * `list()` / `get()` が使う）が読めない行で throw し、`list()` は
   * try/catch 無しでそれを map するためである。**厳密な enum
   * （`commitmentClosedBySchema`）だったら、未知の値が1行入っただけで
   * `list()` が例外を投げ、台帳の一覧が丸ごと読めなくなっていた。**
   * `closedBy` は由来の注記であって台帳の完全性を担わないので、その代償は
   * 大きすぎる（`packages/core/src/schema.ts` の doc）。
   *
   * **なぜ `open()` を使わないのか。** この器が書く値は 'clone' | 'human'
   * の2つに限られる（`CommitmentStore.close` の `by` 引数の型で縛って
   * ある）ので、`open()`（`commitmentSchema.parse` を通す）経由では
   * `closedBy` が未知の値を持つ行をそもそも作れない。**測りたい場面は
   * 「新しい版のデーモンが書いた行を、古い版が読む」であり、そのとき行は
   * 既に保存層に在って `open()` は通っていない。** `open()` 経由で作ると、
   * 厳密な enum へ戻す変異を当てたとき `open()`（setup）が先に落ち、
   * `list()` が丸ごと読めなくなるという当の害が一度も再現されないまま
   * テストが赤くなる（変異には反応するが症状を伝えない）。だから行の作成は
   * `db.execute`（生 SQL）でスキーマ検証を経由せず直接 insert する
   * （同じファイルの「読めない行を『片付いた』に潰さない」テストと同じ作法）。
   */
  it('未知の closedBy を持つ行があっても list() は落ちない（closedBy は台帳の完全性を担わない）', async () => {
    // スキーマ検証を経由せず直接 insert する（上の doc を見よ）。
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
              // 実際にこの器が書く値は 'clone' | 'human' の2つに限られる。
              // 'manager' は、将来書き手が増えた場合や外部から直接書かれた
              // 場合を模すためのものであって、この器自身がこの値を書くわけ
              // ではない。
              closedBy: 'manager',
            })}::jsonb
          )`,
    );

    // list() が例外を投げず、他の行も含めて読める。
    // **`list()` は `{ entries, unreadable }` を返すようになった（issue #296）ので、
    // 配列 matcher の `.resolves.toHaveLength` はもう使えない。** 直接 await して
    // `.entries` を確かめる形でも、同じ意図（厳密な enum へ戻す変異を当てると
    // `list()` 自身が例外を投げ、この await がそのまま失敗する）は保たれる。
    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries).toHaveLength(1);
    // この行は既知の欄（closedBy）の話であって、行そのものは読める。
    // `unreadable` へは回らない。
    expect(listed.unreadable).toEqual([]);

    const all = listed.entries;
    // **未知の値は undefined へ潰さず、そのまま保持する。**
    expect(all[0]?.closedBy).toBe('manager');

    const single = await stores.commitments.get('c-unknown-closedby');
    expect(single?.closedBy).toBe('manager');
  });

  /**
   * **これが issue #296 の本体である。** `closedBy` は由来の注記に過ぎず意図的に
   * 緩く持つ欄だが（直上のテスト）、`origin`（`commitmentOriginSchema`。
   * `z.enum(['human', 'manager', 'external', 'self'])`）は厳密な enum のまま
   * ——直さなければ、未知の値を持つ1行が `list()` を丸ごと落としていた。
   * 生 SQL でスキーマ検証を経由せず insert する手法は「未知の closedBy」テストと
   * 同じ（`open()` 経由では `commitmentSchema.parse` を通ってしまい、未知の
   * `origin` を持つ行をそもそも作れない）。
   */
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
              // **`commitmentOriginSchema` に無い値。** 将来 origin の種類が
              // 増えた・外部から直接書かれた、を模す。
              origin: 'future-origin',
              body: '未知の origin を持つ行',
            })}::jsonb
          )`,
    );

    // 0. **一覧そのものが落ちない。** ここを素の `await` だけで済ませると、
    //    行ごとの `safeParse` をやめる変異が**例外**でテストを殺す —— 例外は
    //    測っている性質を名指ししない。`.resolves` なら「reject した」という
    //    assertion として落ちる（issue #296）。
    await expect(stores.commitments.list()).resolves.toBeDefined();

    // 1. **健全な行は全部返る。** id を名指しして検査する（順序は齢の昇順）。
    const listed = await stores.commitments.list();
    expect(listed.entries.map((entry) => entry.id)).toEqual(['c-ok-1', 'c-ok-2']);

    // 2. **未知の1行は `unreadable` に、id 付きで現れる（黙って消えていない）。**
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]?.id).toBe('c-unknown-origin');
    expect(listed.unreadable[0]?.at).toBe('2026-08-12T00:00:00.000Z');
    // reason に本文（body）が混ざっていないこと（dropped-record.ts と同じ制約）。
    expect(listed.unreadable[0]?.reason).not.toContain('未知の origin を持つ行');

    // 3. **`get()` はその id で throw する（「無い」と「読めない」の区別が消えていない）。**
    await expect(stores.commitments.get('c-unknown-origin')).rejects.toThrow(/読めない形/);
  });

  it('同じ id で二度 open しても上書きされない（1回目の本文が残る）', async () => {
    expect(
      await stores.commitments.open(commitment('c-1', '2026-08-12T00:00:00.000Z', '最初の依頼')),
    ).toEqual({ opened: true, folded: false });

    // 受信箱の合図は配り直されうるので、同じ id の自動 open は普通に二度来る
    expect(
      // **`folded` は偽である**（#1041）—— 畳んだのではなく「同じ id が既に在る」。
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

    // 器が落ちて合図が配り直された、を模す
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

    // 二度目は記録も動かさない（最初に片付けた事実を書き換えない）
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

    // 「いま自分が開いた」と言えるのは1本だけ。**`filter(Boolean)` で数えないこと**
    // （#1041）—— `open` の戻りはオブジェクトになったので、開けなかった回も truthy
    // である。数えるのは `opened` そのものでなければならない。
    expect(results.filter((result) => result.opened)).toHaveLength(1);
    // 同じ id の衝突は「畳んだ」ではない（「既に在る」。畳み込みは本文で決まる）。
    // 本物の PostgreSQL（並行が実際に重なる）でも `folded` は偽でなければならない（#2922）。
    expect(results.filter((result) => result.folded)).toHaveLength(0);
    const rows = (await stores.commitments.list()).entries;
    expect(rows).toHaveLength(1);
    // 後から来たものが先の行を上書きしていない（上書きすると片付いた仕事が蘇る）。
    // **どの1本が勝つかは決まらない**（本物の並行では順序が不定）ので、開いた1本の本文と比べる。
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
    // 別 id の衝突は「畳んだ」である。id の衝突（既に在る）ではない。
    expect(results.filter((result) => result.folded)).toHaveLength(2);
    const winnerId = ids[results.findIndex((result) => result.opened)]!;
    expect((await stores.commitments.list()).entries.map((entry) => entry.id)).toEqual([winnerId]);
    // 畳んだ先が分かるなら、それは勝った行でなければならない（嘘の id を埋めない）。
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

  /**
   * **反転した既存テスト（issue #296）。** 元の題は「読めない行を『片付いた』に
   * 潰さない（fs 版と同じく失敗を表へ出す）」で、`list()` が `rejects.toThrow`
   * することを仕様として固定していた。**この PR がその仕様そのものを直す**
   * ——1行が読めなくても一覧は丸ごと落ちず、その行だけが `unreadable` へ回る。
   * `get('broken')` の `rejects.toThrow` は変えていない（`get` は単票なので
   * 「無い」と「読めない」の区別を throw のまま保つ。`CommitmentStore.get` の
   * doc・`UnreadableCommitmentError` の doc）。
   */
  it('読めない行を「片付いた」に潰さない（list() は丸ごと落ちず、その行だけ unreadable へ回る）', async () => {
    // 人間が手で直した・古い形が残っている、を模して不正な本体を直接置く
    await db.execute(
      sql`insert into commitments (id, at, commitment)
          values ('broken', now(), '{"id":"broken"}'::jsonb)`,
    );
    // 健全な行も1つ混ぜる。**壊れた行がある中でも、健全な行は普通に返ることを見る**
    // （id を名指しして検査する。「読めた行の中身」まで検査しないと、`entries`
    // が空になって握り潰していても気づけない）。
    await stores.commitments.open(commitment('c-ok', '2026-08-12T00:00:00.000Z', '健全な行'));

    // `get('broken')` は依然として throw する（単票の契約は変えていない）。
    await expect(stores.commitments.get('broken')).rejects.toThrow(/読めない形/);

    // **`list()` は丸ごと落ちない。**
    //
    // **`.resolves` の形を保つこと（元のテストがこの形だった理由そのもの）。**
    // 素の `await` で受けてから中身だけ検査すると、行ごとの `safeParse` をやめて
    // throw へ戻す変異を当てたとき、この行は**例外**で死ぬ。例外は「実装が
    // 壊れた」と「足場が壊れた」を区別しないので、**測っている性質を名指し
    // しない。** `.resolves` なら「reject した」という assertion として落ちるので、
    // 赤の理由が「一覧が丸ごと落ちるようになった」だと読める。
    await expect(stores.commitments.list({ includeClosed: true })).resolves.toBeDefined();

    // 健全な行（`c-ok`）は `entries` に、壊れた行（`broken`）は `unreadable` に、
    // id 付きで現れる。
    const listed = await stores.commitments.list({ includeClosed: true });
    expect(listed.entries.map((entry) => entry.id)).toEqual(['c-ok']);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]?.id).toBe('broken');
    expect(listed.unreadable[0]?.reason).toMatch(/./); // 理由は空でない（本文は含めない。上の doc）

    // 「無い」ことだけが null である
    expect(await stores.commitments.get('しらない')).toBeNull();
  });

  /**
   * **issue #416: pg 版は保持上限を持たず、`close()` の契約（「行は消さない」）を
   * そのまま守る。** fs 版（`packages/storage-fs/src/index.test.ts` の
   * 「閉じた行は上限で切られるが、未了は件数によらず1件も落ちない」）は
   * `CLOSED_HISTORY_LIMIT`（`packages/storage-fs/src/commitments.ts` で
   * 500 件）を超えると古い片付き行を物理削除するが、pg 版にはその経路が
   * 無い——ここでは fs 版の上限を明確に超える件数（501件。fs 版のテストと
   * パッケージを跨いで定数を共有すると結合が生まれるので、値はここへ複製する）
   * を片付けても、1件も落ちず `trimmedClosed` が常に `0` のままであることを問う。
   */
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
    // 最初に片付けたもの（fs 版なら物理削除されている側）もまだ読める。
    expect(await stores.commitments.get('closed-0000')).not.toBeNull();
  }, 60_000);
});

/**
 * まだ処理し終えていない受信箱の合図（fs 版と同じ振る舞いになることを問う）。
 */
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

    // 同じ id で置き直す（例えばデーモン再起動直後にもう一度届いた、を模す）
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

  // **経緯（issue #2024 で期待値を反転した）。** もとはここで `claimPending()` が
  // `読めない形` で投げることを期待していた。名前の「fs 版と同じく」は当時の fs 版の
  // 振る舞いを指していたが、fs 版は #1966（PR #1972）で「読めない行は配る側から外して
  // 跡を残し、行は消さない」形へ変わった。投げると、読めない1行が起動時の未読の復元を
  // 丸ごと止め、ほかの正しい未読まで配られなくなる。
  //
  // **守りたいこと（「消された」に潰さない）は変えていない。** 投げる代わりに、
  // (1) stderr に id の跡を残し（黙って飛ばさない）、(2) 行を表から消さない
  // （`pending().count` にも数えられる）ことを見る。
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

    /**
     * **この歯が単独で守るもの**: `pending()` を何度呼んでも `claimPending()`
     * が返す `deliveries` が変わらないこと。fs 版と同じ性質を pg の
     * `UPDATE ... RETURNING` 実装に対しても確かめる——`claimPending` の SQL の
     * 形を真似ているが `UPDATE` を含めていないことの実地の裏取り。
     */
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

  /**
   * `peekPending`（#783 段0）。`pending()` と同じ倒れ先——**読むだけで
   * `deliveries` を1つも進めない**（`UPDATE` を含まない SQL であることの
   * 実地の裏取り。fs 版と同じ性質を pg でも確かめる）。
   */
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

    /**
     * **この歯が単独で守るもの**: `peekPending()` を何度呼んでも、その後の
     * `claimPending()` が返す `deliveries` が 1（初回）のままであること。
     */
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

  /** 契約（#698）を3実装ぶんの1つとして測る。他は testing.ts / storage-fs。 */
  it('TranscriptArchive の契約を満たす', async () => {
    await verifyTranscriptArchiveContract(stores.archive, {
      // 検査19のためだけの裏口（#698）。生 SQL で body_chars / body_md5 を
      // null のまま insert し、この機能より前に積まれた行を再現する
      // （drizzle 経由だと `.default` 等で値が入りうるため、生の SQL を使う）。
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

    // ⭐ 行は在る（list() に出る）。本文だけが落ちている。
    expect((await stores.archive.list()).map((entry) => entry.id)).toContain(id);
    expect(await stores.archive.read(id)).toMatchObject({ kind: 'removed' });

    // 実際の行に body='' が入っており、DELETE していないことを直接見る。
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

  /**
   * ⭐ 判定は `removed_at` だけで行う。**`body === ''` を判定に使っていないか
   * を直接測る**（#698）——空の生ログを退避しただけの行（`remove()` を
   * 一度も呼んでいない）が `removed` に化けないことを、DB の行を直接見て
   * 確かめる。
   */
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

  /**
   * `storedBytes`（#698）は `pg_column_size(body)`——**`length()` /
   * `octet_length()` ではない**（それらは TOAST を展開する）。ここでは
   * `pg_column_size` を実際に呼んでいることを、同じ値と突き合わせて測る
   * （`length()` と混同しても短い本文では値が一致してしまう場合があるので、
   * 突き合わせは同じ関数を使う——「この関数を呼んでいるか」を見るのが
   * 目的であって、絶対値の検算ではない）。
   */
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

  /**
   * `GET /archive/sessions` の元になる `sessions()`——⭐ 依頼の動機そのもの
   * （同一セッションが複数回積まれている、を rows で数える）を pg 実装でも
   * 直接測る（契約テストとは別に、GROUP BY が実際に効いていることを見る）。
   */
  it('sessions()は同一sessionIdの行数(tombstone済み込み)を正しく数える', async () => {
    // ⚠ 1ミリ秒ずつ空ける理由は archive-contract.ts の同じ箇所の注記を参照
    // （id は `-${stamp}.jsonl` のミリ秒精度なので、同じミリ秒に積むと
    // `onConflictDoUpdate` で黙って上書きになる。元から在る別の欠陥）。
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

  /**
   * `sessions().continuity`（#698 続き）は `count(*) filter (where …)` で
   * 内訳を数える——5つのバケツ全部に1行ずつ落として、pg 実装が
   * `first` / `continues` / `diverged` / `unknown` / `absent` を取り違えずに
   * 数えることを直接測る（契約テストとは別に、`filter` が実際に効いている
   * ことを見る）。
   *
   * - `first` / `continues` / `diverged` — 素直に `archive()` を4回呼んだ
   *   結果（うち1回は `null` の `continuity` を持つ行＝`absent` を挟んでから
   *   呼ぶことで `unknown` を作る）。
   * - `absent` — この機能の前に積まれた行の再現。生 SQL で `continuity` を
   *   `null` のまま挿入する。
   * - `unknown` — 直前の行（上の `absent` 行）が指紋を持たないので、
   *   その直後の `archive()` はここに落ちる。
   *
   * ⚠ 1ミリ秒ずつ空ける理由は archive-contract.ts の同じ箇所の注記と同じ
   * ——同じミリ秒に積むと id が衝突し、「直前の行」の順序が曖昧になる。
   */
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

  /**
   * ⭐ #905: 同じミリ秒に2回積んでも、行が2本残る。
   *
   * 契約テスト（検査20）は `list()` / `read()` を通した姿しか見ない——ここでは
   * **テーブルの側**を直接見て、`body` が2本とも別々に残っていることを測る
   * （`onConflictDoUpdate` へ戻すと1行になり、`body` は後勝ちの1本だけになる）。
   *
   * **時計は `toFake: ['Date']` に絞って固定する。** `setTimeout` まで偽物に
   * すると PGlite の待ちが止まる。
   */
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

    // 1本目の id は従来どおり（枝番が付くのは衝突した2本目だけ）。
    expect(first).toBe('session-collision-2026-09-12T03-04-05-678Z.jsonl');
    expect(second).toBe('session-collision-2026-09-12T03-04-05-678Z-2.jsonl');

    const rows = await db.select().from(archive).where(eq(archive.sessionId, 'session-collision'));
    expect(rows).toHaveLength(2);
    const bodyById = new Map(rows.map((row) => [row.id, row.body]));
    expect(bodyById.get(first)).toBe('FIRST\n');
    expect(bodyById.get(second)).toBe('SECOND\n');
  });

  /**
   * ⭐ #905 の要件3の歯: **`id` の前方一致 LIKE が、枝番付きの2本目も拾う。**
   *
   * `id` の先頭が `sanitize(sessionId)` であるという性質は、消す問い合わせの
   * 費用に効いている（前方一致が主キーの btree に落ちる。#698 §6-5）。
   * **枝番を id の先頭側へ付ける形にすると、この `expect` が赤くなる。**
   */
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
