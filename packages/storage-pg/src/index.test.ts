import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, seedPgWorkspace, type PgStores } from './index.js';

/**
 * pg ドライバの受け入れ確認。
 *
 * **偽物の DB では確かめたことにならない。** PGlite はインプロセスで動く実
 * PostgreSQL なので、SQL・索引・冪等性まで本番と同じ経路で通る（CI に外部 DB を
 * 要求せずに済む）。fs ドライバのテストと同じ振る舞いを、同じ IF に対して問う。
 */
let client: PGlite;
let db: Db;
let stores: PgStores;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db);
  stores = createPgStoresFromDb(db);
});

afterEach(async () => {
  await client.close();
});

describe('migrate', () => {
  it('二度通しても壊れない（起動のたびに走る）', async () => {
    await stores.persona.write('values', '# 価値観\n');
    await migrate(db);

    expect((await stores.persona.read('values'))?.content).toContain('価値観');
  });
});

describe('seedPgWorkspace', () => {
  it('記憶が空なら種を1枚だけ置く', async () => {
    expect(await seedPgWorkspace(stores)).toBe(true);
    expect(await stores.persona.list()).toHaveLength(1);
  });

  it('既にある記憶は上書きしない（人間の編集を消さない）', async () => {
    await stores.persona.write('about-me', '# 私\n\n手で書いた内容\n');

    expect(await seedPgWorkspace(stores)).toBe(false);
    expect((await stores.persona.read('about-me'))?.content).toContain('手で書いた内容');
  });
});

describe('PgPersonaStore', () => {
  it('書いて読める（記憶は Markdown のまま）', async () => {
    await stores.persona.write('values', '# 価値観\n\n速さより正しさ\n');

    const doc = await stores.persona.read('values');

    expect(doc?.title).toBe('価値観');
    expect(doc?.content).toContain('速さより正しさ');
    expect(doc?.bytes).toBeGreaterThan(0);
  });

  it('外から書き換えられた記憶が次の読み出しに反映される（受け入れ基準3）', async () => {
    await stores.persona.write('values', '# 価値観\n\nもとの内容\n');

    // CLI / HTTP API 経由で人間が書き換える、を模す（キャッシュしていれば落ちる）
    await stores.persona.write('values', '# 価値観\n\n人間が書き換えた\n');

    expect((await stores.persona.read('values'))?.content).toContain('人間が書き換えた');
    expect(await stores.persona.concat()).toContain('人間が書き換えた');
  });

  it('append は末尾に足す（fs 版と同じ形）', async () => {
    await stores.persona.write('log', '# ログ\n');
    await stores.persona.append('log', '- 追記された学び\n');

    expect((await stores.persona.read('log'))?.content).toBe('# ログ\n\n- 追記された学び\n');
  });

  it('同時に追記しても取りこぼさない（蒸留は並行して同じ文書に書く）', async () => {
    await stores.persona.write('log', '# ログ\n');

    await Promise.all([
      stores.persona.append('log', '- AAA'),
      stores.persona.append('log', '- BBB'),
      stores.persona.append('log', '- CCC'),
    ]);

    const content = (await stores.persona.read('log'))?.content ?? '';
    expect(content).toContain('AAA');
    expect(content).toContain('BBB');
    expect(content).toContain('CCC');
  });

  it('存在しない記憶は null / 経路をまたぐスラッグは拒む', async () => {
    expect(await stores.persona.read('nope')).toBeNull();
    await expect(stores.persona.write('../escape', 'x')).rejects.toThrow(/スラッグ/);
  });

  it('concat は全文書を連結する', async () => {
    await stores.persona.write('a', '# A\n\nあ\n');
    await stores.persona.write('b', '# B\n\nい\n');

    const all = await stores.persona.concat();

    expect(all).toContain('memory: a.md');
    expect(all).toContain('memory: b.md');
  });

  it('消せる', async () => {
    await stores.persona.write('tmp', '# 一時\n');
    await stores.persona.remove('tmp');

    expect(await stores.persona.read('tmp')).toBeNull();
  });
});

describe('PgJournalStore', () => {
  it('追記して新しい順に読める', async () => {
    await stores.journal.append({
      type: 'exchange',
      with: 'human',
      role: 'inbound',
      text: '最初',
    });
    await stores.journal.append({
      type: 'decision',
      decision: '自分で答えた',
      grounds: 'about-me.md にそう書いてある',
    });

    const entries = await stores.journal.list();

    expect(entries).toHaveLength(2);
    expect(entries[0]?.type).toBe('decision');
    expect(entries[1]?.type).toBe('exchange');
  });

  it('type と limit で絞れる', async () => {
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: 'a' });
    await stores.journal.append({ type: 'exchange', with: 'human', role: 'outbound', text: 'b' });
    await stores.journal.append({ type: 'decision', decision: 'd', grounds: 'g' });

    expect(await stores.journal.list({ types: ['decision'] })).toHaveLength(1);
    expect(await stores.journal.list({ limit: 2 })).toHaveLength(2);
  });

  it('since で絞れる', async () => {
    await stores.journal.append({ type: 'decision', decision: '今日の分', grounds: 'g' });

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await stores.journal.list({ since: future })).toHaveLength(0);
    expect(await stores.journal.list({ since: '2020-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('同じミリ秒に並んでも追記順が保たれる（日報が順番を失わない）', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        stores.journal.append({ type: 'exchange', with: 'human', role: 'inbound', text: `t${i}` }),
      ),
    );

    const entries = await stores.journal.list();
    expect(entries).toHaveLength(20);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(20);
  });
});

describe('PgJobStore', () => {
  it('ジョブを積んで session_id ごと読み戻せる（再起動後の resume の足がかり）', async () => {
    const now = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-1',
      managerId: 'mgr-1',
      createdAt: now,
      updatedAt: now,
      status: 'running',
      summary: '依頼',
      request: '依頼の全文',
      cwd: '/work',
      sessionId: 'sess-abc',
    });

    const [job] = await stores.jobs.listJobs();

    expect(job?.sessionId).toBe('sess-abc');
    expect(job?.status).toBe('running');
  });

  it('同じジョブ id は上書きされる', async () => {
    const now = new Date().toISOString();
    const base = {
      id: 'mgr-1',
      createdAt: now,
      updatedAt: now,
      status: 'running' as const,
      summary: 's',
    };
    await stores.jobs.putJob(base);
    await stores.jobs.putJob({ ...base, status: 'done', lastReport: '終わった' });

    const jobs = await stores.jobs.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('done');
    expect(jobs[0]?.lastReport).toBe('終わった');
  });

  it('承認待ちを積んで回答できる', async () => {
    await stores.jobs.putApproval({
      id: 'ap-1',
      createdAt: new Date().toISOString(),
      question: 'これをやってよいか',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(1);

    const approval = await stores.jobs.getApproval('ap-1');
    await stores.jobs.putApproval({
      ...(approval as NonNullable<typeof approval>),
      answeredAt: new Date().toISOString(),
      answer: 'よい',
    });

    expect(await stores.jobs.listApprovals({ pendingOnly: true })).toHaveLength(0);
    expect((await stores.jobs.getApproval('ap-1'))?.answer).toBe('よい');
  });
});

describe('PgTranscriptArchive', () => {
  it('退避して読み戻せる', async () => {
    const id = await stores.archive.archive('session-1', '{"a":1}\n');

    expect(await stores.archive.list()).toContain(id);
    expect(await stores.archive.read(id)).toBe('{"a":1}\n');
  });

  it('無い id は null', async () => {
    expect(await stores.archive.read('居ない')).toBeNull();
  });
});

describe('PgSessionRegistry', () => {
  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });
});

describe('PgSessionStore（SDK のセッション永続化）', () => {
  const key = { projectKey: 'proj', sessionId: 'sess-1' };

  it('一度も書かれていない key は null（空配列ではない）', async () => {
    expect(await stores.sessionStore.load(key)).toBeNull();
  });

  it('積んだ順に読み戻せる', async () => {
    await stores.sessionStore.append(key, [
      { type: 'user', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z' },
      { type: 'assistant', uuid: 'u2' },
    ]);
    await stores.sessionStore.append(key, [{ type: 'assistant', uuid: 'u3' }]);

    const entries = await stores.sessionStore.load(key);

    expect(entries?.map((entry) => entry.uuid)).toEqual(['u1', 'u2', 'u3']);
  });

  it('同じ uuid の再送で二重にならない（SDK は再送・再取り込みしうる）', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.append(key, [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]);

    expect((await stores.sessionStore.load(key))?.map((entry) => entry.uuid)).toEqual(['u1', 'u2']);
  });

  it('uuid の無い行（タイトル・タグ等）は畳まずに積む', async () => {
    await stores.sessionStore.append(key, [{ type: 'title' }]);
    await stores.sessionStore.append(key, [{ type: 'title' }]);

    expect(await stores.sessionStore.load(key)).toHaveLength(2);
  });

  it('中身をそのまま往復させる（アダプタは素通しの器）', async () => {
    const entry = {
      type: 'assistant',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: '日本語もそのまま' }] },
      nested: { deep: [1, 2, { ok: true }] },
    };
    await stores.sessionStore.append(key, [entry]);

    expect((await stores.sessionStore.load(key))?.[0]).toEqual(entry);
  });

  it('セッション一覧と作業者の生ログ（subpath）へ降りられる', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.append({ ...key, subpath: 'worker-1' }, [
      { type: 'user', uuid: 'w1' },
    ]);
    await stores.sessionStore.append({ projectKey: 'proj', sessionId: 'sess-2' }, [
      { type: 'user', uuid: 'x1' },
    ]);

    const listed = await stores.sessionStore.listSessions('proj');

    expect(listed.map((row) => row.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
    expect(listed.every((row) => Number.isInteger(row.mtime))).toBe(true);
    expect(await stores.sessionStore.listSubkeys(key)).toEqual(['worker-1']);
    // subpath は別のトランスクリプト。主のログに混ざらない。
    expect(await stores.sessionStore.load(key)).toHaveLength(1);
  });

  it('消せる（保持期間はアダプタの責任）', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.delete(key);

    expect(await stores.sessionStore.load(key)).toBeNull();
    expect(await stores.sessionStore.listSessions('proj')).toEqual([]);
  });
});
