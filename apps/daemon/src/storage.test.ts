import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WITHHELD_ENV_KEYS } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

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
});
