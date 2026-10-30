import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { captureStderr, clearRecentTracesForTesting, recentDroppedTraces } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { withPathLock } from './file-lock.js';
import { FsSessionRegistry } from './sessions.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('alteroid-sessions-test-');
  clearRecentTracesForTesting();
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

  describe('listTranscriptGraves / transcript-grave-queue.json', () => {
    it('ファイルが無いときは跡を残さず空を返す（陰性対照）', async () => {
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.listTranscriptGraves();
      });
      expect(value).toEqual([]);
      expect(lines).toHaveLength(0);
      expect(recentDroppedTraces()).toHaveLength(0);
    });

    it('千切れた JSON を読んだときは跡を残して空を返す', async () => {
      await writeFile(
        join(dir, 'transcript-grave-queue.json'),
        '{"graves":[{"archiveId":"arc-1',
        'utf8',
      );
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.listTranscriptGraves();
      });
      expect(value).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('生ログの墓標');
      expect(recentDroppedTraces()).toHaveLength(1);
    });
  });

  describe('listLostSessionGraves / lost-session-grave-queue.json', () => {
    it('ファイルが無いときは跡を残さず空を返す（陰性対照）', async () => {
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.listLostSessionGraves();
      });
      expect(value).toEqual([]);
      expect(lines).toHaveLength(0);
      expect(recentDroppedTraces()).toHaveLength(0);
    });

    it('千切れた JSON を読んだときは跡を残して空を返す', async () => {
      await writeFile(
        join(dir, 'lost-session-grave-queue.json'),
        '{"graves":[{"projectKey":"proj-1","sessionId":"sess-1',
        'utf8',
      );
      const registry = new FsSessionRegistry(dir);
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await registry.listLostSessionGraves();
      });
      expect(value).toEqual([]);
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
    await registry.addTranscriptGrave({ archiveId: 'arc-1' });
    await registry.addLostSessionGrave({ projectKey: 'proj-1', sessionId: 'sess-1' });
    await registry.setProjectKey('proj-1');

    const names = (await readdir(dir)).sort();
    expect(names).toEqual([
      'lost-session-grave-queue.json',
      'project-key.json',
      'session.json',
      'transcript-grave-queue.json',
    ]);
    expect(names.some((name) => name.includes('.tmp.'))).toBe(false);
  });

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
    await registry.addTranscriptGrave({ archiveId: 'arc-1' });
    await registry.addLostSessionGrave({ projectKey: 'proj-1', sessionId: 'sess-1' });
    await registry.setProjectKey('proj-1');

    const removed = await registry.clear();
    expect(removed).toBe(4);
    expect(await readdir(dir)).toEqual([]);
  });

  it('墓標を1つだけ置いていた古いファイルは読まず、clear() も触らない（#5869）', async () => {
    await writeFile(join(dir, 'transcript-grave.json'), '{"archiveId":"arc-legacy"}\n', 'utf8');
    await writeFile(
      join(dir, 'lost-session-grave.json'),
      '{"projectKey":"proj","sessionId":"sess-legacy"}\n',
      'utf8',
    );
    const registry = new FsSessionRegistry(dir);

    expect(await registry.listTranscriptGraves()).toEqual([]);
    expect(await registry.listLostSessionGraves()).toEqual([]);
    expect(await registry.clearTranscriptGraveIf('arc-legacy')).toBe(false);
    expect(await registry.clearLostSessionGraveIf('sess-legacy')).toBe(false);
    await registry.addTranscriptGrave({ archiveId: 'arc-new' });
    expect(await registry.listTranscriptGraves()).toEqual([{ archiveId: 'arc-new' }]);

    expect(await registry.clear()).toBe(1);
    expect((await readdir(dir)).sort()).toEqual([
      'lost-session-grave.json',
      'transcript-grave.json',
    ]);
  });
});

describe('墓標の compare-and-set（#1157）', () => {
  it('一致すれば下ろして true', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.addTranscriptGrave({ archiveId: 'arc-1' });
    expect(await registry.clearTranscriptGraveIf('arc-1')).toBe(true);
    expect(await registry.listTranscriptGraves()).toEqual([]);
  });

  it('⛔ 入れ替わっていたら下ろさず false（新しい墓標を消さない）', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.addTranscriptGrave({ archiveId: 'arc-new' });
    expect(await registry.clearTranscriptGraveIf('arc-old')).toBe(false);
    expect(await registry.listTranscriptGraves()).toEqual([{ archiveId: 'arc-new' }]);
  });

  it('そもそも無ければ false', async () => {
    const registry = new FsSessionRegistry(dir);
    expect(await registry.clearTranscriptGraveIf('arc-1')).toBe(false);
  });

  it('捨てた回の墓標も同じ形（一致すれば下ろして true）', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.addLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-1' });
    expect(await registry.clearLostSessionGraveIf('sess-1')).toBe(true);
    expect(await registry.listLostSessionGraves()).toEqual([]);
  });

  it('⛔ 捨てた回の墓標も、入れ替わっていたら下ろさず false', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.addLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-new' });
    expect(await registry.clearLostSessionGraveIf('sess-old')).toBe(false);
    expect(await registry.listLostSessionGraves()).toEqual([
      { projectKey: 'proj', sessionId: 'sess-new' },
    ]);
  });

  describe('⛔ 墓標を立てる・下ろす書き込みは、clear…If の判定と rm の間に割り込まない（#3860）', () => {
    /** ファイルシステムへ何往復か投げて、待たされていない書き込みなら終わっているだけの時間を作る（実時間は待たない）。 */
    async function letUnlockedWritesLand(path: string): Promise<void> {
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        await stat(path).catch(() => undefined);
      }
    }

    interface Case {
      name: string;
      file: string;
      oldId: string;
      newId: string;
      add: (r: FsSessionRegistry, id: string) => Promise<unknown>;
      clear: (r: FsSessionRegistry, id: string) => Promise<unknown>;
      list: (r: FsSessionRegistry) => Promise<string[]>;
    }
    const cases: Case[] = [
      {
        name: '生ログの墓標',
        file: 'transcript-grave-queue.json',
        oldId: 'arc-old',
        newId: 'arc-new',
        add: (r, id) => r.addTranscriptGrave({ archiveId: id }),
        clear: (r, id) => r.clearTranscriptGraveIf(id),
        list: async (r) => (await r.listTranscriptGraves()).map((g) => g.archiveId),
      },
      {
        name: '捨てた回の墓標',
        file: 'lost-session-grave-queue.json',
        oldId: 'sess-old',
        newId: 'sess-new',
        add: (r, id) => r.addLostSessionGrave({ projectKey: 'proj', sessionId: id }),
        clear: (r, id) => r.clearLostSessionGraveIf(id),
        list: async (r) => (await r.listLostSessionGraves()).map((g) => g.sessionId),
      },
    ];

    for (const c of cases) {
      it(`${c.name}の add は、同じパスのロックが握られている間は書かれない`, async () => {
        const registry = new FsSessionRegistry(dir);
        const path = join(dir, c.file);
        await c.add(registry, c.oldId);

        let settled = false;
        let pending: Promise<void> = Promise.resolve();
        await withPathLock(path, async () => {
          pending = c.add(registry, c.newId).then(() => {
            settled = true;
          });
          await letUnlockedWritesLand(path);
          // ロックを握っている間（= clear の判定と書き戻しの間）は、新しい墓標が書かれていない。
          expect(settled).toBe(false);
          const raw = await readFile(path, 'utf8');
          expect(raw).toContain(c.oldId);
          expect(raw).not.toContain(c.newId);
        });
        await pending;
        expect(await c.list(registry)).toEqual([c.oldId, c.newId]);
      });

      it(`${c.name}を下ろす clear…If も、同じパスのロックが握られている間は書き戻さない`, async () => {
        const registry = new FsSessionRegistry(dir);
        const path = join(dir, c.file);
        await c.add(registry, c.oldId);

        let settled = false;
        let pending: Promise<void> = Promise.resolve();
        await withPathLock(path, async () => {
          pending = Promise.resolve(c.clear(registry, c.oldId)).then(() => {
            settled = true;
          });
          await letUnlockedWritesLand(path);
          expect(settled).toBe(false);
          expect(await readFile(path, 'utf8')).toContain(c.oldId);
        });
        await pending;
        expect(await c.list(registry)).toEqual([]);
      });
    }

    it('clear の後ろへ並んだ add の新しい墓標は、clear に消されず残る', async () => {
      const registry = new FsSessionRegistry(dir);
      await registry.addTranscriptGrave({ archiveId: 'arc-old' });
      const [lowered] = await Promise.all([
        registry.clearTranscriptGraveIf('arc-old'),
        registry.addTranscriptGrave({ archiveId: 'arc-new' }),
      ]);
      expect(lowered).toBe(true);
      expect(await registry.listTranscriptGraves()).toEqual([{ archiveId: 'arc-new' }]);
    });
  });

  it('⭐ 同じディレクトリを向いた2つのインスタンスから同時に下ろしても、下ろせるのは1つだけ', async () => {
    const a = new FsSessionRegistry(dir);
    const b = new FsSessionRegistry(dir);
    await a.addTranscriptGrave({ archiveId: 'arc-1' });
    const [ra, rb] = await Promise.all([
      a.clearTranscriptGraveIf('arc-1'),
      b.clearTranscriptGraveIf('arc-1'),
    ]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
    expect(await a.listTranscriptGraves()).toEqual([]);
  });
});

describe('FsSessionRegistry — 墓標の蒸留失敗回数（#4752）', () => {
  it('未記録なら 0、数えると増え、別の印では 1 から数え直し、kind は独立している', async () => {
    const sessions = new FsSessionRegistry(dir);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(1);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(2);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);

    // 別の印のぶんは数えていない。数えても a の回数は消えない（#4898）
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'b')).toBe(1);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);

    // もう一方の kind には触れない
    expect(await sessions.graveDistillFailures('lost_session', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('lost_session', 'b')).toBe(1);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(1);
  });

  it('古い形（1件だけの { graveId, failures }）の保存値も読め、数え足すと新しい形で書く（#4898）', async () => {
    await writeFile(
      join(dir, 'transcript-grave-distill-failures.json'),
      '{"graveId":"a","failures":2}',
      'utf8',
    );
    const sessions = new FsSessionRegistry(dir);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(2);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'b')).toBe(1);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(3);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(1);
  });

  it('墓標を下ろすと、その墓標の回数だけが消える', async () => {
    const sessions = new FsSessionRegistry(dir);
    await sessions.addTranscriptGrave({ archiveId: 'a' });
    await sessions.addTranscriptGrave({ archiveId: 'b' });
    await sessions.noteGraveDistillFailure('transcript', 'a');
    await sessions.noteGraveDistillFailure('transcript', 'b');
    await sessions.clearTranscriptGraveIf('a');
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(0);
    expect(await sessions.graveDistillFailures('transcript', 'b')).toBe(1);
  });

  it('読めない記録は 0 として扱い、投げない', async () => {
    await writeFile(join(dir, 'transcript-grave-distill-failures.json'), '{"graveId":"a', 'utf8');
    const sessions = new FsSessionRegistry(dir);
    expect(await sessions.graveDistillFailures('transcript', 'a')).toBe(0);
    expect(await sessions.noteGraveDistillFailure('transcript', 'a')).toBe(1);
  });
});

describe('FsSessionRegistry — 畳みの控え（fold-state.json）', () => {
  it('未記録なら null、置くと読み戻せ、null で消える', async () => {
    const registry = new FsSessionRegistry(dir);
    expect(await registry.getFoldState()).toBeNull();

    await registry.setFoldState('{"v":1}');
    expect(await registry.getFoldState()).toBe('{"v":1}');

    await registry.setFoldState(null);
    expect(await registry.getFoldState()).toBeNull();
  });

  it('⭐ セッション id を捨てる（setCloneSessionId(null)）と控えも消え、id を置き直すだけでは消えない', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.setCloneSessionId('sess-1');
    await registry.setFoldState('{"v":1}');

    await registry.setCloneSessionId('sess-2');
    expect(await registry.getFoldState()).toBe('{"v":1}');

    await registry.setCloneSessionId(null);
    expect(await registry.getFoldState()).toBeNull();
  });

  it('clear() は控えも消して数える', async () => {
    const registry = new FsSessionRegistry(dir);
    await registry.setCloneSessionId('sess-1');
    await registry.setFoldState('{"v":1}');

    expect(await registry.clear()).toBe(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it('千切れた JSON を読んだときは跡を残して null を返す（起動を止めない）', async () => {
    await writeFile(join(dir, 'fold-state.json'), '{"state":"abc', 'utf8');
    const registry = new FsSessionRegistry(dir);
    let value: string | null = 'sentinel';
    const lines = await captureStderr(async () => {
      value = await registry.getFoldState();
    });
    expect(value).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('畳みの控え');
  });

  it('NUL を含む値は断る', async () => {
    const registry = new FsSessionRegistry(dir);
    await expect(registry.setFoldState('a\u0000b')).rejects.toThrow();
    expect(await registry.getFoldState()).toBeNull();
  });
});
