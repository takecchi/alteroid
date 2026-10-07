import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import type { Db } from './db.js';
import { migrate } from './migrate.js';

// テスト間で DB を共有しない: truncate / ROLLBACK で分離する形は、分離が壊れたとき静かに壊れるため。
// `PGlite#clone()` を使わない: 呼ぶたびに dump し直すので、dump を1回に絞って `loadDataDir` だけ繰り返す。
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

export function migratedTemplate(): Promise<Blob> {
  template ??= buildTemplate();
  return template;
}

export async function createMigratedPglite(): Promise<{ client: PGlite; db: Db }> {
  const loadDataDir = await migratedTemplate();
  const client = new PGlite({ loadDataDir });
  await client.waitReady;
  return { client, db: drizzle(client) };
}
