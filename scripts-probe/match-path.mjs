// 使い捨ての測定用スクリプト（2周目 (iv) 用）。
// 本文のパス候補 p と、差分のファイル一覧 D の照合を段階化する。
// 依頼文の仕様どおり:
//   1. exact:   D に p が完全一致で在る
//   2. suffix:  p が '/' を含まないファイル名で、D のどれかが '/' + p で終わる。
//               2つ以上あれば ambiguous として別に数える（当たりに混ぜない）
//   3. subpath: p が '/' を含み拡張子を持たない（ディレクトリらしき参照）で、
//               D のどれかが p か p + '/' で始まる
//   4. none:    どれにも当たらない
//
// resolved(kind) === true の kind だけを「ずれていない」として扱う。
// ambiguous は resolved に含めない（曖昧な一致を当たりに混ぜない、という依頼文の指示）。

const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/;

/**
 * @param {string} path 本文から取れたパス候補
 * @param {string[]} diffFiles gh pr diff --name-only の全行
 * @returns {{kind: 'exact'|'suffix'|'subpath'|'ambiguous'|'none', matched: string|string[]|null}}
 */
export function matchPath(path, diffFiles) {
  if (diffFiles.includes(path)) {
    return { kind: 'exact', matched: path };
  }

  if (!path.includes('/')) {
    const suffix = '/' + path;
    const candidates = diffFiles.filter((d) => d.endsWith(suffix));
    if (candidates.length === 1) {
      return { kind: 'suffix', matched: candidates[0] };
    }
    if (candidates.length >= 2) {
      return { kind: 'ambiguous', matched: candidates };
    }
    return { kind: 'none', matched: null };
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
