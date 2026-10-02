import type { JournalEntry } from './schema.js';
import type { JournalQuery, JournalStore } from './store.js';

/**
 * 日誌をページ単位で読み継ぐための足場（issue #1283）。
 *
 * ## 直している穴
 *
 * `JournalStore.list()` を `limit` なしで呼ぶ口が複数在り、pg 実装は `limit`
 * 省略時に `Number.MAX_SAFE_INTEGER` を渡す
 * （`grep -Fn -- 'query.limit ?? Number.MAX_SAFE_INTEGER' packages/storage-pg/src/journal.ts`）。
 * ⟹ 窓の中身が多い日（実測: ある1日で約247万行・本文だけで約1.4GB）は、それを
 * 1クエリで JS のヒープへ全部載せようとして落ちる。
 *
 * ## この足場が持つ約束——**呼び出し側が全件を配列へ貯めない**
 *
 * `scanJournalPages` 自身も、内部に全件を持たない。1ページぶん
 * （`options.pageSize`、既定 {@link JOURNAL_SCAN_PAGE_SIZE}）だけを
 * `journal.list()` から受け取り、`onPage` へ渡した直後にそのページへの参照を
 * 手放す（次のページを取るまでの間、保持しているのはページ1つぶんだけ）。
 * **呼び出し側が `onPage` の中で配列に積み増していけば、この約束は呼び出し側で
 * 破れる**——それは足場の責任ではなく呼ぶ側の設計の問題である。`digest.ts` /
 * `distill-gap.ts` の呼び出し側は、畳んだ結果（件数・保持の上限つきの一覧・
 * 最初と最後の時刻など）だけを残す形にしてある。
 *
 * ## ページの大きさ（{@link JOURNAL_SCAN_PAGE_SIZE}）
 *
 * **500 にしてある。** `distill-gap.ts` の {@link DISTILL_GAP_ACTIVITY_SCAN_LIMIT}
 * ——この足場より前から在る「新しい側から何件まで見るか」の定数——と同じ桁に
 * 揃えた。大きすぎるとページ1枚のヒープが太る（実測の1日ぶんの平均だと
 * 1行あたり概ね数百バイト〜だが、`exchange` の本文のように長い行も混ざるので
 * 安全率を持たせる）。小さすぎると往復（クエリ）の回数が増える——500件なら、
 * 数千件規模の走査でも一桁台の往復で収まる。**「なぜ500か」を実データの
 * 分布から精密に決めたわけではない**——安全側に倒した経験則であり、遅い・
 * 重いと分かったら見直すこと。
 *
 * ## `after` の錨——`JournalAnchorNotFoundError` は通常起きない
 *
 * `JournalQuery.after` が指す錨は「id と at の両方が一致する行が無ければ
 * {@link JournalAnchorNotFoundError} を投げる」契約を持つ（`store.ts` の
 * `JournalQuery.after` の doc）。この足場が渡す錨は**直前に store が継続点として
 * 返した行そのもの**（`listPage()` の `next`。読めずに捨てた行を含む、ページの
 * 最後の生の行）なので、追記専用の日誌
 * （`JournalStore` に更新・削除の口が無い）である限り、次の呼び出しでも
 * 必ず見つかる。**それでも例外そのものを握り潰さない**——呼び出し側が
 * `journal.clear()`（ワークスペースのリセット専用の例外的な消去口）を同じ
 * 走査の途中で挟むような想定外の使い方をすれば、この前提は崩れうる。その
 * ときは黙って空へ倒さず、例外をそのまま呼び出し側へ伝える。
 */
export const JOURNAL_SCAN_PAGE_SIZE = 500;

/** {@link scanJournalPages} の呼び出しオプション。 */
export interface JournalScanOptions {
  /**
   * 1回の `journal.list()` に渡す `limit`。既定は {@link JOURNAL_SCAN_PAGE_SIZE}。
   *
   * **常に有限の正の整数になる。** `maxScanned` が指定されていれば、それを
   * 超えないよう自動で縮める（下の `maxScanned` の doc）——呼び出し側が
   * 明示的に大きい値を渡しても、それだけで無制限を意味する余地は無い。
   */
  pageSize?: number;
  /**
   * 走査する総件数の上限。**省略時は無制限**——ページの大きさはヒープを
   * 守るが、往復の回数そのものは減らないので、無制限のまま使ってよいのは
   * 「その走査が別の理由で早めに終わる見込みが強い」場合だけである
   * （`distill-gap.ts` の呼び出し側のように、印を見つけ次第 `onPage` が
   * `false` を返して自分で止める形と対にすること）。**「打ち切らない」が
   * 「際限なく走ってよい」の意味にならないよう、呼び出す側がこの前提を
   * 満たせない（印が必ず近くに在るとは言えない）ときは、必ずこの上限を渡す
   * こと**（`digest.ts` の2本の走査がそれである）。
   */
  maxScanned?: number;
}

/** {@link scanJournalPages} の返り値。 */
export interface JournalScanResult {
  /** 走査した総件数（全ページの合計。`onPage` へ渡した件数の総和と一致する）。 */
  scanned: number;
  /**
   * `maxScanned` に当たって走査を止めたか。
   *
   * **`boolean` を返り値として持たせてあるのは、呼び出し側が握り潰せない
   * 形にするためである**（`CommitmentList` の `unreadable` / `trimmedClosed`
   * と同じ理由——`JournalScanResult` を受け取っておいて `scanned` だけ読んで
   * `truncated` を読み飛ばすことは書けても、この欄自体がコンパイラの目に
   * 触れないことはできない）。
   *
   * **`true` になるのは「`maxScanned` に達した」ときだけで、`onPage` が
   * 自分で止めた（`false` を返した）ときは `false` のままである。** 前者は
   * 「まだ続きが在るかもしれないのに見ていない」で、後者は「もう見る
   * 必要が無くなったので自分から止めた」——意味が違う（打ち切りと早期終了を
   * 同じ値へ潰さない）。
   *
   * ⚠️ **境界の1件だけ、安全側に倒してある。** ちょうど `maxScanned` 件目で
   * 日誌の実際のデータも尽きていた（＝続きが実は無かった）場合でも、この
   * 足場は往復を1回節約するために `truncated: true` を返す——「本当に続きが
   * 無いか」を確かめるための、無駄になりうるもう1回の問い合わせをしない
   * ため。⟹ ごく稀に「打ち切った」と名乗りながら実は続きが無かった、という
   * 誤検知が起こりうるが、逆向き（続きが在るのに「打ち切っていない」と
   * 言う）よりは安全である。
   */
  truncated: boolean;
}

/**
 * 1ページぶんの日誌行を受け取るコールバック。
 *
 * **`false` を返すと走査を止める**（早期終了。{@link JournalScanResult.truncated}
 * は `false` のままになる——「もう見る必要が無い」であって「打ち切った」では
 * ない）。`void` / `true` を返せば続く。
 *
 * ⚠️ **ここで受け取った `page` を呼び出し元のスコープへそのまま貯め込まない
 * こと。** それをやると、この足場がページ単位に留めている意味が呼び出し側で
 * 消える（このファイル冒頭の doc）。
 */
export type JournalScanPageHandler = (page: readonly JournalEntry[]) => void | boolean;

/**
 * 日誌をページ単位で読み継ぐ。**このファイル自身は1ページぶんより多くを
 * 同時にヒープへ持たない**（冒頭の doc）。
 *
 * `query` に `limit` を含めないこと——`limit` はページの大きさそのものなので
 * 足場が自分で組み立てて渡す（呼び出し側が指定しても意味を持たない、という
 * 誤解を型で防ぐため `Omit` で受け付けない）。`order` は呼び出し側の指定を
 * そのまま使う（既定 `desc`——`JournalQuery.order` の既定と同じ）。
 *
 * **`after` は「初期の錨」として渡せる。** `distill-gap.ts` の活動を数える枝
 * （印より後ろだけを見る）のように、走査の始点そのものが呼び出し側の材料
 * （既に見つけた別の行）であることがある——`Omit` で塞ぐと、その使い方が
 * できなくなる。**2ページ目以降の錨は、この関数が自分で（直前のページの
 * 最後の行から）作り直す**——`query.after` を読むのは最初の1回の
 * `journal.list()` 呼び出しだけで、以降は上書きする。
 *
 * **終端は store が言う（`JournalStore.listPage()` の `next === null`。Issue #2604 / #2605）。**
 * 返った件数が要求した `limit` より少なくても、空ページでも、終端とは読まない。
 * store は SQL で `LIMIT` を掛けた後に形の合わない（壊れた）行を捨てる（pg の日誌の
 * `list()`）ので、壊れた行が1行あれば 500 件のページが 499 件で返り、500 行が全部
 * 壊れていれば空で返る——「少ない／空 ＝ その先にもう行が無い」は成り立たない。
 * （#2494 は「空ページだけが終端」と読んでいたが、ページが丸ごと壊れていると
 * 空ページの向こうの古い行を `truncated: false` のまま取りこぼした。）
 * 次の頁は store が返す継続点（捨てた行を含む最後の行）から読む。空のページは
 * `onPage` へ渡さない。
 */
export async function scanJournalPages(
  journal: Pick<JournalStore, 'listPage'>,
  query: Omit<JournalQuery, 'limit'>,
  onPage: JournalScanPageHandler,
  options: JournalScanOptions = {},
): Promise<JournalScanResult> {
  const pageSize = options.pageSize ?? JOURNAL_SCAN_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize は正の整数である必要がある: ${pageSize}`);
  }
  const { maxScanned } = options;
  const order = query.order ?? 'desc';

  // **最初の1回だけ `query.after` を種にする。** 2ページ目以降は直前の
  // ページの最後の行から作り直す（下の代入）ので、呼び出し側が渡した初期の
  // 錨が2回目以降の呼び出しに漏れ残ることは無い。
  let after = query.after;
  let scanned = 0;
  for (;;) {
    // **常に有限の正の `limit` を渡す。** `maxScanned` が無ければ `pageSize`
    // そのもの、在ればそれを超えない範囲まで縮める——`journal.list()` へ渡る
    // `limit` が `undefined` になる経路も `Number.MAX_SAFE_INTEGER` になる経路
    // も、この関数の中に無い（この足場が塞ぐ穴そのもの）。
    const budget = maxScanned === undefined ? pageSize : Math.min(pageSize, maxScanned - scanned);
    // `maxScanned: 0` のように、呼ぶ前から予算が残っていない場合はここで
    // 止まる——1回も `journal.list()` を呼ばずに「打ち切った」と返す。
    if (budget <= 0) return { scanned, truncated: true };

    const { entries: page, next } = await journal.listPage({
      ...query,
      order,
      after,
      limit: budget,
    });
    if (page.length > 0) {
      scanned += page.length;
      if (onPage(page) === false) return { scanned, truncated: false };
      if (maxScanned !== undefined && scanned >= maxScanned) return { scanned, truncated: true };
    }

    // **終端は `next === null` だけ**（Issue #2604 / #2605。冒頭の doc）。短い
    // ページも空ページも終端の印ではない。
    if (next === null) return { scanned, truncated: false };
    after = next;
  }
}
