// 使い捨ての測定用スクリプト。extract-claims.mjs を3種類の設定で当て、
// 段3の表と段4のずれ一覧を生成する。
import fs from 'node:fs';
import { extractClaims } from './extract-claims.mjs';

const PRS_JSON = process.argv[2] || '/tmp/probe-1130-prs.json';
const DIFFS_NDJSON = process.argv[3] || '/tmp/probe-1130-diffs.ndjson';

const prs = JSON.parse(fs.readFileSync(PRS_JSON, 'utf8'));
const diffLines = fs.readFileSync(DIFFS_NDJSON, 'utf8').split('\n').filter(Boolean);
const diffMap = new Map();
for (const line of diffLines) {
  const obj = JSON.parse(line);
  diffMap.set(obj.pr, obj.files);
}

// diff が取れなかった PR は対象から除く（error が付いているもの）
const usable = prs.filter((pr) => {
  const files = diffMap.get(pr.number);
  return Array.isArray(files);
});

function runExtractor(name, opts, subset) {
  let claimCount = 0;
  let missingCount = 0;
  const prsWithMismatch = new Set();
  const mismatches = [];
  for (const pr of subset) {
    const files = diffMap.get(pr.number);
    const claims = extractClaims(pr.body || '', opts);
    for (const c of claims) {
      claimCount++;
      const inDiff = files.includes(c.path);
      if (!inDiff) {
        missingCount++;
        prsWithMismatch.add(pr.number);
        mismatches.push({ pr: pr.number, ...c, files });
      }
    }
  }
  return {
    name,
    prCount: subset.length,
    claimCount,
    missingCount,
    mismatchPrCount: prsWithMismatch.size,
    mismatchPrRatio: subset.length ? (prsWithMismatch.size / subset.length) : 0,
    mismatches,
  };
}

const naiveOpts = { requireVerb: false, stripQuotes: false };
const verbKeepQuotesOpts = { requireVerb: true, stripQuotes: false };
const verbStripQuotesOpts = { requireVerb: true, stripQuotes: true };

const results150 = {
  naive: runExtractor('(i) 素朴（150本）', naiveOpts, usable),
  verbKeep: runExtractor('(ii) 動詞に縛る・引用を残す（150本）', verbKeepQuotesOpts, usable),
  verbStrip: runExtractor('(iii) 動詞に縛る・引用を落とす（150本）', verbStripQuotesOpts, usable),
};

// 直近30本（mergedAt 降順で gh pr list が返した順そのまま先頭30件 = 直近30本）
const usable30 = usable.slice(0, 30);
const naive30 = runExtractor('(i) 素朴（直近30本）', naiveOpts, usable30);

function printTable(r) {
  console.log(`\n### ${r.name}`);
  console.log(`対象PR本数: ${r.prCount}`);
  console.log(`主張の延べ数: ${r.claimCount}`);
  console.log(`うち差分に無いもの: ${r.missingCount} (${r.claimCount ? (100 * r.missingCount / r.claimCount).toFixed(1) : '0.0'}%)`);
  console.log(`1件以上ずれるPRの本数/割合: ${r.mismatchPrCount} / ${r.prCount} (${(100 * r.mismatchPrRatio).toFixed(1)}%)`);
}

console.log('=== 対象PR診断 ===');
console.log(`gh pr list で取得: ${prs.length}`);
console.log(`diff 取得成功（usable）: ${usable.length}`);
console.log(`diff 取得失敗: ${prs.length - usable.length}`);
const failed = prs.filter((pr) => !Array.isArray(diffMap.get(pr.number)));
if (failed.length) {
  console.log('失敗したPR番号:', failed.map((p) => p.number).join(', '));
}

printTable(results150.naive);
printTable(results150.verbKeep);
printTable(results150.verbStrip);
console.log('\n--- 対照: 直近30本の素朴案 ---');
printTable(naive30);

fs.writeFileSync('/tmp/probe-1130-results.json', JSON.stringify(results150, null, 2));
fs.writeFileSync('/tmp/probe-1130-naive30.json', JSON.stringify(naive30, null, 2));
console.log('\n(iii)のずれ一覧とnaive30の詳細は /tmp/probe-1130-results.json /tmp/probe-1130-naive30.json に書いた');
