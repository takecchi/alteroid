import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MemoryConflictError,
  deriveHumanTouchedAtFromJournal,
  deriveMemoryFrontmatter,
  ensureTrailingNewline,
  stripNul,
  memorySlugSchema,
  memoryVersionMatches,
  memoryProtectionRebuildDecision,
  nextDescribedState,
  resolveMemoryDescriptionFreshness,
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

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

interface MemoryIndexEntry {
  humanTouchedAt?: string;
  contentSha256?: string;
  // 書き手は書けない: 書き手が採番すると `updatedAt` より前になり、書いた直後から「古い」と出るため
  describedAt?: string;
  // `read()` が返す `bytes`（`stats.size`）と同じ測り方にする: 1バイトでもずれると、全文書が「基準点を立てた直後から少し変わっている」に化けるため
  describedBytes?: number;
  describedBytesAt?: string;
  // 「unknown」という値は書き込まない: 値が無いこと自体が「日誌に根拠が無い」を表すため
  createdAt?: string;
}

type MemoryIndex = Record<string, MemoryIndexEntry>;

export const MEMORY_INDEX_FILENAME = '.index.json';

// 初期の索引を seed と一緒に置く: 索引が無いと `#readIndex` が「失われた」と見て組み直し、「索引の組み直し」の decision を日誌へ書いてしまうため
export function initialMemoryIndexJson(docs: readonly { slug: string; content: string }[]): string {
  const index: MemoryIndex = {};
  for (const doc of docs) index[doc.slug] = { contentSha256: sha256Hex(doc.content) };
  return JSON.stringify(index);
}

// 読み出しは常にファイルを読み直し、キャッシュしない: 人間の手編集が次の会話に反映されなくなるため
export class FsPersonaStore implements PersonaStore {
  readonly #dir: string;
  readonly #journal: JournalStore;
  // 進行中の組み直しをメモ化する: 同時に複数走ると、組み直しを知らせる日誌エントリが複数件になるため。完了したら null に戻し、次に索引が消えたら改めて組み直す
  #rebuildingIndex: Promise<MemoryIndex> | null = null;

  constructor(dir: string, journal: JournalStore) {
    this.#dir = dir;
    this.#journal = journal;
  }

  // ロック対象は常に `.index.json` 1本にする: `append()` は `.md` と `.index.json` の2ファイルにまたがる1操作で、ファイルごとに別のロックを取ると取得順序の違いでデッドロックしうるため
  // ここで `mkdir` を先に呼ばない: `withPathLock` を呼んだ時点で同期的にプロセス内 FIFO へ並ぶことに依存しているため
  async #serialize<T>(task: () => Promise<T>): Promise<T> {
    return withPathLock(this.#indexPath(), task);
  }

  // `protectionStatus` / `markHumanTouched` / `markCreatedAt` からも直接呼ぶ: `#path` 経由だと、実体が既にある slug には検査が効かない穴があるため
  #checkSlug(slug: string): string {
    const parsed = memorySlugSchema.safeParse(slug);
    if (!parsed.success) throw new Error(`記憶のスラッグが不正: ${slug}`);
    return parsed.data;
  }

  #path(slug: string): string {
    return join(this.#dir, `${this.#checkSlug(slug)}.md`);
  }

  #indexPath(): string {
    return join(this.#dir, MEMORY_INDEX_FILENAME);
  }

  // 無い・壊れているときはその場で日誌から組み直す: 起動時の backfill だけだと、走行中に索引が消えると次の再起動まで全文書が保護されたまま凍るため
  // `#doRebuildIndex` の中で `withPathLock(this.#indexPath(), …)` を取らない: `#serialize` の区間の内側から `#rebuildIndex()` が呼ばれうり、`withPathLock` は再入可能でなくデッドロックするため
  async #readIndex(): Promise<MemoryIndex> {
    try {
      const raw = await readFile(this.#indexPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as MemoryIndex;
      }
    } catch {
      // 無いか、JSON として読めない: 組み直す
    }
    return this.#rebuildIndex();
  }

  async #writeIndex(index: MemoryIndex): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#indexPath(), JSON.stringify(index));
  }

  async #rebuildIndex(): Promise<MemoryIndex> {
    this.#rebuildingIndex ??= this.#doRebuildIndex().finally(() => {
      this.#rebuildingIndex = null;
    });
    return this.#rebuildingIndex;
  }

  async #doRebuildIndex(): Promise<MemoryIndex> {
    const humanTouchedAt = await deriveHumanTouchedAtFromJournal(this.#journal);
    // `this.documents()` を呼ばない: `#readIndex()` が再び `#rebuildIndex()` を呼び、進行中の Promise を自分自身が待つデッドロックになるため
    const docs = await this.#listRawContents();
    const index: MemoryIndex = {};
    let humanRestored = 0;
    for (const doc of docs) {
      const entry: MemoryIndexEntry = { contentSha256: sha256Hex(doc.content) };
      const touchedAt = humanTouchedAt.get(doc.slug);
      if (touchedAt !== undefined) {
        entry.humanTouchedAt = touchedAt;
        humanRestored += 1;
      }
      index[doc.slug] = entry;
    }
    await this.#writeIndex(index);
    const { decision, grounds } = memoryProtectionRebuildDecision({
      humanRestored,
      hashesBaselined: docs.length,
    });
    await this.#journal.append({ type: 'decision', decision, grounds });
    return index;
  }

  async #listRawContents(): Promise<{ slug: string; content: string }[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const out: { slug: string; content: string }[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -'.md'.length);
      if (!memorySlugSchema.safeParse(slug).success) continue;
      try {
        const content = await readFile(this.#path(slug), 'utf8');
        out.push({ slug, content });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return out;
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
      const updatedAt = stats.mtime.toISOString();
      const index = await this.#readIndex();
      const derived = deriveMemoryFrontmatter({
        content,
        updatedAt,
        describedAt: index[slug]?.describedAt,
        describedBytes: index[slug]?.describedBytes,
        describedBytesAt: index[slug]?.describedBytesAt,
        currentBytes: stats.size,
      });
      return {
        slug,
        title: titleOf(content, slug),
        updatedAt,
        createdAt: toMemoryCreatedAt(index[slug]?.createdAt),
        bytes: stats.size,
        content,
        frontmatter: derived.frontmatter,
        kind: derived.kind,
        description: derived.description,
        parent: derived.parent,
        descriptionFreshness: derived.descriptionFreshness,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async write(
    slug: string,
    content: string,
    options?: WriteMemoryOptions,
  ): Promise<MemoryDocument> {
    return this.#serialize(async () => {
      // 前提の版の比較は `#serialize` の内側で行う: 外で読んでから入ると、その間の別の書き手を見逃すため
      if (options?.ifMatch !== undefined) {
        const current = await this.read(slug);
        if (!memoryVersionMatches(current, options.ifMatch)) {
          throw new MemoryConflictError(slug, current);
        }
      }
      return this.#writeNow(slug, content);
    });
  }

  async append(slug: string, content: string): Promise<MemoryDocument> {
    return this.#serialize(async () => {
      const existing = await this.read(slug);
      if (!existing) return this.#writeNow(slug, content);
      return this.#writeNow(slug, `${ensureTrailingNewline(existing.content)}\n${content}`);
    });
  }

  async #writeNow(slug: string, content: string): Promise<MemoryDocument> {
    const before = await this.read(slug);
    const path = this.#path(slug);
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(path, ensureTrailingNewline(stripNul(content)));
    const written = await this.read(slug);
    if (!written) throw new Error(`記憶の書き込みに失敗: ${slug}`);
    // `humanTouchedAt` は更新対象に含めない: 保護の印を降ろさない唯一の保証が、ここで触らないことだから
    const index = await this.#readIndex();
    const priorEntry = index[slug];
    // `describedAt` などは `written.updatedAt` / `written.bytes` と同じ値に確定させる: 別に採番すると mtime の精度差で `stale` に化けたり、1バイトずれたりするため
    const { describedAt, describedBytes, describedBytesAt } = nextDescribedState({
      priorContent: before?.content ?? null,
      nextContent: written.content,
      priorDescribedAt: priorEntry?.describedAt,
      priorDescribedBytes: priorEntry?.describedBytes,
      priorDescribedBytesAt: priorEntry?.describedBytesAt,
      priorBytes: before?.bytes,
      priorUpdatedAt: before?.updatedAt,
      writtenAt: written.updatedAt,
      writtenBytes: written.bytes,
    });
    // `createdAt` は作成を観測した（`before === null` の）ときだけ立てる: 観測していない文書の作成時刻を FS の時刻から捏造しないため
    const createdAt = priorEntry?.createdAt ?? (before === null ? written.updatedAt : undefined);
    index[slug] = {
      ...priorEntry,
      contentSha256: sha256Hex(written.content),
      describedAt,
      describedBytes,
      describedBytesAt,
      createdAt,
    };
    await this.#writeIndex(index);
    // 確定した値で戻り値を組み直す: 省くと、新規作成直後の戻り値だけが「不明」のままになり、pg 版の `RETURNING` と食い違うため
    return {
      ...written,
      createdAt: toMemoryCreatedAt(createdAt),
      descriptionFreshness: resolveMemoryDescriptionFreshness({
        description: written.description,
        describedAt,
        updatedAt: written.updatedAt,
        describedBytes,
        describedBytesAt,
        currentBytes: written.bytes,
      }),
    };
  }

  async remove(slug: string, options?: RemoveMemoryOptions): Promise<void> {
    await this.#serialize(async () => {
      if (options?.ifMatch !== undefined) {
        const current = await this.read(slug);
        if (!memoryVersionMatches(current, options.ifMatch)) {
          throw new MemoryConflictError(slug, current);
        }
      }
      await rm(this.#path(slug), { force: true });
      // 保護状態の派生値（human 印）も一緒に消す: 印だけが実体の無いまま残るのは監査上の嘘になるため
      const index = await this.#readIndex();
      if (slug in index) {
        delete index[slug];
        await this.#writeIndex(index);
      }
    });
  }

  async protectionStatus(slug: string): Promise<MemoryProtectionStatus> {
    this.#checkSlug(slug);
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
    this.#checkSlug(slug);
    await this.#serialize(async () => {
      const index = await this.#readIndex();
      const entry = index[slug];
      // 実体が無い slug に新しい行を作らない: 削除済みの記憶が index にだけ復活するのを防ぐため
      if (entry === undefined && (await this.read(slug)) === null) return;
      const prior = entry?.humanTouchedAt;
      // 単調非減少にする: backfill は日誌を新しい順に舐めるので、古いエントリで巻き戻らないようにするため
      const next = prior === undefined || at > prior ? at : prior;
      index[slug] = { ...entry, humanTouchedAt: next };
      await this.#writeIndex(index);
    });
  }

  async markCreatedAt(slug: string, at: string): Promise<boolean> {
    this.#checkSlug(slug);
    return this.#serialize(async () => {
      const index = await this.#readIndex();
      const entry = index[slug];
      if (entry === undefined && (await this.read(slug)) === null) return false;
      // 一度きりの確定にする: 既に値があれば触らず、2回目以降の backfill を冪等にするため
      if (entry?.createdAt !== undefined) return false;
      index[slug] = { ...entry, createdAt: at };
      await this.#writeIndex(index);
      return true;
    });
  }

  // 1つの文字列へ潰さない: 載せ方は `renderMemoryDocuments` の仕事で、器が持つと実装ごとに形が食い違うため
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

  async clear(): Promise<number> {
    return this.#serialize(async () => {
      const docs = await this.#listRawContents();
      for (const doc of docs) await rm(this.#path(doc.slug), { force: true });
      // 索引は消さず空の索引を置く: 消すと次の読み出しが「失われた」と見て組み直し、「索引の組み直し」の decision を日誌へ書いてしまうため
      await this.#writeIndex({});
      return docs.length;
    });
  }
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

function toMemoryCreatedAt(at: string | undefined): MemoryCreatedAt {
  return at === undefined ? { kind: 'unknown' } : { kind: 'known', at };
}

function titleOf(content: string, fallback: string): string {
  for (const line of content.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  return fallback;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
