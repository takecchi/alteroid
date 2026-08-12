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
    expect(plan.withheldEnvKeys).toEqual([]);
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
});
