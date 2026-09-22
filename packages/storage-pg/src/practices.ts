import { ensureTrailingNewline, practiceSchema, practiceSlugSchema } from '@alteroid/core';
import type { Practice, PracticeMeta, PracticeStore } from '@alteroid/core';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { practices } from './schema.js';

/**
 * 仕事のやり方（#1055 段3）。fs 版と同じ IF を満たすための別の器であって、
 * 器の違いで能力差を作らない（クラウドでだけ人間がやり方を直せない、が起きない）。
 *
 * ## 列に切って入れている（jsonb 1列にしていない）
 *
 * `list()` が返すのは本文を含まない `PracticeMeta` である。jsonb 1列にすると、
 * 一覧の1行を作るためだけに全文をネットワークへ流すことになる。**本文以外は
 * すべて短い値なので、列に切ったほうが素直である**（`schedules` が jsonb なのは
 * あちらの `plan` が入れ子の構造を持つからで、ここには無い）。
 */
export class PgPracticeStore implements PracticeStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #slug(slug: string): string {
    const parsed = practiceSlugSchema.safeParse(slug);
    if (!parsed.success) throw new Error(`やり方のスラッグが不正: ${slug}`);
    return parsed.data;
  }

  async list(): Promise<PracticeMeta[]> {
    const rows = await this.#db
      .select({
        slug: practices.slug,
        kind: practices.kind,
        title: practices.title,
        createdAt: practices.createdAt,
        updatedAt: practices.updatedAt,
        bytes: practices.bytes,
      })
      .from(practices)
      .orderBy(asc(practices.slug));
    return rows.map((row) => ({
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      bytes: row.bytes,
    }));
  }

  async read(slug: string): Promise<Practice | null> {
    const rows = await this.#db
      .select()
      .from(practices)
      .where(eq(practices.slug, this.#slug(slug)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      bytes: row.bytes,
    };
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
    const now = new Date();
    // 本文も題も人間かクローンが書いた自由文なので NUL が混ざりうる。
    const value = stripNulls(
      practiceSchema.parse({
        slug: this.#slug(input.slug),
        kind: input.kind,
        title: input.title,
        content,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        bytes: content.length,
      }),
    );
    const rows = await this.#db
      .insert(practices)
      .values({
        slug: value.slug,
        kind: value.kind,
        title: value.title,
        content: value.content,
        bytes: value.bytes,
        createdAt: now,
        updatedAt: now,
      })
      // **`createdAt` を `set` に入れないこと。** 上書きで作成時刻を捏造しない
      // （`PracticeStore.write` の doc）。既にある行の `created_at` はそのまま残る。
      .onConflictDoUpdate({
        target: practices.slug,
        set: {
          kind: value.kind,
          title: value.title,
          content: value.content,
          bytes: value.bytes,
          updatedAt: now,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error(`やり方 ${value.slug} を書けなかった`);
    return {
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      bytes: row.bytes,
    };
  }

  async remove(slug: string): Promise<void> {
    await this.#db.delete(practices).where(eq(practices.slug, this.#slug(slug)));
  }

  async clear(): Promise<number> {
    const rows = await this.#db.delete(practices).returning({ slug: practices.slug });
    return rows.length;
  }
}
