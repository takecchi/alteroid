import type { Commitment } from '@alteroid/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PgCommitmentStore } from './commitments.js';
import type { Db } from './db.js';
import {
  createMigratedTestDb,
  realPostgresUrl,
  type TestDbHandle,
} from './test-db.test-support.js';

// 未了の select と片付いた行の問い合わせのあいだに閉じる・開き直すが入っても、行が二重に出たり消えたりしない（#5281）。
// 本物の PostgreSQL でだけ回す: 割り込みには別の接続が要り、PGlite は単一接続で再現できないため。

let client: TestDbHandle;
let writer: PgCommitmentStore;
let readerPool: pg.Pool | undefined;

beforeEach(async () => {
  let db: Db;
  ({ client, db } = await createMigratedTestDb());
  writer = new PgCommitmentStore(db);
});

afterEach(async () => {
  await readerPool?.end();
  readerPool = undefined;
  await client.close();
});

function row(id: string, minute: number): Commitment {
  return {
    id,
    at: new Date(Date.parse('2026-09-01T00:00:00.000Z') + minute * 60_000).toISOString(),
    origin: 'human',
    body: `${id} の本文`,
  };
}

async function closeRow(store: PgCommitmentStore, id: string): Promise<void> {
  await store.close(id, '2026-09-02T00:00:00.000Z', `${id} を片付けた`, 'human');
}

function queryText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  return (arg as { text?: string } | null)?.text ?? '';
}

// 未了の select（`closed_at is null`）が返った直後に、別の接続から `interrupt` を1度だけ差し込む db。
// 返す前に待つ: 次の問い合わせより先に、別の接続の書き込みが済んでいることを保証するため。
async function dbInterruptedAfterOpenSelect(interrupt: () => Promise<void>): Promise<Db> {
  const { rows } = await client.query<{ name: string }>('select current_database() as name');
  const url = new URL(realPostgresUrl()!);
  url.pathname = `/${rows[0]!.name}`;
  const real = new pg.Pool({ connectionString: url.toString(), max: 2 });
  real.on('error', () => {});
  readerPool = real;

  let fired = false;
  const wrapQuery = (target: { query: (...args: unknown[]) => Promise<unknown> }) => {
    return async (...args: unknown[]): Promise<unknown> => {
      const result = await target.query(...args);
      if (!fired && /\bis null\b/.test(queryText(args[0]))) {
        fired = true;
        await interrupt();
      }
      return result;
    };
  };
  const bound = (target: object, prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  // drizzle は pool なら `connect()` で接続を借りて transaction を張るので、両方の `query` を包む
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'query') return wrapQuery(target as never);
      if (prop === 'connect') {
        return async () => {
          const connected = await target.connect();
          return new Proxy(connected, {
            get: (inner, innerProp) =>
              innerProp === 'query' ? wrapQuery(inner as never) : bound(inner, innerProp),
          });
        };
      }
      return bound(target, prop);
    },
  });
  return drizzle(proxy);
}

function countOf(ids: string[], id: string): number {
  return ids.filter((candidate) => candidate === id).length;
}

describe.skipIf(realPostgresUrl() === undefined)(
  'PgCommitmentStore.list({ includeClosed: true }) は1つのスナップショットで読む（#5281）',
  () => {
    it('⭐ 未了の select の直後に別の接続で未了の行 Y が閉じられても、X も Y もちょうど1回出る', async () => {
      await writer.open(row('x', 0));
      await writer.open(row('y', 1));
      await closeRow(writer, 'x');

      let interrupted = false;
      const reader = new PgCommitmentStore(
        await dbInterruptedAfterOpenSelect(async () => {
          await closeRow(writer, 'y');
          interrupted = true;
        }),
      );
      const ids = (await reader.list({ includeClosed: true })).entries.map((entry) => entry.id);
      // 割り込みが入らないまま通る（差し込みが効かなくなった）ことを、ここで落とす
      expect(interrupted).toBe(true);
      expect((await writer.get('y'))?.closedAt).toBeDefined();
      expect(countOf(ids, 'x')).toBe(1);
      expect(countOf(ids, 'y')).toBe(1);
    });

    it('⭐ 未了の select の直後に別の接続で片付いた行 X が開き直されても、X も Y もちょうど1回出る', async () => {
      await writer.open(row('x', 0));
      await writer.open(row('y', 1));
      await closeRow(writer, 'x');

      let interrupted = false;
      const reader = new PgCommitmentStore(
        await dbInterruptedAfterOpenSelect(async () => {
          expect((await writer.reopen('x')).kind).toBe('reopened');
          interrupted = true;
        }),
      );
      const ids = (await reader.list({ includeClosed: true })).entries.map((entry) => entry.id);
      expect(interrupted).toBe(true);
      expect((await writer.get('x'))?.closedAt).toBeUndefined();
      expect(countOf(ids, 'x')).toBe(1);
      expect(countOf(ids, 'y')).toBe(1);
    });
  },
);
