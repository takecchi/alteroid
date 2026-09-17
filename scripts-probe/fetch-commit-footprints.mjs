// 使い捨ての測定用スクリプト（3周目 (V=U\F) 用）。
// 各 PR について、PR を構成する各コミット（マージコミットは除く）が
// 触ったファイルの和集合 U を取り、ndjson へ逐次追記する（中断しても残る）。
//
// 手順:
//   1. gh api repos/<repo>/pulls/<N>/commits --paginate でコミット一覧（sha, parents数）を取る
//   2. parents.length > 1 のもの（マージコミット）は除く
//   3. 残った各 sha について gh api repos/<repo>/commits/<sha> --jq '.files[].filename' で
//      そのコミット単体の変更ファイル一覧を取り、和集合へ足す
//
// 出力: 1 PR につき1行の ndjson
//   { pr, commitShas: [...], mergeExcludedShas: [...], filesTruncated: [sha,...], U: [...] }
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PRS_JSON = process.argv[2] || '/tmp/probe-1130-prs.json';
const OUT_NDJSON = process.argv[3] || '/tmp/probe-1130-footprints.ndjson';
const PROGRESS = process.argv[4] || '/tmp/probe-1130-footprints-progress.log';

function log(msg) {
  fs.appendFileSync(PROGRESS, `${new Date().toISOString()} ${msg}\n`);
}

function ghApi(args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 30000 });
}

const prs = JSON.parse(fs.readFileSync(PRS_JSON, 'utf8'));
log(`start total=${prs.length}`);

const done = new Set();
if (fs.existsSync(OUT_NDJSON)) {
  const lines = fs.readFileSync(OUT_NDJSON, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      done.add(obj.pr);
    } catch {
      // 壊れた行は無視
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
    const commitsRaw = ghApi(['--paginate', `repos/takecchi/alteroid/pulls/${n}/commits`]);
    // --paginate は複数ページを連結して返すことがあるので、配列が複数連結された形も
    // 単純な JSON.parse では壊れうる。gh の --paginate は JSON 配列を連結して1つの
    // 巨大な配列相当のテキストとして返すはずだが、念のため個別ページ境界を考慮せず
    // まず素直に parse を試み、失敗したら "][" を "," "," へ置換して繋げる。
    let commits;
    try {
      commits = JSON.parse(commitsRaw);
    } catch {
      const fixed = '[' + commitsRaw.trim().replace(/\]\s*\[/g, ',') .replace(/^\[|\]$/g, '') + ']';
      commits = JSON.parse(fixed);
    }

    const commitShas = [];
    const mergeExcludedShas = [];
    for (const c of commits) {
      const parents = Array.isArray(c.parents) ? c.parents.length : null;
      if (parents !== null && parents > 1) {
        mergeExcludedShas.push(c.sha);
      } else {
        commitShas.push(c.sha);
      }
    }

    const U = new Set();
    const filesTruncated = [];
    for (const sha of commitShas) {
      const detail = ghApi([`repos/takecchi/alteroid/commits/${sha}`]);
      const obj = JSON.parse(detail);
      const files = Array.isArray(obj.files) ? obj.files.map((f) => f.filename) : [];
      for (const f of files) U.add(f);
      // GitHub のコミット詳細 API は極端に大きいコミットで files を切り詰めることがある
      if (obj.stats && typeof obj.files !== 'undefined' && obj.files.length === 0 && (obj.stats.total || 0) > 0) {
        filesTruncated.push(sha);
      }
    }

    const entry = {
      pr: n,
      commitShas,
      mergeExcludedShas,
      filesTruncated,
      U: Array.from(U),
    };
    fs.appendFileSync(OUT_NDJSON, JSON.stringify(entry) + '\n');
    ok++;
    log(`ok pr=${n} commits=${commitShas.length} merged_excluded=${mergeExcludedShas.length} U=${U.size} (ok=${ok} fail=${fail} remaining=${prs.length - ok - fail - done.size})`);
  } catch (e) {
    fail++;
    fs.appendFileSync(OUT_NDJSON, JSON.stringify({ pr: n, error: String(e.message || e).slice(0, 300) }) + '\n');
    log(`FAIL pr=${n} error=${String(e.message || e).slice(0, 200)}`);
  }
}

log(`done total=${prs.length} ok=${ok} fail=${fail} already=${done.size}`);
