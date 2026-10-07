import {
  assertValidCredentialEntries,
  CREDENTIAL_NAME,
  describeSkippedCredentialRow,
  type CredentialEntry,
  type CredentialVaultStore,
  type StoredCredential,
} from '@alteroid/core';
import { asc, inArray } from 'drizzle-orm';

import { byteOrder } from './db.js';
import type { Db } from './db.js';
import { daemonState, managerCredentials } from './schema.js';

// この表を runner から読ませない: runner に記憶ストアの鍵があることになるため。
export class PgCredentialVaultStore implements CredentialVaultStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<StoredCredential[]> {
    const rows = await this.#db
      .select()
      .from(managerCredentials)
      .orderBy(asc(byteOrder(managerCredentials.name)));
    const kept: StoredCredential[] = [];
    rows.forEach((row, index) => {
      // 入口の検査だけで済ませない: DB は直接 `insert` できるため、`../../x` のような名前が runner へ降りて器の外を指す。
      if (!CREDENTIAL_NAME.test(row.name)) {
        process.stderr.write(
          `${describeSkippedCredentialRow({ index, reason: 'name の形式が不正', name: row.name })}\n`,
        );
        return;
      }
      kept.push({
        name: row.name,
        value: row.value,
        updatedAt: row.updatedAt.toISOString(),
        scope: (row.scope ?? 'all') as StoredCredential['scope'],
        secret: row.secret ?? true,
      });
    });
    return kept;
  }

  async put(entries: readonly CredentialEntry[]): Promise<StoredCredential[]> {
    assertValidCredentialEntries(entries);
    const at = new Date();
    const removed = entries.filter((entry) => entry.value.length === 0).map((entry) => entry.name);
    const upserted = entries.filter((entry) => entry.value.length > 0);

    if (removed.length > 0) {
      await this.#db.delete(managerCredentials).where(inArray(managerCredentials.name, removed));
    }
    for (const entry of upserted) {
      const scope = entry.scope ?? 'all';
      const secret = entry.secret ?? true;
      await this.#db
        .insert(managerCredentials)
        .values({ name: entry.name, value: entry.value, updatedAt: at, scope, secret })
        .onConflictDoUpdate({
          target: managerCredentials.name,
          set: { value: entry.value, updatedAt: at, scope, secret },
        });
    }
    return this.list();
  }

  async seedOnce(marker: string, entries: readonly CredentialEntry[]): Promise<string[]> {
    assertValidCredentialEntries(entries);
    const key = `credentials_seeded:${marker}`;
    const at = new Date();
    return this.#db.transaction(async (tx) => {
      // 印を先に取る: 同時に2つのデーモンが起きても、印を取れた1つだけが書くため。
      const claimed = await tx
        .insert(daemonState)
        .values({ key, value: '1' })
        .onConflictDoNothing()
        .returning({ key: daemonState.key });
      if (claimed.length === 0) return [];
      const written: string[] = [];
      for (const entry of entries) {
        if (entry.value.length === 0) continue;
        const inserted = await tx
          .insert(managerCredentials)
          .values({
            name: entry.name,
            value: entry.value,
            updatedAt: at,
            scope: entry.scope ?? 'all',
            secret: entry.secret ?? true,
          })
          .onConflictDoNothing()
          .returning({ name: managerCredentials.name });
        if (inserted.length > 0) written.push(entry.name);
      }
      return written;
    });
  }
}
