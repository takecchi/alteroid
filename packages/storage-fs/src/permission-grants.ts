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
      return { grants };
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
   * 排他する）。
   */
  async #update(mutate: (file: GrantFile) => GrantFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
    });
  }
}
