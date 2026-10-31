#!/usr/bin/env node

import { runBannedPhraseCheck } from './banned-phrase-check-run.mjs';
import { findAdviceHits } from './check-advice-single-source-core.mjs';

runBannedPhraseCheck({
  name: 'check-advice-single-source',
  findHits: findAdviceHits,
  generatorNote:
    '字面の生成元は packages/core/src/usage-limits.ts の STALE_TOKEN_RESTART_ADVICE（#1175）/ ' +
    'RESTART_BEFORE_CHECK_ADVICE / RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN（#1287）である。',
});
