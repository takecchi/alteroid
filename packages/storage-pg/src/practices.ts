import { ensureTrailingNewline, practiceSchema, practiceSlugSchema } from '@alteroid/core';
import type {
  Practice,
  PracticeMeta,
  PracticeStore,
  PracticeVersion,
  PracticeVersionMeta,
} from '@alteroid/core';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
import { practices, practiceVersions } from './schema.js';

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

/** `charsExpr` と同じ理由・同じ数え方で、版の履歴（`practiceVersions.content`）に対して使う式。 */
const versionCharsExpr = sql<number>`char_length(${practiceVersions.content})`;

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
    // ⭐ **本体の upsert と、版の追記を1つのトランザクションに畳む（#1309）。**
    // 途中で落ちたときに「本体は書き変わったが版は増えていない」という食い違いを
    // 作らないため（`PracticeStore.write` の doc）。
    return this.#db.transaction(async (tx) => {
      const rows = await tx
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
        //
        // **⚠️ この `ON CONFLICT DO UPDATE` が、下の版番号の計算を安全にしている
        // 側でもある。** 同一 slug への同時書き込みは、PostgreSQL が
        // `ON CONFLICT` の対象行に対して行うロック待ち（一方が commit するまで
        // もう一方の文を待たせる）によって直列化される——`FsPracticeStore` が
        // `withPathLock` で直列化しているのと同じ効果を、ここでは一意制約の
        // 衝突待ちで得ている。この直列化が無いと、2つの書き込みが同時に
        // `max(version)` を読んで同じ番号を計算しうる。
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

      // ⭐ **書いた後の本文を版として追記する（#1309）。** 番号は
      // 「この slug の既存の版の最大値 + 1」——`remove()` は版を消さないので
      // （`remove()` の doc）、消して作り直しても続きから振られる。
      const maxRows = await tx
        .select({ maxVersion: sql<number | null>`max(${practiceVersions.version})` })
        .from(practiceVersions)
        .where(eq(practiceVersions.slug, value.slug));
      const nextVersion = (maxRows[0]?.maxVersion ?? 0) + 1;
      await tx.insert(practiceVersions).values({
        slug: value.slug,
        version: nextVersion,
        kind: value.kind,
        title: value.title,
        content: value.content,
        at: now,
      });

      return {
        slug: row.slug,
        kind: row.kind,
        title: row.title,
        content: row.content,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        chars: row.chars,
      };
    });
  }

  async remove(slug: string): Promise<void> {
    // **版は消さない**（`PracticeStore.remove` の doc、#1309）——`practices`
    // からだけ消し、`practiceVersions` には触れない。
    await this.#db.delete(practices).where(eq(practices.slug, this.#slug(slug)));
  }

  async clear(): Promise<number> {
    // **版もここでは消す**（`PracticeStore.clear` の doc、#1309）——ワークスペース
    // リセット専用の操作で、人間が明示的に「全部忘れる」と決めたときにしか呼ばれない。
    const rows = await this.#db.delete(practices).returning({ slug: practices.slug });
    await this.#db.delete(practiceVersions);
    return rows.length;
  }

  async listVersions(slug: string): Promise<PracticeVersionMeta[]> {
    const rows = await this.#db
      .select({
        slug: practiceVersions.slug,
        version: practiceVersions.version,
        kind: practiceVersions.kind,
        title: practiceVersions.title,
        at: practiceVersions.at,
        chars: versionCharsExpr,
      })
      .from(practiceVersions)
      .where(eq(practiceVersions.slug, this.#slug(slug)))
      .orderBy(asc(practiceVersions.version));
    return rows.map((row) => ({
      slug: row.slug,
      version: row.version,
      kind: row.kind,
      title: row.title,
      at: toIso(row.at),
      chars: row.chars,
    }));
  }

  async readVersion(slug: string, version: number): Promise<PracticeVersion | null> {
    const rows = await this.#db
      .select({
        slug: practiceVersions.slug,
        version: practiceVersions.version,
        kind: practiceVersions.kind,
        title: practiceVersions.title,
        content: practiceVersions.content,
        at: practiceVersions.at,
        chars: versionCharsExpr,
      })
      .from(practiceVersions)
      .where(
        and(eq(practiceVersions.slug, this.#slug(slug)), eq(practiceVersions.version, version)),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      slug: row.slug,
      version: row.version,
      kind: row.kind,
      title: row.title,
      content: row.content,
      at: toIso(row.at),
      chars: row.chars,
    };
  }
}
