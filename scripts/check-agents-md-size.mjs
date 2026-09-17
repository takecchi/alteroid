#!/usr/bin/env node
/**
 * `AGENTS.md` のバイト数にラチェットを置く歯（Issue #1192）。
 *
 * ## なぜ要るか
 *
 * `AGENTS.md`「書く先を決める」が自分で言っているとおり、この文書は
 * 8.4 日で約 21 倍に育ち、その間の更新に間引いた形跡は1件も無かった。
 * `.claude/skills/` へ移す動線を作った後も、**畳んだ同日15分後の1コミットで
 * +638 バイト増えている**（`f2adf86` → `40dfab4`、2026-09-17 実測）。しかも
 * その増分は無駄な追記ではなく、直前の記述の誤りの訂正だった。⟹ 「短く書け」
 * も「移す先を作った」も、太る力そのものは止めていない。**注意書きを増やす
 * ことと、機械で確かめられる条件を歯へ移すことが別になり始めている**という
 * #1192 の指摘そのものを、この文書自身に対して実践する。
 *
 * ⭐ **バイト数は代理変数にすぎない。** 本当に測りたいのは「新しい作業の
 * たびに、この文書から重要な判断基準を取り出す負担」であって、バイト数は
 * その負担を直接測れないので置いた代理でしかない。閾値の根拠・この歯が
 * 言えないことは `check-agents-md-size-core.mjs` の doc が正本（ここには
 * 判定を read/print するだけの CLI を置く）。
 *
 * ## 判定ロジックの置き場所
 *
 * 予算の定義・履歴・判定は `check-agents-md-size-core.mjs` に切り出してある
 * （`check-web-bundle-size-core.mjs` と同じ分け方）。このファイルは
 * 「読んで、渡して、終了コードを決める」だけ。
 *
 * ## 出すもの（要件の中心）
 *
 * 緑のときも必ず1行出す（`AGENTS.md`「静かに失敗する道具」）。実測バイト・
 * 行数・予算・使用率・余白（`slackBytes`）・`cat` の窓の回数・記録の起点
 * からの増分（バイトと%）・記録の件数、そして**参考として**（判定には使わない）
 * `.claude/skills/**` の合計バイト数を出す。
 *
 * 赤のときは、実測・予算・超過分に加えて、上げ方の手順と、上げる前に
 * 問うべきこと（この文書に残すべき内容か、それとも `.claude/skills/` /
 * Issue へ置くべき内容か）を出す。
 */

import { Buffer } from 'node:buffer';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { BUDGET_HISTORY, judgeAgentsMdSize } from './check-agents-md-size-core.mjs';

const ROOT = join(import.meta.dirname, '..');
const AGENTS_MD_PATH = join(ROOT, 'AGENTS.md');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const ISSUE_URL = 'https://github.com/takecchi/alteroid/issues/1192';

// `console` に頼らない（他の check:* スクリプトと同じ理由 —
// この repo の script はどれも `process.std{out,err}.write` へ寄せてある）。
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
  // `wc -l` と同じ数え方（末尾に改行があれば数えない余計な空行を作らない）。
  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return { bytes, lines };
}

/**
 * `.claude/skills/**` の合計バイト数（参考値。判定には使わない）。
 *
 * `.claude/` は別の担当の領域なので、ディレクトリが無ければ `null` を返して
 * その行自体を出さない——存在しないことを赤にしない。
 */
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

  // **必ず1行出す**（AGENTS.md「静かに失敗する道具」— 出ていなければ走っていないと読める）。
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
