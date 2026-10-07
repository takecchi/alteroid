import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createCredentialStore,
  createRunnerHost,
  type RunnerClient,
  type RunnerHost,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createHttpRunner } from './runner-client.js';

const TOKEN = 'test-runner-token-e2e';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function fakeSdk(): typeof sdkQuery {
  return ((): unknown => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-cred-e2e',
        uuid: 'uuid-cred-e2e',
      } as unknown as SDKMessage;
    }
    return Object.assign(generate(), {
      close: () => undefined,
      interrupt: async () => undefined,
    });
  }) as unknown as typeof sdkQuery;
}

let host: RunnerHost | undefined;
let client: RunnerClient | undefined;

afterEach(async () => {
  await client?.close();
  await host?.shutdown().catch(() => undefined);
  host = undefined;
  client = undefined;
});

async function rig(): Promise<{ client: RunnerClient }> {
  const dir = makeTempDirSync('alteroid-cred-e2e-');
  const credentials = createCredentialStore({ dir: `${dir}/creds`, seed: {}, names: [] });
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: process.env.PATH ?? '' },
    credentials,
  });
  const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return app.request(`${url.pathname}${url.search}`, init as never);
  }) as typeof fetch;

  client = await createHttpRunner({ baseUrl: 'http://runner.test', token: TOKEN, fetchFn });
  return { client };
}

describe('POST /credentials を RunnerClient 越しに叩く（#1790）', () => {
  it('形が不正な本文は RunnerHttpError(400) になり、名前・値のどちらも漏れない', async () => {
    const { client } = await rig();

    let message = '';
    try {
      await client.setCredentials([
        { name: 'FAKE_UNRELATED_TOKEN', value: 'fake-unrelated-secret-value' },
        { name: 'not-a-valid-name', value: 'fake-x-should-not-leak' },
      ]);
      expect.unreachable('400 で拒まれるはず');
    } catch (error) {
      message = String(error);
    }

    expect(message).toMatch(/\(400\)/);
    expect(message).not.toContain('fake-unrelated-secret-value');
    expect(message).not.toContain('FAKE_UNRELATED_TOKEN');
    expect(message).not.toContain('not-a-valid-name');
    expect(message).not.toContain('fake-x-should-not-leak');

    expect(message).toContain('鍵の入力の形が不正（置いていない）');
  });

  it('128文字を超える名前も同様に拒まれ、名前そのものは漏れない', async () => {
    const { client } = await rig();
    const tooLong = `FAKE_${'A'.repeat(200)}`;

    let message = '';
    try {
      await client.setCredentials([{ name: tooLong, value: 'fake-token-e2e' }]);
      expect.unreachable('400 で拒まれるはず');
    } catch (error) {
      message = String(error);
    }

    expect(message).toMatch(/\(400\)/);
    expect(message).not.toContain(tooLong);
    expect(message).not.toContain('fake-token-e2e');
  });

  it('正しい形は通り、指紋だけが返る（client 越し）', async () => {
    const { client } = await rig();

    const fingerprints = await client.setCredentials([
      { name: 'FAKE_TOKEN_E2E', value: 'fake-value-e2e-xyz' },
    ]);

    expect(fingerprints.map((entry) => entry.name)).toEqual(['FAKE_TOKEN_E2E']);
    expect(JSON.stringify(fingerprints)).not.toContain('fake-value-e2e-xyz');
  });
});
