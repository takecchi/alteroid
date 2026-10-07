// 版番号を印に書かない: 版を上げるたびに全部の印を書き直すことになり、文言を確かめない機械的な書き直しで門が形骸化するため。
// 引用は1行に収める: `sdk.d.ts` は JSDoc 1つが1行なので、こちらで改行を入れると `grep -F` で当たらなくなるため。
// 不在の主張（「その欄が無い」）はこの門では書けない: 部分文字列一致は「この文言が在る」しか言えないため、不在は型の歯で守る。

import { lstatSync, readFileSync } from 'node:fs';

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

// 印を `@` で始めない: JSDoc の `@foo` はそこからがタグの本文になり、後ろの日本語の説明が description から外れるため。
export const MARKER = '[sdk-verbatim';

const MARKER_WITH_SYMBOL = /\[sdk-verbatim[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*\]/;

export const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.md'];

// この検査自身は走査から外す: 印の文字列を素で持ち、自分の説明文を引用として当てにいくため。
export const EXCLUDED_PREFIXES = ['scripts/check-sdk-quotes'];

function stripCommentLeader(line) {
  return line
    .replace(/^[ \t]*(?:\/\/+|\/\*+|\*+|#+|<!--)[ \t]?/, '')
    .replace(/[ \t]*(?:\*\/|-->)[ \t]*$/, '')
    .trim();
}

function stripQuoteDecoration(text) {
  let out = text.replace(/^>[ \t]?/, '').trim();
  if (out.startsWith('「') && out.endsWith('」')) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

// 空行を飛ばす幅（`LOOKAHEAD` 行）は狭く取る: 広いと引用を書き忘れた印が後ろにたまたま在った英文を拾って当たってしまうため。
const LOOKAHEAD = 3;

function nextQuoteLine(lines, markerIndex) {
  for (let j = markerIndex + 1; j < lines.length && j <= markerIndex + LOOKAHEAD; j += 1) {
    const text = stripQuoteDecoration(stripCommentLeader(lines[j]));
    if (text.length > 0) return text;
  }
  return '';
}

function bracketedSpan(line) {
  const start = line.indexOf('「');
  const end = line.lastIndexOf('」');
  if (start === -1 || end === -1 || end <= start + 1) return null;
  return line.slice(start + 1, end).trim();
}

// 欠陥の在る印も落とさずに返す: 黙って読み飛ばすと「印を書いたのに検査されない」が静かに起きるため。
export function collectMarkedQuotes(files) {
  const found = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (!raw.includes(MARKER)) continue;

      const at = { path: file.path, line: i + 1 };
      const symbolMatch = MARKER_WITH_SYMBOL.exec(raw);
      if (!symbolMatch) {
        found.push({ ...at, symbol: null, quote: null, defect: 'missing-symbol' });
        continue;
      }
      const symbol = symbolMatch[1];

      const sameLine = bracketedSpan(raw);
      const quote = sameLine !== null ? sameLine : nextQuoteLine(lines, i);

      if (quote.length === 0) {
        found.push({ ...at, symbol, quote: null, defect: 'empty-quote' });
        continue;
      }
      found.push({ ...at, symbol, quote, defect: null });
    }
  }
  return found;
}

// 全出現を見る: 1箇所だけで「隣が `|` だから古い」と決めると、同じ文字列が正しく閉じた別の宣言にも在る場合に誤って赤くするため。
function allIndicesOf(haystack, needle) {
  const indices = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

// 境界チェック（`isUnionTailDrift`）は引用が2値以上の pipe 列挙のときだけ掛ける: 値を1つだけ引く意図的な部分引用は「隣に `|` が続く」のが正しい姿で、一律に掛けると誤って赤くするため。
const UNION_ENUMERATION_PATTERN = /^(?:[\w$]+\??:\s*)?'[^']*'(?:\s*\|\s*'[^']*')+;?$/;

function isUnionTailDrift(sdkTypesText, index, quoteLength) {
  let before = index - 1;
  while (before >= 0 && /\s/.test(sdkTypesText[before])) before -= 1;
  const beforeChar = before >= 0 ? sdkTypesText[before] : null;

  let after = index + quoteLength;
  while (after < sdkTypesText.length && /\s/.test(sdkTypesText[after])) after += 1;
  const afterChar = after < sdkTypesText.length ? sdkTypesText[after] : null;

  return beforeChar === '|' || afterChar === '|';
}

// 正規化せず素の `String.includes` で当てる: 正規化すると「当たったことにする」余地が生まれ、`grep -Fn` で検算する作法と食い違うため。
export function findQuoteDefects(quotes, sdkTypesText) {
  const defects = [];
  for (const q of quotes) {
    if (q.defect === 'missing-symbol') {
      defects.push({
        ...q,
        reason: 'sdk-verbatim の印にシンボルが付いていない（例: [sdk-verbatim Options.env]）',
      });
      continue;
    }
    if (q.defect === 'empty-quote') {
      defects.push({
        ...q,
        reason: '印は在るが引用が取れない（同じ行の「…」か、次の行に1行で書く）',
      });
      continue;
    }
    const missingSegment = q.symbol.split('.').find((seg) => !sdkTypesText.includes(seg));
    if (missingSegment !== undefined) {
      defects.push({
        ...q,
        reason: `シンボル \`${q.symbol}\` の \`${missingSegment}\` が sdk.d.ts に無い（型が消えたか改名された）`,
      });
      continue;
    }
    const occurrences = allIndicesOf(sdkTypesText, q.quote);
    if (occurrences.length === 0) {
      defects.push({
        ...q,
        reason: '逐語が sdk.d.ts に当たらない（文言が変わったか、折り返しが混ざっている）',
      });
      continue;
    }
    if (!UNION_ENUMERATION_PATTERN.test(q.quote)) {
      continue;
    }
    const hasCleanOccurrence = occurrences.some(
      (at) => !isUnionTailDrift(sdkTypesText, at, q.quote.length),
    );
    if (!hasCleanOccurrence) {
      defects.push({
        ...q,
        reason:
          '逐語は sdk.d.ts の一部として当たるが、当たった箇所の隣が `|` に接続しており union の一部にしか当たっていない（末尾に値が足された、または先頭が削られた可能性がある。#793）',
      });
    }
  }
  return defects;
}

// symlink の判定は git のモードではなく `lstatSync` で取る: 追跡・未追跡の別なく一様に判定できるため。
export function listScannableFiles(repoRoot) {
  const listed = listGitScannableFiles({ cwd: repoRoot });

  const paths = listed.filter(
    (p) =>
      SCANNED_EXTENSIONS.some((ext) => p.endsWith(ext)) &&
      !EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );

  const files = [];
  for (const p of paths) {
    const fullPath = `${repoRoot}/${p}`;
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      // 作業ツリーに実体が無い追跡済みファイルは1件だけ飛ばす: 読めない1件のために検査全体を止めない。
      continue;
    }
    // symlink は読まない: `CLAUDE.md` → `AGENTS.md` を2度数えないため。
    if (stat.isSymbolicLink()) continue;
    let content;
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    files.push({ path: p, content });
  }
  return files;
}

// 見つからなければ投げる: 「引用が0件だった」と「検査が走らなかった」は別物で、後者を緑で通すと門が効かないまま生き延びるため。
// 依存（`createRequire` / `existsSync` / `readFileSync`）を引数で受ける。`import` に戻さない: vitest の自前のモジュール解決だと「見つからない」の分岐を測れないため。
// パスを文字列で組み立てない: pnpm の実体のパスに版番号とハッシュが入るため。
// `sdk.d.ts` と `sdk-tools.d.ts` の2枚を必須にする: 片方だけ読むと、もう片方から引いた引用が当たらないと誤判定されるため。
export function resolveSdkTypes(repoRoot, createRequire, existsSync, readFileSync) {
  const anchors = ['packages/core', 'apps/daemon', 'apps/runner'];
  const tried = [];
  for (const anchor of anchors) {
    let entry;
    try {
      const require = createRequire(`${repoRoot}/${anchor}/package.json`);
      entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    } catch (error) {
      tried.push(`${anchor}: 解決できない（${error.code ?? error.message}）`);
      continue;
    }
    const dir = entry.slice(0, entry.lastIndexOf('/'));
    const typesPaths = [`${dir}/sdk.d.ts`, `${dir}/sdk-tools.d.ts`];
    const missing = typesPaths.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      tried.push(`${anchor}: ${missing.join(' / ')} が無い`);
      continue;
    }
    let version = '不明';
    try {
      version = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version ?? '不明';
    } catch {
      // 版が読めなくても検査は成り立つ: 当てる先は型定義の本文だから。
    }
    return {
      typesPath: typesPaths.join(' + '),
      version,
      text: typesPaths.map((path) => readFileSync(path, 'utf8')).join('\n'),
    };
  }
  throw new Error(
    `check-sdk-quotes: 同梱の型定義（sdk.d.ts / sdk-tools.d.ts）が見つからない。先に \`pnpm install\` を走らせたか。試した先:\n  ${tried.join('\n  ')}`,
  );
}
