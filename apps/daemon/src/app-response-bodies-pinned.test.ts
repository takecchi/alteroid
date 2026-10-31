import {
  createAuthProviderRegistry,
  createAuthService,
  createCredentialService,
  createManagerPool,
  createMcpServerService,
  createMemoryStores,
  createProfileService,
  createRunnerRegistry,
  UnreadableTaskError,
} from '@alteroid/core';
import type {
  AuthAccount,
  CloneHost,
  JournalEntry,
  OAuthProvider,
  RunnerClient,
  RunnerRegistry,
  Stores,
  Task,
} from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// `app.ts` の応答の本文・日誌の行の「文」を1字ずつ固定する（重複の整理で文が変わらないことの歯）。
// 期待値は、整理の前の `app.ts` で出た文をそのまま書き写している。

const AT = '2026-10-01T00:00:00.000Z';
const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

let stores: Stores;

function cloneHost(over: Stores): CloneHost {
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
    managers: createManagerPool({ stores: over, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function build(over: Stores = stores, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({
    clone: cloneHost(over),
    stores: over,
    token: 'test-token',
    shutdown: () => {},
    ...extra,
  });
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: AUTH,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // 時刻は実行のたびに変わるので伏せる（文を固定するのが目的）
    const text = (await response.text()).replaceAll(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<時刻>');
    return { status: response.status, body: JSON.parse(text) as unknown };
  };
  return { app, send };
}

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  createdAt: AT,
  updatedAt: AT,
  status: 'queued',
  origin: 'human',
  title: id,
  body: `${id}の本文`,
  ...overrides,
});

async function decisionLines(): Promise<{ decision: string; grounds: string }[]> {
  const rows = await stores.journal.list({ types: ['decision'], order: 'asc' });
  return rows.flatMap((row: JournalEntry) =>
    row.type === 'decision' ? [{ decision: row.decision, grounds: row.grounds }] : [],
  );
}

// 一部のメソッドだけ差し替えたストア（実体のメソッドは実体のまま呼ぶ）
function withOverrides<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, property) {
      if (typeof property === 'string' && property in overrides) return overrides[property];
      const value = Reflect.get(t, property, t) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

beforeEach(() => {
  stores = createMemoryStores();
});

describe('400 の本文（`onInvalid` の文）', () => {
  it('既定の文（where あり）', async () => {
    const { send } = build();
    expect(await send('GET', '/journal?limit=0')).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "入力の形が不正: limit",
        },
        "status": 400,
      }
    `);
  });

  it('where が空のときは `: ` を付けない', async () => {
    const { send } = build();
    await stores.tasks.add(task('t1', { status: 'done', closedAt: AT, closedBy: 'human' }));
    expect(await send('POST', '/tasks/t1/reopen', null)).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "reason の形が不正",
        },
        "status": 400,
      }
    `);
  });

  it('prefix だけが違う文（where あり）', async () => {
    const { send } = build();
    expect({
      reopen: await send('POST', '/tasks/t1/reopen', {}),
      close: await send('POST', '/tasks/t1/close', {}),
      move: await send('POST', '/tasks/t1/move', {}),
      edit: await send('PATCH', '/tasks/t1', {}),
      add: await send('POST', '/tasks', {}),
      memory: await send('PUT', '/memory/topic', {}),
      practice: await send('PUT', '/practices/topic', {}),
      mcp: await send('PUT', '/mcp-servers', {}),
      schedule: await send('POST', '/schedule', {}),
      sessionReopen: await send('POST', '/clone/session/reopen', {}),
      scheduleMinutes: await send('POST', '/schedule', {
        kind: 'k',
        request: 'r',
        spec: { type: 'every', minutes: 0 },
      }),
    }).toMatchInlineSnapshot(`
      {
        "add": {
          "body": {
            "error": "body の形が不正: title, body",
          },
          "status": 400,
        },
        "close": {
          "body": {
            "error": "status / reason の形が不正: status, reason",
          },
          "status": 400,
        },
        "edit": {
          "body": {
            "error": "title / body の形が不正",
          },
          "status": 400,
        },
        "mcp": {
          "body": {
            "error": "MCP サーバの登録の形が不正（保存していない）: mcpServers",
          },
          "status": 400,
        },
        "memory": {
          "body": {
            "error": "記憶の本文の形が不正: content",
          },
          "status": 400,
        },
        "move": {
          "body": {
            "error": "placement の形が不正: placement",
          },
          "status": 400,
        },
        "practice": {
          "body": {
            "error": "やり方の本文の形が不正: kind, title, content",
          },
          "status": 400,
        },
        "reopen": {
          "body": {
            "error": "reason の形が不正: reason",
          },
          "status": 400,
        },
        "schedule": {
          "body": {
            "error": "kind/request/spec の形が不正: kind, request, spec",
          },
          "status": 400,
        },
        "scheduleMinutes": {
          "body": {
            "error": "kind/request/spec の形が不正: spec.minutes（every の分数は 1以上525600（1年）以下の整数のみ。それより長い周期は cron 式か単発の予定で書く）",
          },
          "status": 400,
        },
        "sessionReopen": {
          "body": {
            "error": "\`confirm: true\` を伴っていないか、形が不正（セッションの開き直しは確認を必須にしてある。reason は 1〜500 字）: confirm",
          },
          "status": 400,
        },
      }
    `);
  });
});

describe('記憶・やり方の 409 / 428 の本文', () => {
  it('記憶: 書き換え・削除の 409 と、削除の 428', async () => {
    const { send } = build();
    const created = await send('PUT', '/memory/topic', { content: '最初' });
    expect(created.status).toBe(200);
    expect({
      writeWrongVersion: await send('PUT', '/memory/topic', { content: '次', ifMatch: 'x' }),
      writeExpectsNone: await send('PUT', '/memory/topic', { content: '次', ifMatch: null }),
      removeMissingVersion: await send('DELETE', '/memory/topic'),
      removeWrongVersion: await send('DELETE', '/memory/topic?ifMatch=x'),
    }).toMatchInlineSnapshot(`
      {
        "removeMissingVersion": {
          "body": {
            "current": {
              "document": {
                "bytes": 7,
                "content": "最初
      ",
                "createdAt": {
                  "at": "<時刻>",
                  "kind": "known",
                },
                "descriptionFreshness": {
                  "kind": "absent",
                },
                "frontmatter": {
                  "kind": "none",
                },
                "kind": "premise",
                "slug": "topic",
                "title": "topic",
                "updatedAt": "<時刻>",
              },
              "version": "e190555646a1b4f24e3682143290138e1f612146d010fb3024633049bf9e2329",
            },
            "error": "消す記憶の版（ifMatch）が無いので、消していません",
          },
          "status": 428,
        },
        "removeWrongVersion": {
          "body": {
            "current": {
              "document": {
                "bytes": 7,
                "content": "最初
      ",
                "createdAt": {
                  "at": "<時刻>",
                  "kind": "known",
                },
                "descriptionFreshness": {
                  "kind": "absent",
                },
                "frontmatter": {
                  "kind": "none",
                },
                "kind": "premise",
                "slug": "topic",
                "title": "topic",
                "updatedAt": "<時刻>",
              },
              "version": "e190555646a1b4f24e3682143290138e1f612146d010fb3024633049bf9e2329",
            },
            "error": "記憶が読んだ後に変わっています（消していません）",
          },
          "status": 409,
        },
        "writeExpectsNone": {
          "body": {
            "current": {
              "document": {
                "bytes": 7,
                "content": "最初
      ",
                "createdAt": {
                  "at": "<時刻>",
                  "kind": "known",
                },
                "descriptionFreshness": {
                  "kind": "absent",
                },
                "frontmatter": {
                  "kind": "none",
                },
                "kind": "premise",
                "slug": "topic",
                "title": "topic",
                "updatedAt": "<時刻>",
              },
              "version": "e190555646a1b4f24e3682143290138e1f612146d010fb3024633049bf9e2329",
            },
            "error": "記憶が読んだ後に変わっています（書き換えていません）",
          },
          "status": 409,
        },
        "writeWrongVersion": {
          "body": {
            "current": {
              "document": {
                "bytes": 7,
                "content": "最初
      ",
                "createdAt": {
                  "at": "<時刻>",
                  "kind": "known",
                },
                "descriptionFreshness": {
                  "kind": "absent",
                },
                "frontmatter": {
                  "kind": "none",
                },
                "kind": "premise",
                "slug": "topic",
                "title": "topic",
                "updatedAt": "<時刻>",
              },
              "version": "e190555646a1b4f24e3682143290138e1f612146d010fb3024633049bf9e2329",
            },
            "error": "記憶が読んだ後に変わっています（書き換えていません）",
          },
          "status": 409,
        },
      }
    `);
  });

  it('やり方: 書き換え・削除の 409 と、削除の 428', async () => {
    const { send } = build();
    const created = await send('PUT', '/practices/topic', {
      kind: 'procedure',
      title: '題',
      content: '最初',
    });
    expect(created.status).toBe(200);
    expect({
      writeWrongVersion: await send('PUT', '/practices/topic', {
        kind: 'procedure',
        title: '題',
        content: '次',
        ifMatch: 'x',
      }),
      writeExpectsNone: await send('PUT', '/practices/topic', {
        kind: 'procedure',
        title: '題',
        content: '次',
        ifMatch: null,
      }),
      removeMissingVersion: await send('DELETE', '/practices/topic'),
      removeWrongVersion: await send('DELETE', '/practices/topic?ifMatch=x'),
    }).toMatchInlineSnapshot(`
      {
        "removeMissingVersion": {
          "body": {
            "current": {
              "practice": {
                "chars": 3,
                "content": "最初
      ",
                "createdAt": "<時刻>",
                "kind": "procedure",
                "slug": "topic",
                "title": "題",
                "updatedAt": "<時刻>",
              },
              "version": "e682584a65deb008eb3535dd29c495ddfdd34fba221332adbccd415ccce8f817",
            },
            "error": "消すやり方の版（ifMatch）が無いので、消していません",
          },
          "status": 428,
        },
        "removeWrongVersion": {
          "body": {
            "current": {
              "practice": {
                "chars": 3,
                "content": "最初
      ",
                "createdAt": "<時刻>",
                "kind": "procedure",
                "slug": "topic",
                "title": "題",
                "updatedAt": "<時刻>",
              },
              "version": "e682584a65deb008eb3535dd29c495ddfdd34fba221332adbccd415ccce8f817",
            },
            "error": "やり方が読んだ後に変わっています（消していません）",
          },
          "status": 409,
        },
        "writeExpectsNone": {
          "body": {
            "current": {
              "practice": {
                "chars": 3,
                "content": "最初
      ",
                "createdAt": "<時刻>",
                "kind": "procedure",
                "slug": "topic",
                "title": "題",
                "updatedAt": "<時刻>",
              },
              "version": "e682584a65deb008eb3535dd29c495ddfdd34fba221332adbccd415ccce8f817",
            },
            "error": "やり方が読んだ後に変わっています（書き換えていません）",
          },
          "status": 409,
        },
        "writeWrongVersion": {
          "body": {
            "current": {
              "practice": {
                "chars": 3,
                "content": "最初
      ",
                "createdAt": "<時刻>",
                "kind": "procedure",
                "slug": "topic",
                "title": "題",
                "updatedAt": "<時刻>",
              },
              "version": "e682584a65deb008eb3535dd29c495ddfdd34fba221332adbccd415ccce8f817",
            },
            "error": "やり方が読んだ後に変わっています（書き換えていません）",
          },
          "status": 409,
        },
      }
    `);
  });
});

describe('task の書き込み4口（読めない行の 409 と打ち消しの日誌）', () => {
  const requests = [
    ['close', 'POST', '/tasks/h1/close', { status: 'done', reason: '理由' }],
    ['reopen', 'POST', '/tasks/h1/reopen', { reason: '理由' }],
    ['move', 'POST', '/tasks/h1/move', { placement: { kind: 'front' } }],
    ['edit', 'PATCH', '/tasks/h1', { title: '新題' }],
  ] as const;

  it('読む段で読めない: 本文だけ。日誌は書かない', async () => {
    const unreadable = withOverrides(stores.tasks, {
      get: async () => {
        throw new UnreadableTaskError('壊れた行');
      },
    });
    const { send } = build({ ...stores, tasks: unreadable });
    const out: Record<string, unknown> = {};
    for (const [name, method, path, body] of requests) out[name] = await send(method, path, body);
    expect(out).toMatchInlineSnapshot(`
      {
        "close": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、閉じていない。",
          },
          "status": 409,
        },
        "edit": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、直していない。",
          },
          "status": 409,
        },
        "move": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、動かしていない。",
          },
          "status": 409,
        },
        "reopen": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、開き直していない。",
          },
          "status": 409,
        },
      }
    `);
    expect(await decisionLines()).toEqual([]);
  });

  it('書く段で読めない: 本文と、打ち消しの日誌', async () => {
    await stores.tasks.add(task('h1', { status: 'done', closedAt: AT, closedBy: 'human' }));
    const out: Record<string, unknown> = {};
    for (const [name, method, path, body] of requests) {
      const open = task('h1');
      const row = name === 'reopen' ? task('h1', { status: 'done' }) : open;
      const throwing = new UnreadableTaskError('壊れた行');
      const failing = withOverrides(stores.tasks, {
        get: async () => row,
        setStatus: async () => {
          throw throwing;
        },
        move: async () => {
          throw throwing;
        },
        edit: async () => {
          throw throwing;
        },
      });
      const { send } = build({ ...stores, tasks: failing });
      out[name] = await send(method, path, body);
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "close": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、閉じていない。",
          },
          "status": 409,
        },
        "edit": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、直していない。",
          },
          "status": 409,
        },
        "move": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、動かしていない。",
          },
          "status": 409,
        },
        "reopen": {
          "body": {
            "error": "UnreadableTaskError: 壊れた行。読めない形のまま書き直さないので、開き直していない。",
          },
          "status": 409,
        },
      }
    `);
    expect(await decisionLines()).toMatchInlineSnapshot(`
      [
        {
          "decision": "人間が task を done（終わった）にする（h1）: 理由",
          "grounds": "人間が直接 API から閉じようとしている",
        },
        {
          "decision": "直前のtask を閉じるの行は効いていない（変えていない）。理由: task の閉じる操作が失敗した",
          "grounds": "h1 を閉じる操作。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
        {
          "decision": "人間が閉じた task を開き直す（h1）: 理由",
          "grounds": "人間が直接 API から開き直そうとしている。開き直す前の記録: 状態 done、閉じた時刻 記録なし、主体 記録なし、理由「理由の記録なし」",
        },
        {
          "decision": "直前の閉じた task を開き直すの行は効いていない（変えていない）。理由: task の開き直しが失敗した",
          "grounds": "h1 を開き直す操作。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
        {
          "decision": "人間が task を並べ替える（h1）: h1 を 先頭 へ",
          "grounds": "人間が直接 API から並べ替えようとしている",
        },
        {
          "decision": "直前のtask を並べ替えるの行は効いていない（変えていない）。理由: task の並べ替えが失敗した",
          "grounds": "h1 を動かす操作。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
        {
          "decision": "人間が task を直した（h1）: title: 編集前「h1」→ 編集後「新題」",
          "grounds": "人間が直接 API から編集した",
        },
        {
          "decision": "直前のtask を直すの行は効いていない（変えていない）。理由: task の書き直しが失敗した",
          "grounds": "h1 の編集。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
      ]
    `);
  });

  it('書く段で「行が無かった」: 打ち消しの日誌の理由の文', async () => {
    const out: Record<string, unknown> = {};
    for (const [name, method, path, body] of requests) {
      const row = name === 'reopen' ? task('h1', { status: 'done' }) : task('h1');
      const gone = withOverrides(stores.tasks, {
        get: async () => row,
        setStatus: async () => ({ kind: 'not-found' }),
        move: async () => ({ kind: 'not-found' }),
        edit: async () => ({ kind: 'not-found' }),
      });
      const { send } = build({ ...stores, tasks: gone });
      out[name] = await send(method, path, body);
    }
    expect(out).toMatchInlineSnapshot(`
      {
        "close": {
          "body": {
            "error": "not found",
          },
          "status": 404,
        },
        "edit": {
          "body": {
            "error": "not found",
          },
          "status": 404,
        },
        "move": {
          "body": {
            "error": "not found",
          },
          "status": 404,
        },
        "reopen": {
          "body": {
            "error": "not found",
          },
          "status": 404,
        },
      }
    `);
    expect(await decisionLines()).toMatchInlineSnapshot(`
      [
        {
          "decision": "人間が task を done（終わった）にする（h1）: 理由",
          "grounds": "人間が直接 API から閉じようとしている",
        },
        {
          "decision": "直前のtask を閉じるの行は効いていない（変えていない）。理由: 閉じる直前に行が無くなっていた・既にその状態だった・遷移が許されなかった",
          "grounds": "h1 を閉じる操作。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
        {
          "decision": "人間が閉じた task を開き直す（h1）: 理由",
          "grounds": "人間が直接 API から開き直そうとしている。開き直す前の記録: 状態 done、閉じた時刻 記録なし、主体 記録なし、理由「理由の記録なし」",
        },
        {
          "decision": "直前の閉じた task を開き直すの行は効いていない（変えていない）。理由: 開き直す直前に行が無くなっていた・既に閉じていなかった",
          "grounds": "h1 を開き直す操作。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
        {
          "decision": "人間が task を並べ替える（h1）: h1 を 先頭 へ",
          "grounds": "人間が直接 API から並べ替えようとしている",
        },
        {
          "decision": "直前のtask を並べ替えるの行は効いていない（変えていない）。理由: 動かせなかった（not-found）",
          "grounds": "h1 を動かす操作。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
        {
          "decision": "人間が task を直した（h1）: title: 編集前「h1」→ 編集後「新題」",
          "grounds": "人間が直接 API から編集した",
        },
        {
          "decision": "直前のtask を直すの行は効いていない（変えていない）。理由: 書く直前に行が無くなっていた・閉じていた・読んだ版と変わっていた",
          "grounds": "h1 の編集。日誌を先に書いたが、状態を変える操作が実行されなかったため打ち消す",
        },
      ]
    `);
  });
});

describe('読めない行を id で消す口（404 の本文・200 の本文）', () => {
  const PROVIDER: OAuthProvider = {
    kind: 'oauth2',
    id: 'fake',
    label: 'Fake',
    authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
    exchange: async () => ({
      subject: 'sub',
      email: 'sub@example.test',
      emailVerified: true,
      displayName: 'sub',
    }),
  };

  function appWith(removeUnreadable: (ids: readonly string[]) => Promise<unknown>) {
    const auth = withOverrides(stores.auth, { removeUnreadableAccounts: removeUnreadable });
    const over = {
      ...stores,
      auth,
      permissionGrants: withOverrides(stores.permissionGrants, { removeUnreadable }),
      integrationKeys: withOverrides(stores.integrationKeys, {
        removeUnreadableIntegrationKeys: removeUnreadable,
      }),
    } as Stores;
    return build(over, {
      auth: {
        plan: {
          enabled: true,
          providers: [PROVIDER],
          publicBaseUrl: 'http://127.0.0.1:4517',
          tokenTtlDays: 30,
          description: 'テスト',
        },
        service: createAuthService({
          store: auth,
          providers: createAuthProviderRegistry([PROVIDER]),
        }),
      },
    });
  }

  const paths = [
    '/permission-grants/unreadable/remove',
    '/integration-keys/unreadable/remove',
    '/access/unreadable/remove',
  ];

  it('知らない id: 404（件数と、確かめる口の言い方）', async () => {
    const { send } = appWith(async () => ({ kind: 'unknown', count: 2 }));
    const out: Record<string, unknown> = {};
    for (const path of paths) out[path] = await send('POST', path, { ids: ['a', 'b'] });
    expect(out).toMatchInlineSnapshot(`
      {
        "/access/unreadable/remove": {
          "body": {
            "error": "指した id のうち 2 件が、読めないアカウントの行に無い（何も消していない。id は \`GET /access\` の \`rowsUnreadable.rows[].id\`（alteroid access list）で確かめる）",
          },
          "status": 404,
        },
        "/integration-keys/unreadable/remove": {
          "body": {
            "error": "指した id のうち 2 件が、読めない連携の鍵の行に無い（何も消していない。id は \`GET /integration-keys\` の \`rowsUnreadable.rows[].id\`（alteroid integration list）で確かめる）",
          },
          "status": 404,
        },
        "/permission-grants/unreadable/remove": {
          "body": {
            "error": "指した id のうち 2 件が、読めない許可の行に無い（何も消していない。id は \`GET /permission-grants\` の \`rowsUnreadable.rows[].id\`（alteroid permission list）で確かめる）",
          },
          "status": 404,
        },
      }
    `);
  });

  it('消えた: 200（消した id と件数）', async () => {
    const { send } = appWith(async (ids) => ({ kind: 'removed', ids: [...ids] }));
    const out: Record<string, unknown> = {};
    for (const path of paths) out[path] = await send('POST', path, { ids: ['a', 'b'] });
    expect(out).toMatchInlineSnapshot(`
      {
        "/access/unreadable/remove": {
          "body": {
            "count": 2,
            "removedIds": [
              "a",
              "b",
            ],
          },
          "status": 200,
        },
        "/integration-keys/unreadable/remove": {
          "body": {
            "count": 2,
            "removedIds": [
              "a",
              "b",
            ],
          },
          "status": 200,
        },
        "/permission-grants/unreadable/remove": {
          "body": {
            "count": 2,
            "removedIds": [
              "a",
              "b",
            ],
          },
          "status": 200,
        },
      }
    `);
  });
});

describe('アクセス許可の付与の打ち消しの日誌', () => {
  const PROVIDER: OAuthProvider = {
    kind: 'oauth2',
    id: 'fake',
    label: 'Fake',
    authorizationUrl: (request) => `https://example.test/authorize?state=${request.state}`,
    exchange: async () => ({
      subject: 'sub',
      email: 'sub@example.test',
      emailVerified: true,
      displayName: 'sub',
    }),
  };
  const ACCOUNT: AuthAccount = {
    id: 'acct-1',
    displayName: '太郎',
    email: 'taro@example.test',
    createdAt: AT,
    lastLoginAt: null,
    grantedAt: null,
    grantedBy: null,
  };

  function appWith(overrides: Record<string, unknown>) {
    const auth = withOverrides(stores.auth, overrides);
    return build({ ...stores, auth } as Stores, {
      auth: {
        plan: {
          enabled: true,
          providers: [PROVIDER],
          publicBaseUrl: 'http://127.0.0.1:4517',
          tokenTtlDays: 30,
          description: 'テスト',
        },
        service: createAuthService({
          store: auth,
          providers: createAuthProviderRegistry([PROVIDER]),
        }),
      },
    });
  }

  it('状態の変更が投げた・対象が消えていた・既に許可済みだった', async () => {
    await stores.auth.putAccount(ACCOUNT);
    const out: Record<string, unknown> = {};

    const thrown = appWith({
      grantAccess: async () => {
        throw new Error('壊れた');
      },
    });
    out.thrown = await thrown.send('POST', '/access/acct-1/grant', {}).catch((e: unknown) => ({
      thrown: e instanceof Error ? e.message : String(e),
    }));

    const gone = appWith({ grantAccess: async () => ({ status: 'not_found' }) });
    out.gone = await gone.send('POST', '/access/acct-1/grant', {});

    await stores.auth.grantAccess('acct-1', '2026-01-01T00:00:00.000Z', 'account-a');
    const already = appWith({});
    out.already = await already.send('POST', '/access/acct-1/grant', {});

    expect(out).toMatchInlineSnapshot(`
      {
        "already": {
          "body": {
            "account": {
              "createdAt": "<時刻>",
              "displayName": "太郎",
              "email": "taro@example.test",
              "granted": true,
              "grantedAt": "<時刻>",
              "grantedBy": "account-a",
              "id": "acct-1",
              "identities": [],
              "lastLoginAt": null,
            },
          },
          "status": 200,
        },
        "gone": {
          "body": {
            "error": "not found",
          },
          "status": 404,
        },
        "thrown": {
          "body": {
            "error": "Internal Server Error",
          },
          "status": 500,
        },
      }
    `);
    expect(await decisionLines()).toMatchInlineSnapshot(`
      [
        {
          "decision": "アクセス許可を付与: taro@example.test (acct-1)",
          "grounds": "実行環境の持ち主による操作（alteroid access grant）",
        },
        {
          "decision": "アクセス許可を付与できなかった: taro@example.test (acct-1)",
          "grounds": "実行環境の持ち主による操作（alteroid access grant、状態の変更が失敗）",
        },
        {
          "decision": "アクセス許可を付与: taro@example.test (acct-1)",
          "grounds": "実行環境の持ち主による操作（alteroid access grant）",
        },
        {
          "decision": "アクセス許可を付与できなかった: taro@example.test (acct-1)",
          "grounds": "実行環境の持ち主による操作（alteroid access grant、対象が消えていた）",
        },
        {
          "decision": "アクセス許可を付与: taro@example.test (acct-1)",
          "grounds": "実行環境の持ち主による操作（alteroid access grant）",
        },
        {
          "decision": "アクセス許可を付与していない（既に許可済みだった）: taro@example.test (acct-1)",
          "grounds": "実行環境の持ち主による操作（alteroid access grant、account-a が 2026-01-01T00:00:00.000Z に許可済み）",
        },
      ]
    `);
  });
});

describe('runner への配布結果の日誌の文', () => {
  const okRunner = {
    runnerId: 'r-ok',
    setCredentials: async () => [],
    setMcpServers: async () => undefined,
    setProfile: async () => ({ ok: true }),
  } as unknown as RunnerClient;
  const ngRunner = {
    runnerId: 'r-ng',
    setCredentials: async () => {
      throw new Error('届かない');
    },
    setMcpServers: async () => {
      throw new Error('届かない');
    },
    setProfile: async () => ({ ok: false, error: '届かない' }),
  } as unknown as RunnerClient;
  const registryOf = (...runners: RunnerClient[]): RunnerRegistry =>
    ({ list: async () => runners }) as unknown as RunnerRegistry;

  // 配る先なし / ok と失敗の混在、のそれぞれを新しいストアで通し、日誌の `grounds` を集める
  async function collect(
    run: (runners: RunnerRegistry) => Promise<{ status: number }>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const scenarios: [string, RunnerClient[]][] = [
      ['none', []],
      ['mixed', [okRunner, ngRunner]],
    ];
    for (const [name, runners] of scenarios) {
      stores = createMemoryStores();
      const res = await run(registryOf(...runners));
      out[name] = { status: res.status, grounds: (await decisionLines()).map((l) => l.grounds) };
    }
    return out;
  }

  it('PUT /mcp-servers', async () => {
    expect(
      await collect((runners) =>
        build(stores, { mcpServers: createMcpServerService({ stores, runners }) }).send(
          'PUT',
          '/mcp-servers',
          { mcpServers: { srv: { command: 'npx' } } },
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "mixed": {
          "grounds": [
            "実行環境の持ち主による操作（PUT /mcp-servers）。前の登録: なし。値は書かない（鍵が入りうる）。",
            "実行環境の持ち主による操作（PUT /mcp-servers）。前の登録: なし。値は書かない（鍵が入りうる）。クローンの次のセッションから効く。runner への配布: r-ok=ok, r-ng=失敗（マネージャーには次に開くセッションから効く）。",
          ],
          "status": 200,
        },
        "none": {
          "grounds": [
            "実行環境の持ち主による操作（PUT /mcp-servers）。前の登録: なし。値は書かない（鍵が入りうる）。",
            "実行環境の持ち主による操作（PUT /mcp-servers）。前の登録: なし。値は書かない（鍵が入りうる）。クローンの次のセッションから効く。runner への配布: 配る先なし（マネージャーには次に開くセッションから効く）。",
          ],
          "status": 200,
        },
      }
    `);
  });

  it('PUT /credentials', async () => {
    expect(
      await collect((runners) =>
        build(stores, {
          credentials: createCredentialService({ stores, runners, withheldEnvKeys: [] }),
        }).send('PUT', '/credentials', { credentials: [{ name: 'NPM_TOKEN', value: 'v' }] }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "mixed": {
          "grounds": [
            "実行環境の持ち主による操作（PUT /credentials）。値は書かない（鍵そのものである）。",
            "実行環境の持ち主による操作（PUT /credentials）。値は書かない（鍵そのものである）。runner への配布: r-ok=ok, r-ng=失敗。",
          ],
          "status": 200,
        },
        "none": {
          "grounds": [
            "実行環境の持ち主による操作（PUT /credentials）。値は書かない（鍵そのものである）。",
            "実行環境の持ち主による操作（PUT /credentials）。値は書かない（鍵そのものである）。runner への配布: 配る先なし。",
          ],
          "status": 200,
        },
      }
    `);
  });

  it('PUT /profile/:name', async () => {
    expect(
      await collect((runners) =>
        build(stores, {
          profile: createProfileService({
            stores,
            runners,
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
        }).send('PUT', '/profile/main', { script: 'export A=1', scope: 'all' }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "mixed": {
          "grounds": [
            "実行環境の持ち主による操作（PUT /profile/:name）。値は書かない（鍵が入りうる）。",
            "実行環境の持ち主による操作（PUT /profile/:name）。値は書かない（鍵が入りうる）。クローンの次のセッションから効く。runner への配布: r-ok=ok, r-ng=失敗（マネージャー・作業者には次に開くセッションから効く）。",
          ],
          "status": 200,
        },
        "none": {
          "grounds": [
            "実行環境の持ち主による操作（PUT /profile/:name）。値は書かない（鍵が入りうる）。",
            "実行環境の持ち主による操作（PUT /profile/:name）。値は書かない（鍵が入りうる）。クローンの次のセッションから効く。runner への配布: 配る先なし（マネージャー・作業者には次に開くセッションから効く）。",
          ],
          "status": 200,
        },
      }
    `);
  });
});
