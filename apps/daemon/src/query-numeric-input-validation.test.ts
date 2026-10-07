import type { CloneHost, ManagerPool } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function stubManagerPool(): ManagerPool {
  return {
    async start() {
      throw new Error('このスタブからはマネージャーを起こさない（このテストの主題ではない）');
    },
    async send() {
      return { outcome: 'unknown' as const, detail: 'このスタブでは呼ばれない前提' };
    },
    async abort() {
      return { outcome: 'absent' as const, detail: 'このスタブでは呼ばれない前提' };
    },
    async list() {
      return [];
    },
    denials() {
      return [];
    },
    async runners() {
      return { runners: [], unassigned: [], daemonRevision: { status: 'unknown' } };
    },
    pushHealthOf() {
      return undefined;
    },
    runnerBacklog() {
      return [];
    },
    async runnerIdOf() {
      return undefined;
    },
    async transcript() {
      return { kind: 'missing' as const };
    },
    async unpushedWork() {
      throw new Error('このテストの主題ではない');
    },
    runningManagerOwning() {
      return undefined;
    },
    async restore() {
      return [];
    },
    async resumeStoppedByUsage() {
      return [];
    },
    async reattachRunner() {},
    relocateFrom() {},
    async vacate() {
      return {};
    },
    async probeTurnEnds() {},
    async flushWithheldReports() {},
    async settleStalledUsageWakes() {
      return [];
    },
    async renotifyStalledDenials() {},
    async stop() {},
  };
}

function stubCloneHost(): CloneHost {
  return {
    postPersisted: async () => 'persisted',
    post: () => undefined,
    dropQueuedInboxEvents: async () => 0,
    subscribe: () => () => undefined,
    endConversation: async () => undefined,
    answerApproval: async () => undefined,
    managers: stubManagerPool(),
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    recycleSessionForToken: () => undefined,
    stop: async () => undefined,
  };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp({
    clone: stubCloneHost(),
    stores: createMemoryStores(),
    token: 'test-token',
    shutdown: () => undefined,
  });
});

async function expectPlainJapanese400(res: Response, field: string) {
  const text = await res.text();
  expect(res.status, `本文: ${text}`).toBe(400);
  const body: unknown = JSON.parse(text);
  expect(body, `本文: ${text}`).toEqual({ error: `入力の形が不正: ${field}` });
  expect(text).not.toMatch(/"code"|"message"|"expected"|"success"|"data"/);
}

describe('クエリの数値引数（範囲外・非整数）は日本語の平文で400（HTTP 側、issue #424 の続き）', () => {
  const cases: {
    route: string;
    field: string;
    build: (value: string) => string;
    invalid: { label: string; value: string }[];
    valid: string[];
    okStatus?: number;
  }[] = [
    {
      route: 'GET /reports',
      field: 'limit',
      build: (v) => `/reports?limit=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '366（最大超え）', value: '366' },
        { label: '非整数', value: 'abc' },
        { label: '小数', value: '1.5' },
      ],
      valid: ['1', '365', '7'],
    },
    {
      route: 'GET /journal',
      field: 'limit',
      build: (v) => `/journal?limit=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '1001（最大超え）', value: '1001' },
        { label: '非整数', value: 'abc' },
      ],
      valid: ['1', '1000', '50'],
    },
    {
      route: 'GET /approvals',
      field: 'limit',
      build: (v) => `/approvals?limit=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '非整数', value: 'abc' },
        { label: '負数', value: '-1' },
      ],
      valid: ['1', '200'],
    },
    {
      route: 'GET /commitments',
      field: 'limit',
      build: (v) => `/commitments?limit=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '非整数', value: 'abc' },
      ],
      valid: ['1', '500'],
    },
    {
      route: 'GET /managers',
      field: 'limit',
      build: (v) => `/managers?limit=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '1001（最大超え）', value: '1001' },
        { label: '非整数', value: 'abc' },
      ],
      valid: ['1', '1000'],
    },
    {
      route: 'GET /conversations',
      field: 'limit',
      build: (v) => `/conversations?limit=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '201（最大超え）', value: '201' },
        { label: '非整数', value: 'abc' },
      ],
      valid: ['1', '200', '20'],
    },
    {
      route: 'GET /conversations',
      field: 'scan',
      build: (v) => `/conversations?scan=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '10001（最大超え）', value: '10001' },
        { label: '非整数', value: 'abc' },
      ],
      valid: ['1', '10000', '2000'],
    },
    {
      route: 'GET /conversations/:id',
      field: 'scan',
      build: (v) => `/conversations/conv-x?scan=${v}`,
      invalid: [
        { label: '0（最小未満）', value: '0' },
        { label: '10001（最大超え）', value: '10001' },
        { label: '非整数', value: 'abc' },
      ],
      valid: ['1', '10000'],
      okStatus: 404,
    },
  ];

  for (const { route, field, build, invalid, valid, okStatus = 200 } of cases) {
    describe(`${route} の ${field}`, () => {
      for (const { label, value } of invalid) {
        it(`${label}（${field}=${value}）は日本語の平文で400`, async () => {
          const res = await app.request(build(value));
          await expectPlainJapanese400(res, field);
        });
      }

      it(`境界値・既定値は従来どおり${okStatus}で通る（許す範囲を変えていない）`, async () => {
        for (const value of valid) {
          const res = await app.request(build(value));
          expect(res.status, `${field}=${value} 本文: ${await res.text()}`).toBe(okStatus);
        }
      });
    });
  }

  it('範囲外の値そのものは応答へ1文字も混ざらない（値を変えて2回測る）', async () => {
    const first = await app.request('/journal?limit=99999');
    const firstText = await first.text();
    expect(firstText).not.toContain('99999');
    expect(JSON.parse(firstText)).toEqual({ error: '入力の形が不正: limit' });

    const second = await app.request('/journal?limit=-42');
    const secondText = await second.text();
    expect(secondText).not.toContain('42');
    expect(JSON.parse(secondText)).toEqual({ error: '入力の形が不正: limit' });
  });
});

describe('数値を持たないクエリも200で通る（回帰確認）', () => {
  it('GET /usage は素の呼びで200', async () => {
    const res = await app.request('/usage');
    expect(res.status, await res.text()).toBe(200);
  });

  it('GET /journal/stream は SSE を配線していなければ503（400ではない）', async () => {
    const res = await app.request('/journal/stream');
    expect(res.status, await res.text()).toBe(503);
  });

  it('DELETE /archive/:id は overrideReason 無しで404（該当なし。クエリでは落ちない）', async () => {
    const res = await app.request('/archive/does-not-exist', { method: 'DELETE' });
    expect(res.status, await res.text()).toBe(404);
  });
});

describe('JSON 本文の数値欄は jsonBody() 経由で既に安全（回帰確認。この PR の直し対象ではない）', () => {
  it('POST /schedule: spec.every.minutes=0 は「kind/request/spec の形が不正」の日本語平文で400', async () => {
    const res = await app.request('/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'daily_report',
        request: 'x',
        spec: { type: 'every', minutes: 0 },
      }),
    });
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error:
        'kind/request/spec の形が不正: spec.minutes（every の分数は 1以上525600（1年）以下の整数のみ。それより長い周期は cron 式か単発の予定で書く）',
    });
    expect(text).not.toMatch(/"code"|"success"|"expected"/);
  });

  it('PUT /tokens/policy: cooldownMs=-5 は「設定の入力の形が不正」の日本語平文で400', async () => {
    const res = await app.request('/tokens/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cooldownMs: -5 }),
    });
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: '設定の入力の形が不正: cooldownMs' });
    expect(text).not.toMatch(/"code"|"success"|-5/);
  });

  it('PUT /tokens: tokens[0].order=1.5（非整数）は「トークンのプールの入力の形が不正」の日本語平文で400', async () => {
    const res = await app.request('/tokens', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tokens: [{ label: 'x', value: 'y', order: 1.5 }] }),
    });
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: 'トークンのプールの入力の形が不正（保存していない）: tokens.0.order',
    });
    expect(text).not.toMatch(/"code"|"success"|1\.5/);
  });

  it('POST /archive/remove: minStoredBytes=-1 は既定の「入力の形が不正」の日本語平文で400', async () => {
    const res = await app.request('/archive/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minStoredBytes: -1, reason: 'x' }),
    });
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: '入力の形が不正: minStoredBytes' });
    expect(text).not.toMatch(/"code"|"success"/);
  });

  it('POST /inbox/remove: limit=0 は既定の「入力の形が不正」の日本語平文で400', async () => {
    const res = await app.request('/inbox/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ types: ['timer'], reason: 'x', limit: 0 }),
    });
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: '入力の形が不正: limit' });
    expect(text).not.toMatch(/"code"|"success"/);
  });
});

describe('パス引数の数値（version）は元から自前の日本語平文で400（変更対象ではない。回帰確認）', () => {
  it('version=abc（非整数）は「版番号が不正」で400', async () => {
    const res = await app.request('/practices/daily-report/versions/abc');
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: '版番号が不正' });
  });

  it('version=0（正の整数ではない）は「版番号が不正」で400', async () => {
    const res = await app.request('/practices/daily-report/versions/0');
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: '版番号が不正' });
  });

  it('version=-1（負）は「版番号が不正」で400', async () => {
    const res = await app.request('/practices/daily-report/versions/-1');
    const text = await res.text();
    expect(res.status, `本文: ${text}`).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: '版番号が不正' });
  });
});
