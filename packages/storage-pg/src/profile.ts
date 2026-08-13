import type { EnvProfile, ProfileStore } from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { envProfile } from './schema.js';

/** 高々1行しか持たない表なので、鍵は固定でよい。 */
const PROFILE_ID = 'default';

/**
 * 実行環境プロファイルの置き場（クラウド段）。
 *
 * fs 版（`~/.alteroid/profile.sh`）と同じものの器違いである。器が変わって
 * できなくなることを作らない（M4 受け入れ基準1）。
 *
 * **この表を runner から読ませない。** 読ませられるということは runner に記憶
 * ストアの鍵があるということで、それは M4 受け入れ基準3 が無いと言っているもの
 * である。runner へはデーモンが制御面で降ろす。
 */
export class PgProfileStore implements ProfileStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async read(): Promise<EnvProfile | null> {
    const rows = await this.#db
      .select({ script: envProfile.script, updatedAt: envProfile.updatedAt })
      .from(envProfile)
      .where(eq(envProfile.id, PROFILE_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.script.trim().length === 0) return null;
    return { script: row.script, updatedAt: row.updatedAt.toISOString() };
  }

  async write(script: string): Promise<EnvProfile> {
    const at = new Date();
    if (script.trim().length === 0) {
      await this.#db.delete(envProfile).where(eq(envProfile.id, PROFILE_ID));
      return { script: '', updatedAt: at.toISOString() };
    }

    await this.#db
      .insert(envProfile)
      .values({ id: PROFILE_ID, script, updatedAt: at })
      .onConflictDoUpdate({ target: envProfile.id, set: { script, updatedAt: at } });
    return { script, updatedAt: at.toISOString() };
  }
}
