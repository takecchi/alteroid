// これは計器である: 取れなかったときに既定値・プレースホルダ・腐る値（前回のリリースの sha 等）を返さず、すべて `null` に倒す。
import { z } from 'zod';

import * as generatedCanon from './generated/canon.js';
import type { BuildTime } from './revision-format.js';
import { reportRunnerRevision, resolveBuildRevision } from './revision-resolve.js';

export {
  describeBuildAge,
  describeBuildRevision,
  describeRevisionStatus,
  revisionSourceLabel,
  type BuildRevision,
  type BuildTime,
  type RevisionSource,
  type RunnerRevisionReport,
} from './revision-format.js';

export { reportRunnerRevision, resolveBuildRevision };

// `CANON_BUILT_AT` を名前つき import にしない: 古いイメージの `generated/canon.ts` には
// この定数が無く、名前つき import はロード時エラーになりうる。名前空間 import なら `undefined` で済む。
const bakedBuiltAt: string = (generatedCanon as { CANON_BUILT_AT?: string }).CANON_BUILT_AT ?? '';

/**
 * `env` 引数を持たない: 使わない仮引数を「将来のため」に置くと、既定値つき引数は no-unused-vars で落ちる。
 * 空・壊れた値は `null` に倒す（「取れなかった」を「取れた」に見せない）。`baked` はテスト専用。
 */
export function resolveBuildTime(baked: string = bakedBuiltAt): BuildTime {
  const value = baked.trim();
  if (value.length === 0) return { builtAt: null };
  if (Number.isNaN(Date.parse(value))) return { builtAt: null };
  return { builtAt: value };
}

// 信用しない側から使う: runner の応答はネットワーク越しの入力なので、形が壊れていても落ちずに扱う。
export const buildRevisionSchema = z.object({
  commit: z.string().min(1).nullable(),
  short: z.string().min(1).nullable(),
  source: z.enum(['build', 'workspace', 'env', 'platform']).nullable(),
});
