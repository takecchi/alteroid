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

/**
 * `POST /credentials` の検査（#1790 / PR #1791）を、デーモン側の client 越しに
 * 確かめる歯。横断レビュー 15 回目（t6）が書いた探索テストを取り込んだ。
 *
 * `apps/runner/src/credentials-hook.test.ts`（PR #1791）は runner の Hono
 * アプリを `app.request()` で直に叩くだけで、**デーモン側の HTTP runner
 * client（`RunnerClient` / `createHttpRunner`）を経由していない**。兄弟の
 * `POST /mcp-servers` には `apps/daemon/src/runner-mcp-servers.test.ts` に
 * 「壊れた本文は runner が 400 で拒み、応答に値を載せない」を **client 越し**
 * で確かめる歯があるが（該当テストの逐語は
 * `grep -Fn -- '形が不正な登録は runner が 400 で拒み' apps/daemon/src/runner-mcp-servers.test.ts`）、
 * `POST /credentials` にはその対になる歯が無い。
 *
 * ここではその同じ形を `POST /credentials` に対して手で組み、
 * `RunnerClient.setCredentials()` 経由で壊れた本文を送って確認する。
 *
 * ⛔ 本物の資格情報を拾わないこと —— `createCredentialStore` の `seed` は
 * 既定が `process.env` なので、ここでは必ず `seed: {}` を明示する。値は
 * すべて `fake-` で始まる明らかな偽物だけを使う。
 */

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

/**
 * runner（本物の Hono アプリ）と、それに繋ぐデーモン側の `HttpRunner` を1組作る。
 * `runner-mcp-servers.test.ts` の `rig()` と同じ形——fetch を `app.request()` へ
 * 直に流す。
 */
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
        // 形は正しいが無関係な1本（漏れていないかの対照）。
        { name: 'FAKE_UNRELATED_TOKEN', value: 'fake-unrelated-secret-value' },
        // これが形を崩す（小文字を含む）。
        { name: 'not-a-valid-name', value: 'fake-x-should-not-leak' },
      ]);
      expect.unreachable('400 で拒まれるはず');
    } catch (error) {
      message = String(error);
    }

    expect(message).toMatch(/\(400\)/);
    // 兄弟（/mcp-servers、runner-mcp-servers.test.ts）と同じ形の確認。
    expect(message).not.toContain('fake-unrelated-secret-value');
    expect(message).not.toContain('FAKE_UNRELATED_TOKEN');
    expect(message).not.toContain('not-a-valid-name');
    expect(message).not.toContain('fake-x-should-not-leak');

    /**
     * ⚠️ 固定文言化（PR #1791）により、この
     * メッセージには「どの名前が形式違反だったか」の手がかりが一切無い
     * （`/mcp-servers` と同じ設計。回帰ではなく既存の設計をなぞっただけ）。
     * PR #1791 以前は、runner が返す生の ZodError に `path`
     * （例: `credentials.1.name`——配列の何番目かという索引）が乗っていた
     * ので、送った本文と突き合わせれば「どの行が悪いか」は追えた。
     * 固定文言化後は、この索引の手がかりも消えている——本テストはそれを
     * 確かめるものではなく、単に「値は漏れない」を client 越しに固定する。
     */
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
