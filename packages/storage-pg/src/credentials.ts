import {
  CREDENTIAL_NAME,
  type CredentialEntry,
  type CredentialVaultStore,
  type StoredCredential,
} from '@alteroid/core';
import { asc, inArray } from 'drizzle-orm';

import type { Db } from './db.js';
import { managerCredentials } from './schema.js';

/**
 * マネージャーへ降ろす環境変数の正本（クラウド段）。
 *
 * fs 版（`~/.alteroid/credentials.json`）と同じものの器違いである。器が変わって
 * できなくなることを作らない（M4 受け入れ基準1）。
 *
 * **この表を runner から読ませない。** 読ませられるということは runner に記憶
 * ストアの鍵があるということで、それは M4 受け入れ基準3 が無いと言っているもの
 * である。runner へはデーモンが制御面で降ろす。
 */
export class PgCredentialVaultStore implements CredentialVaultStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(): Promise<StoredCredential[]> {
    const rows = await this.#db
      .select()
      .from(managerCredentials)
      .orderBy(asc(managerCredentials.name));
    return (
      rows
        /**
         * **名前の形をここでも見る。** 入口（HTTP のスキーマ・`CredentialStore#set`）
         * でも見ているが、DB は人間が直接 `insert` できるので、読むときにもう一度
         * 見ないと `../../x` のような名前がそのまま runner へ降りて器の外を指す。
         * 守りを1枚に寄せない（fs 版の `rowSchema` と同じ理由）。
         *
         * **落とした行を黙って消さない**わけではない——ここは読みの口なので、
         * 降ろす集合から外すだけである。手で入れた行が効かないことは、
         * `GET /credentials` に出ない（＝指紋が出ない）ことで見える。
         */
        .filter((row) => CREDENTIAL_NAME.test(row.name))
        .map((row) => ({
          name: row.name,
          value: row.value,
          updatedAt: row.updatedAt.toISOString(),
        }))
    );
  }

  async put(entries: readonly CredentialEntry[]): Promise<StoredCredential[]> {
    const at = new Date();
    // **空文字は「外す」。** 器（`CredentialStore#set`）と同じ約束である。
    const removed = entries.filter((entry) => entry.value.length === 0).map((entry) => entry.name);
    const upserted = entries.filter((entry) => entry.value.length > 0);

    if (removed.length > 0) {
      await this.#db.delete(managerCredentials).where(inArray(managerCredentials.name, removed));
    }
    for (const entry of upserted) {
      await this.#db
        .insert(managerCredentials)
        .values({ name: entry.name, value: entry.value, updatedAt: at })
        .onConflictDoUpdate({
          target: managerCredentials.name,
          set: { value: entry.value, updatedAt: at },
        });
    }
    return this.list();
  }
}
