import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { memorySlugSchema } from '@alteroid/core';
import type { MemoryDocument, MemoryDocumentMeta, PersonaStore } from '@alteroid/core';

/**
 * 記憶 = Markdown ファイル群。
 *
 * 人間が `~/.alteroid/memory/*.md` を直接開いて書き換えられること自体が要件
 * （提供価値1）。したがって読み出しは常にファイルを読み直し、キャッシュしない
 * — 人間の手編集が次の会話に反映されないと受け入れ基準3を満たさない。
 */
export class FsPersonaStore implements PersonaStore {
  readonly #dir: string;
  /** 書き込みを直列化する。蒸留は同じ文書へ並行に追記しうる。 */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
  }

  /** read-modify-write が取りこぼさないよう、書き込みを1本に並べる。 */
  async #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #path(slug: string): string {
    const parsed = memorySlugSchema.safeParse(slug);
    if (!parsed.success) throw new Error(`記憶のスラッグが不正: ${slug}`);
    return join(this.#dir, `${parsed.data}.md`);
  }

  async list(): Promise<MemoryDocumentMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const metas: MemoryDocumentMeta[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -'.md'.length);
      if (!memorySlugSchema.safeParse(slug).success) continue;
      const doc = await this.read(slug);
      if (doc) metas.push(stripContent(doc));
    }
    return metas;
  }

  async read(slug: string): Promise<MemoryDocument | null> {
    const path = this.#path(slug);
    try {
      const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return {
        slug,
        title: titleOf(content, slug),
        updatedAt: stats.mtime.toISOString(),
        bytes: stats.size,
        content,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async write(slug: string, content: string): Promise<MemoryDocument> {
    return this.#serialize(() => this.#writeNow(slug, content));
  }

  async append(slug: string, content: string): Promise<MemoryDocument> {
    return this.#serialize(async () => {
      const existing = await this.read(slug);
      if (!existing) return this.#writeNow(slug, content);
      return this.#writeNow(slug, `${ensureTrailingNewline(existing.content)}\n${content}`);
    });
  }

  /**
   * 一時ファイル経由で置き換える。人間がエディタで開いている最中でも、
   * 切り詰められた途中経過を読ませない（「いつでも読める」が要件である以上、
   * 壊れた状態が見える瞬間を作らない）。
   */
  async #writeNow(slug: string, content: string): Promise<MemoryDocument> {
    const path = this.#path(slug);
    await mkdir(this.#dir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, ensureTrailingNewline(content), 'utf8');
    await rename(tmp, path);
    const written = await this.read(slug);
    if (!written) throw new Error(`記憶の書き込みに失敗: ${slug}`);
    return written;
  }

  async remove(slug: string): Promise<void> {
    await rm(this.#path(slug), { force: true });
  }

  /**
   * 全文書を本文ごと `slug` 昇順で返す（`list()` がその順で並べる）。
   *
   * **1つの文字列へ潰さない。** 見出しを付けて連結するのは
   * `renderMemoryDocuments`（`@alteroid/core` の `memory.ts`）の仕事であって、
   * 器の仕事ではない。かつてここが `concat()` として載せ方まで持っていたため、
   * fs / pg / インメモリで形が食い違った。
   */
  async documents(): Promise<MemoryDocument[]> {
    const metas = await this.list();
    const docs: MemoryDocument[] = [];
    for (const meta of metas) {
      const doc = await this.read(meta.slug);
      if (!doc) continue;
      docs.push(doc);
    }
    return docs;
  }
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

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
