#!/usr/bin/env node

import { runBannedPhraseCheck } from './banned-phrase-check-run.mjs';
import { findStaleTokenAdviceHits } from './check-stale-token-restart-advice-core.mjs';

runBannedPhraseCheck({
  name: 'check-stale-token-restart-advice',
  findHits: findStaleTokenAdviceHits,
  generatorNote:
    '字面の生成元は packages/core/src/usage-limits.ts の STALE_TOKEN_RESTART_ADVICE 1箇所である（Issue #1175）。',
});
