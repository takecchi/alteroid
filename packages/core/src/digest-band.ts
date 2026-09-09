import type { DigestBandLimitedBy, DigestEntry } from "./recall.js";

/**
 * `packDigestBand` — 目次帯（`IndexBand.digestBand`）を組む純関数（docs/recall.md §5、本 PR）。
 *
 * `recall-runtime.ts` の段5から呼ばれるが、埋め込まずここに独立させてある——歯を
 * 当てやすくするため（`MemoryStore` や `Ctx` に依存しない純関数として、DB もフェイクも
 * 要らずに検査できる）。
 *
 * **この関数がやること**: `ScopeAggregate.digests`（DB/実装から来た生の digest。切り詰めて
 * いない）を受け取り、
 * 1. `maxEntryChars` を超える digest を切り詰め、`truncated: true` を立てる
 * 2. `maxChars`（帯全体の文字数予算）と `limit`（件数上限）のどちらかに当たったら打ち切る
 * 3. どの上限に当たったか（あるいは当たらなかったか）を `limitedBy` として返す
 *
 * **この関数がやらないこと**: 候補の並べ替え（呼び出し側が決めた順序をそのまま使う）。
 */
export interface PackDigestBandOptions {
  /** 帯に載せる件数の上限。 */
  limit: number;
  /** 帯全体の文字数予算。 */
  maxChars: number;
  /** 1件の digest の文字数上限。超えたら切り詰めて `truncated: true` を立てる。 */
  maxEntryChars: number;
}

export interface PackedDigestBand {
  band: DigestEntry[];
  limitedBy?: DigestBandLimitedBy;
}

/**
 * 1件を帯へ積んだときの JSON 上の費用の見積もり——固定部分（本 PR）。
 *
 * `{"memoryId":"<36字uuid>","digest":"..."}` を `JSON.stringify` した際の、digest の
 * 中身そのものを除く固定部分（`"memoryId":"` `"` `,"digest":"` `"` `{` `}` の記号類 と
 * 36字の UUID）の実測値。digest 自身の長さはここに含まれず、都度 `digest.length` を足す。
 */
export const DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS = 63;

/** 配列の中でこの件を区切るカンマ1字分（`DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS` に加算する）。 */
export const DIGEST_BAND_ENTRY_SEPARATOR_CHARS = 1;

/**
 * `candidates` から目次帯を組む。
 *
 * @param candidates 帯に載せる資格がある候補。**呼び出し側が決めた順序をそのまま使う
 *   （ここでは並べ替えない）。**
 * @param eligible 資格があった総数（`candidates.length` とは限らない——呼び出し側が既に
 *   `limit` で切って渡してくることがある。`ScopeAggregate.digestEligible.count`）。
 * @param opts 上限3種（`PackDigestBandOptions`）。
 *
 * **不変条件: `band.length <= eligible` を常に守る。** `limit` にどれだけ大きい値を
 * 渡されても、`candidates` に無い件数までは返さない。
 *
 * **`limitedBy` の決め方**:
 * - 打ち切りが一度も起きず、`candidates` を全部載せ、かつ `band.length >= eligible` なら
 *   `limitedBy` は省略する（＝どの上限にも当たらなかった）。
 * - 件数の上限（`limit`）で打ち切った ⟹ `"entry_limit"`。
 * - 文字数の予算（`maxChars`）で打ち切った ⟹ `"char_budget"`。
 * - **同じ件で両方に同時に当たった**（次の件を足すと件数も文字数も超える状態）
 *   ⟹ `"both"`。
 * - `eligible > band.length` なのに `limitedBy` が省略される状態は作らない——`candidates`
 *   自体が `limit` 件しか渡ってきていない（＝呼び出し側/store が既に切って渡してきた）
 *   場合も `"entry_limit"` として報告する。
 */
export function packDigestBand(
  candidates: readonly DigestEntry[],
  eligible: number,
  opts: PackDigestBandOptions,
): PackedDigestBand {
  const band: DigestEntry[] = [];
  let runningChars = 0;
  let limitedBy: DigestBandLimitedBy | undefined;

  for (const candidate of candidates) {
    const digestTooLong = candidate.digest.length > opts.maxEntryChars;
    const digest = digestTooLong ? candidate.digest.slice(0, opts.maxEntryChars) : candidate.digest;
    const cost =
      DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS + digest.length + DIGEST_BAND_ENTRY_SEPARATOR_CHARS;

    const wouldExceedLimit = band.length >= opts.limit;
    const wouldExceedChars = runningChars + cost > opts.maxChars;

    if (wouldExceedLimit && wouldExceedChars) {
      limitedBy = "both";
      break;
    }
    if (wouldExceedLimit) {
      limitedBy = "entry_limit";
      break;
    }
    if (wouldExceedChars) {
      limitedBy = "char_budget";
      break;
    }

    const entry: DigestEntry = { memoryId: candidate.memoryId, digest };
    if (digestTooLong) {
      entry.truncated = true;
    }
    band.push(entry);
    runningChars += cost;
  }

  if (limitedBy === undefined && band.length < eligible) {
    // ここまで来た＝打ち切りは一度も起きなかった（`candidates` を全部消費した）が、
    // それでも資格件数に届いていない。つまり `candidates` 自体が既に `limit`（またはそれ
    // 相当）で切られて渡ってきたということであり、その切り詰めもまた entry_limit の一種
    // として報告する。
    limitedBy = "entry_limit";
  }

  return limitedBy === undefined ? { band } : { band, limitedBy };
}
