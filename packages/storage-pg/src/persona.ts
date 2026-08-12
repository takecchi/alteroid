import { memorySlugSchema } from '@alteroid/core';
import type { MemoryDocument, MemoryDocumentMeta, PersonaStore } from '@alteroid/core';
import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { toIso } from './db.js';
import { memory } from './schema.js';

/**
 * 記憶 = テーブルに入った Markdown 文書（fs 版と同じ中身）。
 *
 * 人間がいつでも読んで直せることは、クラウドでも要件のままである（提供価値1）。
 * ローカルではファイルを開けばよいが、ここでは CLI / HTTP API がその経路になる。
 * だからこの層は fs 版と同じく**キャッシュしない** — 外から書き換えられた記憶が
 * 次の会話に反映されない実装は、受け入れ基準を満たさない。
 */
export class PgPersonaStore implements PersonaStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #slug(slug: string): string {
    const parsed = memorySlugSchema.safeParse(slug);
    if (!parsed.success) throw new Error(`記憶のスラッグが不正: ${slug}`);
    return parsed.data;
  }

  async list(): Promise<MemoryDocumentMeta[]> {
    const rows = await this.#db
      .select({ slug: memory.slug, content: memory.content, updatedAt: memory.updatedAt })
      .from(memory)
      .orderBy(asc(memory.slug));
    return rows.map((row) => stripContent(toDocument(row)));
  }

  async read(slug: string): Promise<MemoryDocument | null> {
    const rows = await this.#db
      .select({ slug: memory.slug, content: memory.content, updatedAt: memory.updatedAt })
      .from(memory)
      .where(eq(memory.slug, this.#slug(slug)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async write(slug: string, content: string): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    const body = ensureTrailingNewline(content);
    const rows = await this.#db
      .insert(memory)
      .values({ slug: key, content: body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: memory.slug,
        set: { content: body, updatedAt: new Date() },
      })
      .returning({ slug: memory.slug, content: memory.content, updatedAt: memory.updatedAt });
    const row = rows[0];
    if (row === undefined) throw new Error(`記憶の書き込みに失敗: ${slug}`);
    return toDocument(row);
  }

  /**
   * 末尾に追記する。**読んでから書く形にしない。**
   *
   * 蒸留は同じ文書へ並行に追記しうるので、SQL の1文で連結する。読み書きに割ると、
   * 間に入った別の追記が消える（fs 版が書き込みを直列化しているのと同じ理由）。
   */
  async append(slug: string, content: string): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    const body = ensureTrailingNewline(content);
    const rows = await this.#db
      .insert(memory)
      .values({ slug: key, content: body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: memory.slug,
        set: {
          content: sql`case
            when right(${memory.content}, 1) = E'\n' then ${memory.content} || E'\n' || ${body}
            else ${memory.content} || E'\n\n' || ${body}
          end`,
          updatedAt: new Date(),
        },
      })
      .returning({ slug: memory.slug, content: memory.content, updatedAt: memory.updatedAt });
    const row = rows[0];
    if (row === undefined) throw new Error(`記憶の追記に失敗: ${slug}`);
    return toDocument(row);
  }

  async remove(slug: string): Promise<void> {
    await this.#db.delete(memory).where(eq(memory.slug, this.#slug(slug)));
  }

  async concat(): Promise<string> {
    const rows = await this.#db
      .select({ slug: memory.slug, content: memory.content, updatedAt: memory.updatedAt })
      .from(memory)
      .orderBy(asc(memory.slug));
    return rows
      .map((row) => `<!-- memory: ${row.slug}.md -->\n${row.content.trimEnd()}`)
      .join('\n\n');
  }
}

interface MemoryRow {
  slug: string;
  content: string;
  updatedAt: Date | string;
}

function toDocument(row: MemoryRow): MemoryDocument {
  return {
    slug: row.slug,
    title: titleOf(row.content, row.slug),
    updatedAt: toIso(row.updatedAt),
    bytes: Buffer.byteLength(row.content, 'utf8'),
    content: row.content,
  };
}

function stripContent(doc: MemoryDocument): MemoryDocumentMeta {
  return { slug: doc.slug, title: doc.title, updatedAt: doc.updatedAt, bytes: doc.bytes };
}

function titleOf(content: string, fallback: string): string {
  for (const line of content.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  return fallback;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
