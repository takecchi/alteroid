import {
  createCredentialService,
  createManagerPool,
  createProfileService,
  createRunnerRegistry,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import type { Db } from '@alteroid/storage-pg';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

/**
 * issue #2415。`PUT /credentials` と `PUT /profile` が、失敗した error を素の
 * `String(error)` で応答と日誌へ載せていた（鍵の値が出うる）。
 *
 * 値の出る経路は、実物の pg ストア（PGlite）で確かめてある: 表を落としておくと INSERT が
 * 落ち（NUL は #2927 で入口の断りになったので、失敗の起こし方に使えない）、drizzle の例外は `Failed query: … params: <値>` を
 * メッセージに持つ。応答と日誌に載るのは `error.name` だけ（`kindOfError`、#2396）。
 * 入力の形（サービスの検証）で断ったときの文は、値を含まないので今までどおり返す。
 *
 * ⚠️ `base.onError`（stderr に1行目を書く。issue #2415 の 3）はこの歯の対象外——
 * 全口に効く別の変更で、ここでは触っていない。
 */

const FAKE_VALUE = 'FAKE_SECRET_VALUE_2415';
/** NUL を含む値。入口で断られる（#2927）ので、ストアの失敗は起こさない。 */
const NUL_VALUE = `${FAKE_VALUE}\u0000`;
/** 実物のストアの失敗を起こす手段: 書き込み先の表を落とす（INSERT が `Failed query … params` で落ちる）。 */
async function breakCredentialsTable(db: Db): Promise<void> {
  await db.execute(sql`drop table manager_credentials`);
}
/** プロファイルの書き込み先の表を落とす（INSERT が `Failed query … params` で落ちる）。 */
async function breakProfileTable(db: Db): Promise<void> {
  await db.execute(sql`drop table env_profile_entries`);
}

function fakeCloneHost(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

async function journalText(stores: Stores): Promise<string> {
  return JSON.stringify(await stores.journal.list());
}

async function putJson(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /credentials・PUT /profile の失敗は、値の出うる String(error) を応答と日誌に載せない（issue #2415）', () => {
  beforeAll(async () => {
    await migratedTemplate();
  }, 30_000);

  let stores: Stores;
  let db: Db;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db } = await createMigratedPglite());
    stores = createPgStoresFromDb(db);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  function stderrText(): string {
    return stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('');
  }

  function credentialsApp() {
    return createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      credentials: createCredentialService({ stores, withheldEnvKeys: ['ALTEROID_DATABASE_URL'] }),
    });
  }

  function profileApp() {
    return createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      profile: createProfileService({
        stores,
        applier: {
          vessel: {} as never,
          fingerprint: () => undefined,
          env: () => ({}),
          async apply() {
            throw new Error('この歯では使わない');
          },
          async prepare() {
            return {
              ok: true,
              names: [],
              commit: async () => undefined,
              discard: async () => undefined,
            };
          },
        },
      }),
    });
  }

  it('PUT /credentials: 実物のストアの失敗（drizzle の Failed query … params）の値が、応答にも日誌にも出ない', async () => {
    const app = credentialsApp();
    await breakCredentialsTable(db);

    const response = await putJson(app, '/credentials', {
      credentials: [{ name: 'NPM_TOKEN', value: FAKE_VALUE }],
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(FAKE_VALUE);
    expect(JSON.parse(text)).toEqual({
      error: '鍵の差し替えに失敗した（Error）。詳細は値が載りうるので返さない',
    });
    expect(await journalText(stores)).not.toContain(FAKE_VALUE);
    expect(stderrText()).not.toContain(FAKE_VALUE);
    // 打ち消しの行は残り、種類（error.name）は追える
    const journal = await journalText(stores);
    expect(journal).toContain('環境変数（鍵）を差し替えられなかった');
    expect(journal).toContain('状態の変更が失敗');
  });

  it('PUT /credentials: 鍵・値の NUL と不正な名前は、入力の誤りとして 400。欄名だけを返し、値は含まない（#2927）', async () => {
    const app = credentialsApp();

    const nulValue = await putJson(app, '/credentials', {
      credentials: [{ name: 'NPM_TOKEN', value: NUL_VALUE }],
    });
    expect(nulValue.status).toBe(400);
    const nulValueBody = await nulValue.text();
    expect(nulValueBody).toContain('credential.value に NUL');
    expect(nulValueBody).not.toContain(FAKE_VALUE);

    const nulName = await putJson(app, '/credentials', {
      credentials: [{ name: `NPM_\u0000TOKEN`, value: FAKE_VALUE }],
    });
    expect(nulName.status).toBe(400);
    expect(await nulName.text()).not.toContain(FAKE_VALUE);

    expect(await journalText(stores)).not.toContain(FAKE_VALUE);
    expect(stderrText()).not.toContain(FAKE_VALUE);
    expect(await stores.credentials.list()).toEqual([]);
  });

  it('PUT /credentials: 入力の形の誤り（サービスの検証）は、今までどおり人が直せる文で 400。値は含まない', async () => {
    const app = credentialsApp();

    const withheld = await putJson(app, '/credentials', {
      credentials: [
        { name: 'NPM_TOKEN', value: FAKE_VALUE },
        { name: 'ALTEROID_DATABASE_URL', value: FAKE_VALUE },
      ],
    });
    expect(withheld.status).toBe(400);
    const withheldBody = await withheld.text();
    expect(withheldBody).toContain('ALTEROID_DATABASE_URL は子プロセスへ伏せる鍵なので');
    expect(withheldBody).not.toContain(FAKE_VALUE);

    const duplicated = await putJson(app, '/credentials', {
      credentials: [
        { name: 'NPM_TOKEN', value: FAKE_VALUE },
        { name: 'NPM_TOKEN', value: FAKE_VALUE },
      ],
    });
    expect(duplicated.status).toBe(400);
    const duplicatedBody = await duplicated.text();
    expect(duplicatedBody).toContain('NPM_TOKEN が2回渡されている');
    expect(duplicatedBody).not.toContain(FAKE_VALUE);

    // 日誌の打ち消しの行にも同じ理由が残り、値は無い
    const journal = await journalText(stores);
    expect(journal).toContain('ALTEROID_DATABASE_URL は子プロセスへ伏せる鍵なので');
    expect(journal).not.toContain(FAKE_VALUE);
  });

  it('PUT /credentials: スキーマ検証（名前の形式）の 400 も、値を返さない', async () => {
    const response = await putJson(credentialsApp(), '/credentials', {
      credentials: [{ name: 'lower_case', value: FAKE_VALUE }],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(FAKE_VALUE);
  });

  it('PUT /credentials: 対照——成功したときは今までどおり 200（指紋だけで、値は出ない）', async () => {
    const app = credentialsApp();

    const response = await putJson(app, '/credentials', {
      credentials: [{ name: 'NPM_TOKEN', value: FAKE_VALUE }],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { credentials: { name: string }[] };
    expect(body.credentials.map((entry) => entry.name)).toEqual(['NPM_TOKEN']);
    expect(JSON.stringify(body)).not.toContain(FAKE_VALUE);
    expect(await journalText(stores)).not.toContain(FAKE_VALUE);
  });

  it('PUT /profile: 実物のストアの失敗（drizzle の Failed query … params）の値が、日誌にも stderr にも応答にも出ない', async () => {
    const app = profileApp();
    await breakProfileTable(db);

    const response = await putJson(app, '/profile', {
      script: `export GH_TOKEN=${FAKE_VALUE}`,
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(FAKE_VALUE);
    const journal = await journalText(stores);
    expect(journal).not.toContain(FAKE_VALUE);
    expect(journal).toContain('実行環境プロファイルを差し替えられなかった');
    expect(journal).toContain('状態の変更が失敗');
    expect(stderrText()).not.toContain(FAKE_VALUE);
  });

  it('PUT /profile: script・行の名前の NUL は入力の誤りとして 400。欄名だけを返し、値は含まない（#2927）', async () => {
    const app = profileApp();

    const nulScript = await putJson(app, '/profile', { script: `export GH_TOKEN=${NUL_VALUE}` });
    expect(nulScript.status).toBe(400);
    const nulScriptBody = await nulScript.text();
    expect(nulScriptBody).toContain('profile.script に NUL');
    expect(nulScriptBody).not.toContain(FAKE_VALUE);

    const nulEntry = await putJson(app, '/profile/team', {
      script: `export GH_TOKEN=${NUL_VALUE}`,
      scope: 'all',
    });
    expect(nulEntry.status).toBe(400);
    expect(await nulEntry.text()).not.toContain(FAKE_VALUE);

    expect(await journalText(stores)).not.toContain(FAKE_VALUE);
    expect(stderrText()).not.toContain(FAKE_VALUE);
    expect(await stores.profile.list()).toEqual([]);
  });

  it('PUT /mcp-servers: env の値・名前の NUL は入力の誤りとして 400。欄名だけを返し、値は含まない（#2927）', async () => {
    const app = createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
    });

    const response = await putJson(app, '/mcp-servers', {
      mcpServers: { demo: { command: 'x', env: { TOKEN: NUL_VALUE } } },
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain('mcpServer.env.value に NUL');
    expect(text).not.toContain(FAKE_VALUE);
    expect(await journalText(stores)).not.toContain(FAKE_VALUE);
    expect(stderrText()).not.toContain(FAKE_VALUE);
    expect(await stores.mcpServers.read()).toBeNull();
  });

  it('PUT /profile: 対照——成功したときは今までどおり 200', async () => {
    const app = profileApp();

    const response = await putJson(app, '/profile', { script: `export GH_TOKEN=${FAKE_VALUE}` });

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(FAKE_VALUE);
    expect(await journalText(stores)).not.toContain(FAKE_VALUE);
  });
});
