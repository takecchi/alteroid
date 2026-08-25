import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { journalEntrySchema, JournalAnchorNotFoundError } from '@alteroid/core';
import type { JournalEntry, JournalEntryInput, JournalQuery, JournalStore } from '@alteroid/core';

/**
 * 日誌 = 追記専用 JSONL（日付ごとに1ファイル）。
 *
 * 「聞かずに実行した判断は必ず日誌に残る」（PRD「権限境界」）のが、人間の
 * 事後否定＝最終承認の実体である。したがって追記だけを提供し、書き換えの口は
 * 用意しない。
 */
export class FsJournalStore implements JournalStore {
  readonly #dir: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async append(input: JournalEntryInput): Promise<JournalEntry> {
    const entry = journalEntrySchema.parse({
      ...input,
      id: randomUUID(),
      at: new Date().toISOString(),
    });

    // 同時追記で行が混ざらないよう直列化する
    const run = this.#chain.then(async () => {
      await mkdir(this.#dir, { recursive: true });
      await appendFile(this.#file(entry.at), `${JSON.stringify(entry)}\n`, 'utf8');
    });
    this.#chain = run.catch(() => undefined);
    await run;

    return entry;
  }

  async list(query: JournalQuery = {}): Promise<JournalEntry[]> {
    const order = query.order ?? 'desc';
    const found: JournalEntry[] = [];
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    // **`limit: 0` = 0件（issue #425）。** 下のループは「push してから件数を
    // 判定する」形（`found.push(entry)` の直後に `found.length >= limit` を
    // 見る）なので、`limit: 0` を素通しすると 1 件目を push した後で初めて
    // 0 >= 0 に当たり、1件返ってしまう（0 件くれという指定なのに 1 件返る
    // off-by-one）。ここで早期 return するのが最小の直し方——ループの中の
    // 判定式（`limit >= 1` のときの挙動）は1文字も変えていない。
    if (limit <= 0) return found;
    // ファイル名は追記時の UTC 日付なので、`since` より古い日のファイルは開かなくてよい。
    // 件数指定の無い `since` 問い合わせ（日報・要約）は M3 から常時走るため、
    // ここで打ち切らないと日誌全部を毎回読むことになる。
    const sinceDay = query.since?.slice(0, 10);
    // `until` より新しい日のファイルは開かなくてよい。
    const untilDay = query.until?.slice(0, 10);

    // **`after`（issue #432 の2本目）は `types` / `with` / `since` / `until` /
    // `limit` より前に効かせる。** 錨の行は `at` からファイル名が一発で決まる
    // （`#file`）ので、そのファイルへ飛んで探す——見つからなければそのファイル
    // だけで「無い」と確定できる（他のファイルを探す必要はない）。
    let anchor: { file: string; index: number } | null = null;
    let anchorDay: string | undefined;
    if (query.after !== undefined) {
      const after = query.after;
      anchor = await this.#locateAnchor(after);
      if (anchor === null) {
        throw new JournalAnchorNotFoundError(
          `after で指定された行（id=${after.id}, at=${after.at}）が見つからない`,
        );
      }
      anchorDay = after.at.slice(0, 10);
    }

    const files = await this.#files(order);

    for (const file of files) {
      const fileDay = file.slice(0, 10);

      // **早期打ち切りの向きは `order` で反転する。** 既定（desc）は新しい
      // 日から走査するので `sinceDay` を下回ったら `break`、`untilDay` を
      // 上回ったら（まだ窓に届いていないだけなので）`continue`。`asc` は
      // 走査が古い日から始まるので、この2つの役割が入れ替わる——
      // `untilDay` を上回ったら `break`、`sinceDay` を下回ったら `continue`。
      // ⚠️ ここを反転し忘れると、asc は黙って窓の外を落とす。
      if (order === 'desc') {
        if (sinceDay !== undefined && fileDay < sinceDay) break;
        if (untilDay !== undefined && fileDay > untilDay) continue;
      } else {
        if (untilDay !== undefined && fileDay > untilDay) break;
        if (sinceDay !== undefined && fileDay < sinceDay) continue;
      }

      // **`after` によるファイル単位の枝刈り。** 錨より「前」（返す向きと逆側）
      // の日付のファイルは丸ごと不要——desc なら錨の日より新しい日、asc なら
      // 錨の日より古い日。
      if (anchor !== null && anchorDay !== undefined) {
        if (order === 'desc' && fileDay > anchorDay) continue;
        if (order === 'asc' && fileDay < anchorDay) continue;
      }

      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);

      const anchorIndexInThisFile = anchor !== null && file === anchor.file ? anchor.index : null;
      const startIndex =
        order === 'desc'
          ? anchorIndexInThisFile !== null
            ? anchorIndexInThisFile - 1
            : lines.length - 1
          : anchorIndexInThisFile !== null
            ? anchorIndexInThisFile + 1
            : 0;
      const step = order === 'desc' ? -1 : 1;

      for (let i = startIndex; order === 'desc' ? i >= 0 : i < lines.length; i += step) {
        const entry = parseLine(lines[i]);
        if (!entry) continue;
        if (query.types && !query.types.includes(entry.type)) continue;
        // **`with` は `limit` より前（この `continue` で候補から落とす時点）で
        // 効かせる**（issue #418 の穴の本体）。`with` を持つのは `exchange`
        // だけなので、非 exchange は `types` を明示していなくてもここで落ちる。
        if (query.with && (entry.type !== 'exchange' || !query.with.includes(entry.with))) continue;
        if (query.since && entry.at < query.since) continue;
        if (query.until && entry.at > query.until) continue;
        found.push(entry);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  /**
   * 1件を id で引く。
   *
   * 日付を持たない id なので、新しい日から順に開いて突き合わせる。掘るための
   * 一発引きであって定常経路ではないため、走査の重さは受け入れる（当たれば
   * その時点で止まる）。
   */
  async get(id: string): Promise<JournalEntry | null> {
    for (const file of await this.#files('desc')) {
      const raw = await readFile(join(this.#dir, file), 'utf8');
      const lines = raw.split('\n').filter((line) => line.length > 0);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const entry = parseLine(lines[i]);
        if (entry?.id === id) return entry;
      }
    }
    return null;
  }

  #file(at: string): string {
    return join(this.#dir, `${at.slice(0, 10)}.jsonl`);
  }

  /**
   * `after` の錨（`{ id, at }`）を、`at` から一発で決まるファイルの中だけで
   * 探す（issue #432 の2本目）。**`id` と `at` の両方が一致する行だけを錨と
   * 認める** — `at` だけでは同一ミリ秒の同着を割れず、`id` だけでは fs が
   * `at` に依存している事実（ファイル名がそこから決まる）と揃わない。
   *
   * 見つからなければ `null`（呼び出し側が `JournalAnchorNotFoundError` を
   * 投げる）。**そのファイルに無ければ「無い」と確定できる** — 錨のファイルは
   * `#file(at)` が一意に決めるので、他の日付のファイルを探す必要はない。
   */
  async #locateAnchor(after: {
    id: string;
    at: string;
  }): Promise<{ file: string; index: number } | null> {
    const file = `${after.at.slice(0, 10)}.jsonl`;
    let raw: string;
    try {
      raw = await readFile(join(this.#dir, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    for (let i = 0; i < lines.length; i += 1) {
      const entry = parseLine(lines[i]);
      if (entry !== null && entry.id === after.id && entry.at === after.at) {
        return { file, index: i };
      }
    }
    return null;
  }

  /**
   * ファイル名の一覧を、`order` に応じた走査順で返す。
   *
   * `desc`（既定・従来の挙動）は新しい日付が先。`asc` はその逆で古い日付が先
   * （issue #432 の2本目）。
   */
  async #files(order: 'asc' | 'desc'): Promise<string[]> {
    try {
      const names = await readdir(this.#dir);
      const sorted = names.filter((name) => name.endsWith('.jsonl')).sort();
      return order === 'desc' ? sorted.reverse() : sorted;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

function parseLine(line: string | undefined): JournalEntry | null {
  if (!line) return null;
  try {
    const parsed = journalEntrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    // 壊れた行があっても日誌全体を読めなくしない（追記専用ゆえ先頭は健全なはず）
    return null;
  }
}
