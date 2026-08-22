import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { memorySlugSchema, sha256Hex } from '@alteroid/core';
import type {
  MemoryDocument,
  MemoryDocumentMeta,
  MemoryProtectionStatus,
  PersonaStore,
} from '@alteroid/core';

/**
 * 保護状態（human guard）の派生値、1文書ぶん。
 *
 * **新しい真実ではない。** 実体は日誌（`memory_update.cause`）にある。ここは
 * 読み出しを安くするためのキャッシュで、失った・信用できないときは `unknown`
 * （守る側）へ落ちる（`PersonaStore.protectionStatus` の doc）。
 */
interface MemoryIndexEntry {
  /** 最後に `cause:'human'` の書き込みが記録された時刻。一度立ったら降ろさない。 */
  humanTouchedAt?: string;
  /** デーモン経由で最後に書いた本文のハッシュ（sha256 hex）。外部編集の検出に使う。 */
  contentSha256?: string;
}

type MemoryIndex = Record<string, MemoryIndexEntry>;

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

  /**
   * 保護状態の索引ファイル。**`list()` は `*.md` しか見ないのでここは拾われない**
   * （`.index.json` は `.md` で終わらない）。
   */
  #indexPath(): string {
    return join(this.#dir, '.index.json');
  }

  /**
   * 索引を読む。**無い・壊れているときは空を返す**（守る側 — 全 slug が
   * `unknown` に落ちる。1つの slug が壊れていても他を巻き込まない）。
   */
  async #readIndex(): Promise<MemoryIndex> {
    try {
      const raw = await readFile(this.#indexPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      return parsed as MemoryIndex;
    } catch {
      return {};
    }
  }

  /** 一時ファイル経由で置き換える（`.md` と同じ作法。壊れた途中経過を見せない）。 */
  async #writeIndex(index: MemoryIndex): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#indexPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(index), 'utf8');
    await rename(tmp, this.#indexPath());
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
    // **書いた直後のハッシュを記録する。** ここが write() と append() の唯一の
    // 通り道なので、道具のハンドラ側（tools.ts）に同じロジックを重複させずに済む。
    // 誰が呼んだか（human / clone / distill）は問わない — 保護の印
    // （humanTouchedAt）はここでは一切触らない（降ろさないための唯一の保証は、
    // ここで更新対象に含めないことである）。
    const index = await this.#readIndex();
    index[slug] = { ...index[slug], contentSha256: sha256Hex(written.content) };
    await this.#writeIndex(index);
    return written;
  }

  async remove(slug: string): Promise<void> {
    await this.#serialize(async () => {
      await rm(this.#path(slug), { force: true });
      // 保護状態の派生値も一緒に消す（pg は行ごと DELETE するので、同じ意味を
      // fs 側でも揃える）。**人間が付けた human 印は、その文書の実体が無くなれば
      // 一緒に消える** — 印だけが実体の無いまま残るのは監査上の嘘になる。
      // 過去に一度でも human で書かれた事実そのものは日誌に残り続けるので、
      // デーモン再起動時の backfill が再びこの印を立て直す。
      const index = await this.#readIndex();
      if (slug in index) {
        delete index[slug];
        await this.#writeIndex(index);
      }
    });
  }

  async protectionStatus(slug: string): Promise<MemoryProtectionStatus> {
    const index = await this.#readIndex();
    const entry = index[slug];
    if (entry?.humanTouchedAt !== undefined) return { kind: 'human' };
    if (entry?.contentSha256 === undefined) return { kind: 'unknown' };
    const doc = await this.read(slug);
    if (doc === null) return { kind: 'unknown' };
    return entry.contentSha256 === sha256Hex(doc.content)
      ? { kind: 'clone-only' }
      : { kind: 'unknown' };
  }

  async markHumanTouched(slug: string, at: string): Promise<void> {
    await this.#serialize(async () => {
      const index = await this.#readIndex();
      const entry = index[slug];
      // 実体が無い slug に新しい行を作らない（削除済みの記憶が index にだけ
      // 復活するのを防ぐ）。既に human 印が立っているなら実体の有無を問わず
      // その印は保つ（`remove()` が消すのはこの `#serialize` チェーンの中で
      // 直列に行われるので、ここで新規に作る行と衝突しない）。
      if (entry === undefined && (await this.read(slug)) === null) return;
      const prior = entry?.humanTouchedAt;
      // **単調非減少。** backfill は日誌を新しい順に舐めるので、古いエントリで
      // 巻き戻らないようにする。
      const next = prior === undefined || at > prior ? at : prior;
      index[slug] = { ...entry, humanTouchedAt: next };
      await this.#writeIndex(index);
    });
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
