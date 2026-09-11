import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CREDENTIAL_NAME, type CredentialEntry, type StoredCredential } from '@alteroid/core';
import type { CredentialVaultStore } from '@alteroid/core';
import { z } from 'zod';

/**
 * 正本1行のスキーマ。**`value` は素の文字列のまま保存する**——ここが正本を持つ
 * 唯一の場所であり、値を持たない顔（指紋）は上の層が作る（`FsTokenPoolStore` の
 * `agentTokenRowSchema` と同じ分け方）。
 */
const rowSchema = z.object({
  /**
   * 環境変数の名前。**ここでも形を検査する。**
   *
   * 入口（HTTP のスキーマ・`CredentialStore#set`）でも見ているが、**ファイルは
   * 人間が手で書き換えられる**ので、読むときにもう一度見ないと、手で書いた
   * `../../x` のような名前がそのまま runner へ降りて器の外を指す。守りを1枚に
   * 寄せない（`credentials.ts` の `CREDENTIAL_NAME` の doc と同じ理由）。
   */
  name: z.string().regex(CREDENTIAL_NAME),
  value: z.string(),
  updatedAt: z.string(),
});

const fileSchema = z.object({
  credentials: z.array(rowSchema).default([]),
});

type CredentialFile = z.infer<typeof fileSchema>;

const EMPTY: CredentialFile = { credentials: [] };

/**
 * マネージャーへ降ろす環境変数の正本の置き場（既定 `~/.alteroid/credentials.json`）。
 *
 * **`memory/` には置かない。** 値（鍵そのもの）を持つ場所であって、人間が手で
 * 書き換える前提の場所ではない（`alteroid credential` / `PUT /credentials` を
 * 経由する）。`FsAuthStore` / `FsTokenPoolStore` と同じ扱いである。
 *
 * **一時ファイルを 0600 で作ってから rename する。** rename の後に絞ると、その
 * 隙間で他人が読める。
 */
export class FsCredentialVaultStore implements CredentialVaultStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#dir = dirname(path);
  }

  async list(): Promise<StoredCredential[]> {
    const file = await this.#read();
    return [...file.credentials].sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(entries: readonly CredentialEntry[]): Promise<StoredCredential[]> {
    const at = new Date().toISOString();
    await this.#update((file) => {
      const rows = new Map(file.credentials.map((row) => [row.name, row]));
      for (const entry of entries) {
        // **空文字は「外す」。** 器（`CredentialStore#set`）と同じ約束にしてある
        // ——片方だけ残ると、指紋を見ても理由が分からない食い違いになる。
        if (entry.value.length === 0) {
          rows.delete(entry.name);
          continue;
        }
        rows.set(entry.name, { name: entry.name, value: entry.value, updatedAt: at });
      }
      return { credentials: [...rows.values()] };
    });
    return this.list();
  }

  async #read(): Promise<CredentialFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /** read-modify-write を直列化する（`FsTokenPoolStore#update` と同じ最小の排他）。 */
  async #update(mutate: (file: CredentialFile) => CredentialFile): Promise<void> {
    const run = this.#chain.then(async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      // 一時ファイルの時点で 0600。rename 後に絞ると、その隙間で他人が読める。
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.#path);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
