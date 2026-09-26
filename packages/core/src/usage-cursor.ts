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
  anchor: UsageCursor,
): boolean {
  if (axis === 'date') return entry.label.localeCompare(anchor.label) < 0;
  const costDiff = entry.cost - anchor.cost;
  if (costDiff !== 0) return costDiff < 0;
  return entry.label.localeCompare(anchor.label) > 0;
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
 *   重複が起きない側）、`risen` は錨と同格以上で `asOf` より後に動いた行
 *   （`anchor.asOf` が無ければ常に空）
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
  const risen =
    asOf === undefined
      ? []
      : entries.filter((entry) => !isAfterAnchor(axis, entry, anchor) && entry.updatedAt > asOf);
  return { kind: 'ok', page, risen };
}
