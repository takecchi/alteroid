import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { Logger } from 'drizzle-orm/logger';
import pg from 'pg';
import { beforeAll } from 'vitest';

import type { Db } from './db.js';
import { migrate } from './migrate.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// テスト間で DB を共有しない: truncate / ROLLBACK で分離する形は、分離が壊れたとき静かに壊れるため。
// 雛形の作成と複製を advisory lock で直列化する: TEMPLATE の元 DB へ他の接続があると `CREATE DATABASE` が落ちるため。
export interface TestDbHandle {
  query<T = unknown>(sql: string): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  withLogger(logger: Logger): Db;
}

export function realPostgresUrl(): string | undefined {
  const url = process.env.ALTEROID_TEST_PG_URL;
  return url === undefined || url === '' ? undefined : url;
}

const ADMIN_LOCK = 0x616c7465;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let templateName: Promise<string> | undefined;

function sourceHash(): string {
  const hash = createHash('sha1');
  for (const file of ['migrate.ts', 'schema.ts']) {
    hash.update(readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  return hash.digest('hex').slice(0, 10);
}

async function adminQuery<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function realPostgresCollation(url: string): Promise<string> {
  return adminQuery(url, async (client) => {
    const result = await client.query<{ datcollate: string }>(
      'select datcollate from pg_database where datname = current_database()',
    );
    return result.rows[0]!.datcollate;
  });
}

async function ensureTemplate(url: string): Promise<string> {
  return adminQuery(url, async (admin) => {
    await admin.query('select pg_advisory_lock($1)', [ADMIN_LOCK]);
    try {
      const current = await admin.query<{ datcollate: string; datctype: string }>(
        'select datcollate, datctype from pg_database where datname = current_database()',
      );
      const { datcollate, datctype } = current.rows[0]!;
      const name = `alteroid_tpl_${datcollate.replace(/\W/g, '_')}_${sourceHash()}`;
      const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
      if (exists.rowCount === 0) {
        const building = `${name}_b${randomBytes(3).toString('hex')}`;
        await admin.query(
          `create database ${quoteIdent(building)} template template0 encoding 'UTF8' ` +
            `lc_collate ${quoteLiteral(datcollate)} lc_ctype ${quoteLiteral(datctype)}`,
        );
        const pool = new pg.Pool({ connectionString: withDatabase(url, building), max: 1 });
        try {
          await migrate(drizzlePg(pool));
        } finally {
          await pool.end();
        }
        // 作り終えてから改名する: 途中で落ちた半端な雛形を名前で拾わないため。
        await admin.query(`alter database ${quoteIdent(building)} rename to ${quoteIdent(name)}`);
      }
      return name;
    } finally {
      await admin.query('select pg_advisory_unlock($1)', [ADMIN_LOCK]);
    }
  });
}

async function createRealDb(
  url: string,
  template: string | undefined,
): Promise<{ client: TestDbHandle; db: Db }> {
  const name = `alteroid_t_${process.pid}_${randomBytes(4).toString('hex')}`;
  await adminQuery(url, async (admin) => {
    await admin.query('select pg_advisory_lock($1)', [ADMIN_LOCK]);
    try {
      if (template === undefined) {
        const current = await admin.query<{ datcollate: string; datctype: string }>(
          'select datcollate, datctype from pg_database where datname = current_database()',
        );
        const { datcollate, datctype } = current.rows[0]!;
        await admin.query(
          `create database ${quoteIdent(name)} template template0 encoding 'UTF8' ` +
            `lc_collate ${quoteLiteral(datcollate)} lc_ctype ${quoteLiteral(datctype)}`,
        );
      } else {
        await admin.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
      }
    } finally {
      await admin.query('select pg_advisory_unlock($1)', [ADMIN_LOCK]);
    }
  });

  const testUrl = withDatabase(url, name);
  const pool = new pg.Pool({ connectionString: testUrl, max: 4 });
  // idle 接続のエラーで落とさない: close 時に DROP DATABASE FORCE が接続を切るため。
  pool.on('error', () => {});
  const extra: pg.Pool[] = [];
  const client: TestDbHandle = {
    async query<T = unknown>(sql: string) {
      const result = await pool.query(sql);
      return { rows: result.rows as T[] };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    withLogger(logger) {
      const loggingPool = new pg.Pool({ connectionString: testUrl, max: 1 });
      loggingPool.on('error', () => {});
      extra.push(loggingPool);
      return drizzlePg(loggingPool, { logger });
    },
    async close() {
      await Promise.all([pool, ...extra].map((p) => p.end()));
      await adminQuery(url, (admin) =>
        admin.query(`drop database if exists ${quoteIdent(name)} with (force)`),
      );
    },
  };
  return { client, db: drizzlePg(pool) };
}

function pgliteHandle(client: PGlite): TestDbHandle {
  return {
    query: <T = unknown>(sql: string) => client.query<T>(sql),
    exec: async (sql) => {
      await client.exec(sql);
    },
    close: () => client.close(),
    withLogger: (logger) => drizzlePglite(client, { logger }),
  };
}

// ファイルごとに `beforeAll` を書く形にしない: 忘れが再発し、最初の `beforeEach` が雛形の作成を払って hookTimeout を越えるため。この補助を import すれば自動で掛かる。
export const TEMPLATE_PREPAY_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  const url = realPostgresUrl();
  if (url !== undefined) {
    templateName ??= ensureTemplate(url);
    await templateName;
    return;
  }
  await migratedTemplate();
}, TEMPLATE_PREPAY_TIMEOUT_MS);

export async function createMigratedTestDb(): Promise<{ client: TestDbHandle; db: Db }> {
  const url = realPostgresUrl();
  if (url !== undefined) {
    templateName ??= ensureTemplate(url);
    return createRealDb(url, await templateName);
  }
  const { client, db } = await createMigratedPglite();
  return { client: pgliteHandle(client), db };
}

export async function createEmptyTestDb(): Promise<{ client: TestDbHandle; db: Db }> {
  const url = realPostgresUrl();
  if (url !== undefined) return createRealDb(url, undefined);
  const client = new PGlite();
  await client.waitReady;
  return { client: pgliteHandle(client), db: drizzlePglite(client) };
}
