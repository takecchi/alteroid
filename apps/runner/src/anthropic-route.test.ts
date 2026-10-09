import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  createCredentialStore,
  createProfileVessel,
  createRunnerHost,
  WITHHELD_ENV_KEYS,
  type RunnerEvent,
  type RunnerHost,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerApp, Outbox } from './app.js';

const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

const FAKE_OAUTH = 'sk-fake-oauth-runner-0001';
const FAKE_AUTH = 'sk-fake-auth-runner-0002';
const FAKE_STALE = 'sk-fake-stale-env-oauth-0003';

let host: RunnerHost | undefined;

afterEach(async () => {
  await host?.shutdown().catch(() => undefined);
  host = undefined;
});

function makeHost(env: NodeJS.ProcessEnv) {
  const events: RunnerEvent[] = [];
  const dir = makeTempDirSync('alteroid-route-');
  host = createRunnerHost({
    runnerId: 'runner-route-test',
    workspacePath: dir,
    emit: (event) => events.push(event),
    env: { PATH: process.env.PATH ?? '', ...env },
    credentials: createCredentialStore({ dir: join(dir, 'cred'), seed: {} }),
    profile: createProfileVessel({
      path: join(dir, 'profile', 'profile.sh'),
      withheldEnvKeys: WITHHELD_ENV_KEYS,
    }),
    codexHome: makeTempDirSync('alteroid-route-codex-'),
  });
  const routeEvents = (): Extract<RunnerEvent, { type: 'anthropic_route' }>[] =>
    events.filter(
      (event): event is Extract<RunnerEvent, { type: 'anthropic_route' }> =>
        event.type === 'anthropic_route',
    );
  return { host, routeEvents };
}

async function helloOf(target: RunnerHost): Promise<Record<string, unknown>> {
  const app = createRunnerApp({
    host: target,
    outbox: new Outbox(),
    tokenSha256: TOKEN_SHA256,
    sseHeartbeatMs: 60_000,
  });
  const response = await app.request('/events', {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
  });
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('SSE の応答に本文が無い');
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('\n\n')) {
    const next = await reader.read();
    if (next.done) break;
    seen += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  const data = /^data: (.*)$/m.exec(seen)?.[1];
  if (data === undefined) throw new Error(`hello の data が読めない: ${seen}`);
  return JSON.parse(data) as Record<string, unknown>;
}

describe('runner の接続先とモデルの別名の名乗り（#4263・#4261）', () => {
  it('hello に anthropicRoute を載せる。器の env に残った OAuth は子に渡らないので「いまは置かれていない」', async () => {
    const { host: h } = makeHost({
      ANTHROPIC_BASE_URL: 'https://user:sk-fake-pw@gw.example.com/v1?k=sk-fake-q',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-x',
      CLAUDE_CODE_OAUTH_TOKEN: FAKE_STALE,
    });
    const hello = await helloOf(h);
    const lines = hello.anthropicRoute as string[];
    expect(lines[0]).toContain('⚠️ ANTHROPIC_BASE_URL が https://gw.example.com を指している');
    expect(lines[0]).toContain('いまは置かれていないが、置かれれば送られる');
    expect(lines.join('\n')).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-x（出所: 器）');
    const raw = JSON.stringify(hello);
    for (const secret of [FAKE_STALE, 'sk-fake-pw', 'sk-fake-q']) expect(raw).not.toContain(secret);
  });

  it('何も置かれていなければ空配列で名乗る（欄を省かない。省くのは古い runner）', async () => {
    const { host: h } = makeHost({});
    expect((await helloOf(h)).anthropicRoute).toEqual([]);
  });

  it('袋に OAuth が降りたら、変わった行を anthropic_route で名乗り直す。同じ行なら名乗り直さない', async () => {
    const { host: h, routeEvents } = makeHost({ ANTHROPIC_BASE_URL: 'https://gw.example.com' });
    expect(routeEvents()).toHaveLength(0);

    await h.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: FAKE_OAUTH }]);
    expect(routeEvents()).toHaveLength(1);
    expect(routeEvents()[0]?.anthropicRoute[0]).toContain('いま置かれている');
    expect(JSON.stringify(routeEvents())).not.toContain(FAKE_OAUTH);

    await h.setCredentials([{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: `${FAKE_OAUTH}-rotated` }]);
    expect(routeEvents()).toHaveLength(1);
  });

  it('接続先用の鍵が袋に降りたら警告が消え、出所は袋になる。値は出ない', async () => {
    const { host: h, routeEvents } = makeHost({ ANTHROPIC_BASE_URL: 'https://gw.example.com' });
    await h.setCredentials([{ name: 'ANTHROPIC_AUTH_TOKEN', value: FAKE_AUTH }]);
    const last = routeEvents().at(-1)?.anthropicRoute ?? [];
    expect(last.some((line) => line.startsWith('⚠️'))).toBe(false);
    expect(last).toHaveLength(1);
    expect(JSON.stringify(routeEvents())).not.toContain(FAKE_AUTH);
  });

  it('プロファイルが別名を宣言したら、出所をプロファイルとして名乗り直す', async () => {
    const { host: h, routeEvents } = makeHost({});
    const result = await h.setProfile('export ANTHROPIC_DEFAULT_SONNET_MODEL=foo-model\n');
    expect(result.ok).toBe(true);
    const lines = routeEvents().at(-1)?.anthropicRoute ?? [];
    expect(lines.join('\n')).toContain(
      'ANTHROPIC_DEFAULT_SONNET_MODEL=foo-model（出所: プロファイル）',
    );
    expect(lines.join('\n')).toContain('別名 sonnet の行き先が変わっている');
    // hello も降りた後の最新を読む
    expect((await helloOf(h)).anthropicRoute).toEqual(lines);
  });
});
