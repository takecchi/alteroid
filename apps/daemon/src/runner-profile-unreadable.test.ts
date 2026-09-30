import { describe, expect, it } from 'vitest';

import { createHttpRunner } from './runner-client.js';

/**
 * `HttpRunner#profile()` は、`/health` の `profile` の欄が**在るのに形が読めない**ときは
 * `undefined`（何も載っていない）ではなく投げる（#2508）。
 * `undefined` へ倒すと、`syncRunner` が「外したプロファイルと一致」と読み、外したはずの
 * プロファイルが runner に残る。欄が無いときは今までどおり `undefined`。
 */

const FAKE_SECRET_VALUE_2508 = 'FAKE_SECRET_VALUE_2508';

async function clientWith(profile: unknown, withField = true) {
  const health: Record<string, unknown> = {
    runnerId: 'runner-test',
    instanceId: 'instance-test',
    workspacePath: '/work',
    credentials: [],
  };
  if (withField) health.profile = profile;
  const fetchFn = (async () =>
    new Response(JSON.stringify(health), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return createHttpRunner({ baseUrl: 'http://runner.test', token: 'test-token', fetchFn });
}

describe('HttpRunner#profile: 欄の形が読めないとき（#2508）', () => {
  it('欄が在るのに形が崩れていれば、undefined ではなく投げる（値は文言に出ない）', async () => {
    const client = await clientWith({ sha256: 42, script: FAKE_SECRET_VALUE_2508 });
    const error = await client.profile().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('profile の欄を読めなかった');
    expect(String(error)).not.toContain(FAKE_SECRET_VALUE_2508);
  });

  it('対照: 欄が無ければ undefined（古い runner・外した状態）', async () => {
    const client = await clientWith(undefined, false);
    expect(await client.profile()).toBeUndefined();
  });

  it('対照: 欄が null でも undefined', async () => {
    const client = await clientWith(null);
    expect(await client.profile()).toBeUndefined();
  });

  it('対照: 形が読めれば、そのまま返す', async () => {
    const good = { sha256: 'a'.repeat(64), bytes: 3, updatedAt: '2026-01-01T00:00:00.000Z' };
    const client = await clientWith(good);
    expect(await client.profile()).toEqual(good);
  });
});
