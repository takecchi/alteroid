/**
 * `TranscriptArchive.archive()` の id の形（`packages/storage-fs/src/archive.ts`
 * の `archiveIdCandidate` / `packages/storage-pg/src/archive.ts` の
 * `archiveIdCandidate`。両者は同じ形を作る）を、3実装（fs / pg）で共有して
 * 解析するための純関数（#908）。
 *
 * ## id の形
 *
 * `${sanitize(sessionId)}-${stamp}.jsonl`。`stamp` は
 * `at.toISOString().replace(/[:.]/g, '-')`（`YYYY-MM-DDTHH-MM-SS-mmmZ`）。
 * 同じ `sessionId` へ同じミリ秒に複数回積むと id が衝突するため（#905）、
 * 2回目以降は **枝番** が付く——`archiveIdCandidate(base, attempt)` は
 * `attempt === 1` なら `${base}.jsonl`、そうでなければ `${base}-${attempt}.jsonl`
 * を返す（fs / pg 両方の `archiveIdCandidate` が同じ形）。
 *
 * ## 枝番＝積んだ順である根拠（#908）
 *
 * fs / pg の `archive()` はどちらも、`base`（sessionId + ミリ秒スタンプ）が
 * 決まったあとに **枝番1から順に空いている id を探し**、最初に空いていた
 * 枝番でその場に確保する（fs は `flag: 'wx'` の排他作成、pg は
 * `onConflictDoNothing` ＋ `returning()`。どちらも「使えたら即返す、使えなければ
 * 次の枝番へ」というループである）。id を消費するのは `archive()` だけで、
 * 他の操作は id の枠を空けない——`remove()` は本体を空へ切り詰めるだけで
 * 行（id の枠）そのものは消さず、`clear()` は全件を消す（次にまた1から埋まる
 * だけで、既存の行との衝突は起きない）。⟹ **同じ (sessionId, ミリ秒) の行に
 * 限れば、枝番は必ず「積んだ順」と一致する** — 1本目が枝番1、2本目が枝番2、
 * ……という形以外にはなり得ない（間に穴が開くこともない。空いている最小の
 * 枝番から順に埋めるため）。
 *
 * ## なぜ `id` の字面順ではなく枝番の数値で比べるか（#908）
 *
 * `-`(0x2D) と `.`(0x2E) の大小関係により、`id` の字面（文字列）比較では
 * `base-2.jsonl < base-3.jsonl < base.jsonl` という順になる——**枝番の無い
 * id（1本目）が、字面上は最大になる。** 同じミリ秒に3本以上積んだとき、
 * 「`id` が最大」で tie-break すると3本目以降が1本目を「直前」だと誤認する
 * （#908 の本体）。枝番を数値として取り出して比較すれば、この字面の逆転は
 * 起きない。
 *
 * **PostgreSQL の照合順（collation）にも依存しない。** `desc(archive.id)` は
 * DB 側の collation 次第で結果が変わりうる（本番と PGlite で揃う保証がない）
 * が、`archiveIdBranch` は id をアプリケーション側の正規表現で解析するだけで、
 * DB には一切問い合わせない。
 */
const ARCHIVE_ID_STAMP_SUFFIX_RE =
  /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-(\d+))?\.jsonl$/;

/**
 * `archiveIdCandidate` が作る id の末尾（`-<stamp>(-<枝番>)?.jsonl`）を解析
 * した結果（#908）。**この正規表現に一致する id の解析はここへ集約する**
 * ——`packages/storage-fs/src/archive.ts` の `fallbackMeta`（`sessionId` /
 * `at` の best-effort 復元。この機能より前の `.meta.json` サイドカーが無い
 * 行が対象）も、この関数の戻り値から `suffix` / `stamp` を取る形にして
 * 正規表現の実体を1つに保つ。
 */
export interface ArchiveIdStampMatch {
  /** マッチ全体（枝番を含む）。呼び出し側が `id` から `sessionId` 部分を
   * 切り出すのに使う（この長さぶんを末尾から引く）。 */
  readonly suffix: string;
  /** `YYYY-MM-DDTHH-MM-SS-mmmZ` 形式のスタンプ（枝番を含まない）。 */
  readonly stamp: string;
  /** 枝番。無ければ 1（1本目と同じ扱い。`archiveIdCandidate(base, 1)` が
   * 枝番を付けないのと対称）。 */
  readonly branch: number;
}

/** `id` の末尾を解析する（#908）。一致しなければ `undefined`。 */
export function matchArchiveIdStamp(id: string): ArchiveIdStampMatch | undefined {
  const match = ARCHIVE_ID_STAMP_SUFFIX_RE.exec(id);
  if (match === null) return undefined;
  const suffix = match[0];
  const stamp = match[1];
  const branchText = match[2];
  if (stamp === undefined) return undefined;
  return { suffix, stamp, branch: branchText === undefined ? 1 : Number.parseInt(branchText, 10) };
}

/**
 * `id` の枝番を取り出す（#908）。**枝番が無ければ 1**（`matchArchiveIdStamp`
 * の doc と同じ）。
 *
 * この正規表現に一致しない id（この機能より前の壊れた名前・
 * `seedFingerprintlessRow` が作る裏口専用の id 等）は 1 を返す——tie-break の
 * 対象として「いちばん古い」側に寄せておくことで、想定外の id が「いちばん
 * 新しい」と誤認されて `#findPreviousArchiveForSession` の `at` 判定より優先
 * されることを防ぐ（`at` が同値のときにしかこの関数の戻り値は比べられない
 * ため、実害が出るとしてもその窓に限られる）。
 */
export function archiveIdBranch(id: string): number {
  return matchArchiveIdStamp(id)?.branch ?? 1;
}

/**
 * `ArchiveEntry`（の `sessionId` / `at` / `id` だけを持つ最小形）2件を
 * 「新しい順」で並べる比較関数（#908）。fs の `list()`・pg の `list()` が
 * 共有する——`list()` はどちらも `.orderBy(desc(at))`（またはそれに相当する
 * 形）で SQL / ファイルシステム側の粗い順を作ったあと、**同じ `at` の
 * tie-break だけ**をこの関数に委ねる形で使うことを想定している。
 *
 * 比較の優先順位:
 * 1. `at` の降順（新しい方が先）
 * 2. （`at` が同値のとき）同じ `sessionId` なら、`archiveIdBranch` の降順
 *    （枝番が大きい＝後から積んだ方が先。#908 の本体）
 * 3. それでも決まらない（`sessionId` が違う、または枝番も同値）ときは
 *    `sessionId`、次に `id` の単純な文字コード比較（`localeCompare` ではない
 *    ——ロケール依存を持ち込まないための、決定的な最終フォールバックに
 *    すぎず、意味のある順序を主張しない）。
 */
export function compareArchiveEntriesNewestFirst(
  a: { readonly sessionId: string; readonly at: string; readonly id: string },
  b: { readonly sessionId: string; readonly at: string; readonly id: string },
): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.sessionId === b.sessionId) {
    const branchDiff = archiveIdBranch(b.id) - archiveIdBranch(a.id);
    if (branchDiff !== 0) return branchDiff;
  } else {
    return a.sessionId < b.sessionId ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
