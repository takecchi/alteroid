import { createHash } from 'node:crypto';

import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  computePluginContentSha256,
  createRunnerHost,
  RUNNER_PLUGIN_BODY_LIMIT_BYTES,
  RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES,
  type RunnerHost,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `POST /plugins/:name` / `PUT /plugins`（daemon から runner へ plugin を送る口）の境界。
 *
 * runner は受けて検査してメモリに持ち、指紋を返すだけ（展開はしない）。ここで固定するのは
 * 制御面の門番・`bodyLimit`・不正な本文を 400 で拒んで前の状態を残すこと・scope が `app` の
 * ものを拒むこと・`/health` に files の中身を載せないこと。値はすべて偽物である。
 */

const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const SHA = 'a'.repeat(40);

function fakeSdk(): typeof sdkQuery {
  return ((): unknown => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-plugins',
        uuid: 'uuid-plugins',
      } as unknown as SDKMessage;
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    });
  }) as unknown as typeof sdkQuery;
}

let host: RunnerHost | undefined;

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

function makeApp() {
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: process.env.PATH ?? '' },
  });
  return createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
}

type App = ReturnType<typeof makeApp>;

interface WireOverrides {
  name?: string;
  scope?: string;
  contentSha256?: string;
  files?: { path: string; executable: boolean; content: string }[];
  sourceSha?: string;
}

function wirePlugin(name: string, text = 'dummy-content', overrides: WireOverrides = {}) {
  const bytes = Buffer.from(text);
  const files = [
    { path: '.claude-plugin/plugin.json', executable: false, content: bytes.toString('base64') },
  ];
  return {
    name,
    sourceSha: SHA,
    scope: 'all',
    enableHooks: false,
    enableMcp: false,
    contentSha256: computePluginContentSha256([
      { path: '.claude-plugin/plugin.json', executable: false, content: bytes },
    ]),
    files,
    ...overrides,
  };
}

const post = (app: App, name: string, body: unknown, headers: Record<string, string> = AUTH) =>
  app.request(`/plugins/${name}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const put = (app: App, body: unknown, headers: Record<string, string> = AUTH) =>
  app.request('/plugins', {
    method: 'PUT',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const health = async (app: App) =>
  (await (await app.request('/health', { headers: AUTH })).json()) as {
    plugins?: { sha256: string; plugins: { name: string; sha: string; contentSha256: string }[] };
  };

describe('制御面の門番', () => {
  it('鍵が無い呼びは、本文を読む前に 401（POST も PUT も）', async () => {
    const app = makeApp();
    const noAuth = { 'content-type': 'application/json' };
    expect((await post(app, 'p-one', wirePlugin('p-one'), noAuth)).status).toBe(401);
    expect((await put(app, { names: [] }, noAuth)).status).toBe(401);
    expect(
      (await post(app, 'p-one', wirePlugin('p-one'), { ...noAuth, authorization: 'Bearer wrong' }))
        .status,
    ).toBe(401);
    expect((await health(app)).plugins).toBeUndefined();
  });

  it('鍵が無ければ、巨大な本文も 413 ではなく 401 で終わる', async () => {
    const app = makeApp();
    const big = 'x'.repeat(RUNNER_PLUGIN_BODY_LIMIT_BYTES + 1);
    expect((await post(app, 'p-one', big, { 'content-type': 'application/json' })).status).toBe(
      401,
    );
  });
});

describe('POST /plugins/:name', () => {
  it('置けたら指紋を返し、/health に名前・sha・contentSha256 だけが載る（中身は載らない）', async () => {
    const app = makeApp();
    const body = wirePlugin('p-one');
    const response = await post(app, 'p-one', body);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { ok: boolean; plugin: unknown };
    expect(json).toEqual({
      ok: true,
      plugin: { name: 'p-one', sha: SHA, contentSha256: body.contentSha256 },
    });

    const h = await health(app);
    expect(h.plugins?.plugins).toEqual([
      { name: 'p-one', sha: SHA, contentSha256: body.contentSha256 },
    ]);
    const raw = JSON.stringify(h.plugins);
    expect(raw).not.toContain('dummy-content');
    expect(raw).not.toContain(body.files[0]?.content);
  });

  it('同名は置き換える', async () => {
    const app = makeApp();
    await post(app, 'p-one', wirePlugin('p-one', 'dummy-content'));
    const second = wirePlugin('p-one', 'dummy-content-2');
    expect((await post(app, 'p-one', second)).status).toBe(200);
    expect((await health(app)).plugins?.plugins).toEqual([
      { name: 'p-one', sha: SHA, contentSha256: second.contentSha256 },
    ]);
  });

  it('bodyLimit を超えたら 413。前の状態が残る', async () => {
    const app = makeApp();
    await post(app, 'p-one', wirePlugin('p-one'));
    const before = (await health(app)).plugins;

    const big = 'x'.repeat(RUNNER_PLUGIN_BODY_LIMIT_BYTES + 1);
    const response = await post(app, 'p-one', big);
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain('xxxxxxxx');
    expect((await health(app)).plugins).toEqual(before);
  });

  it('上限ちょうどの大きさの本文は、大きさでは拒まない（形の検査へ進む）', async () => {
    const app = makeApp();
    const filler = ' '.repeat(
      RUNNER_PLUGIN_BODY_LIMIT_BYTES - JSON.stringify(wirePlugin('p-one')).length,
    );
    const response = await post(app, 'p-one', `${JSON.stringify(wirePlugin('p-one'))}${filler}`);
    expect(response.status).toBe(200);
  });

  it.each([
    ['contentSha256 が files と合わない', { contentSha256: 'f'.repeat(64) }],
    [
      'path が .. を含む',
      {
        files: [
          { path: '../escape', executable: false, content: Buffer.from('x').toString('base64') },
        ],
      },
    ],
    ['scope が app', { scope: 'app' }],
    ['scope が未知', { scope: 'clone' }],
    ['sourceSha が40桁16進でない', { sourceSha: 'main' }],
    ['URL の名前と本文の名前が違う', { name: 'p-other' }],
    [
      'content が base64 でない',
      { files: [{ path: 'a.txt', executable: false, content: 'not base64!!' }] },
    ],
  ] as [string, WireOverrides][])(
    '不正（%s）は 400 で、前の状態が残る',
    async (_label, overrides) => {
      const app = makeApp();
      const first = wirePlugin('p-one');
      await post(app, 'p-one', first);
      const before = (await health(app)).plugins;

      const response = await post(app, 'p-one', wirePlugin('p-one', 'dummy-content-2', overrides));

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain('dummy-content-2');
      expect((await health(app)).plugins).toEqual(before);
    },
  );

  it('scope が app の plugin は、新規でも置かない', async () => {
    const app = makeApp();
    const response = await post(
      app,
      'p-app',
      wirePlugin('p-app', 'dummy-content', { scope: 'app' }),
    );
    expect(response.status).toBe(400);
    expect((await health(app)).plugins).toBeUndefined();
  });

  it('scope が runner のものは置ける', async () => {
    const app = makeApp();
    expect(
      (await post(app, 'p-runner', wirePlugin('p-runner', 'dummy-content', { scope: 'runner' })))
        .status,
    ).toBe(200);
  });

  it('袋の形が崩れていても 400 で、本文を返さない', async () => {
    const app = makeApp();
    const response = await post(app, 'p-one', { name: 'p-one', files: 'dummy-content' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('dummy-content');
  });
});

describe('PUT /plugins', () => {
  it('一覧に無いものをメモリから外し、残ったものの指紋を返す', async () => {
    const app = makeApp();
    await post(app, 'p-one', wirePlugin('p-one'));
    await post(app, 'p-two', wirePlugin('p-two', 'dummy-content-2'));

    const response = await put(app, { names: ['p-two', 'p-unknown'] });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { plugins?: { plugins: { name: string }[] } };
    expect(json.plugins?.plugins.map((p) => p.name)).toEqual(['p-two']);
    expect((await health(app)).plugins?.plugins.map((p) => p.name)).toEqual(['p-two']);
  });

  it('空の一覧は全部外す（指紋の欄が消える）', async () => {
    const app = makeApp();
    await post(app, 'p-one', wirePlugin('p-one'));
    const response = await put(app, { names: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await health(app)).plugins).toBeUndefined();
  });

  it('形が不正なら 400 で、何も外さない', async () => {
    const app = makeApp();
    await post(app, 'p-one', wirePlugin('p-one'));
    const before = (await health(app)).plugins;
    expect((await put(app, { names: 'p-one' })).status).toBe(400);
    expect((await put(app, { nope: [] })).status).toBe(400);
    expect((await health(app)).plugins).toEqual(before);
  });

  it('bodyLimit を超えたら 413 で、何も外さない', async () => {
    const app = makeApp();
    await post(app, 'p-one', wirePlugin('p-one'));
    const before = (await health(app)).plugins;
    const response = await put(app, 'x'.repeat(RUNNER_PLUGIN_RETAIN_BODY_LIMIT_BYTES + 1));
    expect(response.status).toBe(413);
    expect((await health(app)).plugins).toEqual(before);
  });
});
