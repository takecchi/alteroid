import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  createProfileVessel,
  createRunnerHost,
  WITHHELD_ENV_KEYS,
  type RunnerHost,
} from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `POST /profile` の検査を、兄弟の経路（`POST /credentials` / `POST /mcp-servers`）
 * と揃える（#1790 の「確かめていないこと」で名指しされていた同じ形の穴、#1806）。
 *
 * 揃える前は、この経路だけ `zValidator` に `hook` を渡していなかった——形の
 * 不正で 400 になったとき、`@hono/zod-validator` の既定は `c.json(result, 400)`
 * （`result = { success: false, error: <ZodError> }`）を返す。ここは
 * `GH_TOKEN` のような鍵を丸ごと含みうるシェルスクリプトを運ぶ口なので、
 * **送られてきた本文が1文字も応答へ出ないこと**をここで固定する。
 *
 * ⛔ 本物の資格情報・本物のプロファイルを拾わないこと——`env` は必ず最小限の
 * 偽値だけを明示し、プロファイルの本文もすべて `echo fake-profile` のような
 * 明らかな偽物だけを使う。器の本物の `process.env` は一度も読まない。
 */

const TOKEN = 'the-daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function fakeSdk(): typeof sdkQuery {
  return ((): unknown => {
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-profile-hook',
        uuid: 'uuid-profile-hook',
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

/**
 * プロファイルの器つきの runner app を1つ作る。
 *
 * **`env` は明示したキーだけを渡す。** `RunnerHostOptions.env` の既定は
 * `process.env` なので、渡し忘れると器の本物の環境変数（`GH_TOKEN` 等）が
 * そのまま拾われる——ここでは `PATH` だけを実値から借り、それ以外は渡さない。
 */
function makeApp(dir: string) {
  host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: dir,
    emit: () => undefined,
    queryFn: fakeSdk(),
    env: { PATH: process.env.PATH ?? '' },
    profile: createProfileVessel({
      path: join(dir, 'profile', 'profile.sh'),
      withheldEnvKeys: WITHHELD_ENV_KEYS,
    }),
  });
  return createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });
}

describe('POST /profile の hook（#1806）', () => {
  it('形が不正な本文は、既定の400ではなく sanitize された理由文だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    // `script` は文字列のはずが、ここでは型を崩す（オブジェクト）。
    // 中に「漏れたら分かる」偽の目印を仕込んでおく。
    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: { leak: 'fake-profile-should-not-leak' } }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as unknown;
    // 兄弟（/credentials・/mcp-servers）と同じ形——`ok: false` と固定文言だけ。
    expect(body).toEqual({ ok: false, error: 'プロファイルの入力の形が不正（置いていない）' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('fake-profile-should-not-leak');
    expect(raw).not.toContain('leak');
  });

  it('script を欠いた本文も同じ固定文言だけを返す', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ notScript: 'fake-unrelated-value' }),
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).toBe(
      JSON.stringify({ ok: false, error: 'プロファイルの入力の形が不正（置いていない）' }),
    );
    expect(raw).not.toContain('fake-unrelated-value');
    expect(raw).not.toContain('notScript');
  });

  it('正しい形は通り、評価結果が返る（hook は成功時には何もしない）', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: 'echo fake-profile' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; profile?: { sha256: string } };
    expect(body.ok).toBe(true);
    expect(body.profile?.sha256).toEqual(expect.any(String));
  });

  it('壊れたスクリプトは 200 のまま ok:false で理由を返す（hook が横取りしない）', async () => {
    const dir = makeTempDirSync('alteroid-profile-hook-');
    const app = makeApp(dir);

    // 構文として壊れているシェルスクリプト（`profile.test.ts` の既存の壊れた例と
    // 同じ形。偽物で、本物のプロファイルの断片ではない）。hook は「形」しか
    // 見ないので、ここは 400 ではなく `host.setProfile` の評価結果として届く。
    const res = await app.request('/profile', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ script: 'if [ ; then' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
