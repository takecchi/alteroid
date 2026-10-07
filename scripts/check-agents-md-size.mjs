#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { BUDGET_HISTORY, judgeAgentsMdSize } from './check-agents-md-size-core.mjs';

const ROOT = join(import.meta.dirname, '..');
const AGENTS_MD_PATH = join(ROOT, 'AGENTS.md');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const ISSUE_URL = 'https://github.com/takecchi/alteroid/issues/1192';

function log(text) {
  process.stdout.write(text + '\n');
}

function logError(text) {
  process.stderr.write(text + '\n');
}

function formatBytes(n) {
  return n.toLocaleString('en-US') + ' B';
}

function formatPercent(n) {
  return (Math.round(n * 10) / 10).toString() + '%';
}

function countBytesAndLines(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return { bytes, lines };
}

function sumSkillsBytesOrNull(dir) {
  let total = 0;
  let found = false;
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    found = true;
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        total += statSync(full).size;
      }
    }
  }
  walk(dir);
  return found ? total : null;
}

function main() {
  let text;
  try {
    text = readFileSync(AGENTS_MD_PATH, 'utf8');
  } catch (error) {
    logError(`check-agents-md-size: ${AGENTS_MD_PATH} を読めない: ${error}`);
    process.exitCode = 1;
    return;
  }

  const { bytes, lines } = countBytesAndLines(text);
  const result = judgeAgentsMdSize({ bytes, lines });
  const first = BUDGET_HISTORY[0];
  const growthBytes = result.bytes - first.bytes;
  const growthPercent = (growthBytes / first.bytes) * 100;

  const skillsBytes = sumSkillsBytesOrNull(SKILLS_DIR);

  if (!result.ok) {
    logError(`check-agents-md-size: NG — AGENTS.md がバイト数の予算を超えた`);
    logError('');
    logError(
      `実測 ${formatBytes(result.bytes)}（${result.lines}行）/ 予算 ${formatBytes(result.budget)}` +
        ` / 超過 ${formatBytes(result.overBytes)}（${formatPercent(result.overPercent)}）`,
    );
    logError('');
    logError('上げ方: scripts/check-agents-md-size-core.mjs の BUDGET_HISTORY に');
    logError('  { date, bytes, lines, why, ref } を1件足し、why に増やした理由を書くこと。');
    logError('  （理由を書かずに数字だけを上げる経路は無い——予算は履歴の最新の件から導出する）');
    logError('');
    logError('上げる前に問うこと: 足そうとしている文は');
    logError('  (a) 常時必要な判断基準か');
    logError('  (b) 部分系の手順か');
    logError('  (c) 過去の実測記録か。');
    logError(`  (b)(c) なら置き場所は .claude/skills/ か Issue であって、この文書ではない。`);
    logError(`  ${ISSUE_URL}`);

    process.exitCode = 1;
    return;
  }

  const linesOut = [
    `check-agents-md-size: OK — ${formatBytes(result.bytes)}（${result.lines}行）/ ` +
      `予算 ${formatBytes(result.budget)}（使用率 ${formatPercent(result.usedPercent)}）/ ` +
      `余白 ${formatBytes(result.slackBytes)}`,
    `  cat の窓（${formatBytes(30_000)}）: ${result.catWindows}回`,
    `  記録の起点（${first.date}）からの増分: ${growthBytes >= 0 ? '+' : ''}${formatBytes(growthBytes)}` +
      `（${growthPercent >= 0 ? '+' : ''}${formatPercent(growthPercent)}）/ 記録件数 ${BUDGET_HISTORY.length}`,
  ];
  if (skillsBytes !== null) {
    linesOut.push(
      `  参考（判定には使わない）: .claude/skills/** の合計 ${formatBytes(skillsBytes)}`,
    );
  }
  log(linesOut.join('\n'));
}

main();
