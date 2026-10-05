import {
  captureStderr,
  verifyMcpServerStoreContract,
  verifyProfileStoreContract,
} from '@alteroid/core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from './db.js';
import { createPgStoresFromDb, migrate, type PgStores } from './index.js';
import { agentTokens, sessionEntries } from './schema.js';
import { PgSessionStore } from './session-store.js';
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
 * 単位でファイルを分けた。ここは `PgMcpServerStore` / `PgProfileStore` /
 * `PgCredentialVaultStore` / `PgTokenPoolStore` / `PgSessionRegistry` /
 * `PgSessionStore（SDK のセッション永続化）` を持つ。**`describe` / `it` の
 * 本文・順序は1文字も変えていない**——元ファイルの対応する範囲とこのファイルを
 * 突き合わせれば同一であることが確認できる。冒頭の足場（`beforeEach` で
 * PGlite を都度立てて `migrate` する形、`afterEach` で閉じる形）も元ファイルと
 * 同じものを複製している（分岐は生まない——共有モジュールへ切り出すほどの
 * 複雑さが無かったため、各ファイルへ同じ短い足場を複製する側を選んだ）。
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

/**
 * 実行環境プロファイル。
 *
 * **`revert` は本文と更新日時を組で戻す。** ここは人間が `profile status` で見る
 * 「最後に本文を変えた時刻」であり、取り消された更新でそこが動くと、成功して
 * いない更新が最後の変更として表示される（デーモンを起こすたびに動いていたのと
 * 同じ意味の壊れ方）。**器が違っても同じ振る舞いになること**を fs / pg の両方で問う。
 */
/**
 * 人間の MCP 連携の登録（#325 段1）。**Railway ではここが唯一の置き場になる**
 * （volume が無い）。契約は3実装で同じ関数を通す（`mcp-server-contract.ts`）。
 */
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

    // 同じ名前を2行含む＝主キー違反で insert が落ちる。delete も巻き戻ること。
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

  /**
   * **旧 `env_profile`（1本の時代）からの移行**（`migrate.ts`）。旧表は消さない（巻き戻した
   * 旧デーモンが読むため）。写すのは**1度だけ**で、印は `daemon_state` に置く。
   */
  describe('旧 env_profile からの移行', () => {
    const legacyInsert = (script: string) =>
      db.execute(
        sql`insert into env_profile (id, script, updated_at) values ('default', ${script}, '2026-09-01T00:00:00.000Z')`,
      );
    /** 新しい形へ移る前の DB（印も新しい表の中身も無い）を作る。 */
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
      // 1周目と2周目のあいだに「2周目でだけ壊れる状態」を挟む: default を書き換える。
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
      // 人間が default を外した（鍵を含みうる旧本文が、次の起動で蘇ってはいけない）。
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
      // 印が無い状態（ワークスペースのリセットで daemon_state が消えた等）でもう一度通す。
      await db.execute(sql`delete from daemon_state where key = 'env_profile_entries_migrated'`);
      await migrate(db);

      expect(await stores.profile.list()).toEqual([]);
    });
  });
});

/**
 * マネージャーへ降ろす環境変数の正本（名前→値）。
 *
 * **fs / インメモリと同じ振る舞いになること**を問う。`put` は**部分更新**で、
 * 空文字は「外す」である。ここが器ごとに違うと、「片方の器でだけ他の鍵が消える」
 * という壊れ方をする。
 */
describe('PgCredentialVaultStore', () => {
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
    // **DB は人間が直接 insert できる。** 入口の検査だけに頼ると、手で入れた
    // `../../x` がそのまま runner へ降りて器の外を指す。
    await db.execute(
      sql`insert into manager_credentials (name, value) values ('../../../etc/cron.d/x', 'boom')`,
    );
    await stores.credentials.put([{ name: 'NPM_TOKEN', value: 'npm_x' }]);

    expect((await stores.credentials.list()).map((row) => row.name)).toEqual(['NPM_TOKEN']);
  });

  /**
   * 撒く先・シークレット可否（2026-09-14）。既定は `'all'` / `true`——この列が
   * 無かった頃の全行が実際にそうだったことをそのまま表す（`migrate.ts` の
   * 該当 `alter table` のコメント）。
   */
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
    // **2026-09-14 より前に書かれた行を模す。** DB の `not null default` が
    // ここで効くことを確かめる——コード側で埋め直す必要が無いこと。
    await db.execute(sql`insert into manager_credentials (name, value) values ('LEGACY_ROW', 'v')`);

    expect(await stores.credentials.list()).toEqual([
      expect.objectContaining({ name: 'LEGACY_ROW', scope: 'all', secret: true }),
    ]);
  });
});

/**
 * 認証トークンのプール（Issue #393「PR1」）。**回さない**——ここで固定するのは
 * 器の振る舞い（往復・設定の既定・トランザクションでの全文置換）だけである。
 */
describe('PgTokenPoolStore', () => {
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
    // 器の環境変数だけで走っている既定の構成と、1本目を撒いた後は別の状態である
    // （`TokenPoolStore.readActive` の doc）。埋めると、撒いていないものを
    // 撒いたことになる。
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
    // **PR1 の版が書いた行がこの形である。** 器の側が `now()` で埋めると、
    // 「いま作られた」という嘘が入る（`AgentToken.createdAt` の doc）。
    await stores.tokens.replace([{ id: 'tok-a', label: 'a', value: 'tok-aaa', order: 0 }]);
    const [row] = await stores.tokens.list();
    expect(row).not.toHaveProperty('createdAt');
    expect(row).not.toHaveProperty('updatedAt');
  });

  /**
   * **器の環境変数を指す行（`source: 'env'`）という概念は 2026-09-14 に廃止した**
   * が、`ensureEnvToken`（廃止済み）が過去に書いた行が既存の `agent_tokens` 表に
   * 残っていることがある。**そういう行は値を持たないので、そのまま domain の
   * 型（`AgentToken`）へ持ち上げると `credentialOf` が「値が無い」で投げる。**
   * ⟹ `list()` はこの行を静かに読み捨てる（他の行はそのまま返る）。
   */
  it('過去に書かれた source: "env" の行は list() で静かに読み捨てる（クラッシュしない）', async () => {
    // `replace()` は正規化された `AgentToken`（いまは `source: 'stored'` しか
    // 作れない）しか受けないので、レガシー行は drizzle で直接差し込んで再現する。
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
  /**
   * 墓標の compare-and-set（issue #1157 段2）。
   *
   * **pg はここがいちばん強い** —— `clearTranscriptGraveIf` は
   * `delete … where key = ? and value = ?` の1文なので、読みと書きの間に
   * 別の書き手が入る窓そのものが存在しない（`clearLostSessionGraveIf` は
   * 欄が2つあるので `for update` を取った1トランザクションの中で行う）。
   */
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

  /**
   * **⭐ 墓標はセッション id と別の欄に置く**（#564 E1b）。
   *
   * ここが同居していると、**resume を捨てた瞬間に墓標も消える** —— 拾い直すために
   * 立てた印が、拾う理由ができた瞬間に消える形になる（`SessionRegistry` の doc）。
   * ⟹ **`setCloneSessionId(null)` を挟んで、墓標が残ることを測る。**
   */
  it('墓標を覚えて忘れられる。そして resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setTranscriptGrave({ archiveId: 'sess-1-2026.jsonl' });
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });

    // **これが本題である。** resume 素材を捨てる操作は墓標に触らない。
    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getCloneSessionId()).toBeNull();
    expect(await stores.sessions.getTranscriptGrave()).toEqual({ archiveId: 'sess-1-2026.jsonl' });

    await stores.sessions.setTranscriptGrave(null);
    expect(await stores.sessions.getTranscriptGrave()).toBeNull();
  });

  /**
   * **⭐ 墓標は2つの欄に分かれている**（#564 E1b）。
   *
   * 文脈窓で畳む回（退避が在る）と、次の起動が開けなかった回（退避が無い）は**別々に
   * 起きる。** 1つの欄に相乗りさせると、後に立った方が前の方を消す。⟹ **両方を立てて、
   * 両方残ることを測る。**
   */
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

  /**
   * `projectKey` は**器を跨いで**要る（`SessionRegistry.getProjectKey` の doc）——
   * 墓標を立てたい回は、まさにそのプロセスで `append` が1度も来ていない回である。
   */
  it('生ログの scope を覚える。resume 素材を捨てても消えない', async () => {
    expect(await stores.sessions.getProjectKey()).toBeNull();

    await stores.sessions.setCloneSessionId('sess-1');
    await stores.sessions.setProjectKey('-workspace');
    expect(await stores.sessions.getProjectKey()).toBe('-workspace');

    await stores.sessions.setCloneSessionId(null);
    expect(await stores.sessions.getProjectKey()).toBe('-workspace');
  });

  /**
   * issue #1147: fs 側だけでなく pg 側にも「無い」と「読めなかった」の区別を
   * 入れた。**行が無い（陰性対照）**と**行は在るが読めない**を対で測る——
   * 跡が常に出る実装でも緑になる歯にしないため（`journal.list()` の同種の
   * テストと同じ組み立て。`db.execute` で `daemon_state` へ直接、API を
   * 経由しない壊れた行を差し込む）。
   */
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
      // archiveId が無い——`typeof archiveId === 'string'` に合わない。
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

  /**
   * **末尾だけを読む口**（#564 E1b。`SessionTranscriptTail`）。
   *
   * `load()` は全件を戻すので、580 MB 級のセッションでは SDK が掛けている 60 秒の
   * 予算に当たりに行く。⟹ **ここが「全件を戻さない」ことを測る。**
   */
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
    // **古い順に戻る**（生ログの JSONL と同じ並び）。
    expect(all?.indexOf('OLDEST')).toBeLessThan(all?.indexOf('NEWEST') ?? -1);

    // **足りたら止める。** 1行ぶんに満たない予算なら1行だけ返る。
    const one = await stores.sessionStore.readTail(tailKey, 1);
    expect(one?.split('\n')).toHaveLength(1);
    expect(one).toContain('NEWEST');
    expect(one).not.toContain('OLDEST');
  });

  /**
   * **境界: 積んだ量がちょうど `maxChars` に達する回でも、古い行を落とさない**
   * （#1718）。
   *
   * `readTail` を消費する唯一の呼び出し側（`clone.ts` の `#pickUpLostSession`
   * → `tailOf`）は、`transcript.length <= DISTILL_TRANSCRIPT_TAIL_CHARS` で
   * 「切り詰めが要ったか」を判定する。この判定が安全なのは、`readTail` が
   * 「本文が `maxChars` より長いときは、返す量が `maxChars` を必ず**上回る**」
   * ことを守っているときだけである（`SessionTranscriptTail.readTail` の
   * doc「契約」節。`TranscriptArchive.readTail` と同じ強さ）。
   *
   * 下は境界をちょうど突く `maxChars` を選んで確かめる（新しい行1本だけで
   * 累計がちょうど `maxChars` に達するように仕込む——修正前はここで
   * `chars` がちょうど `maxChars` に達し、返る長さが `maxChars - 1` になって
   * 古い行を黙って落としていた）。
   */
  it('境界: 積んだ量がちょうど maxChars に達する回でも、返る長さは maxChars を上回り、古い行を落とさない', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail-boundary' };
    const oldest = { type: 'user' as const, uuid: 'oldest', body: 'OLDEST-MARKER' };
    const newest = { type: 'assistant' as const, uuid: 'newest', body: '' };

    await stores.sessionStore.append(tailKey, [oldest]);
    await stores.sessionStore.append(tailKey, [newest]);

    // pg は jsonb に積むときにキーをアルファベット順へ並べ替えるので、期待値も
    // `JSON.stringify` の素朴な結果ではなくキー順を揃えて計算する。
    const newestLineLength = JSON.stringify({
      body: newest.body,
      type: newest.type,
      uuid: newest.uuid,
    }).length;
    // 新しい行1本だけで累計がちょうど maxChars に達する値を選ぶ
    // （`chars += line.length + 1` が `maxChars` ちょうどになる）。
    const maxChars = newestLineLength + 1;

    const tail = await stores.sessionStore.readTail(tailKey, maxChars);

    // 本文（oldest + newest の全量）は maxChars よりずっと長いので、返る量は
    // maxChars を厳密に上回り、かつ古い行を落としていないこと。
    expect(tail).not.toBeNull();
    expect(tail?.length ?? 0).toBeGreaterThan(maxChars);
    expect(tail).toContain('OLDEST-MARKER');
  });

  /**
   * **陰性対照: 全行の合計（区切り込み）が `maxChars` 未満なら、境界判定を
   * 待たずに全行を返す。**
   *
   * 上のテストは「境界ちょうどで止まりすぎない」ことだけを見ているので、
   * 逆向き（止めるべきときに止まらず、際限なく行を足し続ける）が壊れて
   * いないことは別に測る必要がある——`chars > maxChars + 1` は「まだ足りない
   * ときは足す」を変えていないはずだが、それは実装を読んだ判断であって
   * 測ってはいない。ここで測る。
   */
  it('陰性対照: 全行の合計が maxChars 未満なら、全行を返す（境界判定を待たない）', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail-under-budget' };
    await stores.sessionStore.append(tailKey, [
      { type: 'user', uuid: 'u1', body: 'A' },
      { type: 'assistant', uuid: 'u2', body: 'B' },
      { type: 'assistant', uuid: 'u3', body: 'C' },
    ]);

    // 予算を大きく取り、合計が maxChars に遠く及ばないことを確かめたうえで呼ぶ。
    const maxChars = 10_000;
    const tail = await stores.sessionStore.readTail(tailKey, maxChars);

    expect(tail).not.toBeNull();
    expect(tail?.length ?? 0).toBeLessThan(maxChars);
    expect(tail?.split('\n')).toHaveLength(3);
    expect(tail).toContain('u1');
    expect(tail).toContain('u2');
    expect(tail).toContain('u3');
  });

  /**
   * **絵文字混じりの本文で、契約（`maxChars` を厳密に上回る）が破れる**（issue
   * #1849。`SessionTranscriptTail.readTail` の doc「契約」節）。
   *
   * この実装は `line.length + 1` を UTF-16 コード単位で積んでいる。補助面の
   * 文字（絵文字の多く）は1コードポイントが2コード単位になるため、
   * **コード単位で数えた `chars` が `maxChars + 1` を超えても、実際の
   * コードポイント数はそれより少ないことがある。** そのときこの実装は
   * 「もう十分」と誤判定して古い行を落とすが、返した本文自体は
   * コードポイント数で見ると `maxChars` を超えていない——呼び出し側
   * （`clone.ts` の `tailOf` → `tailByCodePoints`）はコードポイント数で
   * 「切り詰めが要ったか」を判定するので、この食い違いは「本文がもとから
   * 短かった」と誤読され、古い行（`OLDEST-MARKER`）が静かに消える
   * （`TranscriptArchive.readTail` の doc「⚠️ …あちらは JS の `.length`
   * （UTF-16 コード単位）で `maxChars` を数えたままである」がまさにこの穴）。
   */
  it('赤: 絵文字混じりの本文では、返る長さがコードポイント数で maxChars を上回らないことがある', async () => {
    const tailKey = { projectKey: 'proj', sessionId: 'sess-tail-surrogate' };
    const oldest = { type: 'user' as const, uuid: 'oldest', body: 'OLDEST-MARKER' };
    // 絵文字3つ（それぞれ1コードポイント＝2 UTF-16 コード単位）。
    const newest = {
      type: 'assistant' as const,
      uuid: 'newest',
      body: '\u{1F600}\u{1F600}\u{1F600}',
    };

    await stores.sessionStore.append(tailKey, [oldest]);
    await stores.sessionStore.append(tailKey, [newest]);

    // pg は jsonb に積むときにキーをアルファベット順へ並べ替える（既存の境界
    // テストと同じ注意）。
    const newestLine = JSON.stringify({ body: newest.body, type: newest.type, uuid: newest.uuid });
    const newestLineCodePoints = [...newestLine].length;
    const newestLineCodeUnits = newestLine.length;
    // 絵文字3つぶん、コード単位のほうがコードポイントより大きいことを
    // 前提として確かめておく（この差が無ければ、この赤は再現しない）。
    expect(newestLineCodeUnits).toBeGreaterThan(newestLineCodePoints);

    // newest 1行だけの「コードポイント数」はこの maxChars を超えないが、
    // 「UTF-16 コード単位数」は超える値を選ぶ。
    const maxChars = newestLineCodePoints + 1;
    expect(newestLineCodeUnits + 1).toBeGreaterThan(maxChars + 1);

    const tail = await stores.sessionStore.readTail(tailKey, maxChars);

    expect(tail).not.toBeNull();
    // 契約: 本文（oldest + newest）は maxChars よりずっと長いので、返る量は
    // **コードポイント数で** maxChars を厳密に上回ること。
    expect([...(tail ?? '')].length).toBeGreaterThan(maxChars);
    // 古い行を落としていないこと。
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
    // subpath は別のトランスクリプト。主のログに混ざらない。
    expect(await stores.sessionStore.load(key)).toHaveLength(1);
  });

  it('消せる（保持期間はアダプタの責任）', async () => {
    await stores.sessionStore.append(key, [{ type: 'user', uuid: 'u1' }]);
    await stores.sessionStore.delete(key);

    expect(await stores.sessionStore.load(key)).toBeNull();
    expect(await stores.sessionStore.listSessions('proj')).toEqual([]);
  });

  /**
   * **大きさを測る口**（#1283 の OOM、段1。`SessionTranscriptTail.measureSize`）。
   *
   * `load()` を呼ぶ前にこれで大きさを確かめ、大きすぎたら resume しない
   * （`clone.ts` の `#resumeCandidateWithinBudget`）。**測れないときは `null`
   * ——`0` は「測って0バイトだった（行が無い）」という実測である**
   * （`measureSize` の doc）。
   */
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
      // **測れなかった（`null`）ことと取り違えない**——ここから先は数値として扱う。
      expect(afterOne).not.toBeNull();
      // pg_column_size は行のオーバーヘッドも含むので、本文の 1,000 バイト
      // ちょうどにはならない——**900 バイトを大きく超えていること**で
      // 「本当に測っている」ことだけを見る（正確な一致は実装詳細）。
      expect(afterOne as number).toBeGreaterThan(900);

      await stores.sessionStore.append(sizeKey, [
        { type: 'assistant', uuid: 'm2', body: 'y'.repeat(2_000) },
      ]);
      const afterTwo = await stores.sessionStore.measureSize(sizeKey);
      expect(afterTwo).not.toBeNull();
      expect(afterTwo as number).toBeGreaterThan(afterOne as number);

      // **独立した経路で検算する**（実装と同じ関数を呼び直すのではなく、
      // 生の SQL をここでもう一度書いて突き合わせる）。`db.execute` の戻りは
      // ドライバで形が違う（`commitments.ts` の doc「node-postgres は
      // `{ rows }`、他は配列そのもの」）ので、ここでも同じ読み方をする
      // （`migrate.test.ts` の `indexExists` と同じ形）。
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

      // 主トランスクリプト（subpath 省略＝空文字）には1行も無い。
      expect(await stores.sessionStore.measureSize(sizeKey)).toBe(0);
    });

    /**
     * **本文（`entry`）を SELECT していないことを、撃った SQL そのもので見る。**
     * `octet_length(entry::text)` の中でしか `entry` 列に触れていなければ、
     * 本文が Node のメモリへ載ることはない——PostgreSQL 側では伸長するが、
     * **Node 側が受け取るのは長さを表す1つの数値だけ**である
     * （`footprint.ts` の「契約」節と同じ理由）。
     */
    it('撃った SQL は entry 列を octet_length(...) の中でしか参照しない', async () => {
      const sqlKey = { projectKey: 'proj', sessionId: 'sess-measure-sql' };
      await stores.sessionStore.append(sqlKey, [{ type: 'user', uuid: 'q1', body: 'hi' }]);

      const queries: string[] = [];
      const loggingDb = client.withLogger({ logQuery: (query: string) => queries.push(query) });
      const loggedStore = new PgSessionStore(loggingDb);

      await loggedStore.measureSize(sqlKey);

      const measureQuery = queries.find((query) => query.includes('octet_length'));
      expect(measureQuery, queries.join(' | ')).toBeDefined();
      // octet_length(...) の呼び出しを取り除いた残りに "entry" が無ければ、
      // 素の列参照（本文の SELECT）は存在しない。
      const withoutLengthCalls = measureQuery!.replace(/octet_length\([^)]*\)/gi, '');
      expect(withoutLengthCalls).not.toContain('entry');
      // **格納バイトはもう見ていない**（圧縮後の値を予算と比べていたのが穴だった）。
      expect(queries.join(' | ')).not.toContain('pg_column_size');
    });

    /**
     * 🔴 **この describe の中心の歯**（#1283 の続き。`pg_column_size` の穴）。
     *
     * `pg_column_size` は**圧縮後の格納バイト**を返す。予算
     * （`clone.ts` の `RESUME_SIZE_BUDGET_BYTES`）の側は初めから**実テキスト**
     * の量として導かれている（doc 逐語「安全に読める生テキストの上限 ≈
     * 2 GiB ÷ 4 ＝ 512 MiB」）⟹ 圧縮後のバイトをその予算と比べると、
     * **いちばん圧縮の効く（＝いちばん大きい）セッションをいちばん小さく
     * 見積もる。**
     *
     * ⚠️ **本文が 2 KB 程度を超えていないと圧縮そのものが起きない**（TOAST は
     * 行が閾値を超えて初めて働く）。だから上の「積んだぶんだけ増える」の
     * 1,000 バイトでは差が出ない——**圧縮が実際に効く大きさ**で固定する必要が
     * ある。`footprint.test.ts` の `compressiblePhrase` と同じ本文・同じ理由。
     */
    it('圧縮後の格納バイトではなく実テキストバイトを返す（pg_column_size の穴）', async () => {
      const sizeKey = { projectKey: 'proj', sessionId: 'sess-measure-compressible' };
      // alteroid が実際に貯めている本文の形（同じ文面の繰り返し）に寄せる。
      const body =
        '約束の台帳の手順・禁止領域について、この記録は同じ文面を繰り返す傾向がある。'.repeat(
          4_000,
        );
      await stores.sessionStore.append(sizeKey, [{ type: 'user', uuid: 'c1', body }]);

      const measured = await stores.sessionStore.measureSize(sizeKey);
      expect(measured).not.toBeNull();

      // **同じ行を両方の式で測り、実装がどちらを返しているかを決める。**
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

      // まずこの本文で圧縮が**実際に効いている**ことを確かめる——効いていなければ
      // 下の判定は何も区別しない（実測は約85倍。余裕を持たせて10倍で固定する
      // ——`footprint.test.ts` の同じ歯と同じ数字）。
      expect(textBytes).toBeGreaterThan(storedBytes * 10);

      // ⟹ 返っているのは**実テキストバイトの側**である。
      expect(measured).toBe(textBytes);
      expect(measured).not.toBe(storedBytes);
    });

    /**
     * **測れなかったら `null`。`0` ではない**（`measureSize` の doc、AGENTS.md
     * 地雷表「取れない軸に 0 の行を作る」）。`0` は「実測して0バイトだった」
     * という別の事実である。
     *
     * `statement_timeout` による打ち切りも、この関数にとっては「クエリが投げた」
     * という同じ事実でしかない——catch の経路は共通なので、このテストが
     * 「原因を問わず `null` に倒れる」ことを代表して固定する
     * （`footprint.test.ts` が `drop table` で同じ代表をしているのと同じ形。
     * ⚠️ PGlite は `statement_timeout` で実際には打ち切らないことが実測されて
     * いる（`footprint.test.ts` の doc）ので、打ち切りそのものはここでは
     * 起こせない）。
     */
    it('クエリが投げたら null を返す（0 ではない・関数自体は投げない）', async () => {
      const sqlKey = { projectKey: 'proj', sessionId: 'sess-measure-broken' };
      await stores.sessionStore.append(sqlKey, [{ type: 'user', uuid: 'b1', body: 'hi' }]);
      expect(await stores.sessionStore.measureSize(sqlKey)).not.toBeNull();

      await db.execute(sql`drop table session_entries`);

      expect(await stores.sessionStore.measureSize(sqlKey)).toBeNull();
    });

    /**
     * **`statement_timeout` をこのトランザクションだけに掛けている**
     * （`set_config(..., true)` ＝ `SET LOCAL` 相当。接続プールへ漏れない）。
     *
     * `octet_length(entry::text)` は `pg_column_size` と違って本文を実際に
     * 展開する ⟹ **OOM を避けるための計測が、避けたいはずの重い読みを
     * 起こしかねない。** `footprint.ts` と同じ形で上限を掛ける。
     */
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
      // 第3引数 `is_local` が `true` ＝ トランザクションを抜ければ既定へ戻る。
      expect(timeoutQueries[0]).toContain('true');
    });
  });
});
