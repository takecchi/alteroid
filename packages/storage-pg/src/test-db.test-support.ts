import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { Logger } from 'drizzle-orm/logger';
import pg from 'pg';

import type { Db } from './db.js';
import { migrate } from './migrate.js';
import { createMigratedPglite } from './pglite-template.test-support.js';

/**
 * テスト用の補助: 「空の、migrate 済みの、自分専用の DB」を返す。**PGlite か本物の
 * PostgreSQL かを環境変数で切り替える**（#2918）。
 *
 * - `ALTEROID_TEST_PG_URL` が**無い** → 従来どおり PGlite（`createMigratedPglite`）。
 *   手元・既存の CI はこちら。
 * - `ALTEROID_TEST_PG_URL` が**ある** → その PostgreSQL へ繋ぎ、テストごとに
 *   **別の DATABASE** を切る。同じ接続先の DB の照合順・文字コードを引き継ぐ
 *   （本番と同じ条件で差を出すため。`en_US.UTF-8` と `C` を CI が両方回す）。
 *
 * **なぜ要るか。** storage-pg のテストは全部 PGlite で走る。PGlite と本物の差
 * （照合順・NUL・timestamp・bigint の文字列化）で本番だけ壊れうる。**テストを
 * 複製せず**、既存のテストファイルを同じまま本物へ向ける。
 *
 * **分離。** 雛形 DB（migrate 済み）を (照合順, migrate のソースの内容) ごとに1つ
 * 作り、各テストは `CREATE DATABASE ... TEMPLATE` でそこから起こす。テスト間で DB を
 * 共有する形（truncate / ROLLBACK）は採らない — PGlite 側と同じ理由（分離が壊れた
 * とき静かに壊れる）。雛形の作成と複製は advisory lock で直列化する（TEMPLATE の
 * 元 DB へ他の接続があると `CREATE DATABASE` が落ちるため、並列のワーカーが同時に
 * 複製しない）。**雛形 DB は消さない**（接続先は使い捨ての前提。手元で使ったら
 * `.claude/skills/postgres-in-container/SKILL.md` の手順で掃除する）。
 *
 * **接続先の DB は管理用に使うだけで、テストの行は書かない。** 接続のユーザーは
 * `CREATEDB` を持つこと。
 */
export interface TestDbHandle {
  /** `PGlite#query` と同じ形の素の SQL。`rows` だけを使う。 */
  query(sql: string): Promise<{ rows: unknown[] }>;
  close(): Promise<void>;
  /** 同じ DB へ繋ぐ、SQL ログ付きのハンドル（drizzle の `logger`）。 */
  withLogger(logger: Logger): Db;
}

export function realPostgresUrl(): string | undefined {
  const url = process.env.ALTEROID_TEST_PG_URL;
  return url === undefined || url === '' ? undefined : url;
}

const ADMIN_LOCK = 0x616c7465; // 'alte'

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

/** migrate のソースが変わったら雛形も作り直す（古い雛形を黙って使わない）。 */
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

/** 接続先の DB の照合順（`datcollate`）。テストの出力と雛形の名前に使う。 */
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
        // 作り終えてから改名する（途中で落ちた半端な雛形を、名前で拾わない）。
        await admin.query(`alter database ${quoteIdent(building)} rename to ${quoteIdent(name)}`);
      }
      return name;
    } finally {
      await admin.query('select pg_advisory_unlock($1)', [ADMIN_LOCK]);
    }
  });
}

async function createRealDb(url: string): Promise<{ client: TestDbHandle; db: Db }> {
  templateName ??= ensureTemplate(url);
  const template = await templateName;
  const name = `alteroid_t_${process.pid}_${randomBytes(4).toString('hex')}`;
  await adminQuery(url, async (admin) => {
    await admin.query('select pg_advisory_lock($1)', [ADMIN_LOCK]);
    try {
      await admin.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
    } finally {
      await admin.query('select pg_advisory_unlock($1)', [ADMIN_LOCK]);
    }
  });

  const testUrl = withDatabase(url, name);
  const pool = new pg.Pool({ connectionString: testUrl, max: 4 });
  // idle 接続のエラーで落とさない（close 時に DROP DATABASE FORCE が接続を切る）。
  pool.on('error', () => {});
  const extra: pg.Pool[] = [];
  const client: TestDbHandle = {
    async query(sql) {
      const result = await pool.query(sql);
      return { rows: result.rows };
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
    query: (sql) => client.query(sql),
    close: () => client.close(),
    withLogger: (logger) => drizzlePglite(client, { logger }),
  };
}

/**
 * 空の、migrate 済みの、自分専用の DB を返す。呼び手が `client.close()` する。
 * `ALTEROID_TEST_PG_URL` があれば本物の PostgreSQL、無ければ PGlite。
 */
export async function createMigratedTestDb(): Promise<{ client: TestDbHandle; db: Db }> {
  const url = realPostgresUrl();
  if (url !== undefined) return createRealDb(url);
  const { client, db } = await createMigratedPglite();
  return { client: pgliteHandle(client), db };
}
