import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  reasonOf,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

// `managers` は手で書かず実物（`createManagerPool`）を使う: 手書きの `ManagerPool` は本物の実装が増やした分岐に追随しないため。
function fakeCloneHost(stores: Stores): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
}

function stderrLines(stderr: ReturnType<typeof vi.spyOn>): string[] {
  return stderr.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe('.onError（Issue #249: Hono の既定エラーハンドラの console.error(err) を、本文を出さない形に置き換える）', () => {
  let stores: Stores;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stores = createMemoryStores();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it('HTTPException 以外の例外は、応答を既定のまま500に保ち、stderr へ1行だけ・reasonOf で切って・alteroidd: の接頭辞つきで残す（本文は出さない）', async () => {
    const secretish = `${'B'.repeat(260)} token=SHOULD-NOT-LEAK\nSECOND LINE at foo.ts:1:1`;
    stores.auth.listAccounts = async () => {
      throw new Error(secretish);
    };
    const app = createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => {},
    });

    const res = await app.request('/access');

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Internal Server Error' });

    const matching = stderrLines(stderr).filter((line) => line.includes('alteroidd:'));
    expect(matching).toHaveLength(1);
    const line = matching[0]!;

    expect(line.startsWith('alteroidd: ')).toBe(true);
    expect(line).toContain(reasonOf(new Error(secretish)));
    expect(line).not.toContain('SECOND LINE');
    expect(line).not.toContain('at foo.ts:1:1');
    expect(line).not.toContain('SHOULD-NOT-LEAK');
    expect(line).not.toContain('\n    at ');
  });

  it('HTTPException は既定と同じ応答（getResponse() の内容）を返し、ログには残さない', async () => {
    stores.auth.listAccounts = async () => {
      throw new HTTPException(418, { message: 'teapot' });
    };
    const app = createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => {},
    });

    const res = await app.request('/access');

    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: 'teapot' });
    expect(stderrLines(stderr).some((line) => line.includes('alteroidd:'))).toBe(false);
  });

  it('壊れた JSON 本文の 400・存在しない経路の 404 も { error } の JSON で返す（issue #2849）', async () => {
    const app = createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => {},
    });

    const broken = await app.request('/memory/x', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(broken.status).toBe(400);
    expect(broken.headers.get('content-type')).toContain('application/json');
    expect(await broken.json()).toEqual({ error: 'Malformed JSON in request body' });

    const missing = await app.request('/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect(await missing.json()).toEqual({ error: 'not found' });
  });
});
