import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { permissionRuleSchema } from '@alteroid/core';
import type { PermissionRule, PermissionStore } from '@alteroid/core';
import { z } from 'zod';

const fileSchema = z.object({
  permissions: z.array(permissionRuleSchema).default([]),
});

type PermissionFile = z.infer<typeof fileSchema>;

/**
 * 開いている実行許可の台帳 = 1枚の JSON。
 *
 * **上限を持たない**（`commitments.json` の `CLOSED_HISTORY_LIMIT` に当たるものが
 * 無い）。あちらは片付いた行＝履歴を切っているが、こちらに並ぶ行は**すべていま
 * 効いている許可**である。切れば効いている許可が黙って消え、しかも消えたことは
 * 一覧からは見えない。**取り消しは人間の操作としてしか起きない。**
 *
 * ジョブ台帳と同じディレクトリに置く。**人間が開いて読めること**を保つ形にして
 * おく（何が許されているかが人間から見えないのは、この器の目的の否定である）。
 */
export class FsPermissionStore implements PermissionStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'permissions.json');
  }

  /** 許可した順（古い順）。**件数で切らない。** */
  async list(): Promise<PermissionRule[]> {
    return [...(await this.#read()).permissions].sort((a, b) =>
      a.grantedAt.localeCompare(b.grantedAt),
    );
  }

  async get(id: string): Promise<PermissionRule | null> {
    return (await this.#read()).permissions.find((entry) => entry.id === id) ?? null;
  }

  /**
   * 1件許す。**同じ `rule` が既に在れば何もしない。**
   *
   * **読みと書きを同じ排他区間に入れること**（`FsCommitmentStore.open` と同じ理由）。
   * 分けると、同じ規則の grant が並行に来たときに両方が「無い」を読んで両方が書き、
   * **同じ規則が2行になる**。そうなると人間が1行消しても規則は効いたままになり、
   * 「消したのに効き続ける」という一番まずい形になる。
   */
  async grant(entry: PermissionRule): Promise<boolean> {
    return this.#update((file) => {
      // **id ではなく `rule` で見る。** 重複を防ぐのが目的なので、鍵は規則そのもの
      if (file.permissions.some((existing) => existing.rule === entry.rule)) {
        return { next: file, result: false };
      }
      return {
        next: { permissions: [...file.permissions, permissionRuleSchema.parse(entry)] },
        result: true,
      };
    });
  }

  /**
   * 1件取り消す。**行を消す**（残すと、効いていない規則が一覧に並ぶ）。
   *
   * ここも「読む→在るか見る→書く」を同じ排他区間で行う。分けると、二重に届いた
   * 取り消しが両方 `true` を返し、呼び出し側が「いま自分が消した」と誤って
   * 二重に報告する。
   */
  async revoke(id: string): Promise<boolean> {
    return this.#update((file) => {
      if (!file.permissions.some((entry) => entry.id === id)) {
        return { next: file, result: false };
      }
      return {
        next: { permissions: file.permissions.filter((entry) => entry.id !== id) },
        result: true,
      };
    });
  }

  async #read(): Promise<PermissionFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { permissions: [] };
      throw error;
    }
  }

  /** read-modify-write を直列化する（`FsCommitmentStore` と同じ形）。 */
  async #update<T>(
    mutate: (file: PermissionFile) => { next: PermissionFile; result: T },
  ): Promise<T> {
    const run = this.#chain.then(async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, this.#path);
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
