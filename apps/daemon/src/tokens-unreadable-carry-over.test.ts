import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  captureStderr,
  createCloneTools,
  createTokenPoolService,
  createTokenRotator,
  describeUnreadableTokens,
} from '@alteroid/core';
import type { CloneHost, Stores, TokenProbePort, TokenSpreadPort } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';

const BAD_TOKEN_VALUE = 'fake-secret-value-of-the-broken-row-never-print';
const GOOD_TOKEN_VALUE = 'fake-secret-value-of-the-good-row-never-print';
const NOID_TOKEN_VALUE = 'fake-secret-value-of-the-id-less-row-never-print';
const NEW_TOKEN_VALUE = 'fake-secret-value-of-the-added-row-never-print';
const BAD_TOKEN_RAW = {
  id: 'tok-bad',
  label: 'broken-label',
  value: BAD_TOKEN_VALUE,
  order: 'not-a-number',
};
const NOID_TOKEN_RAW = { label: 'no-id-label', value: NOID_TOKEN_VALUE, order: 'x' };

const AUTH = { authorization: 'Bearer test-token' };

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: {} as CloneHost['managers'],
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

async function seed(options: { withNoIdRow?: boolean } = {}) {
  const root = await makeTempDir('alteroid-test-');
  const stores = createFsStores(root);
  await stores.tokens.replace([
    { id: 'tok-good', label: 'good', value: GOOD_TOKEN_VALUE, source: 'stored', order: 0 },
  ]);
  const path = stores.paths.tokens;
  const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: unknown[] };
  raw.tokens.push(BAD_TOKEN_RAW);
  if (options.withNoIdRow === true) raw.tokens.push(NOID_TOKEN_RAW);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);
  return { stores, path };
}

function appOf(stores: Stores, journalStores: Stores = stores) {
  return createApp({
    clone: stubCloneHost(),
    stores: journalStores,
    token: 'test-token',
    shutdown: () => undefined,
    tokens: createTokenPoolService({ stores }),
  });
}

function post(path: string, body: unknown): [string, RequestInit] {
  return [
    path,
    {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ];
}

async function rawIds(path: string): Promise<unknown[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: { id?: unknown }[] };
  return raw.tokens.map((row) => row.id);
}

async function journalText(stores: Stores): Promise<string> {
  return JSON.stringify(await stores.journal.list({ limit: 100 }));
}

describe('全文置換は読めない行を持ち越す（#2354）', () => {
  it('人の PUT /tokens: 読めない行が残り、応答は「持ち越した」（carriedOver）と言う。値は出ない', async () => {
    const { stores, path } = await seed();
    const app = appOf(stores);

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request('/tokens', {
        method: 'PUT',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          tokens: [
            { id: 'tok-good', label: 'good' },
            { label: 'added', value: NEW_TOKEN_VALUE },
          ],
        }),
      });
    });

    expect(response?.status).toBe(200);
    const text = await response!.text();
    const body = JSON.parse(text) as {
      tokens: { label: string }[];
      rowsUnreadable?: { count: number; carriedOver?: boolean };
    };
    expect(body.tokens.map((t) => t.label)).toEqual(['good', 'added']);
    expect(body.rowsUnreadable).toMatchObject({ count: 1, carriedOver: true });
    for (const value of [BAD_TOKEN_VALUE, GOOD_TOKEN_VALUE, NEW_TOKEN_VALUE]) {
      expect(text).not.toContain(value);
    }
    expect(await rawIds(path)).toContain('tok-bad');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: unknown[] };
    expect(raw.tokens).toContainEqual(BAD_TOKEN_RAW);
  });

  it('回し手の書き戻し（token-rotator の replace）でも、読めない行が残る', async () => {
    const { stores, path } = await seed();
    await stores.tokens.writeActive({
      tokenId: 'tok-good',
      generation: 1,
      rotatedAt: '2026-08-25T00:00:00.000Z',
    });
    const probe: TokenProbePort = {
      async probe() {
        return { verdict: 'unusable', reason: 'probe が拒否した' };
      },
    };
    const spread: TokenSpreadPort = {
      async spread() {
        return [{ target: 'runner-primary', ok: true }];
      },
    };
    const rotator = createTokenRotator({
      stores,
      probe,
      spread,
      now: () => new Date('2026-08-25T03:00:00.000Z'),
    });

    await captureStderr(async () => {
      await rotator.observe({
        facts: { kind: 'five_hour', status: 'rejected', resetsAt: 1_800_000_000_000 },
        statusNow: 'rejected',
        observedBy: { tokenId: 'tok-good', generation: 1 },
      });
    });

    const good = (await stores.tokens.list()).find((t) => t.id === 'tok-good');
    expect(good?.cooldownUntil).toBeDefined();
    expect(await rawIds(path)).toContain('tok-bad');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: unknown[] };
    expect(raw.tokens).toContainEqual(BAD_TOKEN_RAW);
  });
});

describe('POST /tokens/unreadable/remove（#2354）', () => {
  it('id で指した行だけが消え、日誌に id と件数が残る。値は応答にも日誌にも出ない', async () => {
    const { stores, path } = await seed();
    const app = appOf(stores);

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(...post('/tokens/unreadable/remove', { ids: ['tok-bad'] }));
    });

    expect(response?.status).toBe(200);
    const text = await response!.text();
    const body = JSON.parse(text) as {
      removedIds: string[];
      tokens: { id: string }[];
      rowsUnreadable?: unknown;
    };
    expect(body.removedIds).toEqual(['tok-bad']);
    expect(body.tokens.map((t) => t.id)).toEqual(['tok-good']);
    expect('rowsUnreadable' in body).toBe(false);
    expect(await rawIds(path)).toEqual(['tok-good']);

    const journal = await journalText(stores);
    expect(journal).toContain('tok-bad');
    expect(journal).toContain('1 件');
    for (const value of [BAD_TOKEN_VALUE, GOOD_TOKEN_VALUE]) {
      expect(text).not.toContain(value);
      expect(journal).not.toContain(value);
    }
  });

  it('日誌が書けないときは、状態を変えずに失敗を返す（日誌が先）', async () => {
    const { stores, path } = await seed();
    const failing: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: async () => {
          throw new Error('journal store unavailable (test)');
        },
      },
    };
    const app = appOf(stores, failing);

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(...post('/tokens/unreadable/remove', { ids: ['tok-bad'] }));
    });

    expect(response?.status).toBe(500);
    expect(await response!.text()).not.toContain(BAD_TOKEN_VALUE);
    expect(await rawIds(path)).toEqual(['tok-good', 'tok-bad']);
    await captureStderr(async () => {
      expect((await stores.tokens.listUnreadable()).map((r) => r.id)).toEqual(['tok-bad']);
    });
  });

  it('知らない id（読めた行の id を含む）は、何も消さず・日誌も書かず 404。指した文字列は返さない', async () => {
    const { stores, path } = await seed();
    const app = appOf(stores);

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(
        ...post('/tokens/unreadable/remove', { ids: ['tok-bad', 'tok-good', 'no-such'] }),
      );
    });

    expect(response?.status).toBe(404);
    const text = await response!.text();
    expect(text).toContain('2 件');
    expect(text).not.toContain('no-such');
    expect(await rawIds(path)).toEqual(['tok-good', 'tok-bad']);
    expect(await journalText(stores)).not.toContain('tok-bad');
  });

  it('id が取れない行は、この口では消せない（id を指せないので残る）。取れる行だけが消える', async () => {
    const { stores, path } = await seed({ withNoIdRow: true });
    const app = appOf(stores);

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(...post('/tokens/unreadable/remove', { ids: ['tok-bad'] }));
    });

    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { rowsUnreadable?: { count: number } };
    expect(body.rowsUnreadable?.count).toBe(1);
    const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: unknown[] };
    expect(raw.tokens).toContainEqual(NOID_TOKEN_RAW);
    const empty = await app.request(...post('/tokens/unreadable/remove', { ids: [''] }));
    expect(empty.status).toBe(400);
  });
});

// 展開（`...`）ではメソッドが落ち、原型の継承では private が壊れる: Proxy で上書きしたメソッド以外を本物の実体へ回す。
function withTokens(stores: Stores, overrides: Partial<Stores['tokens']>): Stores {
  const tokens = new Proxy(stores.tokens, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop as keyof typeof overrides];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...stores, tokens };
}

function put(body: unknown): [string, RequestInit] {
  return [
    '/tokens',
    {
      method: 'PUT',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ];
}

describe('消した後の読み直しの失敗は、「消せなかった」と言わない（#2390）', () => {
  function rereadFailing(stores: Stores): Stores {
    const state = { removed: false };
    return withTokens(stores, {
      removeUnreadable: async (ids: readonly string[]) => {
        const result = await stores.tokens.removeUnreadable(ids);
        state.removed = true;
        return result;
      },
      listUnreadable: async () => {
        if (state.removed) throw new Error(`reread failed (test) ${BAD_TOKEN_VALUE}`);
        return stores.tokens.listUnreadable();
      },
    });
  }

  it('消した後の読み直しだけが投げる: 行は消え、日誌に打ち消しは無く「消した」が残り、応答は消したと言う。値は出ない', async () => {
    const { stores, path } = await seed();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores: rereadFailing(stores) }),
    });

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(...post('/tokens/unreadable/remove', { ids: ['tok-bad'] }));
    });

    const text = await response!.text();
    expect(response?.status).toBe(200);
    const body = JSON.parse(text) as {
      removedIds: string[];
      tokens?: unknown;
      viewUnavailable?: { reason: string };
    };
    expect(body.removedIds).toEqual(['tok-bad']);
    expect(body.tokens).toBeUndefined();
    expect(body.viewUnavailable?.reason).toContain('読み直せなかった');
    expect(await rawIds(path)).toEqual(['tok-good']);

    const journal = await journalText(stores);
    expect(journal).not.toContain('消せなかった');
    expect(journal).toContain('表示の読み直しに失敗した');
    expect(journal).toContain('消した（id: tok-bad）');
    for (const value of [BAD_TOKEN_VALUE, GOOD_TOKEN_VALUE]) {
      expect(text).not.toContain(value);
      expect(journal).not.toContain(value);
    }
  });

  it('対照: 消す呼び出しそのものが投げたときは、今までどおり打ち消しの行と 500。stderr にも応答にも日誌にも値は出ない', async () => {
    const { stores, path } = await seed();
    const failingRemove = withTokens(stores, {
      removeUnreadable: async () => {
        throw new Error(`remove failed (test) ${BAD_TOKEN_VALUE}`);
      },
    });
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores: failingRemove }),
    });

    let response: Response | undefined;
    const stderr = await captureStderr(async () => {
      response = await app.request(...post('/tokens/unreadable/remove', { ids: ['tok-bad'] }));
    });

    const text = await response!.text();
    expect(response?.status).toBe(500);
    expect(await rawIds(path)).toEqual(['tok-good', 'tok-bad']);
    const journal = await journalText(stores);
    expect(journal).toContain('読めない認証トークンの行を消せなかった');
    expect(journal).not.toContain('表示の読み直しに失敗した');
    expect(stderr.join('')).toContain('読めない認証トークンの行の削除');
    for (const value of [BAD_TOKEN_VALUE, GOOD_TOKEN_VALUE]) {
      expect(text).not.toContain(value);
      expect(stderr.join('')).not.toContain(value);
      expect(journal).not.toContain(value);
    }
  });
});

describe('PUT /tokens: 保存した後の読み直しの失敗は、「保存できなかった」と言わない（#2396）', () => {
  function rereadFailing(stores: Stores): Stores {
    const state = { saved: false };
    return withTokens(stores, {
      replace: async (...args: Parameters<Stores['tokens']['replace']>) => {
        const result = await stores.tokens.replace(...args);
        state.saved = true;
        return result;
      },
      listUnreadable: async () => {
        if (state.saved) throw new Error(`reread failed (test) ${NEW_TOKEN_VALUE}`);
        return stores.tokens.listUnreadable();
      },
    });
  }

  it('保存した後の読み直しだけが投げる: 200 と viewUnavailable。保存は済んでいる。応答にも stderr にも日誌にも値は出ない', async () => {
    const { stores, path } = await seed();
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores: rereadFailing(stores) }),
    });

    let response: Response | undefined;
    const stderr = await captureStderr(async () => {
      response = await app.request(
        ...put({
          tokens: [
            { id: 'tok-good', label: 'good' },
            { label: 'added', value: NEW_TOKEN_VALUE },
          ],
        }),
      );
    });

    const text = await response!.text();
    expect(response?.status).toBe(200);
    const body = JSON.parse(text) as { tokens?: unknown; viewUnavailable?: { reason: string } };
    expect(body.tokens).toBeUndefined();
    expect(body.viewUnavailable?.reason).toContain('読み直せなかった');
    expect(text).not.toContain('保存できなかった');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { tokens: { label?: unknown }[] };
    expect(raw.tokens.map((row) => row.label)).toEqual(['good', 'added', 'broken-label']);

    const journal = await journalText(stores);
    expect(journal).toContain('保存したが、表示の読み直しに失敗した');
    expect(journal).toContain('Error');
    for (const value of [BAD_TOKEN_VALUE, GOOD_TOKEN_VALUE, NEW_TOKEN_VALUE]) {
      expect(text).not.toContain(value);
      expect(stderr.join('')).not.toContain(value);
      expect(journal).not.toContain(value);
    }
  });

  it('日誌が書けなくても、保存した事実は変わらない: 200 と viewUnavailable（best-effort）', async () => {
    const { stores } = await seed();
    const failingJournal: Stores = {
      ...stores,
      journal: {
        ...stores.journal,
        append: async () => {
          throw new Error(`journal store unavailable (test) ${NEW_TOKEN_VALUE}`);
        },
      },
    };
    const app = createApp({
      clone: stubCloneHost(),
      stores: failingJournal,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores: rereadFailing(stores) }),
    });

    let response: Response | undefined;
    await captureStderr(async () => {
      response = await app.request(...put({ tokens: [{ id: 'tok-good', label: 'good' }] }));
    });

    expect(response?.status).toBe(200);
    expect(await response!.text()).toContain('viewUnavailable');
  });

  it('対照: 保存そのものが投げたときは、今までどおり 500（保存できなかった）。値は応答にも stderr にも出ない', async () => {
    const { stores, path } = await seed();
    const failingSave = withTokens(stores, {
      replace: async () => {
        throw new Error(`save failed (test) ${NEW_TOKEN_VALUE}`);
      },
    });
    const app = createApp({
      clone: stubCloneHost(),
      stores,
      token: 'test-token',
      shutdown: () => undefined,
      tokens: createTokenPoolService({ stores: failingSave }),
    });

    let response: Response | undefined;
    const stderr = await captureStderr(async () => {
      response = await app.request(
        ...put({
          tokens: [
            { id: 'tok-good', label: 'good' },
            { label: 'added', value: NEW_TOKEN_VALUE },
          ],
        }),
      );
    });

    const text = await response!.text();
    expect(response?.status).toBe(500);
    expect(text).toContain('保存できなかった');
    expect(text).not.toContain('viewUnavailable');
    expect(await rawIds(path)).toEqual(['tok-good', 'tok-bad']);
    expect(await journalText(stores)).not.toContain('読み直しに失敗した');
    expect(stderr.join('')).toContain('認証トークンのプール');
    for (const value of [BAD_TOKEN_VALUE, GOOD_TOKEN_VALUE, NEW_TOKEN_VALUE]) {
      expect(text).not.toContain(value);
      expect(stderr.join('')).not.toContain(value);
    }
  });
});

describe('断りの文は「持ち越す」と言い、「捨てる」と言わない（#2354）', () => {
  it('describeUnreadableTokens: 持ち越す・消す口を言う。捨てる・一緒にとは言わない。値は載せない', () => {
    const text = describeUnreadableTokens([{ id: 'tok-bad', label: 'broken-label', reason: 'x' }]);
    expect(text).toContain('持ち越す');
    expect(text).toContain('POST /tokens/unreadable/remove');
    expect(text).toContain('alteroid token remove-unreadable');
    expect(text).not.toContain('捨てる');
    expect(text).not.toContain('一緒に');
    expect(text).not.toContain('id が取れない行は');
  });

  it('describeUnreadableTokens: id が取れない行があれば、その口では消せないと言う', () => {
    const text = describeUnreadableTokens([{ reason: 'x' }]);
    expect(text).toContain('id が取れない行は、その口では消せない');
  });

  it('token_list も同じ文を出す。値は出ない', async () => {
    const { stores } = await seed();
    const tools = createCloneTools({
      stores,
      emit: () => undefined,
      conversationId: () => undefined,
      memoryCause: () => 'clone',
    });
    const found = tools.find((entry) => entry.name === 'token_list');
    if (!found) throw new Error('token_list が無い');
    let reply = '';
    await captureStderr(async () => {
      const result = await found.handler({} as never, {});
      reply = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
    });
    expect(reply).toContain('持ち越す');
    expect(reply).not.toContain('一緒に捨てる');
    expect(reply).not.toContain(BAD_TOKEN_VALUE);
    expect(reply).not.toContain(GOOD_TOKEN_VALUE);
  });
});
