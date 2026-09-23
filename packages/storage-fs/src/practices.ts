import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureTrailingNewline, practiceSchema } from '@alteroid/core';
import type { Practice, PracticeMeta, PracticeStore } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * ディスクへ書く形。**`chars` を持たない**——#1340 で保存をやめ、本文から
 * 都度導出する形にした（`PracticeStore.write` の doc）。`practiceSchema` から
 * `chars` を落とすことで作る。
 *
 * ⚠️ **既存の JSON に残っている旧い `bytes` 欄を読めなくしないこと。** zod の
 * `z.object` は既定で未知のキーを黙って落とす（`.strict()` を付けていない）ので、
 * 改名前に書かれた `bytes: <数値>` を持つ行もそのまま読める——ここでその挙動を
 * 壊さない（`.strict()` / `.passthrough()` を足さない）。
 */
const practiceRecordSchema = practiceSchema.omit({ chars: true });

type PracticeRecord = z.infer<typeof practiceRecordSchema>;

const fileSchema = z.object({
  practices: z.array(practiceRecordSchema).default([]),
});

type PracticeFile = z.infer<typeof fileSchema>;

/** コードポイント数（UTF-16 のコード単位数ではない）。#1340。 */
function countChars(content: string): number {
  return [...content].length;
}

function toMeta(entry: PracticeRecord): PracticeMeta {
  return {
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    chars: countChars(entry.content),
  };
}

function toPractice(entry: PracticeRecord): Practice {
  return { ...entry, chars: countChars(entry.content) };
}

/**
 * 仕事のやり方 = 1枚の JSON（#1055 段3）。
 *
 * ## ⭐ なぜ Markdown のファイル群（`memory/` の形）にしないのか
 *
 * やり方は散文なので、一見すると記憶と同じく1文書1ファイルにしたくなる。
 * **その形を採らなかったのは、記憶がその形で踏んだ穴が既に repo に記録されて
 * いるからである。**
 *
 * - 1ファイル1文書にすると、本文に入らない値（`kind` / `createdAt`）を置く先が
 *   **本文の外（索引ファイル）**になる。`FsPersonaStore` はまさにそれを持って
 *   いて、索引が失われた・本文のハッシュと食い違ったときは `unknown`（守る側）を
 *   返すしかない（`PersonaStore.protectionStatus` の doc）。**派生値の drift を
 *   新しく1つ作ることになる。**
 * - `createdAt` を本文の外に持てないなら FS の時刻に頼ることになるが、それは
 *   記憶で明示的に禁じられている（`MemoryDocumentMeta.createdAt` の doc、
 *   逐語「**`mtime` にも `birthtime` にも由来しない——これはいまも禁止である**」）。
 *
 * ⟹ **やり方を定義する値は全部1つのファイルに置く。** 索引も sidecar も作らない。
 *
 * 人間が直接開いて読めることは保つ（`schedules.json` / `commitments.json` と
 * 同じ場所・同じ形）。⚠️ **ただし人間の主な入口はここではない** —— 3入口
 * （クローンの道具 / デーモンの HTTP / 画面）から読めて直せることが段3 の
 * 受け入れ基準であり、この JSON はその下に在る器にすぎない。
 */
export class FsPracticeStore implements PracticeStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'practices.json');
  }

  async list(): Promise<PracticeMeta[]> {
    return [...(await this.#read()).practices]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((entry) => toMeta(entry));
  }

  async read(slug: string): Promise<Practice | null> {
    const found = (await this.#read()).practices.find((entry) => entry.slug === slug);
    return found === undefined ? null : toPractice(found);
  }

  async write(input: {
    slug: string;
    kind: string;
    title: string;
    content: string;
  }): Promise<Practice> {
    // **正規化を自分で書かない。** 出所は `@alteroid/core` の
    // `ensureTrailingNewline` 1箇所である（`PracticeStore.write` の doc と #370）。
    const content = ensureTrailingNewline(input.content);
    const now = new Date().toISOString();
    return this.#update((file) => {
      const existing = file.practices.find((entry) => entry.slug === input.slug);
      const next = practiceRecordSchema.parse({
        slug: input.slug,
        kind: input.kind,
        title: input.title,
        content,
        // 上書きで作成時刻を捏造しない（`PracticeStore.write` の doc）。
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return {
        next: {
          ...file,
          practices: [...file.practices.filter((entry) => entry.slug !== input.slug), next],
        },
        result: toPractice(next),
      };
    });
  }

  async remove(slug: string): Promise<void> {
    await this.#update((file) => ({
      next: { ...file, practices: file.practices.filter((entry) => entry.slug !== slug) },
      result: undefined,
    }));
  }

  async clear(): Promise<number> {
    return this.#update((file) => ({
      next: { practices: [] },
      result: file.practices.length,
    }));
  }

  async #read(): Promise<PracticeFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { practices: [] };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（`FsScheduleStore.#update` と同じ形。
   * 排他の強さは `file-lock.ts` の doc）。
   *
   * **`write` の「既存の `createdAt` を引き継ぐ」は、読んでから書くまでの間に
   * 別の書き込みが挟まると壊れる**ので、この区間の中で決める。
   */
  async #update<T>(mutate: (file: PracticeFile) => { next: PracticeFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
      return result;
    });
  }
}
