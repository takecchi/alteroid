import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WITHHELD_ENV_KEYS } from '@alteroid/core';
import { describe, expect, it, vi } from 'vitest';

import { DATABASE_URL_ENV, openStorage, planStorage } from './storage.js';

/**
 * 記憶の置き場の選び方（roadmap M4）。
 *
 * 実 DB への接続が要る部分は storage-pg のテストで担保してある。ここで固定したいのは
 * **構成の決まり方**、とくに「記憶へ到達するのに使った鍵を子プロセスから伏せる」
 * ことが接続の成否と無関係に決まっていること。
 */
describe('planStorage', () => {
  it('既定はローカル（fs）', () => {
    const plan = planStorage({});

    expect(plan.kind).toBe('fs');
    // fs 構成に記憶ストアの鍵は無いが、ログインの鍵は器を問わず伏せる
    // （握られれば誰でもトークンを発行でき、API 経由で記憶へ届く）。
    expect(plan.withheldEnvKeys).toEqual([
      'ALTEROID_GOOGLE_CLIENT_ID',
      'ALTEROID_GOOGLE_CLIENT_SECRET',
    ]);
  });

  it('ALTEROID_DATABASE_URL があればクラウド（pg）', () => {
    const plan = planStorage({
      [DATABASE_URL_ENV]: 'postgres://alteroid:secret@db:5432/alteroid',
    });

    expect(plan.kind).toBe('pg');
  });

  it('空文字は「未指定」として扱う（compose の未設定と同じ）', () => {
    expect(planStorage({ [DATABASE_URL_ENV]: '' }).kind).toBe('fs');
  });

  it('記憶ストアへ到達した鍵を、マネージャー子プロセスから伏せる（受け入れ基準3）', () => {
    const plan = planStorage({
      [DATABASE_URL_ENV]: 'postgres://alteroid:secret@db:5432/alteroid',
    });

    // ここで挙げた鍵は createClone 経由でマネージャーの env から落ちる。
    // マネージャー側の実際の欠落は manager.test.ts が固定している。
    expect(plan.withheldEnvKeys).toContain(DATABASE_URL_ENV);
    // core 側の既定（ローカルの所在）と合わせて、記憶への経路は配られない
    expect(WITHHELD_ENV_KEYS).toContain(DATABASE_URL_ENV);
  });

  it('接続情報を起動ログへ流さない（パスワードを出さない）', () => {
    const plan = planStorage({
      [DATABASE_URL_ENV]: 'postgres://alteroid:secret@db:5432/alteroid',
    });

    expect(plan.description).not.toContain('secret');
    expect(plan.description).toContain('db:5432');
  });
});

describe('openStorage', () => {
  it('fs 構成では人格データディレクトリを用意して返す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

    const storage = await openStorage({ ALTEROID_HOME: root });

    expect(storage.paths.root).toBe(root);
    expect(storage.sessionStore).toBeUndefined();
    expect(await storage.stores.persona.list()).toHaveLength(1);

    await storage.close();
  });

  /**
   * 記憶の保護状態（human guard）の backfill。
   *
   * **日誌に過去の `cause:'human'` の記録があるのに、派生値（human_touched_at /
   * `.index.json`）だけが立っていない**という状況を、デーモン再起動を挟んで
   * 再現する。これは実際に起きうる — 既存の環境にこの機能を入れた直後は、
   * 過去の PUT の履歴が日誌にはあっても派生値はまだ無い。backfill がそれを
   * 追いつかせないと、既存の人間の書き込みが `unknown` に落ちたままになる
   * （守る側なので保護自体は効くが、`human` と `unknown` を混同したままになる）。
   */
  it('起動時に日誌の cause:human を backfill し、既存の人間の書き込みが human になる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

    // --- 1回目の起動（過去のデーモンの寿命を模す） -------------------------
    const first = await openStorage({ ALTEROID_HOME: root });
    await first.stores.persona.write('habits', '# 習慣\n\n人間が過去に書いた\n');
    // `app.ts` の PUT ハンドラが書く形をそのまま模す。ここではあえて
    // `markHumanTouched` を呼ばない — 「日誌には残っているが派生値だけが
    // 追いついていない」状態を作るのが目的である。
    await first.stores.journal.append({
      type: 'memory_update',
      slug: 'habits',
      cause: 'human',
      action: 'write',
      summary: '過去の PUT を模す',
    });
    // まだ backfill していないので clone-only（human 印が無い）。
    expect(await first.stores.persona.protectionStatus('habits')).toEqual({
      kind: 'clone-only',
    });
    await first.close();

    // --- 2回目の起動（再起動） ---------------------------------------------
    const second = await openStorage({ ALTEROID_HOME: root });

    expect(await second.stores.persona.protectionStatus('habits')).toEqual({ kind: 'human' });

    await second.close();
  });

  it('cause:human の action:remove からは backfill しない（削除は保護を立てる理由にならない）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

    const first = await openStorage({ ALTEROID_HOME: root });
    // 人間が削除した記録だけが日誌にある（実体は既に無い）。
    await first.stores.journal.append({
      type: 'memory_update',
      slug: 'gone',
      cause: 'human',
      action: 'remove',
      summary: '過去の DELETE を模す',
    });
    await first.close();

    const second = await openStorage({ ALTEROID_HOME: root });

    // 実体も無ければ human 印も立たない — 新しく書かれたときは無条件で
    // 保護されるのではなく、clone-only から始まる。
    expect(await second.stores.persona.read('gone')).toBeNull();
    expect(await second.stores.persona.protectionStatus('gone')).toEqual({ kind: 'unknown' });

    await second.close();
  });

  /**
   * 記憶の `createdAt` の backfill。**`backfillMemoryHumanTouch` の歯と対の
   * 形にしてある**——同じくデーモン再起動を挟んで、日誌にはあるが派生値に
   * まだ無い状況を再現する。
   *
   * **この配線（記憶の `createdAt` 対応）より前は、`persona.write()` は
   * `createdAt` に一切触れなかった**——backfill だけがこの派生値を動かして
   * いたので、このファイルの下のほうのテストはどれも「まず write() で作り、
   * まだ unknown なことを確かめ、再起動を挟んで known になることを確かめる」
   * という形をしていた。**いまは違う。** `write()` / `append()` 自身が新規
   * 作成の瞬間に `createdAt` を立てる（`packages/storage-fs/src/persona.ts`
   * の `#writeNow` の doc）ので、**backfill を確かめたいテストは、write()
   * が先に立ててしまわないよう、索引の無い生ファイル（backfill 前の昔の
   * 記憶を模す）を直接置く**（`storage-fs` / `storage-pg` のテストと同じ
   * 手口）。
   */
  describe('createdAt の backfill', () => {
    it('起動後に作った記憶が、再起動を挟まずその場で known を持つ（この配線の本体）', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

      const storage = await openStorage({ ALTEROID_HOME: root });

      const written = await storage.stores.persona.write('today', '# 今日\n\n新しく作った記憶\n');

      expect(written.createdAt.kind).toBe('known');
      expect((await storage.stores.persona.read('today'))?.createdAt).toEqual(written.createdAt);

      await storage.close();
    });

    it('起動時に日誌の最初の write を createdAt として backfill する（新しいほうが採られないこと）', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

      // **`journal.append` の `at` は呼び出し側から渡せず、その場の
      // `new Date().toISOString()` になる。** 同じ tick で2回呼ぶと同じ
      // ミリ秒になりかねないので、時計を止めて明示的に2つの時刻を作る
      // （「新しいほうが採られない」を確かめるには、2つが確実に違う必要がある）。
      vi.useFakeTimers();
      try {
        // --- 1回目の起動 -----------------------------------------------------
        const first = await openStorage({ ALTEROID_HOME: root });
        // **store を経由せず、索引の無い生ファイルとして置く。** write() 自身が
        // この PR で新規作成時に createdAt を立てるようになったため、
        // persona.write() で作ると backfill を待たずに known になってしまい、
        // ここで確かめたい「backfill が日誌の最初の write を採用すること」が
        // 隠れる（backfill 前の昔の記憶を模す）。
        await writeFile(join(root, 'memory', 'habits.md'), '# 習慣\n\n最初の版\n', 'utf8');
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const firstWrite = await first.stores.journal.append({
          type: 'memory_update',
          slug: 'habits',
          cause: 'clone',
          action: 'write',
          summary: '最初の write を模す',
        });
        vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
        const secondWrite = await first.stores.journal.append({
          type: 'memory_update',
          slug: 'habits',
          cause: 'clone',
          action: 'write',
          summary: '2回目の write を模す',
        });
        expect(firstWrite.at).not.toBe(secondWrite.at);
        // まだ backfill していないので unknown。
        expect((await first.stores.persona.read('habits'))?.createdAt).toEqual({
          kind: 'unknown',
        });
        await first.close();

        // --- 2回目の起動（再起動） -------------------------------------------
        const second = await openStorage({ ALTEROID_HOME: root });

        // 古いほう（1回目の write）が採られ、新しいほう（2回目）は採られない。
        expect((await second.stores.persona.read('habits'))?.createdAt).toEqual({
          kind: 'known',
          at: firstWrite.at,
        });

        await second.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('write() が立てた createdAt は、日誌に根拠が無くても再起動をまたいで保持される', async () => {
      // **この it() はこの PR で反転した。** 以前はここで「日誌に根拠が無い
      // 文書は unknown のまま（ファイルの mtime を使わない）」を確かめて
      // いた——persona.write() 自体は journal を書かないので、journal に
      // action:'write' が無い文書は backfill の対象にならず、再起動しても
      // unknown のまま、という旧仕様（backfill だけが createdAt の出所
      // だった時代）の裏返しである。**いまは write() 自身が作成そのものを
      // 観測して createdAt を立てるので、日誌の記録に一切頼らず、再起動を
      // またいでも known のままである。**
      const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

      const first = await openStorage({ ALTEROID_HOME: root });
      // memory_update を1件も残さずに書く（`persona.write` 自体は journal を
      // 書かない——journal へ積むのは `app.ts` のハンドラの仕事なので、ここは
      // 「日誌に根拠が無い」状況をそのまま作れる）。
      const written = await first.stores.persona.write('mystery', '# 謎\n\n根拠の無い記憶\n');
      expect(written.createdAt.kind).toBe('known');
      await first.close();

      const second = await openStorage({ ALTEROID_HOME: root });

      expect((await second.stores.persona.read('mystery'))?.createdAt).toEqual(written.createdAt);

      await second.close();
    });

    it('書き込み経路で既に埋まった createdAt を、次の起動の backfill が上書きしない', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

      // journal.append の at を明示的に古くするため、時計を止める
      // （上の「新しいほうが採られない」テストと同じ手口）。
      vi.useFakeTimers();
      try {
        const first = await openStorage({ ALTEROID_HOME: root });
        const written = await first.stores.persona.write('habits', '# 習慣\n');
        expect(written.createdAt.kind).toBe('known');
        await first.close();

        // 再起動の前に、この記憶よりずっと古い write を日誌へ積む——
        // backfill が createdAt の第一の出所であれば、これで巻き戻って見える
        // はずだが、いまは書き込み経路が既に確定させているので、backfill は
        // 何もしない（既に値が入っている slug には触らない。絶対条件2）。
        vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));
        const second = await openStorage({ ALTEROID_HOME: root });
        await second.stores.journal.append({
          type: 'memory_update',
          slug: 'habits',
          cause: 'clone',
          action: 'write',
          summary: 'あとから発覚した、もっと古い write を模す',
        });
        await second.close();

        const third = await openStorage({ ALTEROID_HOME: root });
        expect((await third.stores.persona.read('habits'))?.createdAt).toEqual(written.createdAt);

        await third.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('backfill は冪等——2回目の再起動でも既に埋まった createdAt を書き換えない（絶対条件2・4）', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

      const first = await openStorage({ ALTEROID_HOME: root });
      // 索引の無い生ファイルとして置く（backfill 単体の冪等性を確かめたい
      // ので、write() に createdAt を先に立てさせない）。
      await writeFile(join(root, 'memory', 'habits.md'), '# 習慣\n', 'utf8');
      await first.stores.journal.append({
        type: 'memory_update',
        slug: 'habits',
        cause: 'clone',
        action: 'write',
        summary: '最初の write を模す',
      });
      await first.close();

      const second = await openStorage({ ALTEROID_HOME: root });
      const afterFirstBackfill = (await second.stores.persona.read('habits'))?.createdAt;
      expect(afterFirstBackfill?.kind).toBe('known');
      // 2回目の backfill が動く前に、日誌へさらに古い write を追記する——
      // 冪等でなければここで createdAt が巻き戻って見えてしまう。
      await second.stores.journal.append({
        type: 'memory_update',
        slug: 'habits',
        cause: 'clone',
        action: 'write',
        summary: 'もっと古い write（あとから発覚した過去）を模す',
      });
      await second.close();

      const third = await openStorage({ ALTEROID_HOME: root });
      const afterSecondBackfill = (await third.stores.persona.read('habits'))?.createdAt;

      // 一度確定した値のまま——追記された「もっと古い」記録には動かない。
      expect(afterSecondBackfill).toEqual(afterFirstBackfill);

      await third.close();
    });

    /**
     * **絶対条件1「バックフィルは created_at を埋める以外のことを一切しない」**
     * を、起動をまたいだ実際の配線（`openStorage` → `backfillMemoryCreatedAt`）
     * で確かめる。`markCreatedAt` 単体の歯は `storage-fs` / `storage-pg` の
     * テストに在るが、ここは「本当に backfill 経路からしか動かないこと」を見る。
     */
    it('backfill は本文・updatedAt・保護状態・要旨を書き換えない', async () => {
      const root = await mkdtemp(join(tmpdir(), 'alteroid-storage-'));

      const first = await openStorage({ ALTEROID_HOME: root });
      // 索引の無い生ファイルとして置く（上と同じ理由——write() が
      // createdAt を先に立ててしまうと、backfill 単体の「未書き換え」を
      // 確かめられない）。
      await writeFile(
        join(root, 'memory', 'runbook.md'),
        ['---', 'description: 手順', '---', '# 手順書', '', '本文', ''].join('\n'),
        'utf8',
      );
      await first.stores.persona.markHumanTouched('runbook', '2020-01-01T00:00:00.000Z');
      await first.stores.journal.append({
        type: 'memory_update',
        slug: 'runbook',
        cause: 'human',
        action: 'write',
        summary: '過去の PUT を模す',
      });
      const before = await first.stores.persona.read('runbook');
      const beforeProtection = await first.stores.persona.protectionStatus('runbook');
      await first.close();

      const second = await openStorage({ ALTEROID_HOME: root });
      const after = await second.stores.persona.read('runbook');
      const afterProtection = await second.stores.persona.protectionStatus('runbook');

      expect(after?.content).toBe(before?.content);
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(after?.description).toBe(before?.description);
      expect(after?.kind).toBe(before?.kind);
      expect(afterProtection).toEqual(beforeProtection);
      // createdAt だけが unknown → known に動いたこと。
      expect(before?.createdAt).toEqual({ kind: 'unknown' });
      expect(after?.createdAt?.kind).toBe('known');

      await second.close();
    });
  });
});
