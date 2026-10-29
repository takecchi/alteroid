#!/usr/bin/env node

import { runBannedPhraseCheck } from './banned-phrase-check-run.mjs';
import { findRestartBeforeCheckAdviceHits } from './check-restart-before-check-advice-core.mjs';

runBannedPhraseCheck({
  name: 'check-restart-before-check-advice',
  findHits: findRestartBeforeCheckAdviceHits,
  generatorNote:
    '字面の生成元は packages/core/src/usage-limits.ts の RESTART_BEFORE_CHECK_ADVICE / ' +
    'RESTART_BEFORE_CHECK_ADVICE_CODE_SPAN 1箇所である（Issue #1287）。',
});
