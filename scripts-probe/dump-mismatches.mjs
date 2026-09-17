// 使い捨て。段4の生データダンプを作る（(iii) 動詞に縛る・引用を落とす、でずれた全件）。
// 要約しない。PRごとにグルーピングして diff の重複表示だけを1回に減らす（内容は削らない）。
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

function truncateSentence(s) {
  const escaped = s.replace(/\n/g, '\\n');
  if (escaped.length <= 200) return escaped;
  return escaped.slice(0, 200) + '…(truncated)';
}

function formatDiff(files) {
  if (files.length <= 20) return files.map((f) => '    ' + f).join('\n');
  const head = files.slice(0, 20).map((f) => '    ' + f).join('\n');
  return head + `\n    他${files.length - 20}行`;
}

const lines = [];
let totalMismatches = 0;
let prsWithMismatch = 0;

for (const pr of prs) {
  const files = diffMap.get(pr.number);
  if (!Array.isArray(files)) continue;
  const claims = extractClaims(pr.body || '', { requireVerb: true, stripQuotes: true });
  const mism = claims.filter((c) => !files.includes(c.path));
  if (mism.length === 0) continue;
  prsWithMismatch++;
  lines.push(`\n==================== PR #${pr.number} ====================`);
  lines.push(`差分:\n${formatDiff(files)}`);
  for (const c of mism) {
    totalMismatches++;
    lines.push(`  path=${c.path}  verb=${c.verb}`);
    lines.push(`    文: ${truncateSentence(c.sentence)}`);
  }
}

lines.unshift(`# (iii) 動詞に縛る・引用を落とす、でずれた全件\n# PR本数(ずれ在り)=${prsWithMismatch}  延べ件数=${totalMismatches}`);

const out = lines.join('\n');
fs.writeFileSync('/tmp/probe-1130-mismatches-iii.txt', out);
console.log(`written ${out.length} bytes, ${out.split('\n').length} lines to /tmp/probe-1130-mismatches-iii.txt`);
console.log(`prsWithMismatch=${prsWithMismatch} totalMismatches=${totalMismatches}`);
