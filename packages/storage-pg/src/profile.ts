import type { EnvProfile, EnvProfileScope, ProfileStore } from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { envProfile } from './schema.js';

/** 高々1行しか持たない表なので、鍵は固定でよい。 */
const PROFILE_ID = 'default';

/** 列は text なので、3語のどれでもない中身（手で書いた等）は `all` として読む（fs 版と同じ向き）。 */
function scopeOf(raw: string): EnvProfileScope {
  return raw === 'app' || raw === 'runner' ? raw : 'all';
}

/**
 * 実行環境プロファイルの置き場（クラウド段）。
 *
 * fs 版（`~/.alteroid/profile.sh`）と同じものの器違いである。器が変わって
 * できなくなることを作らない（M4 受け入れ基準1）。
 *
 * **撒く先（`scope`）は同じ行の列に持つ**（fs 版は隣のファイル。`FsProfileStore` の doc）。
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
      .select({
        script: envProfile.script,
        updatedAt: envProfile.updatedAt,
        scope: envProfile.scope,
      })
      .from(envProfile)
      .where(eq(envProfile.id, PROFILE_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.script.trim().length === 0) return null;
    return {
      script: row.script,
      updatedAt: row.updatedAt.toISOString(),
      scope: scopeOf(row.scope),
    };
  }

  async write(script: string, scope: EnvProfileScope = 'all'): Promise<EnvProfile> {
    const at = new Date();
    if (script.trim().length === 0) {
      await this.#db.delete(envProfile).where(eq(envProfile.id, PROFILE_ID));
      return { script: '', updatedAt: at.toISOString(), scope: 'all' };
    }

    await this.#db
      .insert(envProfile)
      .values({ id: PROFILE_ID, script, updatedAt: at, scope })
      .onConflictDoUpdate({ target: envProfile.id, set: { script, updatedAt: at, scope } });
    return { script, updatedAt: at.toISOString(), scope };
  }

  /**
   * 取り消した更新をなかったことにする。
   *
   * **`updated_at` も戻す。** ここは人間が `profile status` で見る「最後に本文を
   * 変えた時刻」であり、成功していない更新でそこが動くと監査情報が嘘になる。
   */
  async revert(previous: EnvProfile | null): Promise<void> {
    if (previous === null) {
      await this.#db.delete(envProfile).where(eq(envProfile.id, PROFILE_ID));
      return;
    }
    const at = new Date(previous.updatedAt);
    await this.#db
      .insert(envProfile)
      .values({ id: PROFILE_ID, script: previous.script, updatedAt: at, scope: previous.scope })
      .onConflictDoUpdate({
        target: envProfile.id,
        set: { script: previous.script, updatedAt: at, scope: previous.scope },
      });
  }

  /** 外す（`ProfileStore.clear` の doc）。 */
  async clear(): Promise<number> {
    const removed = await this.#db.delete(envProfile).returning({ id: envProfile.id });
    return removed.length;
  }
}
