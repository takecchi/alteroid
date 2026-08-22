import {
  deriveHumanTouchedAtFromJournal,
  deriveMemoryFrontmatter,
  memorySlugSchema,
  memoryProtectionRebuildDecision,
  nextDescribedAt,
  sha256Hex,
} from '@alteroid/core';
import type {
  JournalStore,
  MemoryCreatedAt,
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
        createdAt: memory.createdAt,
      })
      .from(memory)
      .orderBy(asc(memory.slug));
    return rows.map((row) => stripContent(toDocument(row)));
  }

  async read(slug: string): Promise<MemoryDocument | null> {
    const rows = await this.#db
      .select({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .where(eq(memory.slug, this.#slug(slug)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toDocument(row);
  }

  async write(slug: string, content: string): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    // **describedAt の判定に要る「書く前の内容」を先に控える。** upsert は
    // SQL の1文で完結するので、JS 側からは新旧の content を突き合わせられない
    // ——別途 SELECT する（fs 版の `#writeNow` が先に `read()` するのと同じ形）。
    const prior = await this.#readPrior(key);
    const body = stripNulls(ensureTrailingNewline(content));
    const now = new Date();
    const rows = await this.#db
      .insert(memory)
      // **新規作成のときだけ `created_at` が入る。** conflict 側（＝更新）の
      // `set` には含めないので、既存行の `created_at` は NULL でも保たれる。
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
    const row = rows[0];
    if (row === undefined) throw new Error(`記憶の書き込みに失敗: ${slug}`);
    const describedAt = await this.#updateDerived(key, prior, row);
    return toDocument({ ...row, describedAt });
  }

  /**
   * 書いた直後の content をハッシュして `content_sha256` へ記録し、
   * `described_at` を進める（変わっていなければ据え置く）。
   *
   * **write() と append() の両方から呼ぶ。** fs 版は `#writeNow` という
   * 唯一の通り道があるが、pg はこの2つが独立したメソッドなので、片方だけ
   * 直す穴を作らないよう意識的に2箇所で揃える。`human_touched_at` はここでは
   * 一切更新しない — 降ろさないための唯一の保証は、この列を更新対象に
   * 含めないことである。
   *
   * **`describedAt` は書き手が渡す値ではなく、ここで新旧の `description` を
   * 比べて決める**（`@alteroid/core` の `nextDescribedAt` の doc）。渡した
   * `row.updatedAt` と同じ時刻を使うことで、直後の読み出しが必ず `fresh` に
   * なるようにする。
   */
  async #updateDerived(
    slug: string,
    prior: { content: string; describedAt: Date | null } | undefined,
    written: { content: string; updatedAt: Date | string },
  ): Promise<Date | null> {
    const describedAtIso = nextDescribedAt({
      priorContent: prior?.content ?? null,
      nextContent: written.content,
      priorDescribedAt:
        prior?.describedAt === null || prior?.describedAt === undefined
          ? undefined
          : toIso(prior.describedAt),
      writtenAt: toIso(written.updatedAt),
    });
    const describedAt = describedAtIso === undefined ? null : new Date(describedAtIso);
    await this.#db
      .update(memory)
      .set({ contentSha256: sha256Hex(written.content), describedAt })
      .where(eq(memory.slug, slug));
    return describedAt;
  }

  async #readPrior(
    slug: string,
  ): Promise<{ content: string; describedAt: Date | null } | undefined> {
    const rows = await this.#db
      .select({ content: memory.content, describedAt: memory.describedAt })
      .from(memory)
      .where(eq(memory.slug, slug))
      .limit(1);
    return rows[0];
  }

  /**
   * 末尾に追記する。**読んでから書く形にしない。**
   *
   * 蒸留は同じ文書へ並行に追記しうるので、SQL の1文で連結する。読み書きに割ると、
   * 間に入った別の追記が消える（fs 版が書き込みを直列化しているのと同じ理由）。
   *
   * **`describedAt` の判定用の「書く前の内容」は、この直列化と別に取る**
   * （下の `#readPrior`）。並行な追記が競合しても、`description` は
   * frontmatter（本文の先頭）にしか無く、末尾への追記では通常変わらない
   * ——変わる稀なケース（追記中の内容に frontmatter の再定義が混じる等）は
   * 想定しない。
   */
  async append(slug: string, content: string): Promise<MemoryDocument> {
    const key = this.#slug(slug);
    const prior = await this.#readPrior(key);
    const body = stripNulls(ensureTrailingNewline(content));
    const now = new Date();
    const rows = await this.#db
      .insert(memory)
      // **新規作成のときだけ `created_at` が入る。** conflict 側（＝更新）の
      // `set` には含めないので、既存行の `created_at` は NULL でも保たれる。
      .values({ slug: key, content: body, updatedAt: now, createdAt: now })
      .onConflictDoUpdate({
        target: memory.slug,
        set: {
          content: sql`case
            when right(${memory.content}, 1) = E'\n' then ${memory.content} || E'\n' || ${body}
            else ${memory.content} || E'\n\n' || ${body}
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
    const describedAt = await this.#updateDerived(key, prior, row);
    return toDocument({ ...row, describedAt });
  }

  /**
   * 行ごと消す。**保護状態の派生値（`human_touched_at` / `content_sha256`）も
   * 同じ行に乗っているので一緒に消える** — fs 版の `remove()` が索引エントリを
   * 消すのと同じ意味である。過去に一度でも human で書かれた事実そのものは
   * 日誌に残り続けるので、デーモン再起動時の backfill が再びこの印を立て直す。
   * `described_at` も同じ行が消えるので一緒に消える（要旨の鮮度は実体が無い
   * 文書には意味を持たない）。
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
    if (row.contentSha256 === null) return this.#healRow(key, row.content);
    return row.contentSha256 === sha256Hex(row.content)
      ? { kind: 'clone-only' }
      : { kind: 'unknown' };
  }

  /**
   * 保護状態の派生値をその場で組み直す（1行ぶん）。
   *
   * **fs 版（`.index.json` 全体の組み直し）とは粒度が違う。** fs は索引が
   * 「1ファイル丸ごと在るか無いか」で失われるが、pg には索引ファイルという
   * 概念が無く、`human_touched_at` / `content_sha256` は行ごとの列である。
   * だからここは**行単位**で「派生値を失っている（`content_sha256` が
   * `null`）」ことを検出し、その行だけを治す。`human_touched_at` が既に
   * 立っている行はここへ来ない（`protectionStatus` が先に `human` を返す）。
   *
   * **`humanTouchedAt`（保護の信号そのもの）は日誌から完全に復元できる**
   * ので保護は失われないが、**外部編集の検出の履歴は失われる**——ハッシュは
   * 日誌に無いので、いまの本文の値で新しく基準化する。この判断の理由は
   * `memoryProtectionRebuildDecision` の doc にある。**`described_at`
   * （#170 の派生値）はここでは触らない** — 行が既にあった以上 `content` は
   * 変わっておらず、`description` の鮮度判定には影響しない。
   *
   * **`content_sha256 is null` の行だけを対象にした `UPDATE ... WHERE` で
   * 治す。** 同時に複数の読み出しが来ても、実際に列を動かせた（＝先着した）
   * 1件だけが日誌へ記録する——2件目以降は `WHERE` に当たらず 0 行更新になる
   * ので、二重に記録しない。
   */
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
    // 行が既に在るときだけ更新する（**新しく行を作らない**）。無い slug へ行を
    // 作ると、削除済みの記憶が空文字の「文書」として list() / read() に化けて
    // 出てくる。単調非減少にするのは、日誌を新しい順に舐める backfill が
    // 呼んでも巻き戻らないようにするため。
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
    // `markHumanTouched` と同じく、行が既に在るときだけ更新し新しい行は作らない。
    // **単調非減少ではなく一度きりの確定**——`created_at` が既に埋まっている行は
    // `isNull` に当たらず 0 行更新になる（絶対条件2「埋めるのは値が無いときだけ」
    // が、この WHERE 句そのもので冪等になる）。**`returning` で実際に動いた行数を
    // 数える**——backfill が「何件埋めたか」を観測するのに要る（絶対条件5）。
    const updated = await this.#db
      .update(memory)
      .set({ createdAt: when })
      .where(and(eq(memory.slug, key), isNull(memory.createdAt)))
      .returning({ slug: memory.slug });
    return updated.length > 0;
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
      .select({
        slug: memory.slug,
        content: memory.content,
        updatedAt: memory.updatedAt,
        describedAt: memory.describedAt,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .orderBy(asc(memory.slug));
    return rows.map(toDocument);
  }
}

interface MemoryRow {
  slug: string;
  content: string;
  updatedAt: Date | string;
  describedAt: Date | string | null;
  createdAt: Date | string | null;
}

function toDocument(row: MemoryRow): MemoryDocument {
  const updatedAt = toIso(row.updatedAt);
  const derived = deriveMemoryFrontmatter({
    content: row.content,
    updatedAt,
    describedAt: row.describedAt === null ? undefined : toIso(row.describedAt),
  });
  return {
    slug: row.slug,
    title: titleOf(row.content, row.slug),
    updatedAt,
    createdAt: toMemoryCreatedAt(row.createdAt),
    bytes: Buffer.byteLength(row.content, 'utf8'),
    content: row.content,
    frontmatter: derived.frontmatter,
    kind: derived.kind,
    description: derived.description,
    parent: derived.parent,
    descriptionFreshness: derived.descriptionFreshness,
  };
}

/** 行の生の値（nullable）を `MemoryCreatedAt`（2値）へ組み立てる。 */
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

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
