// 使い捨ての測定用スクリプト（3周目 = 消えた足跡 V=U\F の測定）。
// U: PRの各コミット（マージコミット除く）が触ったファイルの和集合（fetch-commit-footprints.mjsの出力）
// F: gh pr diff --name-only（1周目のdiffs.ndjsonをそのまま使う）
// V = U \ F
//
// 「本文がバッククォート付きで名指ししているか」は、本文からの素朴な抽出（動詞に縛らない、
// 引用は落とさない）の候補パス群それぞれを p として、matchPath(p, [v], {widenSuffix:true}) が
// resolved になるかで判定する（basename/suffix/subpathの緩い一致を許す——厳密な文字列一致だけに
// 絞ると #1115 のように "AGENTS.md" が完全一致でも見落とす理由は無いはずだが、他のPRで
// "tools.ts" のような短い名指しがフルパスのVと一致しない事故を避けるため）。
//
// 「(iv-c) の主張になっているか」は、同じ本文に (iv-c) の抽出器（動詞に縛り、否定語拡充、
// 名詞除去、引用は落とす）を通した結果の候補パスが、同じ matchPath 判定で v に一致するかを見る。
import fs from 'node:fs';
import { extractClaims } from './extract-claims.mjs';
import { matchPath, isResolved } from './match-path.mjs';

const PRS_JSON = process.argv[2] || '/tmp/probe-1130-prs.json';
const DIFFS_NDJSON = process.argv[3] || '/tmp/probe-1130-diffs.ndjson';
const FOOTPRINTS_NDJSON = process.argv[4] || '/tmp/probe-1130-footprints.ndjson';

const prs = JSON.parse(fs.readFileSync(PRS_JSON, 'utf8'));
const prByNumber = new Map(prs.map((p) => [p.number, p]));

const diffLines = fs.readFileSync(DIFFS_NDJSON, 'utf8').split('\n').filter(Boolean);
const diffMap = new Map();
for (const line of diffLines) {
  const obj = JSON.parse(line);
  diffMap.set(obj.pr, obj.files);
}

const fpLines = fs.readFileSync(FOOTPRINTS_NDJSON, 'utf8').split('\n').filter(Boolean);
const fpMap = new Map();
let fpErrorCount = 0;
for (const line of fpLines) {
  const obj = JSON.parse(line);
  if (obj.error) {
    fpErrorCount++;
    continue;
  }
  fpMap.set(obj.pr, obj);
}

function truncateSentence(s) {
  const escaped = s.replace(/\n/g, '\\n');
  if (escaped.length <= 200) return escaped;
  return escaped.slice(0, 200) + '…(truncated)';
}

function namedInBody(v, bodyCandidates) {
  for (const c of bodyCandidates) {
    const { kind } = matchPath(c.path, [v], { widenSuffix: true });
    if (isResolved(kind)) return c;
  }
  return null;
}

let prsWithFootprint = 0;
let prsWithNonEmptyV = 0;
let totalVElements = 0;
let vNamedCount = 0;
const vNamedPrs = new Set();
let vNamedAndVerbCount = 0;
const vNamedAndVerbPrs = new Set();

const rows = [];

for (const pr of prs) {
  const fp = fpMap.get(pr.number);
  const F = diffMap.get(pr.number);
  if (!fp || !Array.isArray(F)) continue;
  prsWithFootprint++;

  const U = fp.U;
  const Fset = new Set(F);
  const V = U.filter((f) => !Fset.has(f));
  if (V.length === 0) continue;
  prsWithNonEmptyV++;
  totalVElements += V.length;

  const body = pr.body || '';
  const naiveCandidates = extractClaims(body, { requireVerb: false, stripQuotes: false });
  const ivcCandidates = extractClaims(body, {
    requireVerb: true,
    stripQuotes: true,
    extraNegations: true,
    excludeNounForm: true,
  });

  const perElement = [];
  let prHasNamed = false;
  let prHasNamedVerb = false;
  for (const v of V) {
    const namedMatch = namedInBody(v, naiveCandidates);
    if (namedMatch) {
      vNamedCount++;
      prHasNamed = true;
    }
    const verbMatch = namedInBody(v, ivcCandidates);
    if (verbMatch) {
      vNamedAndVerbCount++;
      prHasNamedVerb = true;
    }
    perElement.push({ v, namedMatch, verbMatch });
  }
  if (prHasNamed) vNamedPrs.add(pr.number);
  if (prHasNamedVerb) vNamedAndVerbPrs.add(pr.number);

  rows.push({ pr: pr.number, V, F, U, commitShas: fp.commitShas, mergeExcludedShas: fp.mergeExcludedShas, perElement });
}

function pct(n, d) { return d ? (100 * n / d).toFixed(1) : '0.0'; }

console.log('=== 対象診断 ===');
console.log(`PRs総数: ${prs.length}`);
console.log(`footprint取得成功: ${fpMap.size} / エラー: ${fpErrorCount}`);
console.log(`F(diff)とfootprint両方揃ったPR本数: ${prsWithFootprint}`);

console.log('\n=== 表: 消えた足跡 V=U\\F ===');
console.log(`Vが非空のPR本数/割合: ${prsWithNonEmptyV} / ${prsWithFootprint} (${pct(prsWithNonEmptyV, prsWithFootprint)}%)`);
console.log(`Vの延べ件数: ${totalVElements}`);
console.log(`Vの要素のうち本文がバッククォート付きで名指ししているもの件数/PR本数: ${vNamedCount} / ${vNamedPrs.size}`);
console.log(`さらに動詞に縛った(iv-c)の主張になっている件数/PR本数: ${vNamedAndVerbCount} / ${vNamedAndVerbPrs.size}`);

fs.writeFileSync('/tmp/probe-1130-footprint-rows.json', JSON.stringify(rows, null, 2));
console.log(`\n詳細行を /tmp/probe-1130-footprint-rows.json に書いた（${rows.length}行）`);
