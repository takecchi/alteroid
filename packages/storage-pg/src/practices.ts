import { ensureTrailingNewline, practiceSchema, practiceSlugSchema } from '@alteroid/core';
import type { Practice, PracticeMeta, PracticeStore } from '@alteroid/core';
import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { practices } from './schema.js';

/**
 * `chars`（本文の文字数、コードポイント数）を導出する SQL 式（#1340）。
 *
 * **列に保存しない。** `content` から一意に決まる値を別の列にも持つと、
 * 書き手が片方だけ更新したときに黙ってずれる形が構造として残る（改名前の
 * `bytes` 列がまさにそれだった経緯は Issue #1340 コメント参照）。
 *
 * `char_length` は PostgreSQL では UTF8 データベースでコードポイント数を返す
 * ——JS の `[...content].length`（fs 版、`FsPracticeStore` の `countChars`）と
 * 同じ数え方になる（サロゲートペアの絵文字は1、結合文字は分かれたまま数える。
 * `practice-contract.ts` の契約の歯が両実装の一致を確かめる）。
 *
 * **サーバ側で計算するので、一覧のために本文をネットワークへ流さない**——
 * 直下の「列に切って入れている」の理由を、保存をやめた後も保つ。
 */
const charsExpr = sql<number>`char_length(${practices.content})`;

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
        // **本文はここでは選ばない。** `char_length` は DB 側で計算されるので、
        // 結果として届くのは整数1つだけである（`charsExpr` の doc）。
        chars: charsExpr,
      })
      .from(practices)
      .orderBy(asc(practices.slug));
    return rows.map((row) => ({
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      chars: row.chars,
    }));
  }

  async read(slug: string): Promise<Practice | null> {
    const rows = await this.#db
      .select({
        slug: practices.slug,
        kind: practices.kind,
        title: practices.title,
        content: practices.content,
        createdAt: practices.createdAt,
        updatedAt: practices.updatedAt,
        chars: charsExpr,
      })
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
      chars: row.chars,
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
    // **`chars` はここでは作らない**（`practiceSchema.omit({ chars: true })`
    // を使う）——直後の `.returning()` が DB 側の `char_length` から埋める
    // ので、ここで JS 側の値を先に持つと書く値と返す値の数え方がずれかねない。
    const value = stripNulls(
      practiceSchema.omit({ chars: true }).parse({
        slug: this.#slug(input.slug),
        kind: input.kind,
        title: input.title,
        content,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
    );
    const rows = await this.#db
      .insert(practices)
      .values({
        slug: value.slug,
        kind: value.kind,
        title: value.title,
        content: value.content,
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
          updatedAt: now,
        },
      })
      .returning({
        slug: practices.slug,
        kind: practices.kind,
        title: practices.title,
        content: practices.content,
        createdAt: practices.createdAt,
        updatedAt: practices.updatedAt,
        chars: charsExpr,
      });
    const row = rows[0];
    if (row === undefined) throw new Error(`やり方 ${value.slug} を書けなかった`);
    return {
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      chars: row.chars,
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
