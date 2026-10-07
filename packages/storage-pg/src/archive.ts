import {
  archiveIdBranch,
  assertArchivableSessionId,
  hasNul,
  classifyArchiveContinuity,
  compareArchiveEntriesNewestFirst,
  fingerprintArchiveBody,
  type ArchiveContinuity,
  type ArchiveEntry,
  type ArchiveRead,
  type ArchiveRemoval,
  type ArchiveSessionSummary,
  type ArchiveWrite,
  type TranscriptArchive,
} from '@alteroid/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { byteOrder, stripNulls, toIso, toNumber } from './db.js';
import { archive } from './schema.js';

/**
 * 同じミリ秒に同じセッションへ積まれたときに、枝番を試す上限。
 *
 * **超えたら例外を投げる。⛔ 黙って上書きへ落ちない。** fs 側
 * （`packages/storage-fs/src/archive.ts` の `MAX_ARCHIVE_ID_ATTEMPTS`）と
 * 同じ値・同じ倒れ方である。
 */
const MAX_ARCHIVE_ID_ATTEMPTS = 1000;

/**
 * `archive()` の advisory lock の名前空間。
 *
 * `pg_advisory_xact_lock(hashtext(namespace), hashtext(sessionId))` の
 * 1つ目の鍵——**この文字列を変えると、古いロックと新しいロックが別の鍵に
 * 分かれる**（デプロイをまたいで在庫が残っていても実害は無いが、意味は無い）。
 * pg 側に他の advisory lock は無い——別の advisory lock を足すなら、鍵空間の
 * 衝突を避けるためにこことは別の名前空間文字列を選ぶこと。
 */
const ARCHIVE_SESSION_LOCK_NAMESPACE = 'alteroid.archive.session';

/** `n` 回目の候補 id（1回目は枝番無し）。fs 側と同じ形を作る。 */
function archiveIdCandidate(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.jsonl` : `${base}-${attempt}.jsonl`;
}

/**
 * セッション生ログの退避先（可観測性3層の最下段）。
 *
 * fs 版がファイル名で持っていた識別子を、そのまま主キーとして使う。ジョブ台帳の
 * `archiveIds` は fs / pg のどちらでも同じ形で残るので、manager_id から生ログへ
 * 降りる経路はドライバを替えても切れない。
 */
export class PgTranscriptArchive implements TranscriptArchive {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * **指紋と連続性の判定は、`stripNulls` する前の生の `transcript` で取る。保存だけ
   * NUL を除く**（安全側に倒す）。
   *
   * NUL を除いた後の値で指紋を取ると、NUL の位置だけが違う本文を、
   * pg だけが「続いている」と判定し、fs / インメモリ（生の本文で判定する）と割れる
   * （同じ2回の `archive()` で pg は `continues`、インメモリは `diverged`）。連続性は
   * 自動の畳み・`archive_remove_many` が「消してよいか」を決める材料なので、**迷ったら
   * 消さない側**——NUL の位置だけが違う本文は「続いていない」と読む——に揃える。
   *
   * **代償として、この行の指紋は保存した `body`（NUL を除いた値）ではなく、除く前の
   * 本文を指す。** 指紋は連続性の判定にしか使わないので、判定が3実装で揃うことを
   * 優先した。**既に保存されている行の指紋**は NUL を除いた値のものだが、NUL を
   * 含まなかった行は除く前と同じで、含んでいた行は生の本文と一致しない＝「続いて
   * いない」側に倒れるので、安全側に外れる（移行は要らない）。
   *
   * **直前の行を引くとき `body` 列に触れない**（`select` に含めない）。
   * 100MB 級の行がある `archive` で、判定のためだけに本文を読み直すと
   * 本文を落とさずに大きさを知りたいという `list()` の動機そのものを壊す（`list()` の doc と同じ理由）。
   *
   * **「直前を引く → 判定する → insert する」を1トランザクションに閉じるだけでは
   * 足りない。** 割ると、同じ `sessionId` への並行 `archive()` が同じ「直前」を
   * 見て同じ判定を出す競合が起きるが、トランザクションで閉じれば防げる
   * わけではない——PostgreSQL の既定の分離レベル（READ COMMITTED）は
   * 「同じトランザクションに閉じる」ことと「読んだ行をロックする」ことを
   * 保証しない。`FOR UPDATE` も advisory lock も無い1トランザクションでは、
   * 2つの `archive()` が同じ `sessionId` へ重なって走ったとき、片方の insert が
   * commit する前にもう片方の `select max(at) ...` が走れば、**両方が同じ
   * 「直前」を読んで同じ判定を出す**——実測（真に前方一致する8本を並行に
   * 積んで、8本とも `'first'` になった。逐次なら `'first'` 1本・`'continues'`
   * 7本のはず）。この誤判定は `archive-prune.ts` の `selectArchiveRemovalTargets`
   * （`continuity === 'continues'` と配列上の隣接関係だけで含有を推定し、
   * 実際に何と比較したか＝`comparedTo` を見ない）を欺き、`requireContainment:
   * true`（`archive_remove_many` / 自動の畳みの既定・固定値）でも、他のどこにも
   * 残っていない本文を持つ行を削除対象に選ばせる。
   *
   * **塞ぎ方: トランザクションの先頭で `sessionId` ごとの advisory lock
   * （`pg_advisory_xact_lock`）を取り、同じ `sessionId` への `archive()` を
   * 直列化する。** トランザクション終了（commit/rollback）で自動的に解放される
   * ので、明示の unlock は要らない。鍵は `hashtext(namespace)` /
   * `hashtext(sessionId)` の組——`ARCHIVE_SESSION_LOCK_NAMESPACE` の doc参照。
   * 異なる `sessionId` は別の鍵になるので、他セッションの `archive()` を
   * 待たせない（advisory lock はセッション単位の粒度で、テーブル全体を
   * 塞がない）。
   *
   * ## ⚠️ `at`（と `stamp` / `base`）は advisory lock を取った**後**に決める
   *
   * `at = new Date()` をトランザクションの**外**（`db.transaction(...)`
   * を呼ぶ前）で取ってはいけない。そうすると、**「`at` が
   * 早いのに、ロックは後から取った側」が起こる**——先に `new Date()` を呼んだ
   * 側がロック待ちで足止めされているあいだに、後から `new Date()` を呼んだ側が
   * 先にロックを取って読み書きを終えてしまう。すると `list()` の並び
   * （`at` 昇順）と「実際にロックを取って `select` した順」がずれ、`at` が早い
   * 行のほうが後から insert されて `comparedTo` の鎖が `at` の並びと一致しない
   * ——`selectArchiveRemovalTargets` は `at` 昇順に並べた配列上の隣接関係で
   * 含有を推定するので、鎖と並びがずれれば同じように欺かれる（ロックで塞ぎたい
   * 誤判定がそのまま残る）。**⟹ `at` はロックを取った後、
   * `select` の直前で決める。** これで「ロックを取れた順」＝「`at` の順」＝
   * 「`list()` の並び」＝「`comparedTo` の鎖」が揃う。
   *
   * `body` / `fingerprint`（指紋）は `transcript` だけから決まり、順序に
   * 関わらないので、ロックの前で計算したままでよい。
   *
   * **id が衝突したら枝番を上げる。** `stamp` はミリ秒精度なので、
   * 同じセッションへ同じミリ秒に2回積むと id が衝突する。**`onConflictDoUpdate`
   * では黙って上書きになる**——退避の回数が過少に数えられ、生ログが1本
   * 消える。だから `onConflictDoNothing` ＋ `returning()` で「入ったか」を見て、
   * 0行なら `${base}-2.jsonl` → `${base}-3.jsonl` … と枝番を上げて**同じ
   * トランザクションの中で**やり直す。
   *
   * 既存の id を狙って `archive()` を呼ぶと別の id の行が増える。
   * **上書きが期待されている経路は無い**——`id` は
   * この関数が生成するだけで、呼び出し側から渡す口が無い。
   *
   * **先頭が `sanitize(sessionId)` である性質は保たれる**（`id` の
   * 前方一致 LIKE が主キーの btree に落ちる）。
   *
   * **「直前」の選び方は「`at` が最大の行」の絞り込みだけを SQL に任せ、同着（同じ `at`）の
   * tie-break は JS 側で行う。** `.orderBy(desc(archive.at),
   * desc(archive.id))` にしてはいけない。`desc(archive.id)` は **PostgreSQL の
   * 照合順（collation）依存**——本番と PGlite で同じ順になる保証が無い
   * うえ、`id` の字面順は `base-2.jsonl < base-3.jsonl < base.jsonl` と
   * 並ぶため、同じミリ秒に3本以上積むと1本目を「直前」だと誤認する
   * （fs 側 `#findPreviousArchiveForSession` の doc と同じ理由）。
   * ⟹ SQL では「同じ `sessionId` のうち `at` が最大の行」だけを引き（`id` の
   * 順序は一切見ない。同着は最大でも `MAX_ARCHIVE_ID_ATTEMPTS` 本——上の枝番の
   * ループと同じ上限）、その中から `archiveIdBranch`（＝積んだ順。
   * `archive-id.ts` の doc）が最大の行を JS 側で選ぶ。**引く行は同着の本数
   * だけ**で、同着が無ければ1行である。
   */
  async archive(sessionId: string, transcript: string): Promise<ArchiveWrite> {
    // **積めない sessionId は、DB に触る前に3実装と同じ例外で断る。**
    // 素通りさせると、`pg_advisory_xact_lock(…, hashtext(sessionId))` の時点で
    // PostgreSQL の例外（NUL は `text` に入らない）で落ちる。本文の NUL を除く
    // `stripNulls` とは扱いが違う——本文は中身で、sessionId は行を指す鍵である。
    assertArchivableSessionId(sessionId);
    const body = stripNulls(transcript);
    // 指紋は生の本文で取る（上の doc）。保存する `body` は NUL を除いた値。
    const fingerprint = fingerprintArchiveBody(transcript);
    return this.#db.transaction(async (tx) => {
      // **同じ sessionId への archive() を直列化する。** トランザクション
      // 終了で自動解放されるので unlock は不要。上の doc「塞ぎ方」参照。
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${ARCHIVE_SESSION_LOCK_NAMESPACE}), hashtext(${sessionId}))`,
      );
      // **`at` はロックを取った後で決める。** 上の doc「⚠️」参照——
      // ここより前で `new Date()` を呼ぶと、ロック待ちの順と `at` の順がずれる。
      const at = new Date();
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      const base = `${sanitize(sessionId)}-${stamp}`;
      const candidateRows = await tx
        .select({
          id: archive.id,
          at: archive.at,
          bodyChars: archive.bodyChars,
          bodyMd5: archive.bodyMd5,
        })
        .from(archive)
        .where(
          and(
            eq(archive.sessionId, sessionId),
            sql`${archive.at} = (select max(${archive.at}) from ${archive} where ${archive.sessionId} = ${sessionId})`,
          ),
        );
      const previous = candidateRows.reduce<(typeof candidateRows)[number] | null>((best, row) => {
        if (best === null) return row;
        return archiveIdBranch(row.id) > archiveIdBranch(best.id) ? row : best;
      }, null);
      const { continuity, comparedTo } = classifyArchiveContinuity(previous, transcript);
      for (let attempt = 1; attempt <= MAX_ARCHIVE_ID_ATTEMPTS; attempt += 1) {
        const id = archiveIdCandidate(base, attempt);
        const inserted = await tx
          .insert(archive)
          .values({
            id,
            sessionId,
            at,
            body,
            bodyChars: fingerprint.bodyChars,
            bodyMd5: fingerprint.bodyMd5,
            continuity,
          })
          .onConflictDoNothing({ target: archive.id })
          .returning({ id: archive.id });
        // 0行 ＝ その id は既に埋まっている。次の枝番へ。
        if (inserted.length > 0) {
          return { id, continuity, ...(comparedTo === undefined ? {} : { comparedTo }) };
        }
      }
      throw new Error(
        `archive(): id の衝突が ${MAX_ARCHIVE_ID_ATTEMPTS} 回続いたので退避を中止した（base=${base}）`,
      );
    });
  }

  /**
   * 新しい順。
   *
   * **`storedBytes` は `pg_column_size(body)` で測る。`length(body)` /
   * `octet_length(body)` は使わない。** あの2つは TOAST を展開して本文を
   * 丸ごと読む——100MB 級の行がある `archive` で、一覧を取るためだけに毎行
   * それをやると、本文を落とさずに大きさを知りたいという動機を
   * この関数自身が壊す。`pg_column_size` は本文を展開せず圧縮後の格納
   * バイト数を返す——`body` に触れないぶん、この一覧は軽い。
   *
   * **同着（同じ `at`）の tie-break は SQL の `desc(archive.id)` に任せず、
   * JS 側の `compareArchiveEntriesNewestFirst` に委ねる。** SQL 側は
   * `at` の降順だけを担う——`desc(archive.id)` は PostgreSQL の照合順
   * （collation）に依存するうえ、`id` の字面順は積んだ順と一致しない
   * （`archive()` の doc、`archive-id.ts` の doc と同じ理由）。
   */
  async list(): Promise<ArchiveEntry[]> {
    const rows = await this.#db
      .select({
        id: archive.id,
        sessionId: archive.sessionId,
        at: archive.at,
        storedBytes: sql<number>`pg_column_size(${archive.body})`,
        removedAt: archive.removedAt,
        removedBytes: archive.removedBytes,
        continuity: archive.continuity,
      })
      .from(archive)
      .orderBy(desc(archive.at));
    const entries: ArchiveEntry[] = rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      at: toIso(row.at),
      storedBytes: row.storedBytes,
      ...(row.continuity === null ? {} : { continuity: row.continuity as ArchiveContinuity }),
      ...(row.removedAt === null
        ? {}
        : { removedAt: toIso(row.removedAt), removedBytes: row.removedBytes ?? 0 }),
    }));
    return entries.sort(compareArchiveEntriesNewestFirst);
  }

  /**
   * `sessionId` ごとの集計。**1問い合わせ、`GROUP BY session_id`。**
   *
   * `body` には触れない（`pg_column_size` の理由は `list()` の doc と同じ）ので、
   * `archive` の heap 側だけを見る seq scan でも軽い——索引はいまも主キー
   * （`id`）だけで足りる。`rows` は tombstone 済みの行も数える（`list()` と
   * 同じく、消えるのは本文だけで行は残るため）。
   *
   * `continuity` は `count(*) filter (where continuity = '…')`
   * を5本並べて、同じ1問い合わせの中で内訳まで数える——`body` はおろか行
   * そのものを JS 側へ引き上げない（fs / インメモリの `tallyArchiveContinuity`
   * とは違い、pg はここだけ集計を SQL 側に閉じる。`archive-continuity.ts` の
   * `tallyArchiveContinuity` の doc）。`absent` は `continuity is null`——
   * 連続性の判定（門）より前に積まれた行、あるいは判定自体に失敗した行がここに入る
   * （`ArchiveContinuityTally` の doc。`unknown` との違いはそちらを見よ）。
   */
  async sessions(): Promise<ArchiveSessionSummary[]> {
    const rows = await this.#db
      .select({
        sessionId: archive.sessionId,
        rows: sql<number>`count(*)::int`,
        storedBytes: sql<number>`sum(pg_column_size(${archive.body}))`,
        maxStoredBytes: sql<number>`max(pg_column_size(${archive.body}))::int`,
        firstAt: sql<Date>`min(${archive.at})`,
        lastAt: sql<Date>`max(${archive.at})`,
        continuityFirst: sql<number>`count(*) filter (where ${archive.continuity} = 'first')::int`,
        continuityContinues: sql<number>`count(*) filter (where ${archive.continuity} = 'continues')::int`,
        continuityDiverged: sql<number>`count(*) filter (where ${archive.continuity} = 'diverged')::int`,
        continuityUnknown: sql<number>`count(*) filter (where ${archive.continuity} = 'unknown')::int`,
        continuityAbsent: sql<number>`count(*) filter (where ${archive.continuity} is null)::int`,
      })
      .from(archive)
      .groupBy(archive.sessionId)
      .orderBy(sql`sum(pg_column_size(${archive.body})) desc`, byteOrder(archive.sessionId));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      rows: row.rows,
      // sum(...) は bigint で返るので、素通しにすると文字列のまま漏れうる
      // （db.ts の toNumber の doc）。
      storedBytes: toNumber(row.storedBytes),
      maxStoredBytes: row.maxStoredBytes,
      firstAt: toIso(row.firstAt),
      lastAt: toIso(row.lastAt),
      continuity: {
        first: row.continuityFirst,
        continues: row.continuityContinues,
        diverged: row.continuityDiverged,
        unknown: row.continuityUnknown,
        absent: row.continuityAbsent,
      },
    }));
  }

  async read(id: string): Promise<ArchiveRead> {
    // 読むだけの口の NUL。NUL を含む鍵の行は存在しえない（書き込みが断る）ので「無い」。DB に投げると NUL を含む text を受け付けずエラーになる。
    if (hasNul(id)) return { kind: 'missing' };
    const rows = await this.#db
      .select({
        body: archive.body,
        removedAt: archive.removedAt,
        removedBytes: archive.removedBytes,
      })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { kind: 'missing' };
    // **判定は `removedAt` だけで行う。** `row.body === ''` を見ない——空の
    // 生ログ（PreCompact が呼ばれた時点で本文が空だった、等）を「消された」と
    // 誤判定しないため（`ArchiveRead` interface doc）。
    if (row.removedAt !== null) {
      return {
        kind: 'removed',
        removedAt: row.removedAt.toISOString(),
        bytes: row.removedBytes ?? 0,
      };
    }
    return { kind: 'body', body: row.body };
  }

  /**
   * 末尾だけを読む（OOM 対策、読み出し側。`TranscriptArchive.readTail`）。
   *
   * **`right(body, maxChars + 1)` で PostgreSQL 側に切らせる。** `read()` の
   * ように `body` 列をそのまま `select` すると、100MB 級の行では切る前に
   * 本文の全体がドライバ経由で Node のプロセスへ渡ってしまい、この関数自身が
   * 避けたい OOM を起こす——**返ってくる列は `right(...)` が計算した後の値
   * だけ**である（`list()` が `pg_column_size(body)` で本文に触れずに大きさを
   * 測るのと同じ理由・同じ形）。
   *
   * **`right()` は第2引数をコードポイント数（PostgreSQL の文字集合における
   * 文字数）で数える。** これは `readTail` interface doc が要求する
   * 「`maxChars` はコードポイント数」とちょうど一致するので、
   * この実装は単位が合っている（fs・インメモリ・呼び出し側の `tailOf`
   * （`clone.ts`）は JS の `.length`＝UTF-16 コード単位ではなくコードポイントで
   * 数える）。サロゲートペア（JS 側の話）という概念自体を
   * PostgreSQL 側は持たないので、この関数はそれを割りようがない。
   *
   * **`+ 1` は「ちょうど `maxChars`」を避けるためである**（`readTail`
   * interface doc「本文が `maxChars` より長いとき、返す量は `maxChars` を
   * 厳密に上回ること」）。`right()` は `n` が本文の長さ以上なら本文全体を
   * そのまま返すので、本文が `maxChars` 以下のときの契約（全文を返す）は
   * この `+ 1` があっても崩れない。
   *
   * **tombstone の判定は `read()` と同じである**——`removedAt` だけで
   * 見て、本文の中身（空かどうか）は見ない。`removed` のときは `right(...)` の
   * 結果を無視する（`body` は既に `''` へ切り詰められている行なので、読んでも
   * 意味が無い）。
   */
  async readTail(id: string, maxChars: number): Promise<ArchiveRead> {
    if (!Number.isInteger(maxChars) || maxChars <= 0) {
      throw new Error(
        `archive.readTail(): maxChars は正の整数でなければならない（渡された値: ${String(maxChars)}）`,
      );
    }
    if (hasNul(id)) return { kind: 'missing' };
    const rows = await this.#db
      .select({
        tail: sql<string>`right(${archive.body}, ${maxChars + 1})`,
        removedAt: archive.removedAt,
        removedBytes: archive.removedBytes,
      })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { kind: 'missing' };
    if (row.removedAt !== null) {
      return {
        kind: 'removed',
        removedAt: row.removedAt.toISOString(),
        bytes: row.removedBytes ?? 0,
      };
    }
    return { kind: 'body', body: row.tail };
  }

  /**
   * 本文だけを落とす（tombstone）。**`DELETE` を打たない。** 行は残る——
   * `body = ''` へ切り詰め、`removed_at` / `removed_bytes` を立てるだけの
   * `UPDATE` である。
   *
   * **1本の `UPDATE ... WHERE id = ? AND removed_at IS NULL RETURNING ...`
   * で「まだ消えていない行」だけを狙い撃つ。** 二重の `remove()` が競合しても
   * 片方だけがこの `UPDATE` を通り（`removed`）、もう片方は0行更新に終わって
   * 下の `SELECT` で `already` を見る——read-then-write に割ると、2つの
   * `remove()` が両方「消した」と名乗る窓ができる。
   *
   * `removed_bytes = octet_length(body)` は同じ `UPDATE` 文の中で計算する
   * （PostgreSQL の `SET` は同じ文の中では更新前の行を見るので、`body` を
   * `''` へ書き換える式と同居させても `octet_length` は書き換え前の値を
   * 測る）。
   */
  async remove(id: string): Promise<ArchiveRemoval> {
    if (hasNul(id)) return { kind: 'missing' };
    const updated = await this.#db
      .update(archive)
      .set({
        body: '',
        removedAt: sql`now()`,
        removedBytes: sql`octet_length(${archive.body})`,
      })
      .where(and(eq(archive.id, id), isNull(archive.removedAt)))
      .returning({ removedBytes: archive.removedBytes });
    const row = updated[0];
    if (row !== undefined) return { kind: 'removed', bytes: row.removedBytes ?? 0 };

    // 0行更新 ＝ id が無いか、既に消されていたかのどちらか。引き直して判定する。
    const existing = await this.#db
      .select({ removedAt: archive.removedAt, removedBytes: archive.removedBytes })
      .from(archive)
      .where(eq(archive.id, id))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow === undefined) return { kind: 'missing' };
    if (existingRow.removedAt === null) {
      // **ここへは実務上来ないはずである。** 上の UPDATE が
      // `removed_at IS NULL` を条件に0行だったのに、直後の SELECT で
      // `removed_at IS NULL` の行が見つかった——両方が同じトランザクション
      // 内・単純な逐次呼び出しの範囲では起こらない状態遷移である。黙って
      // `missing` 扱いにはしない（判定できない状態を隠さない）。
      throw new Error(`archive.remove(${id}): 競合が判定できない状態になった`);
    }
    return {
      kind: 'already',
      removedAt: existingRow.removedAt.toISOString(),
      bytes: existingRow.removedBytes ?? 0,
    };
  }

  /**
   * 全件を消す（`TranscriptArchive.clear` の doc）。**tombstone 済み・未 tombstone
   * を問わず行そのものを消す** — `remove()` と違い、本文だけを落とすのではない。
   */
  async clear(): Promise<number> {
    const removed = await this.#db.delete(archive).returning({ id: archive.id });
    return removed.length;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}
