import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { permissionGrantSchema } from '@alteroid/core';
import type { PermissionGrant, PermissionGrantStore } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const fileSchema = z.object({
  grants: z.array(permissionGrantSchema).default([]),
});

type GrantFile = z.infer<typeof fileSchema>;

/**
 * 人間が承認した Bash 許可の記録（Issue #863）。1枚の JSON（`FsJobStore` の
 * `jobs.json` と同じ形——`paths.jobs` ディレクトリを共有するが、ファイルは
 * 別にする。`permission-grants.json` という名前は設計メモの明示）。
 */
export class FsPermissionGrantStore implements PermissionGrantStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'permission-grants.json');
  }

  async list(): Promise<PermissionGrant[]> {
    // **`grantedAt` の昇順で返す**（3実装で揃える——`PgPermissionGrantStore` /
    // インメモリ実装〈`testing.ts`〉と同じ並び。ファイルの生の順序は書き込み
    // 順であって時系列の保証が無いので、ここで揃える）。
    return [...(await this.#read()).grants].sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
  }

  async get(id: string): Promise<PermissionGrant | null> {
    const { grants } = await this.#read();
    return grants.find((grant) => grant.id === id) ?? null;
  }

  async put(grant: PermissionGrant): Promise<void> {
    await this.#update((file) => {
      const grants = file.grants.filter((existing) => existing.id !== grant.id);
      grants.push(permissionGrantSchema.parse(grant));
      return { next: { grants }, result: undefined };
    });
  }

  /**
   * `PermissionGrantStore.revoke` の doc（lost update・#1654 と同型）。
   * **現在値を読むのも書くのも同じ `#update` の排他区間の中**——`get()` した
   * 古い写しではなく、ここで読み直した現在値から `revokedAt` の有無を見る。
   */
  async revoke(id: string, at: string): Promise<PermissionGrant | null> {
    return this.#update((file) => {
      const found = file.grants.find((grant) => grant.id === id);
      if (found === undefined) return { next: file, result: null };
      const next = permissionGrantSchema.parse({ ...found, revokedAt: found.revokedAt ?? at });
      return {
        next: { grants: file.grants.map((grant) => (grant.id === id ? next : grant)) },
        result: next,
      };
    });
  }

  /**
   * `PermissionGrantStore.markUsed` の doc。`revokedAt` などの他の欄には
   * 一切触れない——差し替えるのは `lastUsedAt` だけ。既存より古い時刻では
   * 戻さない。
   */
  async markUsed(id: string, at: string): Promise<boolean> {
    return this.#update((file) => {
      const found = file.grants.find((grant) => grant.id === id);
      // 無い・取り消し済みなら記録しない（Issue #1687。`PermissionGrantStore.markUsed` の doc）。
      if (found === undefined || found.revokedAt !== undefined)
        return { next: file, result: false };
      if (found.lastUsedAt !== undefined && found.lastUsedAt >= at) {
        return { next: file, result: true };
      }
      const next = permissionGrantSchema.parse({ ...found, lastUsedAt: at });
      return {
        next: { grants: file.grants.map((grant) => (grant.id === id ? next : grant)) },
        result: true,
      };
    });
  }

  async #read(): Promise<GrantFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { grants: [] };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（`FsJobStore.#update` と同じ理由——issue
   * #1113 / #1050 の教訓。`withPathLock` でプロセス内・プロセス間の両方を
   * 排他する）。**`mutate` が返す `result` をそのまま呼び出し側へ返す**
   * （`FsScheduleStore.#update` と同じ形——`revoke` / `markUsed` が「読んで
   * から書くまで」を排他区間の中へ引き取れるようにするため）。
   */
  async #update<T>(mutate: (file: GrantFile) => { next: GrantFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
      return result;
    });
  }
}
