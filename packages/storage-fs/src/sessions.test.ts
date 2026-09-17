import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureStderr, clearRecentTracesForTesting, recentDroppedTraces } from '@alteroid/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSessionRegistry } from './sessions.js';

/**
 * issue #1147 の2つの穴への応答。
 *
 * **穴2（本体）**: 4つの読み手（`getCloneSessionId` / `getTranscriptGrave` /
 * `getLostSessionGrave` / `getProjectKey`）は、かつて「ファイルが無い
 * （`ENOENT`）」と「在ったのに読めなかった（千切れた JSON・スキーマ不一致）」
 * の両方を同じ `catch { return null; }` へ潰していた。ここで測るのは
 * **その区別が付くこと**——無いときは跡が出ず、読めなかったときだけ
 * `noteSessionMaterialUnreadable` の跡が出る。**陰性対照（無いとき）を
 * 必ず対で置く**（跡が常に出る実装でも緑になる歯にしないため、
 * AGENTS.md「テストを弱めずに直す」）。
 *
 * **穴1**: 4つの書き込みが `writeFileAtomic`（tmp へ書いて `rename`）を
 * 経由していること。
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alteroid-sessions-test-'));
  clearRecentTracesForTesting();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('「無い」と「読めなかった」の区別（穴2）', () => {
  describe('getCloneSessionId / session.json', () => {
    it('ファイルが無いときは跡を残さず null を返す（陰性対照）', async () => {
      const registry = new FsSessionRegistry(dir);
      let value: string | null = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getCloneSessionId();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(0);
      expect(recentDroppedTraces()).toHaveLength(0);
    });

    it('千切れた JSON を読んだときは跡を残して null を返す', async () => {
      await writeFile(join(dir, 'session.json'), '{"cloneSessionId":"abc', 'utf8');
      const registry = new FsSessionRegistry(dir);
      let value: string | null = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getCloneSessionId();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(1);
      const line = lines[0] as string;
      expect(line).toContain('クローンのセッション id');
      expect(line).toContain('読み出せませんでした');
      expect(line).toContain(
        '本当に無かったのか読めなかっただけなのかを区別できるのは、この行だけである',
      );
      expect(recentDroppedTraces()).toHaveLength(1);
    });

    it('JSON としては読めるがスキーマに合わないときも跡を残して null を返す', async () => {
      // cloneSessionId が数値——`z.string().nullable()` に合わない。
      await writeFile(join(dir, 'session.json'), '{"cloneSessionId":123}', 'utf8');
      const registry = new FsSessionRegistry(dir);
      let value: string | null = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getCloneSessionId();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(1);
      expect(recentDroppedTraces()).toHaveLength(1);
    });
  });

  describe('getTranscriptGrave / transcript-grave.json', () => {
    it('ファイルが無いときは跡を残さず null を返す（陰性対照）', async () => {
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getTranscriptGrave();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(0);
      expect(recentDroppedTraces()).toHaveLength(0);
    });

    it('千切れた JSON を読んだときは跡を残して null を返す', async () => {
      await writeFile(join(dir, 'transcript-grave.json'), '{"archiveId":"arc-1', 'utf8');
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getTranscriptGrave();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('生ログの墓標');
      expect(recentDroppedTraces()).toHaveLength(1);
    });
  });

  describe('getLostSessionGrave / lost-session-grave.json', () => {
    it('ファイルが無いときは跡を残さず null を返す（陰性対照）', async () => {
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getLostSessionGrave();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(0);
      expect(recentDroppedTraces()).toHaveLength(0);
    });

    it('千切れた JSON を読んだときは跡を残して null を返す', async () => {
      await writeFile(
        join(dir, 'lost-session-grave.json'),
        '{"projectKey":"proj-1","sessionId":"sess-1',
        'utf8',
      );
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getLostSessionGrave();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('再開素材を捨てた回の墓標');
      expect(recentDroppedTraces()).toHaveLength(1);
    });
  });

  describe('getProjectKey / project-key.json', () => {
    it('ファイルが無いときは跡を残さず null を返す（陰性対照）', async () => {
      const registry = new FsSessionRegistry(dir);
      let value: string | null = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getProjectKey();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(0);
      expect(recentDroppedTraces()).toHaveLength(0);
    });

    it('千切れた JSON を読んだときは跡を残して null を返す', async () => {
      await writeFile(join(dir, 'project-key.json'), '{"projectKey":"proj', 'utf8');
      const registry = new FsSessionRegistry(dir);
      let value: string | null = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.getProjectKey();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('SDK が生ログを預ける scope');
      expect(recentDroppedTraces()).toHaveLength(1);
    });
  });

  it('本文（ファイルの中身）は跡に乗らない', async () => {
    const secret = 'ghp_000000000000000000000000000000000000';
    await writeFile(join(dir, 'session.json'), `{"cloneSessionId":"${secret}`, 'utf8');
    const registry = new FsSessionRegistry(dir);
    const lines = await captureStderr(async () => {
      await registry.getCloneSessionId();
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(secret);
  });
});

describe('書き込みが writeFileAtomic を経由する（穴1）', () => {
  it('setCloneSessionId のあとに tmp の残骸が残らない', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.setCloneSessionId('sess-1');
    const names = await readdir(dir);
    expect(names).toEqual(['session.json']);
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false);
  });

  it('4つの書き込みすべてで tmp の残骸が残らない', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.setCloneSessionId('sess-1');
    await registry.setTranscriptGrave({ archiveId: 'arc-1' });
    await registry.setLostSessionGrave({ projectKey: 'proj-1', sessionId: 'sess-1' });
    await registry.setProjectKey('proj-1');

    const names = (await readdir(dir)).sort();
    expect(names).toEqual([
      'lost-session-grave.json',
      'project-key.json',
      'session.json',
      'transcript-grave.json',
    ]);
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false);
  });

  /**
   * #1050 と同じ形の再現（`file-lock.test.ts` の「同じ宛先へ2つの書き手が
   * 同時に書いても ENOENT で落ちない」と同じ組み立てを `FsSessionRegistry`
   * 越しに行う）。tmp 名が呼び出しごとに一意でなければ、どちらかの rename が
   * 相手の tmp を踏んで落ちる。**このテストは `writeFileAtomic` 自身の
   * 保証（`atomic.test.ts` 相当。実体は `file-lock.test.ts`）を、
   * `FsSessionRegistry` が実際にその関数を呼んでいることの確認として
   * 繰り返す**——ここが `writeFile` を直接呼ぶ形に戻っていれば、後勝ちの
   * 書き込みが先の書き込みの片方を truncate した状態で終わる窓が生まれ、
   * 稀に壊れた JSON が最終ファイルに残る。
   */
  it('2つのインスタンスが同じディレクトリへ同時に setCloneSessionId しても、最終ファイルは壊れない', async () => {
    const registryA = new FsSessionRegistry(dir);
    const registryB = new FsSessionRegistry(dir);
    const idA = `A-${'x'.repeat(5000)}`;
    const idB = `B-${'y'.repeat(5000)}`;

    const results = await Promise.allSettled([
      registryA.setCloneSessionId(idA),
      registryB.setCloneSessionId(idB),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        throw new Error(`書き込みが失敗した: ${String(result.reason)}`);
      }
    }

    const raw = await readFile(join(dir, 'session.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const value = await registryA.getCloneSessionId();
    expect([idA, idB]).toContain(value);

    const leftoverTmp = (await readdir(dir)).filter((name) => name.includes('.tmp.'));
    expect(leftoverTmp).toEqual([]);
  });
});

describe('clear() は変わらず4欄を消す（回帰確認）', () => {
  it('4つとも設定してから clear すると4件消える', async () => {
    await mkdir(dir, { recursive: true });
    const registry = new FsSessionRegistry(dir);
    await registry.setCloneSessionId('sess-1');
    await registry.setTranscriptGrave({ archiveId: 'arc-1' });
    await registry.setLostSessionGrave({ projectKey: 'proj-1', sessionId: 'sess-1' });
    await registry.setProjectKey('proj-1');

    const removed = await registry.clear();
    expect(removed).toBe(4);
    expect(await readdir(dir)).toEqual([]);
  });
});
