import {
  createMemoryStores,
  failingJournalAppend,
  PluginFetchError,
  type ApplyPluginsResult,
  type CloneHost,
  type FetchedPlugin,
  type PluginDistributionService,
  type PluginFetcher,
  type Stores,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

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

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const encoder = new TextEncoder();
const SECRET_BODY = 'ここは本文でありジャーナルに書いてはいけない文字列';

function fetchedPlugin(overrides: Partial<FetchedPlugin> = {}, body = SECRET_BODY): FetchedPlugin {
  return {
    name: 'demo',
    description: '説明',
    source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA },
    files: [
      {
        path: '.claude-plugin/plugin.json',
        executable: false,
        content: encoder.encode('{"name":"demo"}'),
      },
      {
        path: 'skills/a/SKILL.md',
        executable: false,
        content: encoder.encode(`---\nname: a\n---\n${body}`),
      },
    ],
    skipped: [],
    ...overrides,
  };
}

function harness(
  options: {
    stores?: Stores;
    fetch?: PluginFetcher['fetch'];
    withFetcher?: boolean;
    distribution?: PluginDistributionService;
    now?: () => number;
  } = {},
) {
  const stores = options.stores ?? createMemoryStores();
  const calls: unknown[] = [];
  const fetcher: PluginFetcher = {
    fetch:
      options.fetch ??
      (async (request) => {
        calls.push(request);
        return fetchedPlugin();
      }),
  };
  const app = createApp({
    clone: stubCloneHost(),
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    ...(options.withFetcher === false ? {} : { pluginFetcher: fetcher }),
    ...(options.distribution === undefined ? {} : { pluginDistribution: options.distribution }),
    ...(options.now === undefined ? {} : { pluginPreviewNow: options.now }),
  });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, stores, calls, send };
}

async function preview(h: ReturnType<typeof harness>, body: unknown = urlRequest()) {
  const response = await h.send('POST', '/plugins/preview', body);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text) as {
    previewId: string;
    expiresAt: string;
    summary: Record<string, unknown> & { name: string; sha: string };
  };
}

function urlRequest() {
  return { kind: 'url', url: 'https://example.invalid/r.git' };
}

function recordingDistribution(stores: Stores) {
  const log: string[] = [];
  const service: PluginDistributionService = {
    apply: async (): Promise<ApplyPluginsResult> => {
      const names = (await stores.plugins.list()).map((p) => p.name);
      log.push(`apply:${names.join(',')}`);
      return { names, runners: [{ runnerId: 'r1', ok: true }] };
    },
    syncRunner: async () => null,
  };
  return { log, service };
}

describe('GET /plugins', () => {
  it('空なら空。入れたものは files を含めずに返す', async () => {
    const h = harness();
    const empty = await h.send('GET', '/plugins');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ plugins: [] });

    const p = await preview(h);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(200);
    const text = await (await h.send('GET', '/plugins')).text();
    const body = JSON.parse(text) as { plugins: Record<string, unknown>[] };
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]).toMatchObject({
      name: 'demo',
      scope: 'all',
      enableHooks: false,
      enableMcp: false,
      fileCount: 2,
    });
    expect(body.plugins[0]).not.toHaveProperty('files');
    expect(text).not.toContain(SECRET_BODY);
  });

  it('入れるときに保存した説明を載せる。応答（POST /plugins）にも載る', async () => {
    const h = harness();
    const p = await preview(h);
    const installed = await h.send('POST', '/plugins', { previewId: p.previewId });
    const installedBody = (await installed.json()) as { plugin: Record<string, unknown> };
    expect(installedBody.plugin.description).toBe('説明');
    const body = (await (await h.send('GET', '/plugins')).json()) as {
      plugins: Record<string, unknown>[];
    };
    expect(body.plugins[0]?.description).toBe('説明');
  });

  it('説明が無い plugin は description の欄ごと無い', async () => {
    const h = harness({
      fetch: async () => {
        const { description: _omit, ...rest } = fetchedPlugin();
        return rest;
      },
    });
    const p = await preview(h);
    await h.send('POST', '/plugins', { previewId: p.previewId });
    const body = (await (await h.send('GET', '/plugins')).json()) as {
      plugins: Record<string, unknown>[];
    };
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]).not.toHaveProperty('description');
  });

  it('制御文字・長すぎる説明は整えて保存する（入れられなくならない）', async () => {
    const h = harness({
      fetch: async () =>
        fetchedPlugin({ description: `  一行目\n二行目\u0000${'x'.repeat(3000)}` }),
    });
    const p = await preview(h);
    const response = await h.send('POST', '/plugins', { previewId: p.previewId });
    expect(response.status).toBe(200);
    const stored = await h.stores.plugins.get('demo');
    expect(stored?.description?.startsWith('一行目 二行目 xxx')).toBe(true);
    expect(stored?.description?.length).toBe(1024);
  });

  it('整えて空になる説明は保存しない', async () => {
    const h = harness({ fetch: async () => fetchedPlugin({ description: ' \n\t' }) });
    const p = await preview(h);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(200);
    expect(await h.stores.plugins.get('demo')).not.toHaveProperty('description');
  });

  it('説明を持たない既存の行（古い保存）も一覧に出る', async () => {
    const stores = createMemoryStores();
    await stores.plugins.put({
      name: 'old',
      source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA },
      files: [{ path: 'a.txt', executable: false, content: encoder.encode('a') }],
      installedAt: '2026-10-01T00:00:00.000Z',
      installedBy: 'someone',
    });
    const h = harness({ stores });
    const body = (await (await h.send('GET', '/plugins')).json()) as {
      plugins: Record<string, unknown>[];
    };
    expect(body.plugins.map((x) => x.name)).toEqual(['old']);
    expect(body.plugins[0]).not.toHaveProperty('description');
  });
});

describe('POST /plugins/preview', () => {
  it('取って要約を返す。previewId と期限つき。まだ保存しない', async () => {
    const h = harness();
    const p = await preview(h);
    expect(p.previewId.length).toBeGreaterThanOrEqual(20);
    expect(Number.isNaN(Date.parse(p.expiresAt))).toBe(false);
    expect(p.summary).toMatchObject({
      name: 'demo',
      sha: SHA,
      counts: { skills: 1, agents: 0, commands: 0 },
      fileCount: 2,
    });
    expect(JSON.stringify(p.summary)).toContain(SECRET_BODY);
    expect(await h.stores.plugins.list()).toEqual([]);
    expect(h.calls).toEqual([{ kind: 'url', url: 'https://example.invalid/r.git' }]);
  });

  it('marketplace 名でも取れる。sha を添えるのは拒む', async () => {
    const h = harness();
    await preview(h, { kind: 'marketplace', plugin: 'demo' });
    expect(h.calls).toEqual([{ kind: 'marketplace', plugin: 'demo' }]);
    const bad = await h.send('POST', '/plugins/preview', {
      kind: 'marketplace',
      plugin: 'demo',
      sha: SHA,
    });
    expect(bad.status).toBe(400);
  });

  it('https でない URL・資格つき URL・不正な sha・未知の欄は 400（取りに行かない）', async () => {
    const h = harness();
    for (const body of [
      { kind: 'url', url: 'http://example.invalid/r.git' },
      { kind: 'url', url: 'file:///etc' },
      { kind: 'url', url: 'https://user:pw@example.invalid/r.git' },
      { kind: 'url', url: 'https://example.invalid/r.git?token=fake-value-for-test' },
      { kind: 'url', url: 'https://example.invalid/r.git#frag' },
      { kind: 'url', url: 'https://example.invalid/r.git', sha: 'main' },
      { kind: 'url', url: 'https://example.invalid/r.git', path: '../x' },
      { kind: 'url', url: 'https://example.invalid/r.git', extra: 1 },
      { kind: 'other' },
    ]) {
      const response = await h.send('POST', '/plugins/preview', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it('取得の失敗を種類で返す（invalid=400 / unavailable=502 / unconfigured=503）', async () => {
    const cases = [
      ['invalid', 400],
      ['unavailable', 502],
      ['unconfigured', 503],
    ] as const;
    for (const [kind, status] of cases) {
      const h = harness({
        fetch: async () => {
          throw new PluginFetchError(kind, `理由-${kind}`);
        },
      });
      const response = await h.send('POST', '/plugins/preview', urlRequest());
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: string }).error).toContain(`理由-${kind}`);
    }
  });

  it('fetcher が無い構成は 503', async () => {
    const h = harness({ withFetcher: false });
    expect((await h.send('POST', '/plugins/preview', urlRequest())).status).toBe(503);
  });
});

describe('POST /plugins（確定）', () => {
  it('プレビューした中身をそのまま保存する。取り直さない（取り元が変わっても見せたものを入れる）', async () => {
    let n = 0;
    const h = harness({
      fetch: async () => {
        n += 1;
        return n === 1
          ? fetchedPlugin({}, 'v1の本文')
          : fetchedPlugin(
              { source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA2 } },
              'v2の本文',
            );
      },
    });
    const p = await preview(h);
    const response = await h.send('POST', '/plugins', {
      previewId: p.previewId,
      scope: 'runner',
      enableHooks: true,
      enableMcp: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(n).toBe(1);
    const stored = await h.stores.plugins.get('demo');
    expect(stored?.source.sha).toBe(SHA);
    expect(
      new TextDecoder().decode(stored?.files.find((f) => f.path.endsWith('SKILL.md'))?.content),
    ).toContain('v1の本文');
    expect(stored).toMatchObject({ scope: 'runner', enableHooks: true, enableMcp: true });
    expect(stored?.installedBy.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(stored?.installedAt ?? ''))).toBe(false);
  });

  it('既定は scope all・hooks と mcp は無効', async () => {
    const h = harness();
    const p = await preview(h);
    await h.send('POST', '/plugins', { previewId: p.previewId });
    expect(await h.stores.plugins.get('demo')).toMatchObject({
      scope: 'all',
      enableHooks: false,
      enableMcp: false,
    });
  });

  it('保存の後に apply を呼ぶ。応答に runner ごとの結果を載せる', async () => {
    const stores = createMemoryStores();
    const { log, service } = recordingDistribution(stores);
    const h = harness({ stores, distribution: service });
    const p = await preview(h);
    const response = await h.send('POST', '/plugins', { previewId: p.previewId });
    expect(response.status).toBe(200);
    expect(log).toEqual(['apply:demo']);
    const body = (await response.json()) as {
      plugin: { name: string };
      runners: { runnerId: string; ok: boolean }[];
    };
    expect(body.plugin.name).toBe('demo');
    expect(body.runners).toEqual([{ runnerId: 'r1', ok: true }]);
    expect(JSON.stringify(body)).not.toContain(SECRET_BODY);
  });

  it('日誌には名前・取り元・SHA・scope・フラグだけを書く（中身は書かない）', async () => {
    const h = harness();
    const p = await preview(h);
    await h.send('POST', '/plugins', { previewId: p.previewId, scope: 'app', enableHooks: true });
    const entries = await h.stores.journal.list({ types: ['decision'] });
    const text = JSON.stringify(entries);
    expect(entries.length).toBeGreaterThan(0);
    expect(text).toContain('demo');
    expect(text).toContain('https://example.invalid/r.git');
    expect(text).toContain(SHA);
    expect(text).toContain('app');
    expect(text).toContain('POST /plugins');
    expect(text).not.toContain(SECRET_BODY);
  });

  it('日誌が書けなければ入れずに 500（保存も配布もしない。プレビューは残る）', async () => {
    const stores = createMemoryStores();
    const { log, service } = recordingDistribution(stores);
    const h = harness({ stores: failingJournalAppend(stores, 'disk full'), distribution: service });
    const p = await preview(h);
    const response = await h.send('POST', '/plugins', { previewId: p.previewId });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { code?: string }).code).toBe('journal_write_failed');
    expect(await stores.plugins.list()).toEqual([]);
    expect(log).toEqual([]);

    const ok = harness({ stores, distribution: service });
    // 同じプレビューを別の app では使えない（持ち主はサーバのメモリ）
    expect((await ok.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(404);
  });

  it('日誌が先: 保存が呼ばれた時点で日誌の行が既にある', async () => {
    const stores = createMemoryStores();
    let journalAtPut = -1;
    const wrapped: Stores = {
      ...stores,
      plugins: {
        ...stores.plugins,
        put: async (input) => {
          journalAtPut = (await stores.journal.list({ types: ['decision'] })).length;
          return stores.plugins.put(input);
        },
      },
    };
    const h = harness({ stores: wrapped });
    const p = await preview(h);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(200);
    expect(journalAtPut).toBeGreaterThanOrEqual(1);
  });

  it('大文字小文字だけが違う既存の名前は 409。状態は変わらない', async () => {
    const h = harness();
    const first = await preview(h);
    await h.send('POST', '/plugins', { previewId: first.previewId });
    const other = harness({
      stores: h.stores,
      fetch: async () => fetchedPlugin({ name: 'Demo' }),
    });
    const p = await preview(other);
    const response = await other.send('POST', '/plugins', { previewId: p.previewId });
    expect(response.status).toBe(409);
    expect((await h.stores.plugins.list()).map((x) => x.name)).toEqual(['demo']);
  });

  it('同名は置き換える（版を上げる）', async () => {
    const h = harness();
    const first = await preview(h);
    await h.send('POST', '/plugins', { previewId: first.previewId });
    const again = harness({
      stores: h.stores,
      fetch: async () =>
        fetchedPlugin({ source: { kind: 'url', url: 'https://example.invalid/r.git', sha: SHA2 } }),
    });
    const p = await preview(again);
    expect((await again.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(200);
    expect((await h.stores.plugins.get('demo'))?.source.sha).toBe(SHA2);
  });

  it('知らない・期限切れの previewId は 404。確定したものは再利用できない', async () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    expect((await h.send('POST', '/plugins', { previewId: 'x'.repeat(30) })).status).toBe(404);

    const expired = await preview(h);
    now += 60 * 60 * 1000;
    expect((await h.send('POST', '/plugins', { previewId: expired.previewId })).status).toBe(404);

    const p = await preview(h);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(200);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(404);
  });

  it('不正な scope・未知の欄は 400', async () => {
    const h = harness();
    const p = await preview(h);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId, scope: 'x' })).status).toBe(
      400,
    );
    expect((await h.send('POST', '/plugins', { previewId: p.previewId, nope: 1 })).status).toBe(
      400,
    );
    expect((await h.send('POST', '/plugins', {})).status).toBe(400);
    expect(await h.stores.plugins.list()).toEqual([]);
  });

  it('保存できない形（取り元が https でない等）は 400 で、何も保存しない', async () => {
    const h = harness({
      fetch: async () =>
        fetchedPlugin({ source: { kind: 'url', url: 'file:///tmp/x.git', sha: SHA } }),
    });
    const p = await preview(h);
    const response = await h.send('POST', '/plugins', { previewId: p.previewId });
    expect(response.status).toBe(400);
    expect(await h.stores.plugins.list()).toEqual([]);
  });
});

describe('DELETE /plugins/:name', () => {
  async function installed(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    const p = await preview(h);
    expect((await h.send('POST', '/plugins', { previewId: p.previewId })).status).toBe(200);
    return h;
  }

  it('日誌を書き、消して、apply を呼ぶ', async () => {
    const stores = createMemoryStores();
    const { log, service } = recordingDistribution(stores);
    const h = await installed({ stores, distribution: service });
    log.length = 0;
    const before = (await stores.journal.list({ types: ['decision'] })).length;
    const response = await h.send('DELETE', '/plugins/demo');
    expect(response.status).toBe(200);
    expect(await stores.plugins.list()).toEqual([]);
    expect(log).toEqual(['apply:']);
    const after = await stores.journal.list({ types: ['decision'] });
    expect(after.length).toBeGreaterThan(before);
    expect(JSON.stringify(after)).toContain('DELETE /plugins/:name');
  });

  it('無い名前は 404（日誌も積まない）', async () => {
    const h = harness();
    const response = await h.send('DELETE', '/plugins/nope');
    expect(response.status).toBe(404);
    expect(await h.stores.journal.list({ types: ['decision'] })).toEqual([]);
  });

  it('壊れた行があって list() も get() も投げても、外せる。日誌には取り元不明と書く', async () => {
    const stores = createMemoryStores();
    await installed({ stores });
    const broken: Stores = {
      ...stores,
      plugins: {
        ...stores.plugins,
        list: async () => {
          throw new Error('plugin「demo」を読めない');
        },
        get: async () => {
          throw new Error('plugin「demo」を読めない');
        },
      },
    };
    const h = harness({ stores: broken });
    const response = await h.send('DELETE', '/plugins/demo');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await stores.plugins.list()).toEqual([]);
    const text = JSON.stringify(await stores.journal.list({ types: ['decision'] }));
    expect(text).toContain('取り元不明');
  });

  it('get() が投げても、remove() が false なら 404', async () => {
    const stores = createMemoryStores();
    const broken: Stores = {
      ...stores,
      plugins: {
        ...stores.plugins,
        get: async () => {
          throw new Error('unreadable');
        },
      },
    };
    const response = await harness({ stores: broken }).send('DELETE', '/plugins/nope');
    expect(response.status).toBe(404);
  });

  it('日誌が書けなければ消さずに 500', async () => {
    const stores = createMemoryStores();
    await installed({ stores });
    const failing = harness({ stores: failingJournalAppend(stores, 'disk full') });
    const response = await failing.send('DELETE', '/plugins/demo');
    expect(response.status).toBe(500);
    expect(((await response.json()) as { code?: string }).code).toBe('journal_write_failed');
    expect((await stores.plugins.list()).map((x) => x.name)).toEqual(['demo']);
  });
});
