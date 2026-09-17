// 使い捨てダンプ。V=U\F が非空だった PR 全部を、依頼どおりの生の形で出す。要約しない。
import fs from 'node:fs';
import { extractClaims } from './extract-claims.mjs';
import { matchPath, isResolved } from './match-path.mjs';

const PRS_JSON = process.argv[2] || '/tmp/probe-1130-prs.json';
const DIFFS_NDJSON = process.argv[3] || '/tmp/probe-1130-diffs.ndjson';
const FOOTPRINTS_NDJSON = process.argv[4] || '/tmp/probe-1130-footprints.ndjson';

const prs = JSON.parse(fs.readFileSync(PRS_JSON, 'utf8'));
const diffLines = fs.readFileSync(DIFFS_NDJSON, 'utf8').split('\n').filter(Boolean);
const diffMap = new Map();
for (const line of diffLines) {
  const obj = JSON.parse(line);
  diffMap.set(obj.pr, obj.files);
}
const fpLines = fs.readFileSync(FOOTPRINTS_NDJSON, 'utf8').split('\n').filter(Boolean);
const fpMap = new Map();
for (const line of fpLines) {
  const obj = JSON.parse(line);
  if (!obj.error) fpMap.set(obj.pr, obj);
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

function formatList(files) {
  if (files.length <= 30) return files.map((f) => '    ' + f).join('\n');
  return files.slice(0, 30).map((f) => '    ' + f).join('\n') + `\n    他${files.length - 30}行`;
}

const lines = [];
let prCount = 0;
let vTotal = 0;

for (const pr of prs) {
  const fp = fpMap.get(pr.number);
  const F = diffMap.get(pr.number);
  if (!fp || !Array.isArray(F)) continue;
  const Fset = new Set(F);
  const V = fp.U.filter((f) => !Fset.has(f));
  if (V.length === 0) continue;
  prCount++;
  vTotal += V.length;

  const body = pr.body || '';
  const naiveCandidates = extractClaims(body, { requireVerb: false, stripQuotes: false });
  const ivcCandidates = extractClaims(body, {
    requireVerb: true,
    stripQuotes: true,
    extraNegations: true,
    excludeNounForm: true,
  });

  lines.push(`\n==================== PR #${pr.number} ====================`);
  lines.push(`U\\F（消えた足跡、${V.length}件）:\n${formatList(V)}`);
  for (const v of V) {
    const namedMatch = namedInBody(v, naiveCandidates);
    const verbMatch = namedInBody(v, ivcCandidates);
    lines.push(`  --- v=${v} ---`);
    if (namedMatch) {
      lines.push(`  本文が名指ししているか: path=${namedMatch.path}`);
      lines.push(`    文: ${truncateSentence(namedMatch.sentence)}`);
    } else {
      lines.push(`  本文が名指ししているか: 名指し無し`);
    }
    if (verbMatch) {
      lines.push(`  (iv-c)の主張になっているか: yes verb=${verbMatch.verb}`);
    } else {
      lines.push(`  (iv-c)の主張になっているか: no`);
    }
  }
}

lines.unshift(`# Vが非空だったPR全件（生データ）\n# PR本数=${prCount}  Vの延べ件数=${vTotal}`);

const out = lines.join('\n');
fs.writeFileSync('/tmp/probe-1130-footprints-dump.txt', out);
console.log(`written ${out.length} chars, ${out.split('\n').length} lines to /tmp/probe-1130-footprints-dump.txt`);
console.log(`prCount=${prCount} vTotal=${vTotal}`);
