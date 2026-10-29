#!/usr/bin/env node
// 日誌の書き出し（JSON / JSONL）を読んで、クローン 1 ターンの N・C・P を起点別に集計し、Markdown の表を標準出力へ出す。読むだけ。
// ネットワークへは出ない。本文は出さない。使い方は scripts/pnc-census-README.md。
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { analyze, parseJournalText, renderReport } from './pnc-census-core.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    '使い方: node scripts/pnc-census.mjs <journal.json|journal.jsonl> [<別の書き出し> ...]\n詳細は scripts/pnc-census-README.md\n',
  );
  process.exit(args.length === 0 ? 2 : 0);
}

const entries = [];
let badLines = 0;
let notEntries = 0;
for (const file of args) {
  const reading = parseJournalText(readFileSync(file, 'utf8'));
  entries.push(...reading.entries);
  badLines += reading.badLines;
  notEntries += reading.notEntries;
}

process.stdout.write(`${renderReport(analyze(entries, { badLines, notEntries }))}\n`);
