// `manager.ts` の言い換えの族は射程に含めない: 場面が違う（貸し出しの関門）ため。

import { findBannedPhraseHits, isExemptPath } from './banned-phrase-check-core.mjs';

export { listScannableSources } from './banned-phrase-check-core.mjs';

export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

export const BANNED_PHRASES = [
  {
    id: 'old',
    text: '先に manager_start で起こし直さないこと',
    why:
      '旧字面（#1287 で統一する前）。生成元 RESTART_BEFORE_CHECK_ADVICE / ' +
      'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN に揃えること',
  },
  {
    id: 'unified-plain',
    text: '確かめる前に manager_start で起こし直さないこと',
    why: '統一後の字面（バッククォート無し）。生成元定数 RESTART_BEFORE_CHECK_ADVICE を使わず直接書かれている',
  },
  {
    id: 'unified-code',
    text: '確かめる前に `manager_start` で起こし直さないこと',
    why:
      '統一後の字面（バッククォート有り）。生成元定数 RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN を' +
      '使わず直接書かれている',
  },
];

export const CHECKER_CORE_PATH = 'scripts/check-restart-before-check-advice-core.mjs';

export function isExempt(path) {
  return isExemptPath(path, { generatorPath: GENERATOR_PATH, checkerCorePath: CHECKER_CORE_PATH });
}

export function findRestartBeforeCheckAdviceHits(files) {
  return findBannedPhraseHits(files, BANNED_PHRASES, isExempt);
}
