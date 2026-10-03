import {
  compareProfileEntryNames,
  type EnvProfileEntry,
  type EnvProfileScope,
  type ProfileStore,
} from '@alteroid/core';
import { eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { envProfile, envProfileEntries } from './schema.js';

/** 列は text なので、3語のどれでもない中身（手で書いた等）は `all` として読む（fs 版と同じ向き）。 */
function scopeOf(raw: string): EnvProfileScope {
  return raw === 'app' || raw === 'runner' ? raw : 'all';
}

/**
 * 実行環境プロファイルの置き場（クラウド段）。**名前付きの行を複数持つ**
 * （`env_profile_entries`。1行 ＝ 名前・本文・撒く先・更新日時）。
 *
 * fs 版（`~/.alteroid/profile.d/<name>.sh`）と同じものの器違いである。器が変わって
 * できなくなることを作らない（M4 受け入れ基準1）。
 *
 * **この表を runner から読ませない。** 読ませられるということは runner に記憶
 * ストアの鍵があるということで、それは M4 受け入れ基準3 が無いと言っているもの
 * である。runner へはデーモンが制御面で降ろす。
 *
 * **旧 `env_profile`（1本の時代）は読まない。** 起動時の `migrate` が1度だけ
 * `default` 行へ写す（`migrate.ts`）。書かないが、`clear()` だけは旧表も空にする
 * （全部外したものが、巻き戻した旧版で蘇らないように）。
 */
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

  /**
   * 取り消した更新をなかったことにする。
   *
   * **`updated_at` も戻す。** ここは人間が `profile status` で見る「最後に本文を
   * 変えた時刻」であり、成功していない更新でそこが動くと監査情報が嘘になる。
   * 1つのトランザクションで入れ替える（途中で落ちて集合が半端に残らない）。
   */
  async replaceAll(previous: readonly EnvProfileEntry[]): Promise<void> {
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

  /** 外す（`ProfileStore.clear` の doc）。旧表（`env_profile`）も空にする。 */
  async clear(): Promise<number> {
    await this.#db.delete(envProfile);
    const removed = await this.#db
      .delete(envProfileEntries)
      .returning({ name: envProfileEntries.name });
    return removed.length;
  }
}
