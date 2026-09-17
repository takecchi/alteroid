// 使い捨ての測定用スクリプト。直近のマージ済み PR のファイル一覧を gh から取り、
// ndjson へ逐次追記する（途中で落ちても残る形）。
// AGENTS.md の指示に従い、gh は子プロセスとして起動し、進捗はファイルへ書く。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PRS_JSON = process.argv[2] || '/tmp/probe-1130-prs.json';
const OUT_NDJSON = process.argv[3] || '/tmp/probe-1130-diffs.ndjson';
const PROGRESS = process.argv[4] || '/tmp/probe-1130-progress.log';

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(PROGRESS, line);
}

const prs = JSON.parse(fs.readFileSync(PRS_JSON, 'utf8'));
log(`start total=${prs.length}`);

// 既に取得済みの PR 番号を読み、レジューム可能にする。
const done = new Set();
if (fs.existsSync(OUT_NDJSON)) {
  const lines = fs.readFileSync(OUT_NDJSON, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      done.add(obj.pr);
    } catch {
      // 壊れた行は無視（前回の中断で途中まで書かれた可能性）
    }
  }
  log(`resume: already have ${done.size} entries`);
}

let ok = 0;
let fail = 0;
for (const pr of prs) {
  const n = pr.number;
  if (done.has(n)) continue;
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'diff', String(n), '--repo', 'takecchi/alteroid', '--name-only'],
      { encoding: 'utf8', timeout: 30000 }
    );
    const files = out.split('\n').filter(Boolean);
    fs.appendFileSync(OUT_NDJSON, JSON.stringify({ pr: n, files }) + '\n');
    ok++;
    log(`ok pr=${n} files=${files.length} (ok=${ok} fail=${fail} remaining=${prs.length - ok - fail - done.size})`);
  } catch (e) {
    fail++;
    fs.appendFileSync(OUT_NDJSON, JSON.stringify({ pr: n, files: null, error: String(e.message || e) }) + '\n');
    log(`FAIL pr=${n} error=${String(e.message || e).slice(0, 200)}`);
  }
}
log(`done total=${prs.length} ok=${ok} fail=${fail} already=${done.size}`);
