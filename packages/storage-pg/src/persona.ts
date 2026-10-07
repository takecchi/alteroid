import {
  MemoryConflictError,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryFrontmatter,
  ensureTrailingNewline,
  memorySlugSchema,
  memoryProtectionRebuildDecision,
  nextDescribedState,
  sha256Hex,
} from '@alteroid/core';
import type {
  JournalStore,
  MemoryCreatedAt,
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PersonaStore,
  RemoveMemoryOptions,
  WriteMemoryOptions,
} from '@alteroid/core';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { byteOrder, stripNulls, toIso } from './db.js';
import { memory } from './schema.js';

// キャッシュしない: 外から書き換えられた記憶が次の会話に反映されなくなるため。
export class PgPersonaStore implements PersonaStore {
  readonly #db: Db;
  readonly #journal: JournalStore;

  constructor(db: Db, journal: JournalStore) {
    this.#db = db;
    this.#journal = journal;
  }

  #slug(slug: string): string {
    const parsed = memorySlugSchema.safeParse(slug);
    if (!parsed.success) throw new Error(`記憶のスラッグが不正: ${slug}`);
    return parsed.data;
  }

  async list(): Promise<MemoryDocumentMeta[]> {
    const rows = await this.#db
      .select({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        describedBytes: memory.describedBytes,
        describedBytesAt: memory.describedBytesAt,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .orderBy(asc(byteOrder(memory.slug)));
    return rows.map((row) => stripContent(toDocument(row)));
  }

  async read(slug: string): Promise<MemoryDocument | null> {
    const rows = await this.#db
      .select({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        describedBytes: memory.describedBytes,
        describedBytesAt: memory.describedBytesAt,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .where(eq(memory.slug, this.#slug(slug)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async write(
    slug: string,
    content: string,
    options?: WriteMemoryOptions,
  ): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    const prior = await this.#readPrior(key);
    const body = ensureTrailingNewline(stripNulls(content));
    const now = new Date();
    const returning = {
      slug: memory.slug,
      content: memory.content,
      updatedAt: memory.updatedAt,
      createdAt: memory.createdAt,
    };
    const ifMatch = options?.ifMatch;
    const rows =
      ifMatch === undefined
        ? await this.#upsert(key, body, now)
        : // 読んでから書かない: その間の別の書き手を見逃すため。比較は書き込みと同じ1文の中で行う。
          ifMatch === null
          ? await this.#db
              .insert(memory)
              .values({ slug: key, content: body, updatedAt: now, createdAt: now })
              .onConflictDoNothing({ target: memory.slug })
              .returning(returning)
          : await this.#db
              .update(memory)
              .set({ content: body, updatedAt: now })
              .where(
                and(
                  eq(memory.slug, key),
                  sql`encode(sha256(convert_to(${memory.content}, 'UTF8')), 'hex') = ${ifMatch}`,
                ),
              )
              .returning(returning);
    if (ifMatch !== undefined && rows[0] === undefined) {
      throw new MemoryConflictError(slug, await this.read(slug));
    }
    return this.#finishWrite(key, slug, prior, rows);
  }

  async #upsert(key: string, body: string, now: Date) {
    return await this.#db
      .insert(memory)
      // `created_at` を `set` に入れない: 既存行の `created_at` を保つため。
      .values({ slug: key, content: body, updatedAt: now, createdAt: now })
      .onConflictDoUpdate({
        target: memory.slug,
        set: { content: body, updatedAt: now },
      })
      .returning({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        createdAt: memory.createdAt,
      });
  }

  async #finishWrite(
    key: string,
    slug: string,
    prior:
      | {
          content: string;
          updatedAt: Date | string;
          describedAt: Date | null;
          describedBytes: number | null;
          describedBytesAt: Date | null;
        }
      | undefined,
    rows: {
      slug: string;
      content: string;
      updatedAt: Date | string;
      createdAt: Date | string | null;
    }[],
  ): Promise<MemoryDocument> {
    const row = rows[0];
    if (row === undefined) throw new Error(`記憶の書き込みに失敗: ${slug}`);
    const { describedAt, describedBytes, describedBytesAt } = await this.#updateDerived(
      key,
      prior,
      row,
    );
    return toDocument({ ...row, describedAt, describedBytes, describedBytesAt });
  }

  // `human_touched_at` を更新対象に含めない: 降ろさないための唯一の保証になるため。
  // 基準点に `written` を使わない: `deltaBytes: 0` から始まり、この書き込み自身の増減が測れなくなるため。
  // `Buffer.byteLength` を変えない: `toDocument` の `bytes` と測り方がずれると、書いた直後から「少し変わっている」に化けるため。
  async #updateDerived(
    slug: string,
    prior:
      | {
          content: string;
          updatedAt: Date | string;
          describedAt: Date | null;
          describedBytes: number | null;
          describedBytesAt: Date | null;
        }
      | undefined,
    written: { content: string; updatedAt: Date | string },
  ): Promise<{
    describedAt: Date | null;
    describedBytes: number | null;
    describedBytesAt: Date | null;
  }> {
    const next = nextDescribedState({
      priorContent: prior?.content ?? null,
      nextContent: written.content,
      priorDescribedAt:
        prior?.describedAt === null || prior?.describedAt === undefined
          ? undefined
          : toIso(prior.describedAt),
      priorDescribedBytes: prior?.describedBytes === null ? undefined : prior?.describedBytes,
      priorDescribedBytesAt:
        prior?.describedBytesAt === null || prior?.describedBytesAt === undefined
          ? undefined
          : toIso(prior.describedBytesAt),
      priorBytes: prior === undefined ? undefined : Buffer.byteLength(prior.content, 'utf8'),
      priorUpdatedAt: prior === undefined ? undefined : toIso(prior.updatedAt),
      writtenAt: toIso(written.updatedAt),
      writtenBytes: Buffer.byteLength(written.content, 'utf8'),
    });
    const describedAt = next.describedAt === undefined ? null : new Date(next.describedAt);
    const describedBytes = next.describedBytes === undefined ? null : next.describedBytes;
    const describedBytesAt =
      next.describedBytesAt === undefined ? null : new Date(next.describedBytesAt);
    await this.#db
      .update(memory)
      .set({
        contentSha256: sha256Hex(written.content),
        describedAt,
        describedBytes,
        describedBytesAt,
      })
      .where(eq(memory.slug, slug));
    return { describedAt, describedBytes, describedBytesAt };
  }

  async #readPrior(slug: string): Promise<
    | {
        content: string;
        updatedAt: Date | string;
        describedAt: Date | null;
        describedBytes: number | null;
        describedBytesAt: Date | null;
      }
    | undefined
  > {
    const rows = await this.#db
      .select({
        content: memory.content,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        describedBytes: memory.describedBytes,
        describedBytesAt: memory.describedBytesAt,
      })
      .from(memory)
      .where(eq(memory.slug, slug))
      .limit(1);
    return rows[0];
  }

  // 読んでから書く形にしない: 並行な追記が間に入ると消えるため。SQL の1文で連結する。
  async append(slug: string, content: string): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    const prior = await this.#readPrior(key);
    const stripped = stripNulls(content);
    const body = ensureTrailingNewline(stripped);
    // NUL を落とした結果が空なら改行を足さない: 空行が2つになり、in-memory / fs とずれるため。
    const tail = stripped === '' ? '' : body;
    const now = new Date();
    const rows = await this.#db
      .insert(memory)
      // `created_at` を `set` に入れない: 既存行の `created_at` を保つため。
      .values({ slug: key, content: body, updatedAt: now, createdAt: now })
      .onConflictDoUpdate({
        target: memory.slug,
        set: {
          content: sql`case
            when right(${memory.content}, 1) = E'\n' then ${memory.content} || E'\n' || ${tail}
            else ${memory.content} || E'\n\n' || ${tail}
          end`,
          updatedAt: now,
        },
      })
      .returning({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        createdAt: memory.createdAt,
      });
    const row = rows[0];
    if (row === undefined) throw new Error(`記憶の追記に失敗: ${slug}`);
    const { describedAt, describedBytes, describedBytesAt } = await this.#updateDerived(
      key,
      prior,
      row,
    );
    return toDocument({ ...row, describedAt, describedBytes, describedBytesAt });
  }

  async remove(slug: string, options?: RemoveMemoryOptions): Promise<void> {
    const key = this.#slug(slug);
    const ifMatch = options?.ifMatch;
    if (ifMatch === undefined) {
      await this.#db.delete(memory).where(eq(memory.slug, key));
      return;
    }
    const rows = await this.#db
      .delete(memory)
      .where(
        and(
          eq(memory.slug, key),
          sql`encode(sha256(convert_to(${memory.content}, 'UTF8')), 'hex') = ${ifMatch}`,
        ),
      )
      .returning({ slug: memory.slug });
    if (rows[0] === undefined) {
      throw new MemoryConflictError(slug, await this.read(slug));
    }
  }

  async protectionStatus(slug: string): Promise<MemoryProtectionStatus> {
    const key = this.#slug(slug);
    const rows = await this.#db
      .select({
        content: memory.content,
        humanTouchedAt: memory.humanTouchedAt,
        contentSha256: memory.contentSha256,
      })
      .from(memory)
      .where(eq(memory.slug, key))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { kind: 'unknown' };
    if (row.humanTouchedAt !== null) return { kind: 'human' };
    if (row.contentSha256 === null) return this.#healRow(key, row.content);
    return row.contentSha256 === sha256Hex(row.content)
      ? { kind: 'clone-only' }
      : { kind: 'unknown' };
  }

  // `content_sha256 is null` の行だけを `UPDATE ... WHERE` で治す: 同時に複数の読み出しが来ても、先着した1件だけが日誌へ記録するため。
  // `described_at` を触らない: 行が既にあった以上 `content` は変わっておらず、要旨の鮮度判定に影響しないため。
  async #healRow(slug: string, content: string): Promise<MemoryProtectionStatus> {
    const humanTouchedAt = await deriveHumanTouchedAtFromJournal(this.#journal);
    const touchedAt = humanTouchedAt.get(slug);
    const healed = await this.#db
      .update(memory)
      .set({
        contentSha256: sha256Hex(content),
        ...(touchedAt === undefined ? {} : { humanTouchedAt: new Date(touchedAt) }),
      })
      .where(and(eq(memory.slug, slug), isNull(memory.contentSha256)))
      .returning({ slug: memory.slug });
    if (healed.length > 0) {
      const { decision, grounds } = memoryProtectionRebuildDecision({
        humanRestored: touchedAt === undefined ? 0 : 1,
        hashesBaselined: 1,
      });
      await this.#journal.append({ type: 'decision', decision, grounds });
    }
    return touchedAt === undefined ? { kind: 'clone-only' } : { kind: 'human' };
  }

  async markHumanTouched(slug: string, at: string): Promise<void> {
    const key = this.#slug(slug);
    const when = new Date(at);
    // 新しく行を作らない: 削除済みの記憶が空文字の「文書」として list() / read() に化けるため。
    // 単調非減少にする: 日誌を新しい順に舐める backfill が呼んでも巻き戻らないように。
    await this.#db
      .update(memory)
      .set({ humanTouchedAt: when })
      .where(
        and(
          eq(memory.slug, key),
          or(isNull(memory.humanTouchedAt), lt(memory.humanTouchedAt, when)),
        ),
      );
  }

  async markCreatedAt(slug: string, at: string): Promise<boolean> {
    const key = this.#slug(slug);
    const when = new Date(at);
    const updated = await this.#db
      .update(memory)
      .set({ createdAt: when })
      .where(and(eq(memory.slug, key), isNull(memory.createdAt)))
      .returning({ slug: memory.slug });
    return updated.length > 0;
  }

  // `list()` してから `read()` する形にしない: 記憶の枚数だけクエリが飛び（N+1）、クローンのターンごとに通る経路のため。
  async documents(): Promise<MemoryDocument[]> {
    const rows = await this.#db
      .select({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        describedBytes: memory.describedBytes,
        describedBytesAt: memory.describedBytesAt,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .orderBy(asc(byteOrder(memory.slug)));
    return rows.map(toDocument);
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(memory).returning({ slug: memory.slug });
    return removed.length;
  }
}

interface MemoryRow {
  slug: string;
  content: string;
  updatedAt: Date | string;
  describedAt: Date | string | null;
  describedBytes: number | null;
  describedBytesAt: Date | string | null;
  createdAt: Date | string | null;
}

function toDocument(row: MemoryRow): MemoryDocument {
  const updatedAt = toIso(row.updatedAt);
  const currentBytes = Buffer.byteLength(row.content, 'utf8');
  const derived = deriveMemoryFrontmatter({
    content: row.content,
    updatedAt,
    describedAt: row.describedAt === null ? undefined : toIso(row.describedAt),
    describedBytes: row.describedBytes === null ? undefined : row.describedBytes,
    describedBytesAt: row.describedBytesAt === null ? undefined : toIso(row.describedBytesAt),
    currentBytes,
  });
  return {
    slug: row.slug,
    title: titleOf(row.content, row.slug),
    updatedAt,
    createdAt: toMemoryCreatedAt(row.createdAt),
    bytes: currentBytes,
    content: row.content,
    frontmatter: derived.frontmatter,
    kind: derived.kind,
    description: derived.description,
    parent: derived.parent,
    descriptionFreshness: derived.descriptionFreshness,
  };
}

function toMemoryCreatedAt(at: Date | string | null): MemoryCreatedAt {
  return at === null ? { kind: 'unknown' } : { kind: 'known', at: toIso(at) };
}

function stripContent(doc: MemoryDocument): MemoryDocumentMeta {
  return {
    slug: doc.slug,
    title: doc.title,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    bytes: doc.bytes,
    frontmatter: doc.frontmatter,
    kind: doc.kind,
    description: doc.description,
    parent: doc.parent,
    descriptionFreshness: doc.descriptionFreshness,
  };
}

function titleOf(content: string, fallback: string): string {
  for (const line of content.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  return fallback;
}
