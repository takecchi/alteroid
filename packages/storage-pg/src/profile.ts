import {
  assertProfileRowWritable,
  compareProfileEntryNames,
  type EnvProfileEntry,
  type EnvProfileScope,
  type ProfileStore,
} from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { envProfile, envProfileEntries } from './schema.js';

function scopeOf(raw: string): EnvProfileScope {
  return raw === 'app' || raw === 'runner' ? raw : 'all';
}

// この表を runner から読ませない: runner に記憶ストアの鍵があることになるため。
export class PgProfileStore implements ProfileStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<EnvProfileEntry[]> {
    const rows = await this.#db.select().from(envProfileEntries);
    return rows
      .filter((row) => row.script.trim().length > 0)
      .map((row) => ({
        name: row.name,
        script: row.script,
        scope: scopeOf(row.scope),
        updatedAt: row.updatedAt.toISOString(),
      }))
      .sort((a, b) => compareProfileEntryNames(a.name, b.name));
  }

  async set(name: string, script: string, scope: EnvProfileScope): Promise<EnvProfileEntry> {
    assertProfileRowWritable({ name, script });
    const at = new Date();
    await this.#db
      .insert(envProfileEntries)
      .values({ name, script, scope, updatedAt: at })
      .onConflictDoUpdate({
        target: envProfileEntries.name,
        set: { script, scope, updatedAt: at },
      });
    return { name, script, scope, updatedAt: at.toISOString() };
  }

  async remove(name: string): Promise<boolean> {
    const removed = await this.#db
      .delete(envProfileEntries)
      .where(eq(envProfileEntries.name, name))
      .returning({ name: envProfileEntries.name });
    return removed.length > 0;
  }

  // `updated_at` も戻す: 成功していない更新でそこが動くと監査情報が嘘になるため。
  async replaceAll(previous: readonly EnvProfileEntry[]): Promise<void> {
    for (const row of previous) assertProfileRowWritable(row);
    await this.#db.transaction(async (tx) => {
      await tx.delete(envProfileEntries);
      if (previous.length === 0) return;
      await tx.insert(envProfileEntries).values(
        previous.map((row) => ({
          name: row.name,
          script: row.script,
          scope: row.scope,
          updatedAt: new Date(row.updatedAt),
        })),
      );
    });
  }

  // 旧表も空にする: 全部外したものが、巻き戻した旧版で蘇らないように。
  async clear(): Promise<number> {
    await this.#db.delete(envProfile);
    const removed = await this.#db
      .delete(envProfileEntries)
      .returning({ name: envProfileEntries.name });
    return removed.length;
  }
}
