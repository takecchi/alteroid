import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { migrate } from './migrate.js';

/**
 * テスト用の補助: 「空の、migrate 済みの、自分専用の PGlite」を安く作る。
 *
 * **なぜ要るか。** storage-pg のテストは `beforeEach` ごとに `new PGlite()` →
 * `migrate` を通していた。1テストあたり 1.7〜3.5 秒でほぼ一定＝起動と migrate の
 * 固定費が時間の大半を占める（CI の実測は PR 本文）。
 *
 * **何をするか。** ワーカーのプロセスの中で `new PGlite()` + `migrate` を **1回だけ**
 * 走らせ、その data dir を tar（`dumpDataDir('none')`）として持つ。以降は
 * `new PGlite({ loadDataDir })` でその tar から起こす。`PGlite#clone()` の実体も
 * 「`dumpDataDir` → `loadDataDir` で新しく起こす」だが、`clone()` は呼ぶたびに
 * dump し直すので、ここでは dump を1回に絞って `loadDataDir` だけ繰り返す。
 *
 * **保証は変えない。** 返す複製は雛形と独立した別の PGlite で、片方への書き込みは
 * 他方に見えない（`pglite-template.test.ts` が測る）。テスト間で DB を共有する
 * （truncate / ROLLBACK で分離する）形は採らない — 分離が壊れたとき静かに壊れる。
 * 各テストは今までどおり、空の migrate 済みの自分専用の DB から始まる。
 *
 * **使わないもの。** migrate そのもの・旧スキーマからの移行・DDL を測るテストは
 * migrate の前の状態から始める必要があるので、この補助を通さない。
 */
let template: Promise<Blob> | undefined;

async function buildTemplate(): Promise<Blob> {
  const source = new PGlite();
  try {
    await migrate(drizzle(source));
    return await source.dumpDataDir('none');
  } finally {
    await source.close();
  }
}

/** 雛形の tar。ワーカーのプロセスの中で1回だけ作る（Promise を共有する）。 */
export function migratedTemplate(): Promise<Blob> {
  template ??= buildTemplate();
  return template;
}

/**
 * 空の、migrate 済みの、自分専用の PGlite を返す。呼び手が `client.close()` する。
 */
export async function createMigratedPglite(): Promise<{
  client: PGlite;
  db: ReturnType<typeof drizzle>;
}> {
  const loadDataDir = await migratedTemplate();
  const client = new PGlite({ loadDataDir });
  await client.waitReady;
  return { client, db: drizzle(client) };
}
