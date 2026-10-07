import {
  captureStderr,
  verifyConversationReadStoreContract,
  verifyCredentialSeedOnceContract,
  verifyCredentialVaultContract,
  verifyTokenPoolContract,
  NulNotAllowedError,
  verifyMcpServerStoreContract,
  verifySessionRegistryNulContract,
  verifyProfileStoreContract,
} from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { agentTokens, sessionEntries } from './schema.js';
import { PgSessionStore } from './session-store.js';
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

describe('PgMcpServerStore', () => {
  it('器の契約（#325 段1。3実装で同じことを測る）', async () => {
    await verifyMcpServerStoreContract(stores.mcpServers);
  });

  it('migrate を2回通しても置いた登録が残る（create table if not exists が no-op）', async () => {
    await stores.mcpServers.write({ remote: { type: 'http', url: 'https://example.invalid/mcp' } });
    await migrate(db);
    expect((await stores.mcpServers.read())?.mcpServers).toEqual({
      remote: { type: 'http', url: 'https://example.invalid/mcp' },
    });
  });

  it('SQL で直接書き換えられた行も、読むときに検査する', async () => {
    await db.execute(
      sql`insert into mcp_servers (id, servers) values ('default', ${JSON.stringify({ alteroid: { command: 'x' } })}::jsonb)`,
    );
    await expect(stores.mcpServers.read()).rejects.toThrow(/alteroid/);
  });
});

describe('PgProfileStore', () => {
  it('器の契約（並び順・撒く先・巻き戻し。3実装で同じことを測る）', async () => {
    await verifyProfileStoreContract(stores.profile);
  });

  it('replaceAll は1つのトランザクションで入れ替える（途中で落ちても集合が半端に残らない）', async () => {
    await stores.profile.set('keep', 'export KEEP=1\n', 'runner');
    const before = await stores.profile.list();

    await expect(
      stores.profile.replaceAll([
        {
          name: 'dup',
          script: 'export A=1\n',
          scope: 'all',
          updatedAt: '2026-10-03T00:00:00.000Z',
        },
        {
          name: 'dup',
          script: 'export B=1\n',
          scope: 'all',
          updatedAt: '2026-10-03T00:00:00.000Z',
        },
      ]),
    ).rejects.toThrow();

    expect(await stores.profile.list()).toEqual(before);
  });

  it('列の撒く先が3語のどれでもない（SQL で直接書かれた）行は all として読む', async () => {
    await db.execute(
      sql`insert into env_profile_entries (name, script, scope) values ('hand', 'export H=1', 'runer')`,
    );

    expect(await stores.profile.list()).toMatchObject([{ name: 'hand', scope: 'all' }]);
  });

  describe('旧 env_profile からの移行', () => {
    const legacyInsert = (script: string) =>
      db.execute(
        sql`insert into env_profile (id, script, updated_at) values ('default', ${script}, '2026-09-01T00:00:00.000Z')`,
      );
    const resetToBeforeMigration = async () => {
      await db.execute(sql`delete from env_profile_entries`);
      await db.execute(sql`delete from daemon_state where key = 'env_profile_entries_migrated'`);
    };

    it('旧表の1行を、名前 default・撒く先 all・同じ updated_at で写す。旧表は残る', async () => {
      await resetToBeforeMigration();
      await legacyInsert('export OLD=1\n');

      await migrate(db);

      expect(await stores.profile.list()).toEqual([
        {
          name: 'default',
          script: 'export OLD=1\n',
          scope: 'all',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ]);
      const legacy = await client.query("select script from env_profile where id = 'default'");
      expect(legacy.rows).toHaveLength(1);
    });

    it('2周目で、移行のあとに書き換えた default を旧表の値へ戻さない（冪等）', async () => {
      await resetToBeforeMigration();
      await legacyInsert('export OLD=1\n');
      await migrate(db);
      await stores.profile.set('default', 'export NEW=1\n', 'runner');

      await migrate(db);
      await migrate(db);

      expect(await stores.profile.list()).toMatchObject([
        { name: 'default', script: 'export NEW=1\n', scope: 'runner' },
      ]);
    });

    it('2周目で、移行のあとに外した default を旧表から蘇らせない', async () => {
      await resetToBeforeMigration();
      await legacyInsert('export OLD_SECRET=1\n');
      await migrate(db);
      await stores.profile.remove('default');

      await migrate(db);

      expect(await stores.profile.list()).toEqual([]);
    });

    it('旧表が空白だけなら何も写さない（印だけ立つ）', async () => {
      await resetToBeforeMigration();
      await legacyInsert('  \n');

      await migrate(db);

      expect(await stores.profile.list()).toEqual([]);
      const marker = await client.query(
        "select value from daemon_state where key = 'env_profile_entries_migrated'",
      );
      expect(marker.rows).toHaveLength(1);
    });

    it('clear は旧表も空にする（全部外したものが、旧形式から蘇らない）', async () => {
      await resetToBeforeMigration();
      await legacyInsert('export OLD=1\n');
      await migrate(db);

      await stores.profile.clear();
      await db.execute(sql`delete from daemon_state where key = 'env_profile_entries_migrated'`);
      await migrate(db);

      expect(await stores.profile.list()).toEqual([]);
    });
  });
});

describe('PgCredentialVaultStore', () => {
  it('入口の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyCredentialVaultContract(stores.credentials);
  });

  it('seedOnce の契約（印つきの1度だけの書き込み。3実装で同じことを測る）', async () => {
    await verifyCredentialSeedOnceContract(stores.credentials);
  });

  it('往復（put → list）で値まで戻り、name 昇順で並ぶ', async () => {
    expect(await stores.credentials.list()).toEqual([]);

    const written = await stores.credentials.put([
      { name: 'NPM_TOKEN', value: 'npm_x' },
      { name: 'GIT_AUTHOR_NAME', value: 'takecchi' },
    ]);
    expect(written.map((row) => row.name)).toEqual(['GIT_AUTHOR_NAME', 'NPM_TOKEN']);
    expect(written.map((row) => row.value)).toEqual(['takecchi', 'npm_x']);

    expect(await stores.credentials.list()).toEqual(written);
  });

  it('部分更新——入力に無い名前は触らない', async () => {
    await stores.credentials.put([{ name: 'GH_TOKEN', value: 'ghp_1' }]);
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect((await stores.credentials.list()).map((row) => row.name)).toEqual([
      'GH_TOKEN',
      'NPM_TOKEN',
    ]);
  });

  it('同じ名前を置き直すと値が入れ替わる（行は増えない）', async () => {
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_old' }]);
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_new' }]);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'NPM_TOKEN', value: 'npm_new' }),
    ]);
  });

  it('空文字で外れる（器の側の「外す」と同じ約束）', async () => {
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: '' }]);

    expect(await stores.credentials.list()).toEqual([]);
  });

  it('手で入れた壊れた名前の行は、降ろす集合から外れる（器の外を指す名前を配らない）', async () => {
    await db.execute(
      sql`insert into manager_credentials (name, value) values ('../../../etc/cron.d/x', 'boom')`,
    );
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect((await stores.credentials.list()).map((row) => row.name)).toEqual(['NPM_TOKEN']);
  });

  it('scope・secret を指定して put すると、list にそのまま戻る', async () => {
    await stores.credentials.put([
      { name: 'TZ', value: 'Asia/Tokyo', scope: 'app', secret: false },
      { name: 'MANAGER_ONLY', value: 'x', scope: 'runner', secret: true },
    ]);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'MANAGER_ONLY', scope: 'runner', secret: true }),
      expect.objectContaining({ name: 'TZ', scope: 'app', secret: false }),
    ]);
  });

  it('scope・secret を省略すると all / true になる（列が無かった頃の全行と同じ既定）', async () => {
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'NPM_TOKEN', scope: 'all', secret: true }),
    ]);
  });

  it('列を書く前に直接 insert された行（旧スキーマ相当）も既定で読める', async () => {
    await db.execute(sql`insert into manager_credentials (name, value) values ('LEGACY_ROW', 'v')`);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'LEGACY_ROW', scope: 'all', secret: true }),
    ]);
  });
});

describe('PgTokenPoolStore', () => {
  it('入口の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifyTokenPoolContract(stores.tokens);
  });

  it('往復（replace → list）で値まで戻る。order 昇順で返す', async () => {
    expect(await stores.tokens.list()).toEqual([]);

    const written = await stores.tokens.replace([
      { id: 'tok-a', label: 'a', value: 'tok-aaa', order: 1 },
      { id: 'tok-b', label: 'b', value: 'tok-bbb', order: 0 },
    ]);
    expect(written.map((t) => t.id)).toEqual(['tok-b', 'tok-a']);

    const read = await stores.tokens.list();
    expect(read).toEqual([
      { id: 'tok-b', label: 'b', value: 'tok-bbb', order: 0 },
      { id: 'tok-a', label: 'a', value: 'tok-aaa', order: 1 },
    ]);
  });

  it('全文置換——1トランザクションでの delete → insert（入力に無い行は消える）', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    await stores.tokens.replace([{ id: 'tok-b', label: 'b', value: 'tok-bbb', order: 0 }]);
    expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-b']);
  });

  it('空配列で置換すると全部消える', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    await stores.tokens.replace([]);
    expect(await stores.tokens.list()).toEqual([]);
  });

  it('invalidatedAt / invalidatedReason も往復する（3つ目の状態を落とさない）', async () => {
    await stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'a',
        value: 'tok-aaa',
        order: 0,
        cooldownUntil: 12345,
        lastRejectedAt: '2026-08-01T00:00:00.000Z',
        lastRejectedReason: 'rate_limit',
        invalidatedAt: '2026-08-02T00:00:00.000Z',
        invalidatedReason: 'account_on_hold',
      },
    ]);
    const [row] = await stores.tokens.list();
    expect(row).toEqual({
      id: 'tok-a',
      label: 'a',
      value: 'tok-aaa',
      order: 0,
      cooldownUntil: 12345,
      lastRejectedAt: '2026-08-01T00:00:00.000Z',
      lastRejectedReason: 'rate_limit',
      invalidatedAt: '2026-08-02T00:00:00.000Z',
      invalidatedReason: 'account_on_hold',
    });
  });

  it('createdAt / updatedAt も往復する（Issue #393）', async () => {
    await stores.tokens.replace([
      {
        id: 'tok-a',
        label: 'a',
        value: 'tok-aaa',
        order: 0,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T03:04:05.000Z',
      },
    ]);
    const [row] = await stores.tokens.list();
    expect(row?.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(row?.updatedAt).toBe('2026-08-02T03:04:05.000Z');
  });

  it('現役の指名は、まだ無ければ null（1本目で埋めない）', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    expect(await stores.tokens.readActive()).toBeNull();
  });

  it('現役の指名は世代ごと往復する', async () => {
    const written = await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 7,
      rotatedAt: '2026-08-25T03:00:00.000Z',
    });
    expect(await stores.tokens.readActive()).toEqual(written);
  });

  it('指名し直しても高々1つのまま（2つが同時に現役だと主張しない）', async () => {
    await stores.tokens.writeActive({
      tokenId: 'tok-a',
      generation: 1,
      rotatedAt: '2026-08-25T03:00:00.000Z',
    });
    await stores.tokens.writeActive({
      tokenId: 'tok-b',
      generation: 2,
      rotatedAt: '2026-08-25T04:00:00.000Z',
    });
    expect(await stores.tokens.readActive()).toMatchObject({ tokenId: 'tok-b', generation: 2 });
  });
  it('createdAt / updatedAt が無い行は無いまま往復する（default now() で埋めない）', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    const [row] = await stores.tokens.list();
    expect(row).not.toHaveProperty('createdAt');
    expect(row).not.toHaveProperty('updatedAt');
  });

  it('過去に書かれた source: "env" の行は list() で静かに読み捨てる（クラッシュしない）', async () => {
    await db.insert(agentTokens).values([
      { id: 'env-1', label: '器の環境変数', source: 'env', order: -1 },
      { id: 'tok-a', label: 'spare', value: 'tok-aaa', order: 0 },
    ]);

    const rows = await stores.tokens.list();

    expect(rows.map((row) => row.id)).toEqual(['tok-a']);
    expect(rows[0]).not.toHaveProperty('source');
  });

  it('設定は置かれていなければ core の既定を返す', async () => {
    expect(await stores.tokens.readSettings()).toEqual({
      rotateOn: 'free_exhausted',
      cooldownMs: 5 * 60 * 60 * 1000,
    });
  });

  it('設定を書いて読み直せる（2回目は upsert）', async () => {
    await stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 111 });
    const written = await stores.tokens.writeSettings({
      rotateOn: 'overage_exhausted',
      cooldownMs: 1_000,
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(written).toEqual({
      rotateOn: 'overage_exhausted',
      cooldownMs: 1_000,
      updatedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(await stores.tokens.readSettings()).toEqual(written);
  });

  it('migrate を2回通しても壊れない（冪等）。記録済みの行を消さない', async () => {
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    await stores.tokens.writeSettings({ rotateOn: 'off', cooldownMs: 999 });

    await migrate(db);
    await migrate(db);

    expect((await stores.tokens.list()).map((t) => t.id)).toEqual(['tok-a']);
    expect((await stores.tokens.readSettings()).rotateOn).toBe('off');
  });
});

describe('PgSessionRegistry', () => {
  it('NUL の契約（issue #2927。3実装で同じことを測る）', async () => {
    await verifySessionRegistryNulContract(stores.sessions);
  });

  describe('墓標の compare-and-set（#1157）', () => {
    it('一致すれば下ろして true', async () => {
      await stores.sessions.setTranscriptGrave({ archiveId: 'arc-1' });
      expect(await stores.sessions.clearTranscriptGraveIf('arc-1')).toBe(true);
      expect(await stores.sessions.getTranscriptGrave()).toBeNull();
    });

    it('⛔ 入れ替わっていたら下ろさず false（新しい墓標を消さない）', async () => {
      await stores.sessions.setTranscriptGrave({ archiveId: 'arc-new' });
      expect(await stores.sessions.clearTranscriptGraveIf('arc-old')).toBe(false);
      expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'arc-new' });
    });

    it('そもそも無ければ false', async () => {
      expect(await stores.sessions.clearTranscriptGraveIf('arc-1')).toBe(false);
    });

    it('捨てた回の墓標も同じ形', async () => {
      await stores.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-1' });
      expect(await stores.sessions.clearLostSessionGraveIf('sess-1')).toBe(true);
      expect(await stores.sessions.getLostSessionGrave()).toBeNull();
    });

    it('⛔ 捨てた回の墓標も、入れ替わっていたら下ろさず false', async () => {
      await stores.sessions.setLostSessionGrave({ projectKey: 'proj', sessionId: 'sess-new' });
      expect(await stores.sessions.clearLostSessionGraveIf('sess-old')).toBe(false);
      expect(await stores.sessions.getLostSessionGrave()).toEqual({
        projectKey: 'proj',
        sessionId: 'sess-new',
      });
    });
  });

  it('セッション id を覚えて忘れられる', async () => {
    expect(await stores.sessions.getCloneSessionId()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    expect(await stores.sessions.getCloneSessionId()).toBe('sess-1');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
  });

  it('墓標を覚えて忘れられる。そして resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });

    await stores.sessions.setTranscriptGrave(null);
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
  });

  it('2つの墓標は互いを消さない。そして resume 素材を捨てても両方残る', async () => {
    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    await stores.sessions.setLostSessionGrave({
      projectKey: '-workspace',
      sessionId: 'sess-old',
    });

    await stores.sessions.setCloneSessionId(null);

    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });
    expect(await stores.sessions.getLostSessionGrave()).toEqual({
      projectKey: '-workspace',
      sessionId: 'sess-old',
    });

    await stores.sessions.setLostSessionGrave(null);
    expect(await stores.sessions.getLostSessionGrave()).toBeNull();
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });
    await stores.sessions.setTranscriptGrave(null);
  });

  it('生ログの scope を覚える。resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.getProjectKey()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setProjectKey('-workspace');
    expect(await stores.sessions.getProjectKey()).toBe('-workspace');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getProjectKey()).toBe('-workspace');
  });

  describe('読み出し不能の跡（#1147）', () => {
    it('行が無いときは跡を残さず null を返す（getTranscriptGrave、陰性対照）', async () => {
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await stores.sessions.getTranscriptGrave();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(0);
    });

    it('千切れた JSON の行を読んだときは跡を残して null を返す（getTranscriptGrave）', async () => {
      await db.execute(
        sql`insert into daemon_state (key, value) values ('clone_transcript_grave', '{"archiveId":"arc-1')`,
      );

      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await stores.sessions.getTranscriptGrave();
      });
      expect(value).toBeNull();
      const joined = lines.join('');
      expect(joined).toContain('生ログの墓標');
      expect(joined).toContain('読み出せませんでした');
    });

    it('JSON としては読めるがスキーマに合わない行も、跡を残して null を返す（getTranscriptGrave）', async () => {
      await db.execute(
        sql`insert into daemon_state (key, value) values ('clone_transcript_grave', '{}')`,
      );

      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await stores.sessions.getTranscriptGrave();
      });
      expect(value).toBeNull();
      expect(lines.join('')).toContain('生ログの墓標');
    });

    it('行が無いときは跡を残さず null を返す（getLostSessionGrave、陰性対照）', async () => {
      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await stores.sessions.getLostSessionGrave();
      });
      expect(value).toBeNull();
      expect(lines).toHaveLength(0);
    });

    it('千切れた JSON の行を読んだときは跡を残して null を返す（getLostSessionGrave）', async () => {
      await db.execute(
        sql`insert into daemon_state (key, value) values ('clone_lost_session', '{"projectKey":"proj-1","sessionId":"sess-1')`,
      );

      let value: unknown = 'sentinel';
      const lines = await captureStderr(async () => {
        value = await stores.sessions.getLostSessionGrave();
      });
      expect(value).toBeNull();
      const joined = lines.join('');
      expect(joined).toContain('再開素材を捨てた回の墓標');
      expect(joined).toContain('読み出せませんでした');
    });

    it('本文（値そのもの）は跡に乗らない', async () => {
      const secret = 'ghp_000000000000000000000000000000000000';
      await db.execute(
        sql`insert into daemon_state (key, value)
            values ('clone_transcript_grave', ${`{"archiveId":"${secret}`})`,
      );

      const lines = await captureStderr(async () => {
        await stores.sessions.getTranscriptGrave();
      });
      expect(lines.join('')).not.toContain(secret);
    });
  });
});

describe('PgSessionStore（SDK のセッション永続化）', () => {
  const key = { projectKey: 'proj', sessionId: 'sess-1' };

  it('一度も書かれていない key は null（空配列ではない）', async () => {
    expect(await stores.sessionStore.load(key)).toBeNull();
  });

  it('鍵列（projectKey / sessionId / subpath / uuid）の NUL は NulNotAllowedError で断り、何も積まない（issue #2927）', async () => {
    const entry = { type: 'user', uuid: 'u1', body: 'b' };
    for (const bad of [
      { projectKey: 'pro\u0000j', sessionId: 'sess-1' },
      { projectKey: 'proj', sessionId: 'sess\u0000-1' },
      { projectKey: 'proj', sessionId: 'sess-1', subpath: 'sub\u0000path' },
    ]) {
      await expect(stores.sessionStore.append(bad, [entry])).rejects.toBeInstanceOf(
        NulNotAllowedError,
      );
    }
    await expect(
      stores.sessionStore.append(key, [{ type: 'user', uuid: 'u\u00001', body: 'b' }]),
    ).rejects.toBeInstanceOf(NulNotAllowedError);
    expect(await stores.sessionStore.load(key)).toBeNull();
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u2', body: 'bo\u0000dy' }]);
    expect(await stores.sessionStore.load(key)).toEqual([
      { type: 'user', uuid: 'u2', body: 'body' },
    ]);
  });

  it('読むだけの口は、鍵列に NUL を含んでいても断らず「無い」と同じ結果を返す（issue #3011）', async () => {
    const nulKey = { projectKey: 'pro\u0000j', sessionId: 'sess-1' };
    const nulSession = { projectKey: 'proj', sessionId: 'sess\u0000-1' };
    const nulSubpath = { projectKey: 'proj', sessionId: 'sess-1', subpath: 'sub\u0000path' };
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'keep-1', body: 'b' }]);
    for (const bad of [nulKey, nulSession, nulSubpath]) {
      expect(await stores.sessionStore.load(bad)).toBeNull();
      expect(await stores.sessionStore.readTail(bad, 1_000)).toBeNull();
      expect(await stores.sessionStore.measureSize(bad)).toBeNull();
      await expect(stores.sessionStore.delete(bad)).resolves.toBeUndefined();
    }
    expect(await stores.sessionStore.listSessions('pro\u0000j')).toEqual([]);
    expect(await stores.sessionStore.listSubkeys(nulKey)).toEqual([]);
    expect(await stores.sessionStore.listSubkeys(nulSession)).toEqual([]);
    expect(await stores.sessionStore.load(key)).toEqual([
      { type: 'user', uuid: 'keep-1', body: 'b' },
    ]);
  });

  it('末尾だけを、古い順に組み直して返す', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail' };
    expect(await stores.sessionStore.readTail(tailKey, 1_000)).toBeNull();

    await stores.sessionStore.append(tailKey, [
      { type: 'user', uuid: 't1', body: 'OLDEST' },
      { type: 'assistant', uuid: 't2', body: 'MIDDLE' },
      { type: 'assistant', uuid: 't3', body: 'NEWEST' },
    ]);

    const all = await stores.sessionStore.readTail(tailKey, 10_000);
    expect(all?.split('\n')).toHaveLength(3);
    expect(all?.indexOf('OLDEST')).toBeLessThan(all?.indexOf('NEWEST') ?? -1);

    const one = await stores.sessionStore.readTail(tailKey, 1);
    expect(one?.split('\n')).toHaveLength(1);
    expect(one).toContain('NEWEST');
    expect(one).not.toContain('OLDEST');
  });

  it('境界: 積んだ量がちょうど maxChars に達する回でも、返る長さは maxChars を上回り、古い行を落とさない', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail-boundary' };
    const oldest = { type: 'user' as const, uuid: 'oldest', body: 'OLDEST-MARKER' };
    const newest = { type: 'assistant' as const, uuid: 'newest', body: '' };

    await stores.sessionStore.append(tailKey, [oldest]);
    await stores.sessionStore.append(tailKey, [newest]);

    // 期待値を `JSON.stringify` の素朴な結果にしない: pg は jsonb に積むときにキーをアルファベット順へ並べ替えるため。
    const newestLineLength = JSON.stringify({
      body: newest.body,
      type: newest.type,
      uuid: newest.uuid,
    }).length;
    const maxChars = newestLineLength + 1;

    const tail = await stores.sessionStore.readTail(tailKey, maxChars);

    expect(tail).not.toBeNull();
    expect(tail?.length ?? 0).toBeGreaterThan(maxChars);
    expect(tail).toContain('OLDEST-MARKER');
  });

  it('陰性対照: 全行の合計が maxChars 未満なら、全行を返す（境界判定を待たない）', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail-under-budget' };
    await stores.sessionStore.append(tailKey, [
      { type: 'user', uuid: 'u1', body: 'A' },
      { type: 'assistant', uuid: 'u2', body: 'B' },
      { type: 'assistant', uuid: 'u3', body: 'C' },
    ]);

    const maxChars = 10_000;
    const tail = await stores.sessionStore.readTail(tailKey, maxChars);

    expect(tail).not.toBeNull();
    expect(tail?.length ?? 0).toBeLessThan(maxChars);
    expect(tail?.split('\n')).toHaveLength(3);
    expect(tail).toContain('u1');
    expect(tail).toContain('u2');
    expect(tail).toContain('u3');
  });

  it('赤: 絵文字混じりの本文では、返る長さがコードポイント数で maxChars を上回らないことがある', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail-surrogate' };
    const oldest = { type: 'user' as const, uuid: 'oldest', body: 'OLDEST-MARKER' };
    const newest = {
      type: 'assistant' as const,
      uuid: 'newest',
      body: '\u{1F600}\u{1F600}\u{1F600}',
    };

    await stores.sessionStore.append(tailKey, [oldest]);
    await stores.sessionStore.append(tailKey, [newest]);

    const newestLine = JSON.stringify({ body: newest.body, type: newest.type, uuid: newest.uuid });
    const newestLineCodePoints = [...newestLine].length;
    const newestLineCodeUnits = newestLine.length;
    expect(newestLineCodeUnits).toBeGreaterThan(newestLineCodePoints);

    const maxChars = newestLineCodePoints + 1;
    expect(newestLineCodeUnits + 1).toBeGreaterThan(maxChars + 1);

    const tail = await stores.sessionStore.readTail(tailKey, maxChars);

    expect(tail).not.toBeNull();
    expect([...(tail ?? '')].length).toBeGreaterThan(maxChars);
    expect(tail).toContain('OLDEST-MARKER');
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
    expect(await stores.sessionStore.load(key)).toHaveLength(1);
  });

  it('消せる（保持期間はアダプタの責任）', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.delete(key);

    expect(await stores.sessionStore.load(key)).toBeNull();
    expect(await stores.sessionStore.listSessions('proj')).toEqual([]);
  });

  describe('measureSize', () => {
    it('一度も書かれていない key は0バイト（測れなかったのではなく、実測して0）', async () => {
      const neverWritten = { projectKey: 'proj', sessionId: 'sess-measure-empty' };
      expect(await stores.sessionStore.measureSize(neverWritten)).toBe(0);
    });

    it('積んだぶんだけ増える', async () => {
      const sizeKey = { projectKey: 'proj', sessionId: 'sess-measure' };
      expect(await stores.sessionStore.measureSize(sizeKey)).toBe(0);

      await stores.sessionStore.append(sizeKey, [
        { type: 'user', uuid: 'm1', body: 'x'.repeat(1_000) },
      ]);
      const afterOne = await stores.sessionStore.measureSize(sizeKey);
      expect(afterOne).not.toBeNull();
      expect(afterOne as number).toBeGreaterThan(900);

      await stores.sessionStore.append(sizeKey, [
        { type: 'assistant', uuid: 'm2', body: 'y'.repeat(2_000) },
      ]);
      const afterTwo = await stores.sessionStore.measureSize(sizeKey);
      expect(afterTwo).not.toBeNull();
      expect(afterTwo as number).toBeGreaterThan(afterOne as number);

      const raw: unknown = await db.execute(
        sql`select sum(octet_length(${sessionEntries.entry}::text)) as bytes
            from session_entries
            where project_key = ${sizeKey.projectKey}
              and session_id = ${sizeKey.sessionId}
              and subpath = ''`,
      );
      const rows = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []);
      const rawRow = rows[0] as { bytes: string | number } | undefined;
      expect(rawRow).toBeDefined();
      expect(afterTwo).toBe(Number(rawRow?.bytes));
    });

    it('subpath が違う行（作業者の生ログ）は数えない', async () => {
      const sizeKey = { projectKey: 'proj', sessionId: 'sess-measure-subpath' };
      await stores.sessionStore.append({ ...sizeKey, subpath: 'worker-1' }, [
        { type: 'user', uuid: 'w1', body: 'z'.repeat(5_000) },
      ]);

      expect(await stores.sessionStore.measureSize(sizeKey)).toBe(0);
    });

    it('撃った SQL は entry 列を octet_length(...) の中でしか参照しない', async () => {
      const sqlKey = { projectKey: 'proj', sessionId: 'sess-measure-sql' };
      await stores.sessionStore.append(sqlKey, [{ type: 'user', uuid: 'q1', body: 'hi' }]);

      const queries: string[] = [];
      const loggingDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });
      const loggedStore = new PgSessionStore(loggingDb);

      await loggedStore.measureSize(sqlKey);

      const measureQuery = queries.find((query) => query.includes('octet_length'));
      expect(measureQuery, queries.join(' | ')).toBeDefined();
      const withoutLengthCalls = measureQuery!.replace(/octet_length\([^)]*\)/gi, '');
      expect(withoutLengthCalls).not.toContain('entry');
      expect(queries.join(' | ')).not.toContain('pg_column_size');
    });

    // 本文を 1,000 バイト程度にしない: 2 KB 程度を超えないと TOAST の圧縮が起きず、差が出ないため。
    it('圧縮後の格納バイトではなく実テキストバイトを返す（pg_column_size の穴）', async () => {
      const sizeKey = { projectKey: 'proj', sessionId: 'sess-measure-compressible' };
      const body =
        '約束の台帳の手順・禁止領域について、この記録は同じ文面を繰り返す傾向がある。'.repeat(
          4_000,
        );
      await stores.sessionStore.append(sizeKey, [{ type: 'user', uuid: 'c1', body }]);

      const measured = await stores.sessionStore.measureSize(sizeKey);
      expect(measured).not.toBeNull();

      const raw: unknown = await db.execute(
        sql`select sum(pg_column_size(${sessionEntries.entry})) as stored,
                   sum(octet_length(${sessionEntries.entry}::text)) as text
            from session_entries
            where project_key = ${sizeKey.projectKey}
              and session_id = ${sizeKey.sessionId}
              and subpath = ''`,
      );
      const rows = Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? []);
      const rawRow = rows[0] as { stored: string | number; text: string | number } | undefined;
      expect(rawRow).toBeDefined();
      const storedBytes = Number(rawRow?.stored);
      const textBytes = Number(rawRow?.text);

      expect(textBytes).toBeGreaterThan(storedBytes * 10);

      expect(measured).toBe(textBytes);
      expect(measured).not.toBe(storedBytes);
    });

    it('クエリが投げたら null を返す（0 ではない・関数自体は投げない）', async () => {
      const sqlKey = { projectKey: 'proj', sessionId: 'sess-measure-broken' };
      await stores.sessionStore.append(sqlKey, [{ type: 'user', uuid: 'b1', body: 'hi' }]);
      expect(await stores.sessionStore.measureSize(sqlKey)).not.toBeNull();

      await db.execute(sql`drop table session_entries`);

      expect(await stores.sessionStore.measureSize(sqlKey)).toBeNull();
    });

    it("set_config('statement_timeout', …, true) を同じトランザクションで撃っている", async () => {
      const sqlKey = { projectKey: 'proj', sessionId: 'sess-measure-timeout' };
      await stores.sessionStore.append(sqlKey, [{ type: 'user', uuid: 't1', body: 'hi' }]);

      const queries: string[] = [];
      const loggingDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });
      await new PgSessionStore(loggingDb).measureSize(sqlKey);

      const timeoutQueries = queries.filter((query) =>
        query.includes("set_config('statement_timeout'"),
      );
      expect(timeoutQueries, queries.join(' | ')).toHaveLength(1);
      expect(timeoutQueries[0]).toContain('true');
    });
  });
});

describe('PgConversationReadStore', () => {
  it('器の契約（3実装で同じことを測る）', async () => {
    await verifyConversationReadStoreContract(stores.conversationReads);
  });

  it('migrate を2回通しても基準時刻と位置が残る（create table if not exists が no-op）', async () => {
    await stores.conversationReads.ensureBaseline('2026-10-01T00:00:00.000Z');
    await stores.conversationReads.advance('c1', '2026-10-01T00:00:01.000Z');
    await migrate(db);
    await migrate(db);
    expect(await stores.conversationReads.read()).toMatchObject({
      state: 'ok',
      baseline: '2026-10-01T00:00:00.000Z',
      positions: { c1: { readThrough: '2026-10-01T00:00:01.000Z' } },
    });
  });
});
