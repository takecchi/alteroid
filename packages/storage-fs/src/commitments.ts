import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  assertNoNul,
  commitmentClosedBySchema,
  commitmentSchema,
  compareIsoInstant,
  findOpenManagerDuplicate,
  stripNul,
  UnreadableCommitmentError,
  unreadableCommitmentSchema,
} from '@alteroid/core';
import type {
  Commitment,
  CommitmentClosedBy,
  CommitmentEditedBy,
  CommitmentList,
  CommitmentOpenResult,
  CommitmentStore,
  UnreadableCommitment,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * ディスク上の生の形。**要素は `z.unknown()` で受ける**（issue #296 以降）。
 *
 * かつては `z.array(commitmentSchema).default([])` でファイル全体を1回で
 * `parse` していた — 1行でも `commitmentSchema` に合わなければファイル全体が
 * 読めなくなっていた（pg 版の `list()` が未知の enum 値1つで丸ごと落ちるのと
 * 同じ形の問題で、fs 版はさらに重い。ファイル全体の `parse` なので、行ごとの
 * 保存すらしていない pg 版の jsonb 列より一段広い単位で落ちていた）。
 *
 * **行ごとに読むためには、まず「行の形をここでは決めない」ところまで緩めて
 * 読み込む必要がある。** 要素の妥当性は `splitFileRows`（下）が
 * `commitmentSchema.safeParse` で行ごとに判定する。
 *
 * **`trimmedClosedCount` は `trimClosed`（下）が物理削除した片付き行の累計件数
 * （issue #416）。** 削除はプロセスをまたいで起き続けるので、`CommitmentList.
 * trimmedClosed`（`packages/core/src/store.ts`）として申告するにはディスク側に
 * 持たせて読み書きのたびに引き継ぐ必要がある。**古いファイル（この欄がまだ無い
 * 版で書かれたもの）は `default(0)` で読める** — 「無いなら0件削除」であって、
 * それより前に切り詰められた分を遡って数え直すことはできない。
 */
/**
 * 読めない行に付けた「閉じた」印（issue #2148）。
 *
 * **`close()` は読めない行の中身（生の値）を書き換えない。** `commitmentSchema`
 * に合わない値をどう直せば「閉じた形」になるかは決めようがない
 * （本体がそもそも読めていないので、`closedAt` をどこへどう足せばよいか判定
 * できない）。だから生の値（`commitments` 配列側。`toDiskShape` が書く
 * `unreadable[].value`）には一切触れず、`id` をキーにした別欄へ
 * 「いつ・なぜ・誰が閉じたか」を記録する——**読めない行の中身をそれらしい
 * 値で埋めない**（`list()` が返す `unreadable` の形は `UnreadableCommitment`
 * のままで、`closedAt` 等を持たない。閉じたかどうかは `list()` の
 * `includeClosed` による絞り込みのほうへ出す。下の `list()` の doc）。
 *
 * **古いファイル（この欄がまだ無い版）は `default([])` で読める** —
 * 「無いなら閉じた読めない行は無い」であって、それより前に閉じた読めない
 * 行を遡って復元することはできない。
 */
const closedUnreadableRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  reason: z.string(),
  by: commitmentClosedBySchema,
});

const rawFileSchema = z.object({
  commitments: z.array(z.unknown()).default([]),
  trimmedClosedCount: z.number().int().nonnegative().default(0),
  closedUnreadable: z.array(closedUnreadableRowSchema).default([]),
});

/**
 * 読めなかった1行の、書き戻し用の内部表現。
 *
 * **`value`（生の値）を持つのがここの要である。** `#update` は読んだものを
 * 書き戻す器なので、読めなかった行の生の値を保持しておかないと、書き戻しの
 * たびにその行がファイルから消える。消えると `open` / `close` が1回走った
 * だけで、読めなかった行が**ディスクから永久に消える** —
 * これはこの issue（#296）が防ごうとしているもの（1行読めないだけで一覧が
 * 丸ごと落ちる）より重い事故である。落ちるだけなら人間が気づいて直せるが、
 * 消えたことには誰も気づけない。だから `entries`（読めた行）と分けて持ち、
 * 書き出しではこの `value` をそのまま `commitments` 配列へ戻す
 * （`#update` を見よ）。
 *
 * `id` / `at` は公開型（`UnreadableCommitment`）に合わせて**取れたときだけ**
 * 持つ。取れない（本体が `id` / `at` という欄を持たない、あるいは持っていても
 * 文字列でない・日時として読めない）ことがあるのは、行が壊れているという
 * 前提そのものが「その他の欄も信用できない」を含意するためである。
 *
 * **`closed` は `close()` が付けた印（issue #2148。`closedUnreadableRowSchema`
 * の doc）。** `id` が取れた行にしか付かない——`close(id, …)` は id で行を探す
 * ので、`id` が取れない行はそもそも close の対象として見つけられない
 * （見つけられないことは既存の `get(id)` と同じ制約であり、この修正で新しく
 * 増えた制約ではない）。
 */
type UnreadableRow = {
  value: unknown;
  id?: string;
  at?: string;
  reason: string;
  closed?: { at: string; reason: string; by: CommitmentClosedBy };
};

/**
 * この器がメモリ上で持つ形。**ディスク上の形（`commitments: unknown[]` の
 * 1本の配列）とは別**であることに注意 — 読めた行と読めなかった行を分けて
 * 持つことで、`list()` / `get()` / `open()` の判定を型で書けるようにする。
 * ディスクへ戻すときは `#update` が両方をまた1本の配列へ合成する。
 *
 * **`trimmedClosedCount` は `rawFileSchema` の同名欄をそのまま引き継ぐ
 * （issue #416）。** `trimClosed` が削除するたびに増やし、`toDiskShape` で
 * また書き戻す — 累計なので、読んで書いてを繰り返すあいだ1度も減らない。
 */
type CommitmentFile = {
  entries: Commitment[];
  unreadable: UnreadableRow[];
  trimmedClosedCount: number;
};

/**
 * `UnreadableRow`（書き戻し用の内部表現。`value` を持つ）を、公開する形
 * （`UnreadableCommitment`。`value` を持たない）へ写す。**`list()` の返り値は
 * 必ずこれを経由すること** — 直接 `file.unreadable` を返すと、型の上には
 * 無い `value`（行の本体そのもの）へ、型を無視すれば実行時にアクセスできる
 * 状態のまま外へ渡ることになる。
 */
function toPublicUnreadable(row: UnreadableRow): UnreadableCommitment {
  return { id: row.id, at: row.at, reason: row.reason };
}

/**
 * 生の値から `id` / `at` を、文字列として読めるときだけ取り出す。
 *
 * **読めない行の中身をこれ以上詮索しないこと。** ここで見るのは `id` / `at`
 * の2欄だけであり、`body` を覗きに行かない（`dropped-record.ts` と同じ
 * 「本文を載せない」制約 — `reason`（zod のエラーメッセージ）には本文が
 * 混ざらないが、`id` / `at` の抽出をうっかり広げて `body` まで拾うと、
 * その制約が抽出のほうから破れる）。
 */
function stringFieldOf(value: unknown, key: 'id' | 'at'): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * 生の配列（`rawFileSchema` を通しただけの `unknown[]`）を、行ごとに
 * `entries` / `unreadable` へ振り分ける（issue #296）。
 *
 * **`commitmentSchema.safeParse` を使う ＝ 1行が合わなくても投げない。**
 * ファイル全体を `parse` していた旧実装と違い、ここで落ちるのは1行の
 * 判定であって読み込みそのものではない。
 *
 * **`trimmedClosedCount` は持ち回らない。** ここが振り分けるのは `commitments`
 * 配列の行だけで、削除の累計件数は別欄（`rawFileSchema.trimmedClosedCount`）
 * にある。呼び出し側（`#read`）が合成する。
 */
function splitFileRows(rows: unknown[]): Omit<CommitmentFile, 'trimmedClosedCount'> {
  const entries: Commitment[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const value of rows) {
    const parsed = commitmentSchema.safeParse(value);
    if (parsed.success) {
      entries.push(parsed.data);
      continue;
    }
    const id = stringFieldOf(value, 'id');
    const atCandidate = stringFieldOf(value, 'at');
    // **`at` は「文字列である」だけでなく `UnreadableCommitment.at`
    // （`isoDateTime`）として読める形かも確かめる。** 壊れた行の `at` は
    // 型どおりの日時とは限らない（そもそも壊れているから読めていない）。
    // 確かめる規則を独自に持たず、公開スキーマ（`unreadableCommitmentSchema`）
    // の `at` の判定をそのまま借りる — 二重定義すると片方だけ直して
    // 食い違う形になる。
    const at =
      atCandidate !== undefined &&
      unreadableCommitmentSchema.shape.at.safeParse(atCandidate).success
        ? atCandidate
        : undefined;
    unreadable.push({ value, id, at, reason: parsed.error.message });
  }
  return { entries, unreadable };
}

/**
 * 内部表現（`CommitmentFile`）を、ディスクへ書く形（`{ commitments:
 * unknown[] }`）へ合成する。
 *
 * **⚠️ 読めなかった行の生の値（`unreadable[].value`）を必ず含めること。**
 * ここを `entries` だけにすると、書き戻しのたびに読めない行が消える
 * （このファイル冒頭の `UnreadableRow` の doc、そして issue #296 の
 * 「fs 版の書き戻しで読めない行を消さない」という要件そのもの）。
 *
 * **順序は保証しない。** 読めた行・読めなかった行を分けて持つ以上、
 * ディスク上の元の並び（両者が混ざっていた順）は再現しない。`list()` は
 * どのみち `at` / `closedAt` で並べ直すので実害は無く、人間が
 * `commitments.json` を直接開いて読む場合も、失われるのは「どちらが先に
 * 積まれたか」という見た目の情報だけである。
 *
 * **`trimmedClosedCount` も書き戻す（issue #416）。** 累計件数なので、ここを
 * 落とすと次回の起動で0へ戻り、それまでの削除が無かったことになる。
 *
 * **`closedUnreadable` は `unreadable[].closed` が付いた行から作り直す
 * （issue #2148）。** `id` が取れている行だけが対象になる——`closed` は
 * `close(id, …)` が id で見つけた行にしか付かないので、`id` を持たない
 * `closed` 付きの行はそもそも存在しない（型では防げないので、ここで
 * `row.id !== undefined` を再確認してから積む）。
 */
function toDiskShape(file: CommitmentFile): {
  commitments: unknown[];
  trimmedClosedCount: number;
  closedUnreadable: { id: string; at: string; reason: string; by: CommitmentClosedBy }[];
} {
  return {
    commitments: [...file.entries, ...file.unreadable.map((row) => row.value)],
    trimmedClosedCount: file.trimmedClosedCount,
    closedUnreadable: file.unreadable.flatMap((row) =>
      row.closed !== undefined && row.id !== undefined
        ? [{ id: row.id, at: row.closed.at, reason: row.closed.reason, by: row.closed.by }]
        : [],
    ),
  };
}

/**
 * 片付いた行をここまで残して切る。
 *
 * **未了の行は数に関係なく1件も切らない。** 切った瞬間にこの器の目的（忘れさせない
 * こと）が消えるので、上限は「片付いた行だけ」に掛かる。
 *
 * 上限が要るのは fs 版が**毎回ファイル全体を書き直す**器だからである。自動 open は
 * 人間の発言のたびに1行増えるので、片付いた行を無限に積むと1回の open の費用が
 * 台帳の齢に比例して増えていく（人間の発言が遅くなる形で表に出る）。
 *
 * **切ってよい根拠は、永続の記録が日誌側にあることである。** 何をいつ引き受けて
 * 何をもって片付けたかは日誌（追記専用）に残っており、ここが持つのは「まだ
 * 片付いていないか」の状態と、日報が拾う直近の片付きだけである。日報の材料として
 * 要るのは直近の分なので、古い片付きが落ちても人間が読むものは欠けない。
 *
 * 500 なのは、自動 open の粒度（人間の発言1つ）で見て数日〜数週間ぶんが残る量で
 * ありながら、1枚の JSON として人間が開いて読める大きさに収まるためである。
 */
export const CLOSED_HISTORY_LIMIT = 500;

/**
 * 引き受けたまま終わっていない仕事の台帳 = 1枚の JSON。
 *
 * ジョブ台帳・継続中の依頼と同じディレクトリに置く。**人間が開いて読めること**を
 * 保つ形にしておく（「クローンが何を引き受けたまま抱えているか」が人間から見えない
 * のは可観測性の穴になる）。
 */
export class FsCommitmentStore implements CommitmentStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'commitments.json');
  }

  /**
   * **読めない行のうち、まだ閉じていないものは `includeClosed` に関わらず
   * 常に返す。** `closedAt` が読めない以上、片付いたとみなす根拠が無いので、
   * 未了扱いで安全側へ倒す（issue #296）。
   *
   * **⭐ ただし `close()`（issue #2148）で明示的に閉じた読めない行は別である。**
   * その行だけは「閉じた」という事実を型の外（`unreadableCommitmentSchema`
   * には無い別欄、`UnreadableRow.closed`）に持っているので、pg 版が
   * `closed_at` 列で判定するのと同じ形で `includeClosed` に従わせられる——
   * `includeClosed` が偽なら隠し、真なら `unreadable` へ出す。**閉じたと
   * 分かっている行まで安全側（常に出す）へ倒す理由は無い**（分からない
   * ときにだけ安全側へ倒すのが上の段落の理由だった）。
   *
   * **pg 版との差はここまでで消える（「言えないこと」の更新）。** かつては
   * 「fs 版は閉じているかどうかを読めなかった行の中身からしか判定できない」
   * という差があったが、`close()` が読めない行にも印を付けられるようになった
   * ことで、印が付いた行については pg 版と同じ絞り込みができる。**差が残る
   * のは「印を付けていない（＝ `close()` を一度も呼ばれていない）読めない
   * 行」だけ**——そちらは pg 版でも `commitment` 列そのものが壊れている以上
   * `closed_at` が動く経路が無く、常に未了として出る点は変わらない。
   */
  async list(options?: { includeClosed?: boolean }): Promise<CommitmentList> {
    const file = await this.#read();
    // 未了は古い順。齢が判断の材料なので、放置されているものから見せる
    const open = file.entries
      .filter((entry) => entry.closedAt === undefined)
      // 実時刻で比べる（issue #2451。`compareIsoInstant` の doc——文字列比較だと
      // オフセット表記の違う行で pg の `asc(at)` と並びが食い違う）
      .sort((a, b) => compareIsoInstant(a.at, b.at));
    // **公開する形（`UnreadableCommitment`）へ写してから返す。** `file.unreadable`
    // は書き戻しのために生の値（`value`）を抱えている内部表現であり、そのまま
    // 外へ渡すと、構造的には型に無い `value`（＝行の本体。`body` を含みうる）へ
    // 呼び出し側が実行時にアクセスできてしまう。`dropped-record.ts` の
    // 「本文を出さない」制約はログだけでなく、この型の境界でも保つ。
    //
    // **`toPublicUnreadable` は `closed` を持ち出さない。** 閉じたかどうかは
    // `includeClosed` の絞り込み（下）でだけ表現し、`UnreadableCommitment`
    // の形そのものは増やさない——読めない行の中身をそれらしい値で埋めない、
    // という制約は「閉じたか」の1ビットにも及ぶ（pg 版も `unreadable` へ
    // `closedAt` を出さないので、ここで出すと逆に fs 側だけ情報が増える）。
    const unreadableUnclosed = file.unreadable
      .filter((row) => row.closed === undefined)
      .map(toPublicUnreadable);
    // **`trimmedClosed` は毎回 `file.trimmedClosedCount` をそのまま出す
    // （issue #416）。** `includeClosed` の真偽に関わらず同じ値 — 削除は
    // 過去に一度でも起きていれば増えている事実であって、いま何を見せるか
    // という絞り込みとは別の軸だからである（`unreadable` と同じ扱い）。
    if (options?.includeClosed !== true) {
      return {
        entries: open,
        unreadable: unreadableUnclosed,
        trimmedClosed: file.trimmedClosedCount,
      };
    }
    const closed = file.entries
      .filter((entry) => entry.closedAt !== undefined)
      // 実時刻の降順（issue #2451。pg の `desc(closedAt)` と揃える）
      .sort((a, b) => compareIsoInstant(b.closedAt ?? '', a.closedAt ?? ''));
    // 閉じた読めない行も含めて出す（新しい順・古い順を判定する材料が無いので、
    // 未了扱いの読めない行の後ろへそのまま連結する）。
    const unreadableClosed = file.unreadable
      .filter((row) => row.closed !== undefined)
      .map(toPublicUnreadable);
    return {
      entries: [...open, ...closed],
      unreadable: [...unreadableUnclosed, ...unreadableClosed],
      trimmedClosed: file.trimmedClosedCount,
    };
  }

  /**
   * **読めなかった行の id と一致したら throw する（pg 版の `get` と揃える）。**
   * 「無い（そもそも引き受けていない）」と「読めない（壊れて入っている）」は
   * 別物で、後者を `null` へ潰すとその区別が消える（issue #296）。
   *
   * **投げる型は `Error` ではなく `UnreadableCommitmentError`（`@alteroid/core`）
   * である。** pg 版の `parseCommitment` と揃える — 呼び出し側が
   * `instanceof` で「行が読めない」と「器そのものの障害」を見分けられるように
   * するため（`UnreadableCommitmentError` の doc、`packages/core/src/store.ts`）。
   */
  async get(id: string): Promise<Commitment | null> {
    const file = await this.#read();
    const found = file.entries.find((entry) => entry.id === id);
    if (found !== undefined) return found;
    const broken = file.unreadable.find((row) => row.id === id);
    if (broken !== undefined) {
      throw new UnreadableCommitmentError(
        `引き受けた仕事 ${id} が読めない形で入っている（片付いたのではない）: ${broken.reason}`,
      );
    }
    return null;
  }

  /**
   * 未了として開く。**既に在れば何もしない。**
   *
   * **読みと書きを同じ排他区間に入れること。** 分けると、同じ id の open が並行に
   * 来たときに両方が「無い」を読んで両方が書き、後から書いた側が先の行を上書きする。
   * 受信箱の合図は配り直されうる（`InboxStore` の取引）ので、その id を使う自動 open
   * は**同じ id で二度呼ばれるのが普通**である。上書きしてしまえば、一度片付けた
   * 仕事が配り直しのたびに開き直る。
   *
   * **重複判定は `unreadable` の id も見る（issue #296）。** 読めない行と同じ id を
   * 開き直すと、`toDiskShape` が生の値をそのまま書き戻す一方で新しい行も足すことに
   * なり、同じ id が2行（壊れた生の値＋新しい読める値）並ぶ状態になる。それは
   * どちらが「本物」か誰にも判定できない状態を自分で作ることになるので避ける。
   *
   * **同一マネージャー×同一本文×未了も開かない（issue #1041）。** 判定は
   * `findOpenManagerDuplicate`（`@alteroid/core`）——**3実装で同じ規則を持つため、
   * ここで書き直さない。** 置き場所は `#update` の閉包の中である必要がある：
   * 閉包は `withPathLock`（`file-lock.ts`）の区間の内側で `#read()` し直すので、
   * **ここへ置いたときだけ読みと書きが同じ排他区間に入る**（外で `list()` して
   * から `open()` を呼ぶ形が #1041 そのものである）。
   *
   * **⚠️ プロセスを跨いだ排他は issue #1113 で足したが、advisory（勧告的）である。**
   * `#update` は `withPathLock` で `${this.#path}.lock` を取り合うので、**同じ
   * このクラスを経由して書く別プロセスに対しては**この畳み込みも id の冪等性も
   * 保たれる。**保たれないのは、ロックを見ない書き手が同じファイルを直接触った
   * 場合**（`withPathLock` の doc）——そこは DB の制約で守る `storage-pg` の
   * `PgCommitmentStore.open` とは強さが違う。本番の記憶ストアは PostgreSQL
   * なので、そちらは常に DB 側の保証で閉じている。
   */
  async open(rawEntry: Commitment): Promise<CommitmentOpenResult> {
    // id（鍵）の NUL は断り、本文は落として残す（issue #3011）。
    assertNoNul('commitment.id', rawEntry.id);
    const entry = { ...rawEntry, body: stripNul(rawEntry.body) };
    return this.#update<CommitmentOpenResult>((file) => {
      // 閉じた行・読めない行も含めて見る（片付いたものを開き直さない／
      // 読めない行と同じ id を二重に持たない）
      const known =
        file.entries.some((existing) => existing.id === entry.id) ||
        file.unreadable.some((row) => row.id === entry.id);
      if (known) return { next: file, result: { opened: false, folded: false } };
      const duplicate = findOpenManagerDuplicate(file.entries, entry);
      if (duplicate !== undefined)
        return {
          next: file,
          result: { opened: false, folded: true, foldedInto: duplicate.id },
        };
      return {
        next: trimClosed({
          entries: [...file.entries, commitmentSchema.parse(entry)],
          unreadable: file.unreadable,
          trimmedClosedCount: file.trimmedClosedCount,
        }),
        result: { opened: true, folded: false },
      };
    });
  }

  /**
   * 片付いたことを記録する。
   *
   * **⚠️ `CommitmentStore.close` の契約（「行は消さない」）をここは完全には
   * 守れていない（issue #416）。** ここが記録した片付き行は、`trimClosed`
   * （このファイル下部）が `CLOSED_HISTORY_LIMIT`（500件）を超えた古い側から
   * 新しい順に物理削除する。理由は fs 版が毎回ファイル全体を書き直す器だから
   * である——片付いた行を無限に積むと1回の書き込み費用が台帳の齢に比例して
   * 増えていく。**削除した累計件数は捨てずに `trimmedClosedCount` として持ち
   * 回り、`list()` が `CommitmentList.trimmedClosed` として外へ出す** ——
   * 契約から逸脱した事実そのものは、少なくとも合図としては消さない。
   *
   * ここも「読む→既に閉じていないか見る→書く」を同じ排他区間で行う。分けると、
   * 二重に届いた片付けが両方 `true` を返し、呼び出し側が「いま自分が閉じた」と
   * 誤って二重に報告する。
   *
   * **⭐ 読めない行の id を渡されたときも `true` を返せる（issue #2148。旧来の
   * 挙動から変わった点）。** 読めない行の中身（`commitmentSchema` に合わない
   * 生の値）は書き換えられないので、pg 版のように `closedAt` を jsonb の中へ
   * 進めることはできない——だが「その id を閉じたという事実」自体は、生の値に
   * 触れない別欄（`UnreadableRow.closed`。`closedUnreadableRowSchema` の doc）
   * へ記録できる。`entries` に見つからず、`unreadable` に見つかったときは、
   * その行がまだ閉じていなければ `closed` を立てて `true`、**既に `closed` が
   * 付いていれば「いま自分が閉じたのではない」ので `false`**——`entries` 側の
   * 「無い / 既に閉じている」判定と同じ形を保つ。
   *
   * **⚠️ この行の中身（`body` 等）は依然として読めないままである。** ここで
   * 変わるのは「閉じたと言えるかどうか」だけで、`get(id)` は相変わらず
   * `UnreadableCommitmentError` を投げる（閉じたかどうかに関わらず、中身が
   * 読めないという事実は変わっていない）——`list()` の `includeClosed` に
   * よる絞り込みだけが、この `closed` 印を見て変わる（`list()` の doc）。
   *
   * **`at` を渡された id が本当に見つからないときは、これまでどおり `false`**
   * （`entries` にも `unreadable` にも無い）。
   *
   * **pg 版とここで揃った（「言えないこと」の更新。issue #296 時点の doc を
   * 差し替える）。** pg 版は `closed_at` が jsonb（`commitment`）とは独立した
   * 列なので、行が読めない形でも `closed_at` だけを進められ、`close()` は
   * `true` を返す（`packages/storage-pg/src/commitments.ts` の `close` の
   * doc）。fs 版には pg のその列に当たるものが無いが、**同じ効果（「閉じたと
   * 言えること」）を別の置き場所（`closedUnreadable`）で実現した**ことで、
   * north_star 禁止1（器の違いで能力差を作らない）に触れる差は消えている。
   *
   * **この直しで `POST /commitments/:id/close`（`apps/daemon/src/app.ts`）の
   * 500 は消える。** あちらは `close()` を先に呼び、失敗したときだけ理由を
   * 求めて `get(id)` を呼ぶ作りなので、読めない行の `close()` がここで
   * `true` を返せるようになった以上、その `get(id)` の呼び出し自体に届かない
   * ——旧 doc が説明していた「fs 版はここで `false` を返した直後、その
   * `get(id)` が throw する」という経路は、まだ閉じていない読めない行では
   * 起きなくなった。**既に閉じている読めない行への2度目の `close()`** は
   * 相変わらず `false` を返すので、その場合の `get(id)` フォールバックは
   * 依然として throw しうる——`apps/daemon/src/app.ts` 側がその
   * `UnreadableCommitmentError` を捕まえて 409 にする（issue #2148。同ファイル
   * の `POST /commitments/:id/close` の doc）。MCP の `commitment_close`
   * （`packages/core/src/tools.ts`）も同じ形に直した——`close()` の前に
   * 必ず `get(id)` を呼んでいたのを、`UnreadableCommitmentError` を
   * `instanceof` で捕まえてから `close()` へ進む形にした。
   */
  async close(id: string, at: string, rawReason: string, by: CommitmentClosedBy): Promise<boolean> {
    const reason = stripNul(rawReason);
    return this.#update((file) => {
      const found = file.entries.find((entry) => entry.id === id);
      if (found !== undefined) {
        // 既に閉じている。「いま自分が閉じた」ではない
        if (found.closedAt !== undefined) return { next: file, result: false };
        return {
          next: trimClosed({
            entries: file.entries.map((entry) =>
              entry.id === id
                ? { ...entry, closedAt: at, closedReason: reason, closedBy: by }
                : entry,
            ),
            unreadable: file.unreadable,
            trimmedClosedCount: file.trimmedClosedCount,
          }),
          result: true,
        };
      }
      // **読めない行を id で探す（issue #2148）。** 見つからなければ本当に
      // 無い id である——`entries` にも `unreadable` にも無い以上、これまで
      // どおり `false`。
      const broken = file.unreadable.find((row) => row.id === id);
      if (broken === undefined) return { next: file, result: false };
      // 読めない行も、既に閉じていれば「いま自分が閉じた」ではない
      if (broken.closed !== undefined) return { next: file, result: false };
      return {
        next: {
          entries: file.entries,
          unreadable: file.unreadable.map((row) =>
            row === broken ? { ...row, closed: { at, reason, by } } : row,
          ),
          trimmedClosedCount: file.trimmedClosedCount,
        },
        result: true,
      };
    });
  }

  /**
   * 複数件を1回でまとめて片付いたことを記録する（issue #844。
   * `CommitmentStore.closeMany` の doc）。
   *
   * **`#update` の排他区間を1回だけ使い、対象の行を全部その中で処理する。**
   * `close()` を `ids` の件数だけ呼ぶ形（＝ `#update` を件数分呼ぶ形）にしない
   * のがこのメソッドの存在理由そのもの——fs 版は `#update` のたびに台帳の
   * JSON 全体を tmp へ書いて `rename` する器なので（`close()` の doc、
   * `packages/storage-fs/src/index.test.ts` の注記）、500件を `close()` の
   * ループで閉じれば500回の全体書き直しになる。**1回の排他区間に畳むことで、
   * 書き込みの回数を「対象の件数」から「呼び出しの回数（1）」へ落とす。**
   *
   * **判定・書き換えの筋は `close()` をそのまま複数件へ広げただけである。**
   * 対象は `ids` に含まれ、かつ未了の行（`closedAt === undefined`）だけ——
   * 存在しない id・既に閉じている id はそのまま素通りする。実際に閉じた id
   * だけを `closedIds` へ積み、戻り値にする。
   *
   * **`ids` を `Set` にしてから見るので、重複があっても対象の判定は変わらない
   * ——同じ行が複数回書き換えられることも、戻り値に同じ id が複数回入ること
   * も無い。** 1回の走査で1行ごとに高々1回しか処理しないため。
   *
   * **`ids` が空なら `#update` を呼ばずに `[]` を返す。** 「対象が無い」と
   * 分かっている呼び出しでまで排他区間へ入って読み直し・書き直しをする理由が
   * 無い。これにより、空配列を渡したときはファイルの中身が1バイトも変わらない。
   *
   * **`trimClosed` は `close()` と同じくここでも呼ぶ。** 新しく閉じた行が
   * 増える点は `close()` と変わらないので、保持上限（`CLOSED_HISTORY_LIMIT`）
   * の扱いも `close()` と揃える——複数件をまとめて閉じたからといって、
   * 未了の行を切ったり上限の計算を変えたりしない。
   */
  async closeMany(
    ids: readonly string[],
    at: string,
    rawReason: string,
    by: CommitmentClosedBy,
  ): Promise<string[]> {
    const reason = stripNul(rawReason);
    if (ids.length === 0) return [];
    const targets = new Set(ids);
    return this.#update((file) => {
      const closedIds: string[] = [];
      const entries = file.entries.map((entry) => {
        if (!targets.has(entry.id) || entry.closedAt !== undefined) return entry;
        closedIds.push(entry.id);
        return { ...entry, closedAt: at, closedReason: reason, closedBy: by };
      });
      return {
        next: trimClosed({
          entries,
          unreadable: file.unreadable,
          trimmedClosedCount: file.trimmedClosedCount,
        }),
        result: closedIds,
      };
    });
  }

  /**
   * `body` を書き換える。**`open` / `close` と同じ排他区間（`#update`）で行う**
   * — 読んでから書く形にすると、並行編集や「編集」と「片付け」の競合で
   * 後勝ちが黙って先の書き込みを踏み消す。
   *
   * **`origin` が `'human'` かどうかの判定はここでは行わない**
   * （`CommitmentStore.editBody` の doc）。呼び出し側（`apps/daemon/src/app.ts`
   * の `PATCH /commitments/:id`）が確かめてから呼ぶ前提で、ここは「まだ
   * 閉じていない」という不変条件だけを見る。
   *
   * **`trimClosed` は呼ばない。** 編集は既存の未了行を書き換えるだけで、
   * 新しく片付いた行を作らないので、切り詰めの対象が増えない。
   */
  async editBody(
    id: string,
    rawBody: string,
    at: string,
    by: CommitmentEditedBy,
  ): Promise<boolean> {
    const body = stripNul(rawBody);
    return this.#update((file) => {
      const found = file.entries.find((entry) => entry.id === id);
      // 無い / 既に閉じている。どちらも書き換えない
      if (found === undefined || found.closedAt !== undefined) {
        return { next: file, result: false };
      }
      return {
        next: {
          entries: file.entries.map((entry) =>
            entry.id === id ? { ...entry, body, editedAt: at, editedBy: by } : entry,
          ),
          unreadable: file.unreadable,
          trimmedClosedCount: file.trimmedClosedCount,
        },
        result: true,
      };
    });
  }

  /**
   * 全件を消す（`CommitmentStore.clear` の doc）。未了・片付いた行・読めない行
   * （`unreadable`）を問わず消す。`trimmedClosedCount`（issue #416 の累計）も
   * 0へ戻す——台帳そのものが空になった以上、これまでの切り詰め累計は意味を
   * 持たない。
   */
  async clear(): Promise<number> {
    return this.#update((file) => ({
      next: { entries: [], unreadable: [], trimmedClosedCount: 0 },
      result: file.entries.length + file.unreadable.length,
    }));
  }

  async #read(): Promise<CommitmentFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed = rawFileSchema.parse(JSON.parse(raw));
      const { entries, unreadable } = splitFileRows(parsed.commitments);
      // **`closedUnreadable`（issue #2148）を id で引き当てて `unreadable`
      // 側の行へ合流させる。** `close()` が読めない行に付けた印は、生の値
      // （`commitments` 配列）には書かれていないので、読み込むたびにここで
      // 合成し直す必要がある（`closedUnreadableRowSchema` の doc）。
      const closedById = new Map(parsed.closedUnreadable.map((row) => [row.id, row]));
      return {
        entries,
        unreadable: unreadable.map((row) => {
          if (row.id === undefined) return row;
          const closedRow = closedById.get(row.id);
          if (closedRow === undefined) return row;
          return {
            ...row,
            closed: { at: closedRow.at, reason: closedRow.reason, by: closedRow.by },
          };
        }),
        trimmedClosedCount: parsed.trimmedClosedCount,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { entries: [], unreadable: [], trimmedClosedCount: 0 };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（issue #1113 / #1050 — `withPathLock` で
   * プロセス内・プロセス間の両方を排他する。advisory の強さは `withPathLock`
   * の doc を見よ）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうかを決める操作**（`open` / `close`）を、この区間の外へ出さないこと。
   *
   * **⚠️ 書き出しは `toDiskShape` を必ず経由すること（issue #296）。** `next`
   * （`CommitmentFile`）をそのまま `JSON.stringify` すると `entries` /
   * `unreadable` という内部表現の形でディスクへ書かれてしまい、かつ
   * `unreadable[].value`（読めない行の生の値）がその形のまま残る一方で
   * 二度と `commitments` 配列の要素として読み込まれなくなる —
   * つまり読めなかった行は次回の起動で永久に読み込み対象から外れる。
   * `toDiskShape` は読めた行と読めなかった行の生の値を1本の `commitments`
   * 配列へ合成し直すことで、次回の `#read` が同じ行を同じように扱えるように
   * する。
   */
  async #update<T>(
    mutate: (file: CommitmentFile) => { next: CommitmentFile; result: T },
  ): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(toDiskShape(next), null, 2)}\n`);
      return result;
    });
  }
}

/**
 * 片付いた行だけを新しい順に `CLOSED_HISTORY_LIMIT` 件まで切り詰める。
 *
 * **未了の行には触れない。** 判定に使うのは `closedAt` の有無だけで、件数や齢では
 * ない（「古い未了から捨てる」は忘れさせないという目的の否定である）。
 *
 * **読めない行（`unreadable`）も1件も切らない（issue #296）。** `closedAt` が
 * そもそも読めていない以上、片付いたと見なす根拠が無い — 未了の行と同じ扱いで、
 * 上限にも `CLOSED_HISTORY_LIMIT` の計算にも入れない。
 *
 * **切った件数は捨てず `trimmedClosedCount` へ足す（issue #416）。** ここが
 * `CommitmentStore.close` の契約（「行は消さない」）を破る唯一の場所であり、
 * 破った回数の累計をここでしか数えられない——`list()` を呼んだ時点では、
 * 既に削除された行がいつ・何件消えたかを逆算する材料がどこにも残っていない。
 */
function trimClosed(file: CommitmentFile): CommitmentFile {
  const closed = file.entries.filter((entry) => entry.closedAt !== undefined);
  if (closed.length <= CLOSED_HISTORY_LIMIT) return file;

  const kept = new Set(
    [...closed]
      // 実時刻の降順（issue #2451。`list()` の片付き側と同じ比べ方で「新しい順」を決める）
      .sort((a, b) => compareIsoInstant(b.closedAt ?? '', a.closedAt ?? ''))
      .slice(0, CLOSED_HISTORY_LIMIT)
      .map((entry) => entry.id),
  );
  const removed = closed.length - kept.size;
  return {
    entries: file.entries.filter((entry) => entry.closedAt === undefined || kept.has(entry.id)),
    unreadable: file.unreadable,
    trimmedClosedCount: file.trimmedClosedCount + removed,
  };
}
