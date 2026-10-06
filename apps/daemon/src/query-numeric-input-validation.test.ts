import type { CloneHost, ManagerPool } from '@alteroid/core';
import { createMemoryStores } from '@alteroid/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

/**
 * HTTP 側（`apps/daemon`）の数値クエリ引数。
 *
 * **PR #1729（`main` の `63ec79e`）が塞いだのは MCP の道具（`packages/core/src/tools.ts`）
 * 側だった。** あちらは入力スキーマ側の `.int()`/`.min()`/`.max()` が SDK の
 * ハンドラ呼び出し**前**の検証で弾かれ、英語の zod の JSON がそのまま返る形
 * だった。
 *
 * **この HTTP の口には、形は同じでも別の機構の穴が在る。** `apps/daemon/src/app.ts`
 * の `jsonBody()`（`POST`/`PUT`/`PATCH` の本文）は `validator('json', schema, hook)`
 * の `hook` を必ず渡すので、スキーマの制約（`.int()`/`.min()`/`.max()` 込み）に
 * 落ちても `hook` が先に呼ばれ、日本語の平文 `{ error: '入力の形が不正: <path>' }`
 * を返す（`@hono/standard-validator@0.4.0` の `sValidator` は、スキーマ検証と
 * `hook` 呼び出しを**同じ関数の中で**行うため——tools.ts の SDK 側のような
 * 「ハンドラより前の別の検証層」が無い）。
 *
 * **ところがクエリ（`validator('query', …)`）は10箇所とも `hook` を渡していない。**
 * `hook` 無しだと `@hono/standard-validator` の既定 400
 * （`{ data: <クエリそのもの>, error: <zod の issue 配列（英語）>, success: false }`）
 * に落ちる——`jsonBody` の doc に書いてある実測（issue #424）と同じ形が、
 * クエリでは直っていなかった。
 *
 * **不変（この歯が守るもの）**: 数値クエリが範囲外・非整数のとき —
 * 1. ステータスは 400
 * 2. 本文は `{ error: string }` のみ（`data` も `success` も無い）
 * 3. `error` は日本語の平文で、英語の zod の issue（`code`/`message`/`expected` 等）
 *    を1文字も含まない
 * 4. 送られた値そのものを1文字も含まない（`whereValidationFailed` の不変条件を
 *    クエリ側にも揃える）
 *
 * 許す範囲は1つも変えない——境界値（`min`/`max` ちょうど）は従来どおり 200 で
 * 通ることも表の中で測る。
 */

/**
 * `GET /usage`（`clone.managers.list()`）・`DELETE /archive/:id`
 * （`clone.managers.runningManagerOwning()`）が実際に呼ぶだけの最小実装。
 * このファイルの主題（クエリの数値検査）には無関係な口なので、走行中の
 * マネージャーが1件も無い・拒否も無い、という素の状態だけを返す。
 */
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

/** 400 応答の本文が、日本語の平文だけであることを測る共通のアサーション。 */
async function expectPlainJapanese400(res: Response, field: string) {
  const text = await res.text();
  expect(res.status, `本文: ${text}`).toBe(400);
  const body: unknown = JSON.parse(text);
  expect(body, `本文: ${text}`).toEqual({ error: `入力の形が不正: ${field}` });
  // 英語の zod の issue が混ざっていないこと（`code`/`message`/`expected` はどれも
  // zod の ZodIssue が持つ欄で、日本語の平文には現れない語である）。
  expect(text).not.toMatch(/"code"|"message"|"expected"|"success"|"data"/);
}

describe('クエリの数値引数（範囲外・非整数）は日本語の平文で400（HTTP 側、issue #424 の続き）', () => {
  const cases: {
    route: string;
    field: string;
    build: (value: string) => string;
    invalid: { label: string; value: string }[];
    valid: string[];
    /**
     * 境界値・既定値を渡したときに期待するステータス。既定 200。
     * `/conversations/:id` は id 自体が存在しないので、クエリの検査さえ
     * 通れば（＝400にならなければ）404 でよい——ここで測りたいのは
     * 「クエリの検査を通り抜けたか」であって「該当する会話があるか」では
     * ない。
     */
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

  /**
   * 送信した値そのものが応答に1文字も混ざらないことを、境界外の**具体的な値**で
   * 個別に確かめる（`whereValidationFailed` の不変条件——`jsonBody` と同じ
   * 保証をクエリ側にも揃える）。
   */
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

/**
 * 数値を持たないクエリスキーマ（`usageQuery` / `journalStreamQuery` /
 * `archiveRemoveQuery`）も、`jsonBody` と対になるラッパー（`queryParams`）へ
 * 揃っていることを見る——**壊れ方を再現できる数値欄が無いだけで、既定の
 * 400（`{data, error, success}`）に落ちる経路自体は他の7経路と同じ**
 * `validator('query', schema)` の呼び方だった。ここでは「クエリが壊れて
 * いなければ従来どおり200で通る」までを測り、生の直接呼び出しが1つも
 * 残っていないことは `app-ts-query-json-validator-wrapped.test.ts` が
 * ソースを静的に見て測る。
 */
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

/**
 * JSON 本文側の数値欄（`jsonBody()` 経由）は、この PR より前から安全である
 * ことを回帰の歯として固定する。
 *
 * **なぜクエリと違う結論になるか。** `@hono/standard-validator@0.4.0` の
 * `sValidator` は `schema['~standard'].validate(value)` を呼んだ**同じ関数の
 * 中で** `hook` を呼ぶ（`node_modules/.../@hono/standard-validator/dist/index.mjs`
 * の `sValidator` 実装、逐語で確認済み）。MCP の道具（`packages/core/src/tools.ts`、
 * PR #1729）が踏んだ穴は、SDK がハンドラより**前**の別の検証層（生成した JSON
 * Schema）で `.int()`/`.min()`/`.max()` を落としていたことだった。HTTP の
 * `jsonBody`/`queryParams` にはその「別の検証層」が無く、`hook` を渡している限り
 * スキーマ側に `.int()`/`.min()`/`.max()` が直書きされていても `hook` が必ず
 * 先に呼ばれる——だから `POST /schedule` の `spec.every.minutes`（`z.number().int().min(1)`、
 * `packages/core/src/schema.ts` の `scheduleSpecSchema`）のように制約が入力
 * スキーマに直書きのままでも安全である。
 *
 * ここで測るのは「すでに安全」であって「この PR が直した」ではない
 * ——直す前から `jsonBody` の `hook` が効いていた（issue #424）。この歯が
 * 無ければ、将来誰かが `jsonBody` の呼び出しから `onInvalid` を外す・
 * `hook` を省略する形に書き換えても、赤くなる場所が無い。
 */
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

/**
 * パス引数（`c.req.param()`）の手組みの数値検査（`Number(raw)` +
 * `Number.isInteger` + `<= 0` 判定、issue #1670）も、この PR の対象では
 * ないが「数値の欄を1つ残らず数える」の一環として実測しておく。**この経路は
 * 元から自前で日本語の平文を返しており、`validator`/`jsonBody`/`queryParams`
 * のどれも経由しない**（`app.ts` の `GET /practices/:slug/versions/:version`）。
 */
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
