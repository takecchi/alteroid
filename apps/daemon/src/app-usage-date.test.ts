import {
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  fakeCloneHost as fakeCloneHostBase,
  usageDate,
} from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

function fakeCloneHost(stores: Stores): CloneHost {
  return fakeCloneHostBase({
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
  });
}

function appWith(
  now?: () => Date,
  resolveTimeZone?: () => string | undefined,
): ReturnType<typeof createApp> {
  const stores = createMemoryStores();
  return createApp({
    clone: fakeCloneHost(stores),
    stores,
    token: 'test-token',
    shutdown: () => {},
    ...(now === undefined ? {} : { now }),
    ...(resolveTimeZone === undefined ? {} : { resolveTimeZone }),
  });
}

describe('GET /usage の from / to は、実在しない日を 400 で断る（Issue #2156）', () => {
  const unreal = ['2026-02-30', '2026-13-01', '2026-00-00', '2026-04-31', '2025-02-29'] as const;
  for (const date of unreal) {
    it(`from=${date} は 400`, async () => {
      const app = appWith();
      expect((await app.request(`/usage?from=${date}`)).status).toBe(400);
    });
    it(`to=${date} は 400`, async () => {
      const app = appWith();
      expect((await app.request(`/usage?to=${date}`)).status).toBe(400);
    });
  }

  it('形の合わない値も、いまどおり 400', async () => {
    const app = appWith();
    expect((await app.request('/usage?from=2026-8-1')).status).toBe(400);
    expect((await app.request('/usage?to=yesterday')).status).toBe(400);
  });

  it('実在する日（閏年の 2/29 を含む）は通す', async () => {
    const app = appWith();
    expect((await app.request('/usage?from=2024-02-29&to=2026-08-31')).status).toBe(200);
    expect((await app.request('/usage?from=2026-12-31')).status).toBe(200);
  });
});

describe('GET /usage の today は、台帳の日と同じ関数・同じ TZ の値（Issue #2268）', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  });

  const instant = new Date('2026-09-30T00:30:00Z');
  const cases = [
    ['UTC', '2026-09-30'],
    ['Asia/Tokyo', '2026-09-30'],
    ['America/Los_Angeles', '2026-09-29'],
  ] as const;
  for (const [tz, expected] of cases) {
    it(`TZ=${tz} で、注入した時計 ${instant.toISOString()} の today は ${expected}`, async () => {
      process.env['TZ'] = tz;
      const app = appWith(() => instant);
      const res = await app.request('/usage');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { today: string };
      expect(body.today).toBe(expected);
      expect(body.today).toBe(usageDate(instant));
    });
  }
});

describe('GET /usage の ledgerTimeZone は、台帳の日を決める TZ の名前', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    if (originalTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = originalTz;
  });

  // UTC では 9/30、Asia/Tokyo では 10/1 になる時刻
  const instant = new Date('2026-09-30T20:00:00Z');
  const read = async (app: ReturnType<typeof createApp>) => {
    const res = await app.request('/usage');
    expect(res.status).toBe(200);
    return (await res.json()) as { today: string; ledgerTimeZone: string | null };
  };

  it('実行時の TZ の IANA 名を返し、today の暦日はその TZ で決まる', async () => {
    process.env['TZ'] = 'Asia/Tokyo';
    const tokyo = await read(appWith(() => instant));
    expect(tokyo.ledgerTimeZone).toBe('Asia/Tokyo');
    expect(tokyo.today).toBe('2026-10-01');

    process.env['TZ'] = 'UTC';
    const utc = await read(appWith(() => instant));
    expect(utc.ledgerTimeZone).toBe('UTC');
    expect(utc.today).toBe('2026-09-30');
  });

  it('その名前で時刻を引き直すと today と同じ暦日になる（名前が日付を決めた TZ を指す）', async () => {
    process.env['TZ'] = 'America/Los_Angeles';
    const body = await read(appWith(() => instant));
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: body.ledgerTimeZone ?? 'invalid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
    expect(body.ledgerTimeZone).toBe('America/Los_Angeles');
    expect(day).toBe(body.today);
  });

  it('Intl が TZ 名を解決できないとき、欄を省かず null を返す（UTC などの既定値を埋めない）', async () => {
    process.env['TZ'] = 'Asia/Tokyo';
    const body = await read(
      appWith(
        () => instant,
        () => undefined,
      ),
    );
    expect(body).toHaveProperty('ledgerTimeZone', null);
    expect(body.today).toBe('2026-10-01');
    const empty = await read(
      appWith(
        () => instant,
        () => '',
      ),
    );
    expect(empty.ledgerTimeZone).toBeNull();
  });

  it('Date が使う TZ と食い違う名前は返さない（POSIX 形式の TZ は Date には効くが Intl は名前を持たない）', async () => {
    process.env['TZ'] = 'JST-9';
    const body = await read(appWith(() => instant));
    expect(body.today).toBe('2026-10-01');
    expect(body.ledgerTimeZone).toBeNull();

    // 別の TZ の名前を差し込まれても、実際に日付を決めている TZ と合わなければ採らない
    process.env['TZ'] = 'Asia/Tokyo';
    const mismatch = await read(
      appWith(
        () => instant,
        () => 'America/Los_Angeles',
      ),
    );
    expect(mismatch.ledgerTimeZone).toBeNull();
  });
});
