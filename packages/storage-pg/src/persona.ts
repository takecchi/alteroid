import { memorySlugSchema, sha256Hex } from '@alteroid/core';
import type {
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PersonaStore,
} from '@alteroid/core';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toIso } from './db.js';
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
    const body = stripNulls(ensureTrailingNewline(content));
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
    await this.#updateHash(key, row.content);
    return toDocument(row);
  }

  /**
   * 書いた直後の content をハッシュして `content_sha256` へ記録する。
   *
   * **write() と append() の両方から呼ぶ。** fs 版は `#writeNow` という
   * 唯一の通り道があるが、pg はこの2つが独立したメソッドなので、片方だけ
   * 直す穴を作らないよう意識的に2箇所で揃える。`human_touched_at` はここでは
   * 一切更新しない — 降ろさないための唯一の保証は、この列を更新対象に
   * 含めないことである。
   */
  async #updateHash(slug: string, content: string): Promise<void> {
    await this.#db
      .update(memory)
      .set({ contentSha256: sha256Hex(content) })
      .where(eq(memory.slug, slug));
  }

  /**
   * 末尾に追記する。**読んでから書く形にしない。**
   *
   * 蒸留は同じ文書へ並行に追記しうるので、SQL の1文で連結する。読み書きに割ると、
   * 間に入った別の追記が消える（fs 版が書き込みを直列化しているのと同じ理由）。
   */
  async append(slug: string, content: string): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    const body = stripNulls(ensureTrailingNewline(content));
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
    await this.#updateHash(key, row.content);
    return toDocument(row);
  }

  /**
   * 行ごと消す。**保護状態の派生値（`human_touched_at` / `content_sha256`）も
   * 同じ行に乗っているので一緒に消える** — fs 版の `remove()` が索引エントリを
   * 消すのと同じ意味である。過去に一度でも human で書かれた事実そのものは
   * 日誌に残り続けるので、デーモン再起動時の backfill が再びこの印を立て直す。
   */
  async remove(slug: string): Promise<void> {
    await this.#db.delete(memory).where(eq(memory.slug, this.#slug(slug)));
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
    if (row.contentSha256 === null) return { kind: 'unknown' };
    return row.contentSha256 === sha256Hex(row.content)
      ? { kind: 'clone-only' }
      : { kind: 'unknown' };
  }

  async markHumanTouched(slug: string, at: string): Promise<void> {
    const key = this.#slug(slug);
    const when = new Date(at);
    // 行が既に在るときだけ更新する（**新しく行を作らない**）。無い slug へ行を
    // 作ると、削除済みの記憶が空文字の「文書」として list() / read() に化けて
    // 出てくる。単調非減少にするのは、日誌を新しい順に舐める backfill が
    // 呼んでも巻き戻らないようにするため。
    await this.#db
      .update(memory)
      .set({ humanTouchedAt: when })
      .where(
        and(eq(memory.slug, key), or(isNull(memory.humanTouchedAt), lt(memory.humanTouchedAt, when))),
      );
  }

  /**
   * 全文書を本文ごと `slug` 昇順で返す。**1クエリで取り切る。**
   *
   * `list()` してから slug ごとに `read()` する形にすると、記憶の枚数だけ
   * クエリが飛ぶ（N+1）。ここはクローンのターンが立つたびに通る経路である。
   *
   * 載せ方（見出しを付けて連結する形）は持たない — それは
   * `renderMemoryDocuments`（`@alteroid/core` の `memory.ts`）の仕事で、
   * 器ごとに書いた結果 fs / pg / インメモリで食い違ったのがこの分離の理由である。
   */
  async documents(): Promise<MemoryDocument[]> {
    const rows = await this.#db
      .select({ slug: memory.slug, content: memory.content, updatedAt: memory.updatedAt })
      .from(memory)
      .orderBy(asc(memory.slug));
    return rows.map(toDocument);
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
