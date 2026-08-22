import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  deriveHumanTouchedAtFromJournal,
  deriveMemoryFrontmatter,
  memorySlugSchema,
  memoryProtectionRebuildDecision,
  nextDescribedAt,
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
} from '@alteroid/core';

/**
 * 保護状態（human guard）の派生値と、要旨の鮮度の派生値、1文書ぶん。
 *
 * **新しい真実ではない。** 実体は日誌（`memory_update.cause`）と本文
 * （`content` 先頭の frontmatter）にある。ここは読み出しを安くするための
 * キャッシュで、失った・信用できないときは安全側（保護は `unknown`、
 * 要旨の鮮度は `unknown`）へ落ちる。
 *
 * **ここは「誰も送らない導出値」だけを追記で伸ばす場所である。** 人間・クローンが
 * 書く値は本文（`content`）の側に置く——入口のスキーマ（`memory_write` /
 * `PUT /memory/:slug` の body）を1つも変えないことが要件だからである。
 *
 * **#173 が要った2つ（`humanTouchedAt` / `contentSha256`）の隣に、#170（記憶の
 * 目次化）が要る `describedAt` を足す。** 1ファイルへ統合する形は変えない。
 *
 * **`createdAt` も同じ隣に足す（記憶の `createdAt` 対応）。** `humanTouchedAt`
 * と完全に同じ形——素の `optional`。**「unknown」という値をここへ書き込まない**
 * ——値が無いこと自体が「日誌に根拠が無い」を表す（`memoryCreatedAtSchema` の
 * doc）。読み出し側（`read()`）が無い slug を `{ kind: 'unknown' }` へ組み立てる。
 */
interface MemoryIndexEntry {
  /** 最後に `cause:'human'` の書き込みが記録された時刻。一度立ったら降ろさない。 */
  humanTouchedAt?: string;
  /** デーモン経由で最後に書いた本文のハッシュ（sha256 hex）。外部編集の検出に使う。 */
  contentSha256?: string;
  /**
   * 最後に `description`（frontmatter）が変わったと確定した時刻。
   *
   * **書き手は書けない**（`write()` のとき新旧の `description` を比べて
   * store がここを進める。書き手が採番するとしたら `updatedAt` より必ず
   * 前になり、書いた直後から「古い」と出てしまう）。変わっていなければ
   * 据え置く（`@alteroid/core` の `nextDescribedAt` の doc）。
   */
  describedAt?: string;
  /**
   * この slug が作られた時刻。**一度定まったら変わらない**
   * （`markHumanTouched` の単調非減少とも違う——単調非減少ですらなく、
   * 一度セットしたら二度と触らない一度きりの確定値）。
   *
   * **値が入る経路は2つ。** (1) 第一の出所は `#writeNow` 自身——
   * `before === null`（＝この書き込みが文書を作った）ときに
   * `written.updatedAt` をそのまま立てる。(2) この配線より前に作られた行は
   * `markCreatedAt`（デーモン起動時の backfill）が日誌の最初の
   * `memory_update`（`action:'write'`）から埋める
   * （`deriveMemoryCreatedAtFromJournal`（`@alteroid/core`）の doc）。
   * どちらの経路も「既に値が在れば触らない」を守るので、書く順序が
   * 前後しても最終的な値は変わらない。
   */
  createdAt?: string;
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
  readonly #journal: JournalStore;
  /** 書き込みを直列化する。蒸留は同じ文書へ並行に追記しうる。 */
  #chain: Promise<unknown> = Promise.resolve();
  /**
   * 索引の組み直しが進行中なら、その Promise。**同時に複数の組み直しを
   * 走らせない**（かつ、組み直しを知らせる日誌エントリを1件だけにする）ための
   * メモ化。完了したら null に戻す——**「一度組み直したら二度と組み直さない」
   * ではなく「1回の消失イベントにつき1回」**にするため（次に索引が本当に
   * また消えたら、そのときは改めて組み直してよい）。
   */
  #rebuildingIndex: Promise<MemoryIndex> | null = null;

  constructor(dir: string, journal: JournalStore) {
    this.#dir = dir;
    this.#journal = journal;
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
   * 索引を読む。**無い・壊れている（JSON として読めない／オブジェクトの形を
   * していない）ときは、その場で日誌から組み直す。** `unknown` は守る側へ倒す
   * という約束のせいで、索引を失うと全文書が保護されたまま動かせなくなる
   * （distill が何も畳めず、クローンには「守られている」としか見えない
   * ——静かに凍る）。起動時の backfill だけでは、走行中に索引が消えた場合に
   * 次の再起動まで凍ったままになるので、読み出しのその場で直す。
   */
  async #readIndex(): Promise<MemoryIndex> {
    try {
      const raw = await readFile(this.#indexPath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as MemoryIndex;
      }
      // JSON までは読めたが、期待する形（オブジェクト）をしていない
      // ＝ スキーマが合わない。組み直す。
    } catch {
      // 無い（ENOENT）か、JSON として読めない。組み直す。
    }
    return this.#rebuildIndex();
  }

  /** 一時ファイル経由で置き換える（`.md` と同じ作法。壊れた途中経過を見せない）。 */
  async #writeIndex(index: MemoryIndex): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#indexPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(index), 'utf8');
    await rename(tmp, this.#indexPath());
  }

  /** 同時に来た複数の呼び出しを、進行中の組み直し1本へ束ねる。 */
  async #rebuildIndex(): Promise<MemoryIndex> {
    this.#rebuildingIndex ??= this.#doRebuildIndex().finally(() => {
      this.#rebuildingIndex = null;
    });
    return this.#rebuildingIndex;
  }

  /**
   * 索引（保護状態の派生値）を日誌から組み直す。
   *
   * **`humanTouchedAt`（保護の信号そのもの）は日誌から完全に復元できる**
   * （`cause:'human'` の `memory_update` は追記専用の日誌に残り続ける）ので、
   * **保護は失われない**。**失うのは外部編集の検出の履歴だけ**である——
   * `content_sha256` 相当のハッシュは日誌に無いので、いま存在する本文の値で
   * 新しく基準化する（「ここから先を見張る」）。この組み直しより前に外部から
   * 本文が書き換えられていたとしても、それはもう検出できない。**これを
   * 「外部編集が無かった証拠」として読まないこと** — 単に、組み直し以前の
   * 履歴が失われただけである。
   *
   * 組み直したこと自体は日誌へ1件残す（`memory_update` ではなく `decision`
   * ——記憶の本文は変わっていない。変わったのは派生値だけである）。
   *
   * 永続化した結果、次回の `#readIndex` は通常の読み出し経路（ファイルが
   * 存在し、正しくパースできる）に戻る——**1回の消失イベントにつき1回**だけ
   * 組み直しが走る。
   */
  async #doRebuildIndex(): Promise<MemoryIndex> {
    const humanTouchedAt = await deriveHumanTouchedAtFromJournal(this.#journal);
    // **`this.documents()` を呼ばない。** `documents()` → `list()` → `read()` は
    // （この PR から）`#readIndex()` に依存しており、索引がまだ無い・壊れている
    // このタイミングでそれを呼ぶと `#readIndex()` が再び `#rebuildIndex()` を
    // 呼ぶ——`#rebuildingIndex` のメモ化により**この実行中の Promise を
    // 自分自身が待つ**循環待機（デッドロック）になる。索引に依存しない生の
    // 読み出しだけをここで使う。
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

  /**
   * ファイル名と本文だけを、索引に触れずに読む。
   *
   * **`#doRebuildIndex` からだけ呼ぶ。** `list()` / `read()` / `documents()`
   * は `#readIndex()` に依存しており、索引の組み直し中にそれらを呼ぶと
   * 自分自身を待つ循環待機になる（`#doRebuildIndex` のコメント）。
   */
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
    // **describedAt の判定に要る「書く前の内容」を先に控える。** 存在しない
    // slug（新規作成）なら null——`nextDescribedAt` はその場合 `description`
    // が「無い→在る」に変わったとみなし、新しい describedAt を立てる。
    const before = await this.read(slug);
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
    const priorEntry = index[slug];
    // **describedAt も同じ唯一の通り道で進める。** 書き手は describedAt を
    // 直接書けない（`MemoryIndexEntry.describedAt` の doc）——ここが
    // `description` の新旧を比べて、変わっていれば `written.updatedAt` と
    // 同じ時刻に確定させる（変わっていなければ据え置く）。同じ時刻を使うのは、
    // 直後の読み出しが必ず `fresh` になるようにするためである（`describedAt`
    // をここで別に採番すると mtime の精度差で `stale` に化けうる）。
    const describedAt = nextDescribedAt({
      priorContent: before?.content ?? null,
      nextContent: written.content,
      priorDescribedAt: priorEntry?.describedAt,
      writtenAt: written.updatedAt,
    });
    // **作成そのものを観測している唯一の場所。** `before === null`（＝この
    // 書き込みが文書を作った）ときだけ `createdAt` を立てる。既に値が在れば
    // 触らない（一度きりの確定）。更新では何もしない。
    //
    // **ここで `written.updatedAt`（＝いま書いたファイルの mtime）を使うことについて。**
    // 作成を観測していない文書の作成時刻を FS の時刻から捏造するのは禁じられて
    // いる（`memoryCreatedAtSchema` の doc）。ここはそれに当たらない——**作成
    // そのものを観測している経路の中で、その書き込み自身が刻んだ時刻を記録して
    // いる。推定ではなく記録である。** 同じ関数の `describedAt` が精度差で
    // `stale` に化けるのを避けて同じ時刻を使うのと同じ理由で、ここも同じ時刻を
    // 使う（結果、新規作成では `作成` と `更新` が必ず一致する）。
    const createdAt = priorEntry?.createdAt ?? (before === null ? written.updatedAt : undefined);
    index[slug] = {
      ...priorEntry,
      contentSha256: sha256Hex(written.content),
      describedAt,
      createdAt,
    };
    await this.#writeIndex(index);
    // written は上の index 更新より前に読んだので、その時点の describedAt・
    // createdAt（更新前の値）を持っている。確定した値で組み直す——これを
    // 省くと、新規作成した直後の戻り値だけが「不明」のままになり、次の
    // read() / list() でようやく known に変わるという、この PR が塞ぎたい
    // ものと同じ形の遅延が戻り値にだけ残ってしまう（pg 版は `RETURNING` が
    // insert 直後の行をそのまま返すので、この遅延を持たない——ここで揃える）。
    return {
      ...written,
      createdAt: toMemoryCreatedAt(createdAt),
      descriptionFreshness: resolveMemoryDescriptionFreshness({
        description: written.description,
        describedAt,
        updatedAt: written.updatedAt,
      }),
    };
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

  async markCreatedAt(slug: string, at: string): Promise<boolean> {
    return this.#serialize(async () => {
      const index = await this.#readIndex();
      const entry = index[slug];
      // 実体が無い slug に新しい行を作らない（`markHumanTouched` と同じ理由）。
      if (entry === undefined && (await this.read(slug)) === null) return false;
      // **一度きりの確定。** `markHumanTouched` の単調非減少とも違う——
      // 既に値が入っていれば何もしない（絶対条件2「埋めるのは値が無いときだけ」）。
      // これにより2回目以降の backfill は自動的に冪等になる。
      if (entry?.createdAt !== undefined) return false;
      index[slug] = { ...entry, createdAt: at };
      await this.#writeIndex(index);
      return true;
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

/** 索引の生の値（`optional`）を `MemoryCreatedAt`（2値）へ組み立てる。 */
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
