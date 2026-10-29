// 1 つ目の字面に `manager_stop → ` を含める: `lost` の委譲向けの「確かめてから起こし直せ」（別の助言）を誤って捕まえないため。

import { findBannedPhraseHits, isExemptPath } from './banned-phrase-check-core.mjs';

export { listScannableSources } from './banned-phrase-check-core.mjs';

export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

export const BANNED_PHRASES = [
  {
    id: 'advice',
    text: 'manager_stop → manager_start で起こし直すこと',
    why: '助言の行動そのもの。生成元 STALE_TOKEN_RESTART_ADVICE を参照すること',
  },
  {
    id: 'understatement',
    text: '会話は失われる',
    why: '#914 が「失われるものを過小に言っている」と名指しした言い方。進行中の作業も失われる',
  },
];

export const CHECKER_CORE_PATH = 'scripts/check-stale-token-restart-advice-core.mjs';

export function isExempt(path) {
  return isExemptPath(path, { generatorPath: GENERATOR_PATH, checkerCorePath: CHECKER_CORE_PATH });
}

export function findStaleTokenAdviceHits(files) {
  return findBannedPhraseHits(files, BANNED_PHRASES, isExempt);
}
