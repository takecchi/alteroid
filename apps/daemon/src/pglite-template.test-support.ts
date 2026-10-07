import { PGlite } from '@electric-sql/pglite';
import { migrate, type Db } from '@alteroid/storage-pg';
import { drizzle } from 'drizzle-orm/pglite';

// `storage-pg` の同名の補助を複製して daemon 側に置く: `@alteroid/storage-pg` の `exports` は `dist` だけを指し、テスト用の出口を足すと本番のパッケージの面にテストの補助が載るため。
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
