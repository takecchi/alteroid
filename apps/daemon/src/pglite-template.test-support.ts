import { PGlite } from '@electric-sql/pglite';
import { migrate, type Db } from '@alteroid/storage-pg';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * テスト用の補助: 「空の、migrate 済みの、自分専用の PGlite」を安く作る。
 *
 * `packages/storage-pg/src/pglite-template.test-support.ts`（PR #2300）と同じ形の複製。
 * 二重に置く理由: `@alteroid/storage-pg` の `exports` は `dist` だけを指し、テスト用の
 * 出口を足すと本番のパッケージの面（と tsup のビルド）にテストの補助が載る。daemon が
 * 使う `migrate` は既に公開されているので、20行ほどの補助を daemon 側に置くほうが小さい。
 *
 * **何をするか。** ワーカーのプロセスの中で `new PGlite()` + `migrate` を **1回だけ**
 * 走らせ、その data dir を tar（`dumpDataDir('none')`）として持つ。以降は
 * `new PGlite({ loadDataDir })` でその tar から起こす。返す複製は雛形と独立した別の
 * PGlite で、片方への書き込みは他方に見えない（`pglite-template.test.ts` が測る）。
 * 各テストは今までどおり、空の migrate 済みの自分専用の DB から始まる。
 *
 * **使わないもの。** migrate の前の状態・旧スキーマ・起動オプションを作るテストは
 * この補助を通さない（今の daemon のテストには無い）。
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
 * 空の、migrate 済みの、自分専用の PGlite を返す。呼び手が `client.close()` する
 * （今までも閉じていなかったテストは、閉じないまま）。
 */
export async function createMigratedPglite(): Promise<{ client: PGlite; db: Db }> {
  const loadDataDir = await migratedTemplate();
  const client = new PGlite({ loadDataDir });
  await client.waitReady;
  return { client, db: drizzle(client) };
}
