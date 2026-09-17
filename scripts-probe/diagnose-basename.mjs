// 使い捨て診断（自分の判定であって実測ではない、と明記して報告する専用）。
// (iii) でずれたと判定された211件のうち、パスがファイル名だけ（ディレクトリ無し）で、
// 差分の中にその basename と一致するフルパスが実在するものを数える。
// これは「本文が嘘をついた」ではなく「抽出器がフルパス一致でしか照合していないために
// basename参照を取りこぼした」形の疑いがあるものを機械的に切り分けるための診断であって、
// 判定そのものではない。
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

let total = 0;
let basenameOnlyNoSlash = 0;
let basenameMatchesSomeDiffFile = 0;
let dirRefNoExt = 0; // 末尾が '/' や拡張子なしのディレクトリらしき参照

for (const pr of prs) {
  const files = diffMap.get(pr.number);
  if (!Array.isArray(files)) continue;
  const claims = extractClaims(pr.body || '', { requireVerb: true, stripQuotes: true });
  const mism = claims.filter((c) => !files.includes(c.path));
  for (const c of mism) {
    total++;
    if (!c.path.includes('/')) {
      basenameOnlyNoSlash++;
      const hit = files.some((f) => f.split('/').pop() === c.path);
      if (hit) basenameMatchesSomeDiffFile++;
    } else if (c.path.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(c.path)) {
      dirRefNoExt++;
    }
  }
}

const fullPathWithExtNotFound = total - basenameOnlyNoSlash - dirRefNoExt;

console.log(JSON.stringify({
  total,
  basenameOnlyNoSlash,
  basenameMatchesSomeDiffFile,
  basenameOnlyAndNoMatchAnywhere: basenameOnlyNoSlash - basenameMatchesSomeDiffFile,
  dirRefNoExt,
  fullPathWithExtNotFound,
}, null, 2));

// 残り（フルパス・拡張子ありなのに差分に無い）の中身も一応出す
let printed = 0;
for (const pr of prs) {
  const files = diffMap.get(pr.number);
  if (!Array.isArray(files)) continue;
  const claims = extractClaims(pr.body || '', { requireVerb: true, stripQuotes: true });
  const mism = claims.filter((c) => !files.includes(c.path));
  for (const c of mism) {
    const isBasenameOnly = !c.path.includes('/');
    const isDirRef = !isBasenameOnly && (c.path.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(c.path));
    if (!isBasenameOnly && !isDirRef) {
      printed++;
      console.log(`PR #${pr.number}  path=${c.path}  verb=${c.verb}`);
    }
  }
}
console.log(`printed=${printed}`);
