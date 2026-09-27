import { z } from 'zod';

/**
 * `usage_read` の axis 継続点、および `self_status` の台帳突き合わせ
 * （`ledgerCursor`）の継続点（issue #1673）。
 *
 * ## 何を直しているか
 *
 * `usage_read` の `axis` モードと `self_status` の台帳突き合わせは、どちらも
 * **費用の降順（同額はラベルの昇順）で並べ替え直す配列**を頁分けして返す
 * （`tools.ts` の `usageAxisEntries` / `renderLedgerCrossReference`）。台帳は
 * 委譲が進むたびに増え続けるので、まとめ表示を見てから続きを取りに行くまでの
 * 間に別の行の費用が変わって順位が入れ替わると、**素の配列添字（旧 `offset`）が
 * 指す位置の意味が変わる**——1件が両方の応答からも消え、別の1件が重複する
 * （#1673 本文の実測）。
 *
 * ## 錨は値そのもの（keyset）。位置の探索はしない
 *
 * `token-cursor.ts` は「id で位置を探す→無ければ比較」の2段だが、ここでは
 * 1段で足りる——**費用は増える一方**（台帳は積み上げるだけで、記録済みの
 * 消費が減ることは無い。`usage.ts` の `subtract` が負にしない設計と同じ前提）
 * なので、「錨より小さい費用（同額なら錨よりラベルが後ろ）」だけを続きの頁と
 * すれば、**最初に見せた行が続きの頁に紛れ込むことは無い**（費用が下がって
 * 錨を追い越すことが無いため）。⟹ 位置の探索が要らない——錨の行が現在の
 * 配列のどこにあるかを探さず、値の比較だけで頁を切れる。
 *
 * ## `asOf`（取りこぼし対策）
 *
 * 上だけでは足りない——**錨より前（上位）に居た行が、初回の呼び出しの後に
 * 費用を積んで別の行を追い越し、錨のさらに上へ移ることがある**（#1673 の
 * `mgr-15` がその実例）。そうなった行は「錨より後ろ」に来ないので、続きの
 * 頁（`isAfterAnchor` で選ぶ側）には現れない——かといって、まとめ表示の
 * 時点でも下位すぎて出ていない。**このままでは1件が両方の応答からも消える。**
 *
 * 対策として、錨に `asOf`（初回の呼び出し時点の、対象の行の `updatedAt` の
 * 最大値）を持たせる。続きの呼び出しでは、**錨と同格以上（＝続きの頁には
 * 含めない側）の行のうち、`updatedAt` が `asOf` より後のもの**を別枠
 * （`risen`）として拾う。これには2種類が混ざる——(a) 初回より後に追い越して
 * 錨より上位へ来た行（本当の意味で「順位が上がった」）、(b) 初回時点で
 * 既に錨より上位に居て、その後も費用を積んだ行（既に見せてある行が伸びた
 * だけ）。**この2つを区別する手段が無い**（畳んだ集計からは「初回時点で
 * どこに居たか」を復元できない）ので、両方まとめて「順位が上がった、または
 * 既に見せた行が伸びた可能性がある」として名乗る（呼び出し側の doc・
 * 出力文言が担当する）。
 *
 * ## `asOf` と同着（同一ミリ秒）の追い越しを取りこぼさない（issue #1719）
 *
 * `asOf` はミリ秒精度なので、**別の行が `asOf` を作った行とちょうど同じ
 * ミリ秒に錨を追い越すことがある**（並行する委譲が同じ tick で書く形。
 * #1719 の `mgr-15` が実例）。この行は次の2つがどちらも偽になり、**page にも
 * risen にも出ない**——`isAfterAnchor`（費用が違うので偽）、`updatedAt > asOf`
 * （同着なので偽）。単に `>` を `>=` に直すだけでは別の取りこぼしを生む——
 * **`asOf` を作った行そのもの（初回にもう見せてあり、その後1文字も伸びて
 * いない行）まで、呼ぶたびに `risen` へ載り続ける**（`updatedAt === asOf` が
 * 恒久的に真であり続けるため）。
 *
 * だから錨は `asOf` に加えて `tiedAtAsOf`（初回の呼び出し時点で、錨と同格
 * 以上の行のうち `updatedAt` がちょうど `asOf` と一致していた行の
 * `(label, cost)` の組の一覧）を持つ。続きの呼び出しでは、`updatedAt === asOf`
 * の行を次のどちらかに当たるときだけ `risen` に載せる——(1) `updatedAt > asOf`
 * （これまでどおり）、(2) `updatedAt === asOf` で、かつその `(label, cost)` の
 * 組が `tiedAtAsOf` のどれとも一致しない（＝初回には無かった・初回から値が
 * 変わった行なので、本当に「追い越した」か「伸びた」）。**一致するなら、
 * 初回にそのまま見せていた・その後も変わっていない行なので `risen` には
 * 載せない。** `tiedAtAsOf` の作り方は {@link findUsageCursorTies} を見よ
 * （錨を作る側——`tools.ts` の `usage_read` と `self_status` の
 * `ledgerCursor` ——の両方が呼ぶ）。
 *
 * **`tiedAtAsOf` は錨の候補集合（`isAfterAnchor` が偽の側）からしか採らない**
 * ——その側だけが `risen` の対象だから。それより外側（まだ見せていない側）の
 * 同着は単に次の頁に自然に現れるので、ここには含めない。
 *
 * **⚠️ この候補集合そのものの大きさは、1回目の呼び出しに限れば軸モードなら
 * `USAGE_AXIS_PAGE`（100）、まとめ表示なら `USAGE_AXIS_LIMIT`（14）で頭打ちに
 * なる（`tools.ts` の該当定数）が、cursor を繋いで何頁も辿る呼び出しでは
 * そうならない**——錨の順位は「これまでに見せた頁の合計」で伸びるので、
 * 続きを何度も辿るほど候補集合そのものは大きくなりうる（頭打ちにならない）。
 * `tiedAtAsOf` の実際の長さは、その候補集合のうち `updatedAt` が `asOf` と
 * 一致する行だけなので、通常は候補集合よりずっと小さい（同じミリ秒に書き込む
 * 行が複数あることは稀）——ただし、行の `updatedAt` の粒度が粗い・一括投入で
 * 大量の行に同一の時刻を刻む、といった入力では、候補集合の全体が同着になる
 * こともあり得る（構造として頭打ちを保証してはいない）。実データでの実測は
 * していない。
 *
 * **古い形の cursor（`tiedAtAsOf` を持たないもの）は、壊れた cursor として
 * 断らずに、これまでどおり `updatedAt > asOf`（厳密不等号）で読む**
 * （後方互換。`tiedAtAsOf` が存在しないことと、存在して空配列であることは
 * 別の意味を持つ——前者は「同着の判定機構そのものを知らない旧版」、後者は
 * 「今回は錨の候補集合の中に同着が無かった」）。
 *
 * ## 錨は不透明な文字列（`encode…` / `decode…`）
 *
 * `token-cursor.ts` と同じ理由——中身の構造を呼び手に知らせない。壊れた
 * cursor・別の文脈（`axis` が違う／`usage_read` と `self_status` を混ぜた）
 * の cursor は、黙って先頭へ倒さず断る（`resolveUsageCursor` の
 * `'malformed'` / `'wrong-axis'`）。
 *
 * ## `axis` は「文脈の名前」であって `UsageAxis` に限らない
 *
 * `usage_read` の6軸（`date` / `manager` / `model` / `layer` / `site` /
 * `token`）だけでなく、`self_status` の台帳突き合わせも同じ錨を使う
 * （文脈名は `'ledger'`。`tools.ts` 側で渡す）。**別の文脈の錨を渡されたら
 * 断る**——`usage_read` の cursor を `self_status` の `ledgerCursor` に
 * 使い回せてしまうと、どちらの側も「この cursor は自分のものだ」と信じて
 * 頁を切ることになり、壊れた頁が黙って返る。
 */
const usageCursorSchema = z.object({
  /** その錨がどの文脈のものか（`UsageAxis` の値、または `'ledger'`）。 */
  axis: z.string().min(1),
  /** 最後に見せた行のラベル（軸の値、または台帳突き合わせの合成鍵）。 */
  label: z.string(),
  /** 最後に見せた行の、その時点の費用（USD）。 */
  cost: z.number(),
  /**
   * 初回の呼び出し時点の、対象の行の `updatedAt` の最大値。
   *
   * **無いことがある**——対象の行が1件も無い状態からは錨そのものが作れない
   * （打ち切りが起きるのは1件以上あるときだけなので、実務上は常に入るが、
   * 型としては optional にしておく——後方互換で古い形の cursor が来ても
   * 壊れた cursor として拒むのではなく、`risen` を出さない形で読める）。
   */
  asOf: z.string().optional(),
  /**
   * 初回の呼び出し時点で、錨の候補集合（`isAfterAnchor` が偽の側）のうち
   * `updatedAt` がちょうど `asOf` と同着だった行の `(label, cost)` の組
   * （issue #1719）。
   *
   * **無いことがある**——`asOf` と同じ理由で optional にしてある。ただし
   * 意味は `asOf` とは違う：**存在しないのは「同着の判定機構そのものを
   * 知らない旧版の cursor」**（`resolveUsageCursor` は `updatedAt > asOf`
   * の厳密不等号だけで読む＝後方互換）。**存在して空配列なのは「今回は
   * 同着が無かった」**（`updatedAt === asOf` の行は無条件に `risen` へ回る）。
   */
  tiedAtAsOf: z.array(z.object({ label: z.string(), cost: z.number() })).optional(),
});

export type UsageCursor = z.infer<typeof usageCursorSchema>;

/** カーソルを不透明な文字列へ符号化する。呼び手は中身の構造を知らなくてよい。 */
export function encodeUsageCursor(cursor: UsageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeUsageCursorResult = { ok: true; cursor: UsageCursor } | { ok: false };

/** カーソルを decode する。**壊れていれば `{ ok: false }`。** */
export function decodeUsageCursor(raw: string): DecodeUsageCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = usageCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

/** `resolveUsageCursor` が扱えるエントリの最小形。 */
export interface UsageCursorEntry {
  label: string;
  cost: number;
  /** そのエントリを構成する台帳の行のうち、最も新しい `updatedAt`。 */
  updatedAt: string;
}

/**
 * 錨より「後ろ」（続きの頁の本体）に入るか。
 *
 * **`'date'` だけ特別**——`usageAxisEntries` の `date` 軸はラベル（日付文字列）
 * の降順だけで並び、費用は順序に関与しない（`tools.ts` の該当コメント）。
 * それ以外の軸・文脈（`self_status` の `'ledger'` を含む）は「費用降順・
 * 同額はラベル昇順」（`usageAxisEntries` の `byCost` と同じ比較）。
 *
 * **`localeCompare` で揃える。** 並べ替え側（`byCost` / `date` のソート）が
 * `localeCompare` を使っているので、ここも同じ関数で比較しないと、
 * ロケール依存の文字（同じ文字でも `<`/`>` と `localeCompare` で大小が
 * 逆転しうる）で頁の境界と実際の並びがずれる。
 */
function isAfterAnchor(
  axis: string,
  entry: Pick<UsageCursorEntry, 'label' | 'cost'>,
  anchor: Pick<UsageCursor, 'axis' | 'label' | 'cost'>,
): boolean {
  if (axis === 'date') return entry.label.localeCompare(anchor.label) < 0;
  const costDiff = entry.cost - anchor.cost;
  if (costDiff !== 0) return costDiff < 0;
  return entry.label.localeCompare(anchor.label) > 0;
}

/** 錨の `tiedAtAsOf` の1件（issue #1719）。 */
export type UsageCursorTie = { label: string; cost: number };

/**
 * 錨を作る側（`tools.ts`）が呼ぶ——初回の呼び出し時点で、錨の候補集合
 * （`isAfterAnchor` が偽の側＝続きの頁には含めない側）のうち `updatedAt` が
 * ちょうど `asOf` と同着だった行を集める（issue #1719）。`resolveUsageCursor`
 * の doc の「`asOf` と同着の追い越しを取りこぼさない」節を見よ。
 *
 * `asOf` が `undefined`（対象の行が1件も無い）なら、同着そのものが定義でき
 * ないので空配列を返す。
 */
export function findUsageCursorTies<T extends UsageCursorEntry>(
  entries: readonly T[],
  axis: string,
  anchor: Pick<UsageCursorEntry, 'label' | 'cost'>,
  asOf: string | undefined,
): UsageCursorTie[] {
  if (asOf === undefined) return [];
  return entries
    .filter((entry) => !isAfterAnchor(axis, entry, { axis, ...anchor }) && entry.updatedAt === asOf)
    .map((entry) => ({ label: entry.label, cost: entry.cost }));
}

export type ResolveUsageCursorResult<T> =
  { kind: 'malformed' } | { kind: 'wrong-axis' } | { kind: 'ok'; page: T[]; risen: T[] };

/**
 * cursor を、いまの（呼ばれた時点で並べ替え直した）エントリ集合へ当てる。
 * **純関数。**
 *
 * - `cursorRaw` が `undefined`: 絞らない。`page` は全件、`risen` は空
 *   （まだ比べる基準＝ `asOf` が無い最初の呼び出しなので、何も「上がった」
 *   とは言えない）
 * - decode できない: `{ kind: 'malformed' }`——**黙って先頭からへは倒さない**
 * - `axis` が cursor の持つものと違う: `{ kind: 'wrong-axis' }`——他の軸・
 *   他の文脈（`usage_read` と `self_status` の間）の錨を使い回さない
 * - それ以外: `{ kind: 'ok', page, risen } `。`page` は錨より後ろ（欠落・
 *   重複が起きない側）、`risen` は錨と同格以上で `asOf` より後に動いた行、
 *   **および `asOf` とちょうど同着で、かつ `anchor.tiedAtAsOf` のどの
 *   `(label, cost)` の組とも一致しない行**（issue #1719。`anchor.asOf` が
 *   無ければ常に空。`anchor.tiedAtAsOf` が無い旧形式の cursor は、同着を
 *   `risen` に含めない——`updatedAt > asOf` の厳密不等号のみで読む）
 */
export function resolveUsageCursor<T extends UsageCursorEntry>(
  entries: readonly T[],
  axis: string,
  cursorRaw: string | undefined,
): ResolveUsageCursorResult<T> {
  if (cursorRaw === undefined) return { kind: 'ok', page: [...entries], risen: [] };
  const decoded = decodeUsageCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const anchor = decoded.cursor;
  if (anchor.axis !== axis) return { kind: 'wrong-axis' };

  const page = entries.filter((entry) => isAfterAnchor(axis, entry, anchor));
  const asOf = anchor.asOf;
  const tiedAtAsOf = anchor.tiedAtAsOf;
  // 初回に見せた（＝控えてある）組と一致するか。`tiedAtAsOf` が無い旧形式の
  // cursor では、同着をそもそも `risen` へ回さない（下で使う側が済ませる）。
  const wasAlreadyShown = (entry: Pick<UsageCursorEntry, 'label' | 'cost'>): boolean =>
    (tiedAtAsOf ?? []).some((tie) => tie.label === entry.label && tie.cost === entry.cost);
  const risen =
    asOf === undefined
      ? []
      : entries.filter((entry) => {
          if (isAfterAnchor(axis, entry, anchor)) return false;
          if (entry.updatedAt > asOf) return true;
          if (entry.updatedAt < asOf) return false;
          // entry.updatedAt === asOf: 同着（issue #1719）。旧形式の cursor
          // （tiedAtAsOf が無い）は、これまでどおり厳密不等号のみで読むので
          // 常に false。新形式では「初回に見せた組と一致しない」ときだけ真。
          return tiedAtAsOf !== undefined && !wasAlreadyShown(entry);
        });
  return { kind: 'ok', page, risen };
}
