// 使い捨ての測定用スクリプト。(iv-c) と (iv-d)（suffix 照合を widenSuffix で広げた版）の差分だけを出す。
import fs from 'node:fs';
import { extractClaims } from './extract-claims.mjs';
import { matchPath, isResolved } from './match-path.mjs';

const PRS_JSON = process.argv[2] || '/tmp/probe-1130-prs.json';
const DIFFS_NDJSON = process.argv[3] || '/tmp/probe-1130-diffs.ndjson';

const prs = JSON.parse(fs.readFileSync(PRS_JSON, 'utf8'));
const diffLines = fs.readFileSync(DIFFS_NDJSON, 'utf8').split('\n').filter(Boolean);
const diffMap = new Map();
for (const line of diffLines) {
  const obj = JSON.parse(line);
  diffMap.set(obj.pr, obj.files);
}
const usable = prs.filter((pr) => Array.isArray(diffMap.get(pr.number)));

const extractOpts = { requireVerb: true, stripQuotes: true, extraNegations: true, excludeNounForm: true };

function run(widenSuffix) {
  let claimCount = 0;
  const kindCounts = { exact: 0, suffix: 0, subpath: 0, ambiguous: 0, none: 0 };
  const mismatchPrs = new Set();
  let missing = 0;
  for (const pr of usable) {
    const files = diffMap.get(pr.number);
    const claims = extractClaims(pr.body || '', extractOpts);
    for (const c of claims) {
      claimCount++;
      const { kind } = matchPath(c.path, files, { widenSuffix });
      kindCounts[kind]++;
      if (!isResolved(kind)) {
        missing++;
        mismatchPrs.add(pr.number);
      }
    }
  }
  return { claimCount, missing, mismatchPrCount: mismatchPrs.size, kindCounts };
}

const ivc = run(false);
const ivd = run(true);

function pct(n, d) { return d ? (100 * n / d).toFixed(1) : '0.0'; }

console.log('=== (iv-c) vs (iv-d)（suffixをwidenした版）===');
console.log(`対象PR本数: ${usable.length}（両方とも同じ）`);
console.log(`主張の延べ数: (iv-c) ${ivc.claimCount} / (iv-d) ${ivd.claimCount}（抽出は変えていないので同数のはず）`);
console.log(`うち差分に無いもの: (iv-c) ${ivc.missing} (${pct(ivc.missing, ivc.claimCount)}%) / (iv-d) ${ivd.missing} (${pct(ivd.missing, ivd.claimCount)}%)`);
console.log(`1件以上ずれるPR本数/割合: (iv-c) ${ivc.mismatchPrCount}/${usable.length} (${pct(ivc.mismatchPrCount, usable.length)}%) / (iv-d) ${ivd.mismatchPrCount}/${usable.length} (${pct(ivd.mismatchPrCount, usable.length)}%)`);
console.log(`matchKind内訳: (iv-c) ${JSON.stringify(ivc.kindCounts)}`);
console.log(`matchKind内訳: (iv-d) ${JSON.stringify(ivd.kindCounts)}`);
console.log(`差分: missing ${ivc.missing}→${ivd.missing}（差${ivd.missing - ivc.missing}）, mismatchPR ${ivc.mismatchPrCount}→${ivd.mismatchPrCount}（差${ivd.mismatchPrCount - ivc.mismatchPrCount}）`);
