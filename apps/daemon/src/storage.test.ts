import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WITHHELD_ENV_KEYS } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { DATABASE_URL_ENV, openStorage, planStorage } from './storage.js';

describe('planStorage', () => {
  it('既定はローカル（fs）', () => {
    const plan = planStorage({});

    expect(plan.kind).toBe('fs');
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

    expect(plan.withheldEnvKeys).toContain(DATABASE_URL_ENV);
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
  // stdout を握り潰す: `openStorage` を呼ぶ全テストが本物の stdout へ書くため。
  let root: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('fs 構成では人格データディレクトリを用意して返す', async () => {
    root = await makeTempDir('alteroid-storage-');

    const storage = await openStorage({ ALTEROID_HOME: root });

    expect(storage.paths.root).toBe(root);
    expect(storage.sessionStore).toBeUndefined();
    expect(await storage.stores.persona.list()).toHaveLength(1);

    await storage.close();
  });

  it('起動時に会話の既読の基準時刻を決め、再起動しても変えない', async () => {
    root = await makeTempDir('alteroid-storage-');

    const first = await openStorage({ ALTEROID_HOME: root });
    const decided = await first.stores.conversationReads.read();
    expect(decided.state === 'ok' && decided.baseline !== null).toBe(true);
    await first.close();

    const second = await openStorage({ ALTEROID_HOME: root });
    expect(await second.stores.conversationReads.read()).toEqual(decided);
    await second.close();
  });

  it('起動時に日誌の cause:human を backfill し、既存の人間の書き込みが human になる', async () => {
    root = await makeTempDir('alteroid-storage-');

    const first = await openStorage({ ALTEROID_HOME: root });
    await first.stores.persona.write('habits', '# 習慣\n\n人間が過去に書いた\n');
    await first.stores.journal.append({
      type: 'memory_update',
      slug: 'habits',
      cause: 'human',
      action: 'write',
      summary: '過去の PUT を模す',
    });
    expect(await first.stores.persona.protectionStatus('habits')).toEqual({
      kind: 'clone-only',
    });
    await first.close();

    const second = await openStorage({ ALTEROID_HOME: root });

    expect(await second.stores.persona.protectionStatus('habits')).toEqual({ kind: 'human' });

    await second.close();
  });

  it('cause:human の action:remove からは backfill しない（削除は保護を立てる理由にならない）', async () => {
    root = await makeTempDir('alteroid-storage-');

    const first = await openStorage({ ALTEROID_HOME: root });
    await first.stores.journal.append({
      type: 'memory_update',
      slug: 'gone',
      cause: 'human',
      action: 'remove',
      summary: '過去の DELETE を模す',
    });
    await first.close();

    const second = await openStorage({ ALTEROID_HOME: root });

    expect(await second.stores.persona.read('gone')).toBeNull();
    expect(await second.stores.persona.protectionStatus('gone')).toEqual({ kind: 'unknown' });

    await second.close();
  });

  describe('createdAt の backfill', () => {
    it('起動後に作った記憶が、再起動を挟まずその場で known を持つ（この配線の本体）', async () => {
      root = await makeTempDir('alteroid-storage-');

      const storage = await openStorage({ ALTEROID_HOME: root });

      const written = await storage.stores.persona.write('today', '# 今日\n\n新しく作った記憶\n');

      expect(written.createdAt.kind).toBe('known');
      expect((await storage.stores.persona.read('today'))?.createdAt).toEqual(written.createdAt);

      await storage.close();
    });

    it('起動時に日誌の最初の write を createdAt として backfill する（新しいほうが採られないこと）', async () => {
      root = await makeTempDir('alteroid-storage-');

      vi.useFakeTimers();
      try {
        const first = await openStorage({ ALTEROID_HOME: root });
        // 索引の無い生ファイルとして置く: persona.write() で作ると backfill を待たずに known になってしまうため。
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
        expect((await first.stores.persona.read('habits'))?.createdAt).toEqual({
          kind: 'unknown',
        });
        await first.close();

        const second = await openStorage({ ALTEROID_HOME: root });

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
      root = await makeTempDir('alteroid-storage-');

      const first = await openStorage({ ALTEROID_HOME: root });
      const written = await first.stores.persona.write('mystery', '# 謎\n\n根拠の無い記憶\n');
      expect(written.createdAt.kind).toBe('known');
      await first.close();

      const second = await openStorage({ ALTEROID_HOME: root });

      expect((await second.stores.persona.read('mystery'))?.createdAt).toEqual(written.createdAt);

      await second.close();
    });

    it('書き込み経路で既に埋まった createdAt を、次の起動の backfill が上書きしない', async () => {
      root = await makeTempDir('alteroid-storage-');

      vi.useFakeTimers();
      try {
        const first = await openStorage({ ALTEROID_HOME: root });
        const written = await first.stores.persona.write('habits', '# 習慣\n');
        expect(written.createdAt.kind).toBe('known');
        await first.close();

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
      root = await makeTempDir('alteroid-storage-');

      const first = await openStorage({ ALTEROID_HOME: root });
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

      expect(afterSecondBackfill).toEqual(afterFirstBackfill);

      await third.close();
    });

    it('backfill は本文・updatedAt・保護状態・要旨を書き換えない', async () => {
      root = await makeTempDir('alteroid-storage-');

      const first = await openStorage({ ALTEROID_HOME: root });
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
      expect(before?.createdAt).toEqual({ kind: 'unknown' });
      expect(after?.createdAt?.kind).toBe('known');

      await second.close();
    });
  });
});
