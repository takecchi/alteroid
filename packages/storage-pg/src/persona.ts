import {
  MemoryConflictError,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryFrontmatter,
  ensureTrailingNewline,
  memoryHeadingOf,
  memorySlugSchema,
  memoryProtectionRebuildDecision,
  memoryTitleOf,
  nextDescribedState,
  sha256Hex,
  stripMemoryContent,
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
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

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

  // 一覧のために本文を全部流さない（#5089）: 先頭の `LIST_HEAD_CHARS` 字と大きさだけを読み、題と frontmatter が先頭の完結した行の中で決まる文書はそれで作る。
  // 決まらない文書（先頭に見出しが無い・frontmatter が閉じていない）だけ本文を読み直す。どちらでも `read()` から作る値と同じになる
  async list(): Promise<MemoryDocumentMeta[]> {
    const rows = await this.#db
      .select({
        slug: memory.slug,
        head: sql<string>`left(${memory.content}, ${LIST_HEAD_CHARS})`,
        chars: sql<number>`char_length(${memory.content})`,
        // `Buffer.byteLength(content, 'utf8')` と同じ値: 器の文字コードによらず UTF-8 で数える
        bytes: sql<number>`octet_length(convert_to(${memory.content}, 'UTF8'))`,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        describedBytes: memory.describedBytes,
        describedBytesAt: memory.describedBytesAt,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .orderBy(asc(byteOrder(memory.slug)));

    const metas = new Map<string, MemoryDocumentMeta>();
    const undecided: string[] = [];
    for (const row of rows) {
      const content = decidedPrefix(row.head, Number(row.chars) <= LIST_HEAD_CHARS);
      if (content === undefined) {
        undecided.push(row.slug);
        continue;
      }
      metas.set(row.slug, metaOf(row, content, Number(row.bytes)));
    }
    if (undecided.length > 0) {
      const full = await this.#db
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
        .where(inArray(memory.slug, undecided));
      for (const row of full) metas.set(row.slug, stripMemoryContent(toDocument(row)));
    }
    // 1回目の並びを保つ。2回目までの間に消えた文書は落とす
    return rows.flatMap((row) => {
      const meta = metas.get(row.slug);
      return meta === undefined ? [] : [meta];
    });
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
              .values({
                slug: key,
                content: body,
                contentSha256: sha256Hex(body),
                updatedAt: now,
                createdAt: now,
              })
              .onConflictDoNothing({ target: memory.slug })
              .returning(returning)
          : await this.#db
              .update(memory)
              .set({ content: body, contentSha256: sha256Hex(body), updatedAt: now })
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
      // ハッシュは本文と同じ1文で書く（#4739）: 別の文で後から書くと、交錯した書き手・途中の失敗で本文とずれ、保護の判定が `unknown` に倒れるため
      .values({
        slug: key,
        content: body,
        contentSha256: sha256Hex(body),
        updatedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: memory.slug,
        set: { content: body, contentSha256: sha256Hex(body), updatedAt: now },
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
      // ハッシュはここで書かない（#4739）: 本文と同じ1文で書いてある。ここで書くと、交錯した別の書き手の本文に古いハッシュを重ねるため
      .set({
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
    const appended = sql`case
      when right(${memory.content}, 1) = E'\n' then ${memory.content} || E'\n' || ${tail}
      else ${memory.content} || E'\n\n' || ${tail}
    end`;
    const rows = await this.#db
      .insert(memory)
      // `created_at` を `set` に入れない: 既存行の `created_at` を保つため。
      .values({
        slug: key,
        content: body,
        contentSha256: sha256Hex(body),
        updatedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: memory.slug,
        // ハッシュは連結した本文から同じ1文で出す（#4739）
        set: {
          content: appended,
          contentSha256: sql`encode(sha256(convert_to(${appended}, 'UTF8')), 'hex')`,
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

/** 一覧で読む本文の先頭の字数（#5089）。frontmatter と最初の見出しは、ふつう先頭の数行に在る */
const LIST_HEAD_CHARS = 4096;

/**
 * 先頭だけで題と frontmatter が全文と同じに決まるなら、その判定に使う本文（全文か、完結した行までの先頭）を返す。決まらなければ undefined。
 * 決まる条件: 全文が先頭に収まっている／先頭の完結した行の中に、最初の見出しが在り、かつ frontmatter が無いか閉じている
 */
function decidedPrefix(head: string, complete: boolean): string | undefined {
  if (complete) return head;
  const lastNewline = head.lastIndexOf('\n');
  if (lastNewline < 0) return undefined;
  // 途中で切れた最後の行は使わない: 切れた行が見出しや区切りに見えると、全文と違う判定になるため
  const prefix = head.slice(0, lastNewline + 1);
  if (memoryHeadingOf(prefix) === undefined) return undefined;
  const lines = prefix.split('\n');
  if (lines[0]?.trim() === FRONTMATTER_DELIMITER) {
    const closed = lines.some((line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER);
    if (!closed) return undefined;
  }
  return prefix;
}

// `memory.ts` の `parseMemoryFrontmatter` と同じ区切り
const FRONTMATTER_DELIMITER = '---';

function metaOf(
  row: Omit<MemoryRow, 'content'>,
  content: string,
  currentBytes: number,
): MemoryDocumentMeta {
  const updatedAt = toIso(row.updatedAt);
  const derived = deriveMemoryFrontmatter({
    content,
    updatedAt,
    describedAt: row.describedAt === null ? undefined : toIso(row.describedAt),
    describedBytes: row.describedBytes === null ? undefined : row.describedBytes,
    describedBytesAt: row.describedBytesAt === null ? undefined : toIso(row.describedBytesAt),
    currentBytes,
  });
  return {
    slug: row.slug,
    title: memoryTitleOf(content, row.slug),
    updatedAt,
    createdAt: toMemoryCreatedAt(row.createdAt),
    bytes: currentBytes,
    frontmatter: derived.frontmatter,
    kind: derived.kind,
    description: derived.description,
    parent: derived.parent,
    descriptionFreshness: derived.descriptionFreshness,
  };
}

// 欄の並びは変える前と同じにする（`content` は `bytes` の後）: 応答の JSON の形を変えないため
function toDocument(row: MemoryRow): MemoryDocument {
  const meta = metaOf(row, row.content, Buffer.byteLength(row.content, 'utf8'));
  return {
    slug: meta.slug,
    title: meta.title,
    updatedAt: meta.updatedAt,
    createdAt: meta.createdAt,
    bytes: meta.bytes,
    content: row.content,
    frontmatter: meta.frontmatter,
    kind: meta.kind,
    description: meta.description,
    parent: meta.parent,
    descriptionFreshness: meta.descriptionFreshness,
  };
}

function toMemoryCreatedAt(at: Date | string | null): MemoryCreatedAt {
  return at === null ? { kind: 'unknown' } : { kind: 'known', at: toIso(at) };
}
