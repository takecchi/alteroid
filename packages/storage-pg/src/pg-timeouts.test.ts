import { createServer, type Server, type Socket } from 'node:net';

import { RequestTiming, runWithRequestTiming } from '@alteroid/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTimedPool,
  PgTimeoutError,
  type PgTimeoutEvent,
  withPgQueryTimeout,
} from './pg-timeouts.js';

// pg の単純な問い合わせ（`Q`）だけを話す偽のサーバー。本文に `hang` を含めば答えない、`slow` を含めば 150ms 後に答える。
// `silent` なら繋いだ後の起動の挨拶にも答えない（繋ぐ期限の歯）
interface FakePg {
  url: string;
  connections: () => number;
  close: () => Promise<void>;
}

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const READY = message('Z', Buffer.from('I', 'latin1'));
const AUTH_OK = message('R', Buffer.from([0, 0, 0, 0]));
const DONE = Buffer.concat([message('C', Buffer.from('SELECT 0\0', 'latin1')), READY]);

async function startFakePg(options: { silent?: boolean } = {}): Promise<FakePg> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (options.silent === true) return;
    let buffered = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (!started) {
          if (buffered.length < 4) return;
          const length = buffered.readInt32BE(0);
          if (buffered.length < length) return;
          buffered = buffered.subarray(length);
          started = true;
          socket.write(Buffer.concat([AUTH_OK, READY]));
          continue;
        }
        if (buffered.length < 5) return;
        const type = buffered.toString('latin1', 0, 1);
        const length = buffered.readInt32BE(1);
        if (buffered.length < length + 1) return;
        const body = buffered.toString('utf8', 5, length + 1);
        buffered = buffered.subarray(length + 1);
        if (type === 'X') {
          socket.end();
          return;
        }
        if (type !== 'Q') continue;
        if (body.includes('hang')) continue;
        if (body.includes('slow')) {
          setTimeout(() => socket.write(DONE), 150);
          continue;
        }
        socket.write(DONE);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('偽のサーバーの番地が取れない');
  return {
    url: `postgres://u:p@127.0.0.1:${String(address.port)}/db`,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: { silent?: boolean; max?: number; queryTimeoutMs?: number } = {},
): Promise<{ fake: FakePg; pool: ReturnType<typeof createTimedPool>; events: PgTimeoutEvent[] }> {
  const fake = await startFakePg(options);
  cleanups.push(fake.close);
  const events: PgTimeoutEvent[] = [];
  const pool = createTimedPool({
    connectionString: fake.url,
    ...(options.max === undefined ? {} : { max: options.max }),
    connectTimeoutMs: 100,
    queryTimeoutMs: options.queryTimeoutMs ?? 50,
    onTimeout: (event) => events.push(event),
  });
  cleanups.push(() => pool.end().catch(() => undefined));
  return { fake, pool, events };
}

describe('PostgreSQL の問い合わせと接続に期限を付ける（#4655）', () => {
  it('⭐ 返らない問い合わせは既定の期限で打ち切り、接続を切って捨て、次の問い合わせは繋ぎ直して通る', async () => {
    const { fake, pool, events } = await setup();

    const error = await pool.query('select hang').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PgTimeoutError);
    expect((error as PgTimeoutError).kind).toBe('query');
    expect(events).toEqual([{ kind: 'query', timeoutMs: 50, sql: 'select hang' }]);

    await expect(pool.query('select ok')).resolves.toBeDefined();
    expect(fake.connections()).toBe(2);
  });

  it('トランザクションのように借りた接続でも打ち切り、返した接続はプールが捨てる（落ちない）', async () => {
    const { pool } = await setup();
    const client = await pool.connect();
    const error = await client.query('select hang').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PgTimeoutError);
    client.release();
    expect(pool.totalCount).toBe(0);
    await expect(pool.query('select ok')).resolves.toBeDefined();
  });

  it('withPgQueryTimeout の中では期限が延びる', async () => {
    const { pool, events } = await setup();
    await expect(withPgQueryTimeout(1_000, () => pool.query('select slow'))).resolves.toBeDefined();
    expect(events).toEqual([]);
    // 外では既定の期限のまま
    await expect(pool.query('select slow')).rejects.toBeInstanceOf(PgTimeoutError);
  });

  it('⭐ 空きを待ってから打つ問い合わせも、呼んだ時点の延びた期限で打つ', async () => {
    const { pool, events } = await setup({ max: 1 });
    const held = await pool.connect();
    // 延ばした文脈の外で返す: 空きを待っていた問い合わせは、返した側の文脈で打たれる
    setTimeout(() => held.release(), 20);
    await expect(withPgQueryTimeout(1_000, () => pool.query('select slow'))).resolves.toBeDefined();
    expect(events).toEqual([]);
  });

  it('起動の挨拶に答えない相手には、繋ぐ期限で打ち切る', async () => {
    const { pool, events } = await setup({ silent: true });
    const error = await pool.query('select ok').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PgTimeoutError);
    expect((error as PgTimeoutError).kind).toBe('connect');
    expect(events).toEqual([{ kind: 'connect', timeoutMs: 100 }]);
  });

  it('プールが埋まったまま空かなければ、空きを待つのも繋ぐ期限で打ち切る', async () => {
    const { pool, events } = await setup({ max: 1 });
    const held = await pool.connect();
    const error = await pool.query('select ok').catch((caught: unknown) => caught);
    held.release();
    expect(error).toBeInstanceOf(PgTimeoutError);
    expect((error as PgTimeoutError).kind).toBe('connect');
    expect(events).toEqual([{ kind: 'connect', timeoutMs: 100 }]);
  });
});

describe('HTTP の要求の器へ、問い合わせの本数・時間・空き待ちを数える（#5089）', () => {
  it('⭐ 要求の中で打った問い合わせだけを数え、最も長い1本の SQL の頭を残す', async () => {
    const { pool } = await setup({ queryTimeoutMs: 1_000 });
    const timing = new RequestTiming();
    await runWithRequestTiming(timing, async () => {
      await pool.query('select ok');
      await pool.query('select slow from journal');
    });
    // 外で打った分は数えない
    await pool.query('select ok');

    expect(timing.db.count).toBe(2);
    expect(timing.db.slowestSql).toBe('select slow from journal');
    expect(timing.db.slowestMs).toBeGreaterThanOrEqual(100);
    expect(timing.db.wallMs).toBeGreaterThanOrEqual(timing.db.slowestMs);
  });

  it('借りた接続（トランザクション）で打った問い合わせも数える', async () => {
    const { pool } = await setup({ queryTimeoutMs: 1_000 });
    const timing = new RequestTiming();
    await runWithRequestTiming(timing, async () => {
      const client = await pool.connect();
      await client.query('begin');
      await client.query('select ok');
      await client.query('commit');
      client.release();
    });
    expect(timing.db.count).toBe(3);
  });

  it('⭐ 空きを待ってから打つ問い合わせは、返した側ではなく呼んだ要求に数え、待った時間も足す', async () => {
    const { pool } = await setup({ max: 1, queryTimeoutMs: 1_000 });
    const held = await pool.connect();
    const other = new RequestTiming();
    const timing = new RequestTiming();
    // 別の要求の文脈で返す
    setTimeout(() => {
      void runWithRequestTiming(other, async () => {
        held.release();
      });
    }, 30);
    await runWithRequestTiming(timing, () => pool.query('select ok'));

    expect(timing.db.count).toBe(1);
    expect(timing.db.waitMs).toBeGreaterThanOrEqual(20);
    expect(other.db.count).toBe(0);
  });

  it('失敗した問い合わせも1本に数える', async () => {
    const { pool } = await setup();
    const timing = new RequestTiming();
    await runWithRequestTiming(timing, () => pool.query('select hang').catch(() => undefined));
    expect(timing.db.count).toBe(1);
  });
});
