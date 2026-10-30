// 値を何も import しない: Web（`@alteroid/logic`）が `@alteroid/core/github-ci-format` から、core 本体を評価せずに読むため。
import type { GithubObservationOk } from './progress-github.js';

export type GithubCiCountLabel = Readonly<Record<'success' | 'failure' | 'pending', string>>;

// 軸の名前は呼ぶ側が渡せる: Web は日本語の表の名前で出し、既定（CLI・クローンが読む面）は raw の英語のまま。
const RAW_COUNT_LABEL: GithubCiCountLabel = {
  success: 'success',
  failure: 'failure',
  pending: 'pending',
};

/** `ci` が無いときは `success 0 / failure 0` と書かない: 0 件と読めてしまうから。 */
export function describeGithubCi(
  ok: Pick<GithubObservationOk, 'ci' | 'ciUnavailable'>,
  countLabel: GithubCiCountLabel = RAW_COUNT_LABEL,
): string {
  if (ok.ci !== undefined) {
    const ci = ok.ci;
    const counted = ci.success + ci.failure + ci.pending;
    return (
      `CI: ${String(ci.pulls)} 件の PR を確認 — ${countLabel.success} ${String(ci.success)} / ${countLabel.failure} ${String(ci.failure)} / ${countLabel.pending} ${String(ci.pending)}` +
      (counted < ci.pulls ? `（チェックが無い等で未集計 ${String(ci.pulls - counted)} 件）` : '') +
      `（数えたもの: ${ci.checks}）` +
      (ci.truncated === true ? '（打ち切り。数は下限）' : '')
    );
  }
  if (ok.ciUnavailable !== undefined)
    return `CI: 取れなかった — ${ok.ciUnavailable}（0 件ではない）`;
  return 'CI: 観測していない（0 件ではない）';
}
