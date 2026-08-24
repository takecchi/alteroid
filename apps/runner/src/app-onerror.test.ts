import { createHash } from 'node:crypto';

import { createRunnerHost, reasonOf, type RunnerHost } from '@alteroid/core';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerApp, Outbox } from './app.js';

/**
 * `.onError`（Issue #249）専用の検証。runner 側には既存の `app.test.ts` は
 * 無い（`ls apps/runner/src` で確認済み）が、daemon 側と対にして独立ファイルへ
 * 置く——将来ここへ他のテストが増えたときに同じ理由（他 PR との衝突回避）で
 * 分けやすくしておく。
 *
 * `/managers/:id/resume` を踏み台に使う。このルートは既に「`RunnerFenceError`
 * 以外は Hono の既定へ流す」と自分の doc に書いてある
 * （`grep -n 'Hono の既定 500 に落とさない' apps/runner/src/app.ts` の近傍）ので、
 * `.onError` を検証する実在の経路として最も素直である。
 */

const TOKEN = 'daemon-only-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function newHost(): RunnerHost {
  return createRunnerHost({
    runnerId: 'runner-onerror-test',
    workspacePath: '/workspace',
    emit: () => undefined,
  });
}

function resumeRequest() {
  return {
    method: 'POST',
    headers: { ...bearer(), 'content-type': 'application/json' },
    body: JSON.stringify({
      managerId: 'mgr-1',
      sessionId: 'sess-1',
      cwd: '/workspace',
      request: '続き',
    }),
  };
}

/** spy に積まれた呼び出しの1番目の引数を文字列化して並べる。 */
function stderrLines(stderr: ReturnType<typeof vi.spyOn>): string[] {
  return stderr.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('.onError（Issue #249: Hono の既定エラーハンドラの console.error(err) を、本文を出さない形に置き換える）', () => {
  let host: RunnerHost;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = newHost();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stderr.mockRestore();
    await host.shutdown();
  });

  it('RunnerFenceError 以外の例外は、応答を既定のまま500に保ち、stderr へ1行だけ・reasonOf で切って・alteroid-runner: の接頭辞つきで残す（本文は出さない）', async () => {
    const secretish = `${'C'.repeat(260)} token=SHOULD-NOT-LEAK\nSECOND LINE at foo.ts:1:1`;
    host.resume = async () => {
      throw new Error(secretish);
    };
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    const res = await app.request('/managers/mgr-1/resume', resumeRequest());

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');

    const matching = stderrLines(stderr).filter((line) => line.includes('alteroid-runner:'));
    expect(matching).toHaveLength(1);
    const line = matching[0]!;

    expect(line.startsWith('alteroid-runner: ')).toBe(true);
    expect(line).toContain(reasonOf(new Error(secretish)));
    expect(line).not.toContain('SECOND LINE');
    expect(line).not.toContain('at foo.ts:1:1');
    expect(line).not.toContain('SHOULD-NOT-LEAK');
    expect(line).not.toContain('\n    at ');
  });

  it('HTTPException は既定と同じ応答（getResponse() の内容）を返し、ログには残さない', async () => {
    host.resume = async () => {
      throw new HTTPException(418, { message: 'teapot' });
    };
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    const res = await app.request('/managers/mgr-1/resume', resumeRequest());

    expect(res.status).toBe(418);
    expect(await res.text()).toBe('teapot');
    expect(stderrLines(stderr).some((line) => line.includes('alteroid-runner:'))).toBe(false);
  });

  it('RunnerFenceError は既定どおり409へ変換され、こちらの `.onError` は素通りする（既存の分岐を壊していないことの確認）', async () => {
    const { RunnerFenceError } = await import('@alteroid/core');
    host.resume = async () => {
      throw new RunnerFenceError({ managerId: 'mgr-1', expected: 2, given: 1 });
    };
    const app = createRunnerApp({ host, outbox: new Outbox(), tokenSha256: TOKEN_SHA256 });

    const res = await app.request('/managers/mgr-1/resume', resumeRequest());

    expect(res.status).toBe(409);
    expect(stderrLines(stderr).some((line) => line.includes('alteroid-runner:'))).toBe(false);
  });
});
