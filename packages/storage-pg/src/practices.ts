import {
  ensureTrailingNewline,
  hasNul,
  PracticeConflictError,
  stripNul,
  practiceMetaSchema,
  practiceSchema,
  practiceSlugSchema,
  practiceVersionMetaSchema,
  practiceVersionMatches,
  practiceVersionSchema,
  UnreadablePracticeError,
} from '@alteroid/core';
import type {
  Practice,
  PracticeList,
  PracticeMeta,
  PracticeStore,
  PracticeVersion,
  PracticeVersionMeta,
  RemovePracticeOptions,
  UnreadablePractice,
  WritePracticeOptions,
} from '@alteroid/core';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { byteOrder, stripNulls, toIso } from './db.js';
import { practices, practiceVersions } from './schema.js';

// `issue.message` を使わない: zod の既定メッセージが将来 `received`（実際の値）を含む形に変わっても値が漏れないようにするため。
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

// slug 以外の値を載せない: `title` / `content` には自由文が入りうるため。
function describeSkippedPracticeRow(params: { slug: string; reason: string }): string {
  return `alteroid: practices の不正な行を読み飛ばしました（slug=${JSON.stringify(params.slug)}、${params.reason}）`;
}

function describeSkippedPracticeVersionRow(params: {
  slug: string;
  version: number;
  reason: string;
}): string {
  return (
    `alteroid: practiceVersions の不正な行を読み飛ばしました` +
    `（slug=${JSON.stringify(params.slug)}、version=${params.version}、${params.reason}）`
  );
}

// 列に保存しない: `content` から決まる値を別の列にも持つと、書き手が片方だけ更新したときに黙ってずれるため。
// サーバ側で計算する: 一覧のために本文をネットワークへ流さないため。
const charsExpr = sql<number>`char_length(${practices.content})`;

const versionCharsExpr = sql<number>`char_length(${practiceVersions.content})`;

// jsonb 1列にしない: 一覧の1行を作るためだけに全文をネットワークへ流すことになるため。
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

  async list(): Promise<PracticeList> {
    const rows = await this.#db
      .select({
        slug: practices.slug,
        kind: practices.kind,
        title: practices.title,
        createdAt: practices.createdAt,
        updatedAt: practices.updatedAt,
        chars: charsExpr,
      })
      .from(practices)
      .orderBy(asc(byteOrder(practices.slug)));
    const entries: PracticeMeta[] = [];
    const unreadable: UnreadablePractice[] = [];
    for (const row of rows) {
      const parsed = practiceMetaSchema.safeParse({
        slug: row.slug,
        kind: row.kind,
        title: row.title,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        chars: row.chars,
      });
      if (parsed.success) {
        entries.push(parsed.data);
        continue;
      }
      const reason = summarizeInvalidFields(parsed.error.issues);
      process.stderr.write(`${describeSkippedPracticeRow({ slug: row.slug, reason })}\n`);
      unreadable.push({ slug: row.slug, reason });
    }
    return { entries, unreadable };
  }

  // 読めない行を `null` にしない: 呼び出し側が `UnreadablePracticeError` を `instanceof` で見分け、書き直し・削除まで進むため。
  async read(slug: string): Promise<Practice | null> {
    if (hasNul(slug)) return null;
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
    const parsed = practiceSchema.safeParse({
      slug: row.slug,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      chars: row.chars,
    });
    if (!parsed.success) {
      throw new UnreadablePracticeError(
        `やり方 ${slug} が読めない形で入っている（消されたのではない）: ${parsed.error.message}`,
        { slug },
      );
    }
    return parsed.data;
  }

  async write(
    input: {
      slug: string;
      kind: string;
      title: string;
      content: string;
    },
    options?: WritePracticeOptions,
  ): Promise<Practice> {
    const content = ensureTrailingNewline(stripNul(input.content));
    const now = new Date();
    // `chars` をここで作らない: JS 側の値を先に持つと、書く値と DB 側の `char_length` が返す値の数え方がずれかねないため。
    const value = stripNulls(
      practiceSchema.omit({ chars: true }).parse({
        slug: this.#slug(input.slug),
        kind: stripNul(input.kind),
        title: stripNul(input.title),
        content,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
    );
    // upsert と版の追記を別のトランザクションにしない: 途中で落ちると「本体は書き変わったが版は増えていない」食い違いが残るため。
    const ifMatch = options?.ifMatch;
    const written = await this.#db.transaction(async (tx) => {
      // 行をロックしてから比べる: 読んでから書くと、その間の別の書き手を見逃すため。
      if (typeof ifMatch === 'string') {
        const locked = await tx
          .select({ kind: practices.kind, title: practices.title, content: practices.content })
          .from(practices)
          .where(eq(practices.slug, value.slug))
          .for('update');
        if (!practiceVersionMatches(locked[0] ?? null, ifMatch)) return undefined;
      }
      const returning = {
        slug: practices.slug,
        kind: practices.kind,
        title: practices.title,
        content: practices.content,
        createdAt: practices.createdAt,
        updatedAt: practices.updatedAt,
        chars: charsExpr,
      };
      const insert = tx.insert(practices).values({
        slug: value.slug,
        kind: value.kind,
        title: value.title,
        content: value.content,
        createdAt: now,
        updatedAt: now,
      });
      const rows =
        ifMatch === null
          ? // 上書きしない: 同時に作った別の書き手がいれば行を返さない。
            await insert.onConflictDoNothing({ target: practices.slug }).returning(returning)
          : // `createdAt` を `set` に入れない: 上書きで作成時刻を捏造しないため。
            // `ON CONFLICT DO UPDATE` を外さない: 同一 slug への同時書き込みがロック待ちで直列化され、下の `max(version)` が同じ番号を返さないため。
            await insert
              .onConflictDoUpdate({
                target: practices.slug,
                set: {
                  kind: value.kind,
                  title: value.title,
                  content: value.content,
                  updatedAt: now,
                },
              })
              .returning(returning);
      const row = rows[0];
      if (row === undefined) {
        if (ifMatch === null) return undefined;
        throw new Error(`やり方 ${value.slug} を書けなかった`);
      }

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
    if (written === undefined) {
      throw new PracticeConflictError(input.slug, await this.#readOrNull(input.slug));
    }
    return written;
  }

  async #readOrNull(slug: string): Promise<Practice | null> {
    try {
      return await this.read(slug);
    } catch (error) {
      if (error instanceof UnreadablePracticeError) return null;
      throw error;
    }
  }

  async remove(slug: string, options?: RemovePracticeOptions): Promise<void> {
    if (hasNul(slug)) return;
    const key = this.#slug(slug);
    const ifMatch = options?.ifMatch;
    // 版を消さない: `practices` からだけ消し、`practiceVersions` には触れない。
    if (ifMatch === undefined) {
      await this.#db.delete(practices).where(eq(practices.slug, key));
      return;
    }
    // 1文の DELETE にしない: 版は JSON のハッシュで SQL の1文では書けず、比較と DELETE の間に別の書き手を割り込ませないため。
    const current = await this.#db.transaction(async (tx) => {
      const locked = await tx
        .select({ kind: practices.kind, title: practices.title, content: practices.content })
        .from(practices)
        .where(eq(practices.slug, key))
        .for('update');
      if (!practiceVersionMatches(locked[0] ?? null, ifMatch)) return { conflict: true as const };
      await tx.delete(practices).where(eq(practices.slug, key));
      return { conflict: false as const };
    });
    if (current.conflict) {
      throw new PracticeConflictError(slug, await this.#readOrNull(slug));
    }
  }

  async clear(): Promise<number> {
    // 1つのトランザクションで束ねる: 2文目が落ちたときに1文目の DELETE だけが確定し、呼び手が「何も消えていない」と読みうるため。
    return this.#db.transaction(async (tx) => {
      const rows = await tx.delete(practices).returning({ slug: practices.slug });
      await tx.delete(practiceVersions);
      return rows.length;
    });
  }

  async listVersions(slug: string): Promise<PracticeVersionMeta[]> {
    if (hasNul(slug)) return [];
    const parsedSlug = this.#slug(slug);
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
      .where(eq(practiceVersions.slug, parsedSlug))
      .orderBy(asc(practiceVersions.version));
    const result: PracticeVersionMeta[] = [];
    for (const row of rows) {
      const parsed = practiceVersionMetaSchema.safeParse({
        slug: row.slug,
        version: row.version,
        kind: row.kind,
        title: row.title,
        at: toIso(row.at),
        chars: row.chars,
      });
      if (parsed.success) {
        result.push(parsed.data);
        continue;
      }
      process.stderr.write(
        `${describeSkippedPracticeVersionRow({
          slug: row.slug,
          version: row.version,
          reason: summarizeInvalidFields(parsed.error.issues),
        })}\n`,
      );
    }
    return result;
  }

  async readVersion(slug: string, version: number): Promise<PracticeVersion | null> {
    if (hasNul(slug)) return null;
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
    const parsed = practiceVersionSchema.safeParse({
      slug: row.slug,
      version: row.version,
      kind: row.kind,
      title: row.title,
      content: row.content,
      at: toIso(row.at),
      chars: row.chars,
    });
    if (!parsed.success) {
      throw new UnreadablePracticeError(
        `やり方 ${slug} の版 ${version} が読めない形で入っている（消されたのではない）: ${parsed.error.message}`,
        { slug, version },
      );
    }
    return parsed.data;
  }
}
