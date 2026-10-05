/**
 * `/progress` の GitHub の欄に出す文言（値 → 表示ラベルの写し）。
 *
 * **core の値は変えない。** `describeGithubCi`（core）は `success` / `failure` / `pending` を
 * 字面のまま出す（CLI・クローンの道具が読む原本）。Web は値を受け取ったあと、表示の直前に
 * この層で日本語へ写す。#2608 の歯（`progress.test.tsx`）は「core と Web が同じ値・同じ並び・同じ
 * 数を持つ」ことを測っていて、この表の写しだけを逆に戻して原本と突き合わせる。
 */

/** CI の件数の軸（core の `ci` の `success` / `failure` / `pending`）。 */
export type GithubCiCountKey = 'success' | 'failure' | 'pending';

/** 値 → 表示ラベル。`satisfies` で、軸を足してここを足し忘れると型で落ちる。 */
export const GITHUB_CI_COUNT_LABEL = {
  success: '成功',
  failure: '失敗',
  pending: '実行中・待ち',
} as const satisfies Record<GithubCiCountKey, string>;

/** 表示の並び（core の `describeGithubCi` と同じ順）。 */
export const GITHUB_CI_COUNT_ORDER: readonly GithubCiCountKey[] = ['success', 'failure', 'pending'];

/** `github_observation` を記録した側（core の `GITHUB_OBSERVATION_CLONE_OBSERVER` は `'clone'`）。 */
export const GITHUB_OBSERVED_BY_LABEL: Readonly<Record<string, string>> = {
  clone: 'クローン',
};

/** 知らない値は識別子を出さず、一般的な言い方にする（`observedBy` は申告された自由文）。 */
export const GITHUB_OBSERVED_BY_UNKNOWN = 'クローン以外からの申告';

/** 記録元の表示名。`Object.hasOwn` で引く（`constructor` などの名乗りを拾わない）。 */
export function githubObservedByLabel(observedBy: string): string {
  return Object.hasOwn(GITHUB_OBSERVED_BY_LABEL, observedBy)
    ? (GITHUB_OBSERVED_BY_LABEL[observedBy] as string)
    : GITHUB_OBSERVED_BY_UNKNOWN;
}
