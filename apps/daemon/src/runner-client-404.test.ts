import type { RunnerPlugin } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createHttpRunner, RunnerHttpError } from './runner-client.js';

// 口を持たない runner（その口が 404）を模す。/health だけは答える
async function rig404(): Promise<Awaited<ReturnType<typeof createHttpRunner>>> {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, runnerId: 'runner-old' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('404 Not Found', { status: 404 });
  }) as typeof fetch;
  return createHttpRunner({ baseUrl: 'http://runner.test', token: 't', fetchFn });
}

async function caught(promise: Promise<unknown> | undefined): Promise<unknown> {
  return promise?.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectHttp404(error: unknown): void {
  expect(error).toBeInstanceOf(RunnerHttpError);
  expect((error as RunnerHttpError).status).toBe(404);
}

const PLUGIN: RunnerPlugin = {
  name: 'p-one',
  version: '1',
  contentSha256: 'a'.repeat(64),
  files: [],
} as unknown as RunnerPlugin;

describe('HttpRunner: 口が 404 のとき、専用の例外に付け替えず RunnerHttpError を投げる（#5717）', () => {
  it('setMcpServers / setPermissionRules', async () => {
    const client = await rig404();
    expectHttp404(await caught(client.setMcpServers?.({})));
    expectHttp404(await caught(client.setPermissionRules?.(['Bash(ls)'])));
  });

  it('setPlugin / retainPlugins', async () => {
    const client = await rig404();
    expectHttp404(await caught(client.setPlugin?.(PLUGIN)));
    expectHttp404(await caught(client.retainPlugins?.([])));
  });

  it('setCodexAuth / takeCodexAuthWriteBack', async () => {
    const client = await rig404();
    expectHttp404(await caught(client.setCodexAuth?.(null)));
    expectHttp404(await caught(client.takeCodexAuthWriteBack?.('fp')));
  });
});
