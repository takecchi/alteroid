// 助言の字面を生成元の外で書き写すことを禁じる検査（#1175 世代ずれの助言 / #1287 逆向きの助言を1本にまとめた。#6015）。
// 禁じる字面は下の表で持つ。生成元はどちらも `packages/core/src/usage-limits.ts`。
// 'advice' の字面に `manager_stop → ` を含める: `lost` の委譲向けの「確かめてから起こし直せ」（別の助言）を誤って捕まえないため。
// `manager.ts` の言い換えの族は射程に含めない: 場面が違う（貸し出しの関門）ため。

import { findBannedPhraseHits, isExemptPath } from './banned-phrase-check-core.mjs';

export { listScannableSources } from './banned-phrase-check-core.mjs';

export const GENERATOR_PATH = 'packages/core/src/usage-limits.ts';

export const BANNED_PHRASES = [
  {
    id: 'advice',
    text: 'manager_stop → manager_start で起こし直すこと',
    why: '助言の行動そのもの。生成元 STALE_TOKEN_RESTART_ADVICE を参照すること（#1175）',
  },
  {
    id: 'understatement',
    text: '会話は失われる',
    why: '#914 が「失われるものを過小に言っている」と名指しした言い方。進行中の作業も失われる',
  },
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

export const CHECKER_CORE_PATH = 'scripts/check-advice-single-source-core.mjs';

export function isExempt(path) {
  return isExemptPath(path, { generatorPath: GENERATOR_PATH, checkerCorePath: CHECKER_CORE_PATH });
}

export function findAdviceHits(files) {
  return findBannedPhraseHits(files, BANNED_PHRASES, isExempt);
}
