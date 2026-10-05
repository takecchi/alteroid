import { describeRevisionStatus, reportRunnerRevision, resolveBuildRevision } from '@alteroid/core';
import type { BuildRevision } from '@alteroid/core';

/**
 * `alteroid --version` が出す文字列（#2857）。
 *
 * **版の正本は、core の `resolveBuildRevision`（ビルドが焼いた git の sha）である。**
 * `alteroid runners` の「デーモンの版」と同じ出所なので、2つを突き合わせて同じ版か
 * 確かめられる。`apps/cli/package.json` の `version` は `0.0.0`（`private: true`。上げる運用が
 * 無い）で、人間の目に版の手がかりにならない——かつての固定 `0.1.0` と同じ嘘になる。
 *
 * **取れないときは「不明」と言う**（`describeBuildRevision` と同じ約束。既定値を作らない）。
 * 焼き込みも `ALTEROID_BUILD_REV` / `RAILWAY_GIT_COMMIT_SHA` も無い器（git の外で
 * ビルドしたイメージなど）がそれに当たる。
 */
export function describeCliVersion(rev: BuildRevision = resolveBuildRevision()): string {
  if (rev.short === null || rev.commit === null) {
    return (
      'alteroid 版: 不明（ビルドが版を焼き込んでおらず、' +
      'ALTEROID_BUILD_REV / RAILWAY_GIT_COMMIT_SHA も無い）'
    );
  }
  // sha は分かるが出所の分類が分からない（`BuildRevision` の doc）。分かる分だけ言う。
  if (rev.source === null) return `alteroid ${rev.short}（フル ${rev.commit}）`;
  // 言い方は `alteroid runners` の「デーモンの版」と同じ関数に任せる（口ごとに文言を作らない）。
  return `alteroid ${describeRevisionStatus(reportRunnerRevision(rev))}`;
}
