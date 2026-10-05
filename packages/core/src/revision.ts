/**
 * 実行時に「いまの版」を解決する唯一の場所。
 *
 * **なぜ要るのか。** デーモン（app）と runner は別の Service で別々にビルド・
 * デプロイされる（`railway/daemon.json` / `railway/runner.json`）。同じ `main`
 * から起こしていても、デプロイのタイミングがずれれば**別のコミットで走る窓**が
 * できる。その窓でだけ壊れるものは、両者が自分の版を名乗れて初めて見つかる。
 *
 * **これは計器である。「取れなかった」を「取れた」に見せてはいけない。** 埋まら
 * なかったときに既定値・プレースホルダ・腐る値（前回のリリースの sha 等）を
 * 絶対に返さない。全部 `null` に倒し、表示は `describeBuildRevision` が
 * 「不明」に倒す。
 *
 * **型と言い方は隣の `revision-format.ts` に在る**（`@alteroid/core/revision` として
 * ブラウザへ出す軽い口。ここは焼き込みと zod を読むので画面からは読ませられない）。
 * 既存の呼び出し側のために、このファイルからもそのまま再 export する。
 */

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

/**
 * `CANON_BUILT_AT` を**名前つき import にしない**（#1226）。
 *
 * `write-canon.mjs` の `builtAt()` の doc が言うとおり、この変更より前に焼かれた
 * イメージの `generated/canon.ts` にはこの定数そのものが無い。名前つき import
 * （`import { CANON_BUILT_AT } from ...`）は、無い名前を静的に要求する形なので、
 * モジュール解決によってはロード時エラーになりうる。名前空間 import
 * （`import * as generatedCanon`）なら、無くても単に `undefined` になるだけで
 * 読み込み自体は落ちない——「無い＝不明」に倒す先が、ここで確保される。
 */
const bakedBuiltAt: string = (generatedCanon as { CANON_BUILT_AT?: string }).CANON_BUILT_AT ?? '';

/**
 * このイメージが**焼かれた時刻**を解決する（#1226）。
 *
 * **`resolveBuildRevision` と違い、出所は1つしか無い**（焼き込みのみ——実行時の
 * 環境変数で上書きできる経路はいまのところ無い）。**⚠️ だから `env` 引数は
 * 持たない**——設計の下書きは `resolveBuildRevision` と同じ `(env, baked)` の
 * 並びを例示していたが、`env` を読まない実装で仮引数だけ置くと、この repo の
 * lint（`@typescript-eslint/no-unused-vars`）がデフォルト値つき引数を未使用と
 * して落とす（実測: 早期 return の有無に関わらず、デフォルト値を持つ引数は
 * 位置に関係なく使用を要求される——`after-used` の除外は無引数値の場合にしか
 * 効かない）。使われない仮引数を"将来のため"に残す形は、AGENTS.md
 * 「取れない軸に0の行を作る」と同じ族（無い実体をそれらしい形で埋める）なので
 * 採らない。将来、実行時の上書き経路（例: `ALTEROID_BUILD_AT`）を足すときに
 * この第1引数を追加すること。
 *
 * **空・壊れた値（`Date.parse` が `NaN`）は `null` に倒す。** 「取れなかった」を
 * 「取れた」に見せない、というこのファイル冒頭の約束と同じ——古い焼き込み
 * （`CANON_BUILT_AT` が無い）・空文字・壊れた文字列のどれであっても同じ `null`
 * へ倒れる。読む側（`describeBuildAge`）はこの3つを区別する必要が無い。
 *
 * `baked`（引数）の効力の範囲は `REAL_BAKED_REVISION` の doc と同じ
 * ——テスト専用で、**本番の経路はどこからも渡さない。**
 */
export function resolveBuildTime(baked: string = bakedBuiltAt): BuildTime {
  const value = baked.trim();
  if (value.length === 0) return { builtAt: null };
  if (Number.isNaN(Date.parse(value))) return { builtAt: null };
  return { builtAt: value };
}

/**
 * `BuildRevision` の wire 形（`GET /health` が返す JSON の中身）。
 *
 * **信用しない側から使う。** runner が返した JSON はネットワーク越しの入力であり、
 * 形が壊れていても（版違いの runner・改造された応答）落ちずに扱えること。
 * `.safeParse` に通す側（`apps/daemon/src/runner-client.ts`）が使う。
 */
export const buildRevisionSchema = z.object({
  commit: z.string().min(1).nullable(),
  short: z.string().min(1).nullable(),
  source: z.enum(['build', 'workspace', 'env', 'platform']).nullable(),
});
