#!/usr/bin/env node

import { join } from 'node:path';
import process from 'node:process';

import { logError } from './cli-log.mjs';
import {
  findMissingTypecheckPrereqs,
  formatMissingMessage,
} from './check-typecheck-prereqs-core.mjs';

// 引数で root を差し替えられるのは試験のため。
const root = process.argv[2] ?? join(import.meta.dirname, '..');

const missing = findMissingTypecheckPrereqs(root);
if (missing.length > 0) {
  logError(formatMissingMessage(missing));
  process.exitCode = 1;
}
