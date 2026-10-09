import {
  DEFAULT_ATTACHMENT_LIMITS,
  MemoryAttachmentStore,
  createAuthProviderRegistry,
  createAuthService,
  createMemoryStores,
  type AttachmentLimits,
  type CloneHost,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { planAttachmentBlobs, planStorage } from './storage.js';

const OPERATOR = { authorization: 'Bearer test-token' };

const LIMITS: AttachmentLimits = {
  ...DEFAULT_ATTACHMENT_LIMITS,
  maxImageBytes: 6,
  maxFileBytes: 4,
  maxLargeFileBytes: 10,
};

function setup(limits: AttachmentLimits, storeLimits: AttachmentLimits = limits) {
  const attachments = new MemoryAttachmentStore({ limits: storeLimits });
  const stores = { ...createMemoryStores(), attachments };
  const app = createApp({
    clone: {} as CloneHost,
    stores,
    token: 'test-token',
    shutdown: () => undefined,
    attachmentLimits: limits,
    auth: {
      plan: {
        enabled: true,
        providers: [],
        publicBaseUrl: 'http://127.0.0.1:4517',
        tokenTtlDays: 30,
        description: 'テスト',
      },
      service: createAuthService({ store: stores.auth, providers: createAuthProviderRegistry([]) }),
    },
  });
  return { app, attachments };
}

/** content-length を付けない（chunked）本文。 */
function chunkedBody(size: number, chunk = 3): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const n = Math.min(chunk, size - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(7));
    },
  });
}

function postChunked(app: ReturnType<typeof setup>['app'], size: number) {
  return app.request('/attachments?name=big.bin&type=application%2Foctet-stream', {
    method: 'POST',
    headers: { ...OPERATOR, 'content-type': 'application/octet-stream' },
    body: chunkedBody(size),
    // Node の fetch は、ストリームの本文に duplex を要る
    duplex: 'half',
  } as RequestInit);
}

describe('POST /attachments の本文の上限（大きいファイルの別枠。#4128 段2）', () => {
  it('chunked の本文が上限を超えれば 413（too_large）で、何も残らない', async () => {
    const { app, attachments } = setup(LIMITS);
    const res = await postChunked(app, 11);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'too_large' });
    expect((await attachments.list({ limit: 10 })).items).toEqual([]);
  });

  it('chunked の本文が別枠の上限ちょうどなら通る（maxFileBytes を超えていても）', async () => {
    const { app, attachments } = setup(LIMITS);
    const res = await postChunked(app, 10);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: 10 });
    expect((await attachments.list({ limit: 10 })).items).toHaveLength(1);
  });

  it('口の上限は、置き場の上限と食い違っても効く（chunked の本文を数えるだけの流れで包む）', async () => {
    const { app, attachments } = setup(LIMITS, DEFAULT_ATTACHMENT_LIMITS);
    const res = await postChunked(app, 11);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: '添付は 1 つ 10 バイトまで', code: 'too_large' });
    expect((await attachments.list({ limit: 10 })).items).toEqual([]);
  });

  it('別枠が無ければ maxFileBytes を超える chunked の本文は 413', async () => {
    const { app, attachments } = setup({ ...LIMITS, maxLargeFileBytes: 0 });
    const res = await postChunked(app, 5);
    expect(res.status).toBe(413);
    expect((await attachments.list({ limit: 10 })).items).toEqual([]);
  });

  it('content-length が上限を超えれば、読まずに 413 と今までと同じ文言', async () => {
    const { app, attachments } = setup(LIMITS);
    const res = await app.request('/attachments?name=big.bin&type=application%2Foctet-stream', {
      method: 'POST',
      // `Request` の本文は content-length を自動では載せない（実サーバでは届く）ので、ヘッダで明示する
      headers: {
        ...OPERATOR,
        'content-type': 'application/octet-stream',
        'content-length': '11',
      },
      body: new Uint8Array(11),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: '添付は 1 つ 10 バイトまで', code: 'too_large' });
    expect((await attachments.list({ limit: 10 })).items).toEqual([]);
  });

  it('GET /attachments/limits は maxLargeFileBytes を返す', async () => {
    const { app } = setup(LIMITS);
    const res = await app.request('/attachments/limits', { headers: OPERATOR });
    expect(await res.json()).toMatchObject({ maxFileBytes: 4, maxLargeFileBytes: 10 });
  });
});

describe('planAttachmentBlobs（置き場の実際の構成から、外部ストレージと上限を決める）', () => {
  const S3 = {
    ALTEROID_ATTACHMENT_S3_BUCKET: 'bkt',
    ALTEROID_ATTACHMENT_S3_ACCESS_KEY_ID: 'AKIADUMMY',
    ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY: 'dummy-secret',
  };
  const run = (env: NodeJS.ProcessEnv, kind: 'fs' | 'pg') => {
    const lines: string[] = [];
    const plan = planAttachmentBlobs(env, kind, (line) => lines.push(line));
    return { ...plan, lines };
  };

  it('pg で設定が読めれば使う。大きいファイルの枠は 2 GiB', () => {
    const got = run(S3, 'pg');
    expect(got.config?.bucket).toBe('bkt');
    expect(got.limits.maxLargeFileBytes).toBe(2147483648);
    expect(got.lines).toEqual([]);
  });

  it('未設定なら使わず、枠は 0（無言）', () => {
    const got = run({}, 'pg');
    expect(got.config).toBeUndefined();
    expect(got.limits.maxLargeFileBytes).toBe(0);
    expect(got.lines).toEqual([]);
  });

  it('fs の置き場では使わない。枠を 0 に揃え、stderr に1行', () => {
    const got = run({ ...S3, ALTEROID_ATTACHMENT_MAX_LARGE_FILE_BYTES: '4096' }, 'fs');
    expect(got.config).toBeUndefined();
    expect(got.limits.maxLargeFileBytes).toBe(0);
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0]).toContain('fs の置き場では使わない');
  });

  it('設定が不正なら起動は続け、外部ストレージは使わず、理由を1行（値は載せない）', () => {
    const got = run(
      { ALTEROID_ATTACHMENT_S3_BUCKET: 'secret-bkt', ALTEROID_ATTACHMENT_S3_ACCESS_KEY_ID: 'k' },
      'pg',
    );
    expect(got.config).toBeUndefined();
    expect(got.limits.maxLargeFileBytes).toBe(0);
    expect(got.lines).toHaveLength(1);
    expect(got.lines[0]).toContain('ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY');
    expect(got.lines[0]).not.toContain('secret-bkt');
  });

  it('資格の環境変数は、設定されているときだけ担い手の子プロセスから伏せる', () => {
    expect(planStorage({}).withheldEnvKeys).not.toContain(
      'ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY',
    );
    const withheld = planStorage({
      ...S3,
      ALTEROID_DATABASE_URL: 'postgres://u:p@h/d',
    }).withheldEnvKeys;
    expect(withheld).toContain('ALTEROID_ATTACHMENT_S3_SECRET_ACCESS_KEY');
    expect(withheld).toContain('ALTEROID_ATTACHMENT_S3_ACCESS_KEY_ID');
  });
});
