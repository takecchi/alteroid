// 使い捨ての測定用スクリプト（2周目 (iv)）。
// (iii) を基準に、次の3施策を単独・積み上げで当てて数字がどう動くかを測る:
//   (iv-a) = 照合だけ段階化（exact→suffix→subpath→none。ambiguousは当たりに含めない）
//   (iv-b) = (iv-a) + 否定語リストを拡げる（抽出側。動詞・窓は変えない）
//   (iv-c) = (iv-b) + 動詞の名詞用法を1つだけ除外（抽出側）
// 動詞リスト・窓の取り方はどの列でも1周目と同じ（extract-claims.mjs は変更していない、
// オプトインの追加パラメータのみ）。

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

// --- (iii) 基準: extractClaims(requireVerb, stripQuotes=true) + 照合は「完全一致のみ」 ---
function runIII() {
  let claimCount = 0, missing = 0;
  const mismatchPrs = new Set();
  const mismatches = [];
  for (const pr of usable) {
    const files = diffMap.get(pr.number);
    const claims = extractClaims(pr.body || '', { requireVerb: true, stripQuotes: true });
    for (const c of claims) {
      claimCount++;
      const inDiff = files.includes(c.path);
      if (!inDiff) {
        missing++;
        mismatchPrs.add(pr.number);
        mismatches.push({ pr: pr.number, ...c, matchKind: 'none(exact-only)' });
      }
    }
  }
  return { claimCount, missing, mismatchPrCount: mismatchPrs.size, mismatches };
}

// --- (iv-a/b/c) 共通の実行器: extractOpts で抽出、matchPath で照合段階化 ---
function runIV(extractOpts) {
  let claimCount = 0;
  let resolvedCount = 0;
  let ambiguousCount = 0;
  let noneCount = 0;
  const kindCounts = { exact: 0, suffix: 0, subpath: 0, ambiguous: 0, none: 0 };
  const mismatchPrs = new Set();
  const mismatches = [];
  for (const pr of usable) {
    const files = diffMap.get(pr.number);
    const claims = extractClaims(pr.body || '', extractOpts);
    for (const c of claims) {
      claimCount++;
      const { kind, matched } = matchPath(c.path, files);
      kindCounts[kind]++;
      if (isResolved(kind)) {
        resolvedCount++;
      } else {
        if (kind === 'ambiguous') ambiguousCount++;
        else noneCount++;
        mismatchPrs.add(pr.number);
        mismatches.push({ pr: pr.number, ...c, matchKind: kind, matchedCandidates: matched });
      }
    }
  }
  const missing = ambiguousCount + noneCount;
  return { claimCount, missing, mismatchPrCount: mismatchPrs.size, kindCounts, ambiguousCount, noneCount, mismatches };
}

const iii = runIII();
const ivA = runIV({ requireVerb: true, stripQuotes: true, extraNegations: false, excludeNounForm: false });
const ivB = runIV({ requireVerb: true, stripQuotes: true, extraNegations: true, excludeNounForm: false });
const ivC = runIV({ requireVerb: true, stripQuotes: true, extraNegations: true, excludeNounForm: true });

function pct(n, d) {
  return d ? (100 * n / d).toFixed(1) : '0.0';
}

console.log('=== 対象 ===');
console.log(`gh pr list で取得: ${prs.length} / diff取得成功(usable): ${usable.length}`);

console.log('\n=== 表: (iii) / (iv-a) / (iv-b) / (iv-c) ===');
console.log('| 指標 | (iii) 1周目再掲 | (iv-a) 照合のみ | (iv-b) 照合+否定語 | (iv-c) 照合+否定語+名詞除去 |');
console.log('| --- | --- | --- | --- | --- |');
console.log(`| 対象PR本数 | ${usable.length} | ${usable.length} | ${usable.length} | ${usable.length} |`);
console.log(`| 主張の延べ数 | ${iii.claimCount} | ${ivA.claimCount} | ${ivB.claimCount} | ${ivC.claimCount} |`);
console.log(`| うち差分に無いもの(missing) | ${iii.missing} (${pct(iii.missing, iii.claimCount)}%) | ${ivA.missing} (${pct(ivA.missing, ivA.claimCount)}%) | ${ivB.missing} (${pct(ivB.missing, ivB.claimCount)}%) | ${ivC.missing} (${pct(ivC.missing, ivC.claimCount)}%) |`);
console.log(`| 1件以上ずれるPR本数/割合 | ${iii.mismatchPrCount}/${usable.length} (${pct(iii.mismatchPrCount, usable.length)}%) | ${ivA.mismatchPrCount}/${usable.length} (${pct(ivA.mismatchPrCount, usable.length)}%) | ${ivB.mismatchPrCount}/${usable.length} (${pct(ivB.mismatchPrCount, usable.length)}%) | ${ivC.mismatchPrCount}/${usable.length} (${pct(ivC.mismatchPrCount, usable.length)}%) |`);

console.log('\n=== (iv-a)/(iv-b)/(iv-c) の matchKind 内訳 ===');
for (const [name, r] of [['iv-a', ivA], ['iv-b', ivB], ['iv-c', ivC]]) {
  console.log(`${name}: ${JSON.stringify(r.kindCounts)} (ambiguous=${r.ambiguousCount}, none=${r.noneCount})`);
}

console.log('\n=== 施策ごとの効き（claimCount の変化 = 抽出側の変化、missing の変化 = 照合/否定語/名詞除去の変化）===');
console.log(`(iii)→(iv-a): claimCount ${iii.claimCount}→${ivA.claimCount} (差${ivA.claimCount - iii.claimCount}, 照合は抽出に影響しないので差0のはず), missing ${iii.missing}→${ivA.missing} (差${ivA.missing - iii.missing}, ここが「照合段階化」の効き)`);
console.log(`(iv-a)→(iv-b): claimCount ${ivA.claimCount}→${ivB.claimCount} (差${ivB.claimCount - ivA.claimCount}, 否定語拡充で抽出から落ちた件数), missing ${ivA.missing}→${ivB.missing} (差${ivB.missing - ivA.missing})`);
console.log(`(iv-b)→(iv-c): claimCount ${ivB.claimCount}→${ivC.claimCount} (差${ivC.claimCount - ivB.claimCount}, 名詞用法除外で抽出から落ちた件数), missing ${ivB.missing}→${ivC.missing} (差${ivC.missing - ivB.missing})`);

fs.writeFileSync('/tmp/probe-1130-iv-results.json', JSON.stringify({ iii, ivA, ivB, ivC }, null, 2));
console.log('\n詳細を /tmp/probe-1130-iv-results.json に書いた');
