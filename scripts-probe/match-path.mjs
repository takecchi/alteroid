// 使い捨ての測定用スクリプト（2周目 (iv) 用。3周目で (iv-d) の widenSuffix オプションを追加）。
// 本文のパス候補 p と、差分のファイル一覧 D の照合を段階化する。
// 依頼文の仕様どおり（既定 = (iv-a)〜(iv-c) で使ったもの）:
//   1. exact:   D に p が完全一致で在る
//   2. suffix:  p が '/' を含まないファイル名で、D のどれかが '/' + p で終わる。
//               2つ以上あれば ambiguous として別に数える（当たりに混ぜない）
//   3. subpath: p が '/' を含み拡張子を持たない（ディレクトリらしき参照）で、
//               D のどれかが p か p + '/' で始まる
//   4. none:    どれにも当たらない
//
// (iv-d) 用オプション opts.widenSuffix: true にすると、suffix 照合を
// 「'/' を含まない名前」に限らず、p が '/' を含んでいても D のどれかが
// '/' + p で終わるなら当たりとする（例: lib/types.ts が
// apps/web/app/lib/types.ts に当たる）。⚠ 候補が2つ以上なら ambiguous のまま。
//
// resolved(kind) === true の kind だけを「ずれていない」として扱う。
// ambiguous は resolved に含めない（曖昧な一致を当たりに混ぜない、という依頼文の指示）。

const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/**
 * @param {string} path 本文から取れたパス候補
 * @param {string[]} diffFiles gh pr diff --name-only の全行
 * @param {object} [opts]
 * @param {boolean} [opts.widenSuffix] (iv-d) suffix 照合を '/' を含むパスにも広げるか
 * @returns {{kind: 'exact'|'suffix'|'subpath'|'ambiguous'|'none', matched: string|string[]|null}}
 */
export function matchPath(path, diffFiles, opts = {}) {
  const { widenSuffix = false } = opts;

  if (diffFiles.includes(path)) {
    return { kind: 'exact', matched: path };
  }

  const canTrySuffix = widenSuffix || !path.includes('/');
  if (canTrySuffix) {
    const suffix = '/' + path;
    const candidates = diffFiles.filter((d) => d.endsWith(suffix));
    if (candidates.length === 1) {
      return { kind: 'suffix', matched: candidates[0] };
    }
    if (candidates.length >= 2) {
      return { kind: 'ambiguous', matched: candidates };
    }
    // suffix で当たらなければ、'/' を含まないパスはここで none。
    // '/' を含むパスは下の subpath 判定へ続く（widenSuffix でも subpath は独立に効く）。
    if (!path.includes('/')) {
      return { kind: 'none', matched: null };
    }
  }

  // path に '/' を含む
  if (!HAS_EXTENSION_RE.test(path)) {
    const prefix = path.endsWith('/') ? path : path + '/';
    const candidates = diffFiles.filter((d) => d === path || d.startsWith(prefix));
    if (candidates.length > 0) {
      return { kind: 'subpath', matched: candidates };
    }
    return { kind: 'none', matched: null };
  }

  return { kind: 'none', matched: null };
}

export function isResolved(kind) {
  return kind === 'exact' || kind === 'suffix' || kind === 'subpath';
}
