import type { LostSessionGrave, SessionTranscriptTail } from '@alteroid/core';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls, toNumber } from './db.js';
import { STATEMENT_TIMEOUT_MS, withStatementTimeout } from './footprint.js';
import { sessionEntries, sessions } from './schema.js';

/**
 * SDK の SessionStore アダプタ（roadmap M4）。
 *
 * クローンもマネージャーも、セッションの生ログはローカルディスクにも書かれるが、
 * コンテナではそれが再起動で消える。**同じ PostgreSQL に載せておけば、器が作り
 * 直されても走行中だったセッションの続きへ戻れる。**
 *
 * 注意（SDK の契約）:
 * - `uuid` を持つ行は冪等キーとして扱う（再送・再取り込みで二重に積まない）
 * - `uuid` を持たない行（タイトル・タグ等）はそのまま積む
 * - 一度も書かれていない key には `null` を返す（空配列ではない）
 */
/**
 * `readTail` が末尾から見る行数の上限。
 *
 * **文字数で足りるまで積むが、1行の大きさは一定でない**（数十字のものも数 KB の
 * ものもある）。⟹ 行数の上限は**費用の天井**として置く —— 足りなければ短い末尾に
 * なるが、蒸留はそれで成立する（`clone.ts` の `tailOf` は、もともと末尾しか読まない）。
 */
const TAIL_SCAN_ROWS = 2_000;

export class PgSessionStore implements SessionStore, SessionTranscriptTail {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const subpath = key.subpath ?? '';

    // uuid 付きは冪等に、無いものはそのまま。まとめて1文にすると、片方の
    // 衝突指定が他方に効いてしまう（uuid 無しの行が黙って落ちる）。
    const idempotent = entries.filter((entry) => typeof entry.uuid === 'string');
    const plain = entries.filter((entry) => typeof entry.uuid !== 'string');

    if (idempotent.length > 0) {
      await this.#db
        .insert(sessionEntries)
        .values(
          idempotent.map((entry) => ({
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            subpath,
            uuid: entry.uuid ?? null,
            entry: stripNulls(entry),
          })),
        )
        .onConflictDoNothing({
          target: [
            sessionEntries.projectKey,
            sessionEntries.sessionId,
            sessionEntries.subpath,
            sessionEntries.uuid,
          ],
          // 部分ユニーク索引なので述語まで書く。書かないと索引が選ばれず、
          // 衝突が検出されないまま同じ行が二重に積まれる。
          where: sql`${sessionEntries.uuid} is not null`,
        });
    }

    if (plain.length > 0) {
      await this.#db.insert(sessionEntries).values(
        plain.map((entry) => ({
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath,
          uuid: null,
          entry: stripNulls(entry),
        })),
      );
    }

    // `listSessions` の mtime。索引を持たないと、どのセッションが新しいのか
    // 分からなくなる（SDK は mtime 降順で並べる前提で読む）。
    await this.#db
      .insert(sessions)
      .values({
        projectKey: key.projectKey,
        sessionId: key.sessionId,
        subpath,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [sessions.projectKey, sessions.sessionId, sessions.subpath],
        set: { updatedAt: new Date() },
      });
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = await this.#db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(this.#keyFilter(key))
      .orderBy(asc(sessionEntries.seq));
    if (rows.length === 0) return null;
    return rows.map((row) => row.entry as SessionStoreEntry);
  }

  /**
   * 末尾だけを返す（#564 E1b。`SessionTranscriptTail`）。
   *
   * **`load()` を使わない。** あちらは全件を戻すので、580 MB 級のセッションでは
   * SDK が `load()` に掛けている 60 秒の予算に当たりに行くことになる。
   *
   * **索引の並びをそのまま逆から読む** —— `session_entries_key_idx` は
   * `(project_key, session_id, subpath, seq)` なので、`desc(seq)` はソートを起こさない。
   */
  async readTail(key: LostSessionGrave, maxChars: number): Promise<string | null> {
    const rows = await this.#db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(
        and(
          eq(sessionEntries.projectKey, key.projectKey),
          eq(sessionEntries.sessionId, key.sessionId),
          eq(sessionEntries.subpath, ''),
        ),
      )
      .orderBy(desc(sessionEntries.seq))
      .limit(TAIL_SCAN_ROWS);
    if (rows.length === 0) return null;

    // **新しい方から積んで、足りたら止める。** 生ログは1行1レコードの JSONL なので、
    // ここで組み直したものは器の外に在るファイルと同じ形になる。
    const lines: string[] = [];
    let chars = 0;
    for (const row of rows) {
      const line = JSON.stringify(row.entry);
      lines.push(line);
      chars += line.length + 1;
      if (chars >= maxChars) break;
    }
    return lines.reverse().join('\n');
  }

  /**
   * その鍵の大きさ（バイト）を測る（#1283 の OOM、段1。`SessionTranscriptTail`）。
   *
   * ## ⚠️ 訂正の記録 — 圧縮後の格納バイトを予算と比べていた
   *
   * この doc は当初「`pg_column_size(entry)` は行内に収まった TOAST ポインタの
   * サイズだけを見て、外部チャンクを取りに行かない」と書き、**その合計を
   * `clone.ts` の 512 MiB の予算（`RESUME_SIZE_BUDGET_BYTES`）と比べていた。
   * これは誤りである。** `pg_column_size` が返すのは**圧縮後の格納バイト数**
   * であって、`JSON.parse` がメモリへ展開する実テキストの量ではない（TOAST の
   * 生チャンクを読みに行かないのは正しいが、「ポインタのサイズだけ」は
   * 正しくない——圧縮された状態のサイズをそのまま返す）。
   *
   * #1292 のレビューで本物の PostgreSQL 17 を立てて実測した値
   * （`footprint.ts` の doc「訂正の記録」に同じものが在る）:
   *
   * ```
   * -- 日本語の定型文の繰り返し、4000回
   * pg_column_size(jsonb)        =     5,369 バイト（圧縮後・格納バイト）
   * octet_length(jsonb::text)    =   456,012 バイト（実テキスト）
   * ⟹ 約85倍の過小申告
   *
   * -- 圧縮の効かないランダム文字列（対照）
   * pg_column_size               =    40,016 バイト
   * octet_length(...::text)      =    40,012 バイト   ⟹ ほぼ一致
   * ```
   *
   * **そして予算の側は初めから実テキストの量として導かれている**
   * （`clone.ts` の `RESUME_SIZE_BUDGET_BYTES` の doc 逐語「安全に読める生
   * テキストの上限 ≈ 2 GiB ÷ 4 ＝ **512 MiB**」）。⟹ 圧縮後のバイトをその予算と
   * 比べると、**いちばん圧縮の効くセッションをいちばん小さく見積もる。** 生ログは
   * 同じ形の JSON 行の繰り返しで、alteroid が貯めている中でもいちばん圧縮が効く
   * 種類の本文である ⟹ **この門は、いちばん止めたいセッションで開く側に倒れる**
   * ——門の存在理由がそのまま無効になる。
   *
   * ⟹ **比較に使う数は `sum(octet_length(entry::text))`（実テキストバイト）に
   * する。** `footprint.ts` の `textBytes` と同じ式・同じ理由である。
   *
   * ## 本文は Node のメモリへ載せない（契約は変わっていない）
   *
   * `octet_length(entry::text)` は PostgreSQL 側では本文を伸長・テキスト化する
   * が、**Node 側が受け取るのはその長さを表す1つの数値だけ**である
   * （`footprint.ts` の「契約」節と同じ）。`entry` 列は `octet_length(...)` の
   * 中にしか現れない——撃った SQL そのものを歯にしてある。
   *
   * ## だからコストの上限が要る
   *
   * `pg_column_size` と違い、こちらは本文を実際に展開する——**OOM を避ける
   * ための計測が、避けたいはずの重い読みを起こしかねない。** そこで
   * `footprint.ts` と同じ形で `statement_timeout` をこのトランザクションだけに
   * 掛ける（`set_config(..., true)` ＝ `SET LOCAL` 相当。トランザクションが
   * 終われば戻るので、接続プール経由で他の処理へ影響を残さない）。
   *
   * ## 測れなかったら `null`（＝「安全」ではない）
   *
   * 打ち切られた・クエリが投げた、はどちらも `null`——**`0` にしない。** `0` は
   * 「実測して0バイトだった」であって、「測れなかった」の代用にしない
   * （`SessionTranscriptTail.measureSize` の doc、AGENTS.md 地雷表「取れない軸に
   * 0 の行を作る」）。行が無い鍵は `sum(...)` が SQL の `NULL` を返すが、それは
   * 集約対象が0行だからであって測れなかったのではない ⟹ `0` を返す。
   *
   * ⚠️ **`null` を受けた呼び出し側は resume する側へ倒れる**（`clone.ts` の
   * `#resumeCandidateWithinBudget`「判定できないときは能力を削らない側へ倒す」
   * ——#1284 が明記した方針であり、ここでは覆さない）。⟹ **打ち切りは大きい
   * セッションほど起こりやすい**ので、この門は打ち切りのぶんだけ開く側に倒れうる。
   * ⛔ **その境目は測っていない**——本物の規模で `statement_timeout` が実際に
   * 何バイトあたりで発火するかは確かめていない。
   */
  async measureSize(key: LostSessionGrave): Promise<number | null> {
    try {
      return await withStatementTimeout(this.#db, STATEMENT_TIMEOUT_MS, async (tx) => {
        const [row] = await tx
          .select({
            textBytes: sql<
              number | string | null
            >`sum(octet_length(${sessionEntries.entry}::text))`,
          })
          .from(sessionEntries)
          .where(
            and(
              eq(sessionEntries.projectKey, key.projectKey),
              eq(sessionEntries.sessionId, key.sessionId),
              eq(sessionEntries.subpath, ''),
            ),
          );
        if (row === undefined || row.textBytes === null) return 0;
        return toNumber(row.textBytes);
      });
    } catch {
      return null;
    }
  }

  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    const rows = await this.#db
      .select({ sessionId: sessions.sessionId, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(and(eq(sessions.projectKey, projectKey), eq(sessions.subpath, '')));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      mtime: Math.floor(new Date(row.updatedAt).getTime()),
    }));
  }

  /** 作業者（サブエージェント）の生ログも resume 時に materialize させる。 */
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const rows = await this.#db
      .select({ subpath: sessions.subpath })
      .from(sessions)
      .where(
        and(
          eq(sessions.projectKey, key.projectKey),
          eq(sessions.sessionId, key.sessionId),
          ne(sessions.subpath, ''),
        ),
      );
    return rows.map((row) => row.subpath);
  }

  async delete(key: SessionKey): Promise<void> {
    await this.#db.delete(sessionEntries).where(this.#keyFilter(key));
    await this.#db
      .delete(sessions)
      .where(
        and(
          eq(sessions.projectKey, key.projectKey),
          eq(sessions.sessionId, key.sessionId),
          eq(sessions.subpath, key.subpath ?? ''),
        ),
      );
  }

  #keyFilter(key: SessionKey) {
    return and(
      eq(sessionEntries.projectKey, key.projectKey),
      eq(sessionEntries.sessionId, key.sessionId),
      eq(sessionEntries.subpath, key.subpath ?? ''),
    );
  }

  /**
   * 全件を消す（ワークスペースのリセット専用。#workspace-reset）。
   *
   * **SDK の `SessionStore` / `SessionTranscriptTail` interface にはこのメソッド
   * を足さない** — 足すと fs 側にも同じ口が要ることになるが、fs 構成では
   * SDK 自身がローカルディスクへ直接生ログを書いており（`Stores.sessionStore`
   * の doc「pg 構成でだけ付く」）、core の `Stores` から触れる預け先そのものが
   * 無い。だから `Storage`（`apps/daemon/src/storage.ts`）が pg 構成でだけ、
   * このメソッドを直接呼べる形で配線する（`clearSessionLog` の doc）。
   *
   * `session_entries` と `sessions` の両方を消す（`append` が両方へ書くのと
   * 対）。消した `session_entries` の行数を返す（`sessions` は1セッションに
   * つき高々1行なので、行数の桁が違う——申告として意味があるのは前者）。
   */
  async clearAll(): Promise<number> {
    const removedEntries = await this.#db
      .delete(sessionEntries)
      .returning({ seq: sessionEntries.seq });
    await this.#db.delete(sessions);
    return removedEntries.length;
  }
}
