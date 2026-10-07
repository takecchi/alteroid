import {
  describeRevisionStatus,
  reportRunnerRevision,
  resolveBuildRevision,
} from '@alteroid/core/cli-light';
import type { BuildRevision } from '@alteroid/core/cli-light';

// `package.json` の `version` を使わない: `0.0.0` のままで、人間の目に版の手がかりにならないため
export function describeCliVersion(rev: BuildRevision = resolveBuildRevision()): string {
  if (rev.short === null || rev.commit === null) {
    return (
      'alteroid 版: 不明（ビルドが版を焼き込んでおらず、' +
      'ALTEROID_BUILD_REV / RAILWAY_GIT_COMMIT_SHA も無い）'
    );
  }
  if (rev.source === null) return `alteroid ${rev.short}（フル ${rev.commit}）`;
  return `alteroid ${describeRevisionStatus(reportRunnerRevision(rev))}`;
}
