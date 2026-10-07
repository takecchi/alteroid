// コメント・文字列・テンプレートリテラル・正規表現リテラルを潰してから走査する: この字面を説明するコメントやテスト名への誤爆を避けるため。
// ALLOWLIST に載っているのに当たりが無いパスは `stale` として失敗にする: 古い許可が残ると、後から別の理由で丸渡しが増えても素通りするため。

import { listGitScannableFiles } from './git-scannable-files-core.mjs';

// 置換後も文字数と改行位置を変えない: 返す行番号を元のファイルの行番号と対応させるため。
export function maskCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  const isRegexContext = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const c = out[j];
    if ('([{,;:=&|!?+-*%^~<>'.includes(c)) return true;
    const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(out.slice(0, j + 1));
    if (
      word &&
      [
        'return',
        'typeof',
        'instanceof',
        'in',
        'of',
        'new',
        'delete',
        'void',
        'throw',
        'case',
        'do',
        'else',
        'yield',
        'await',
      ].includes(word[0])
    ) {
      return true;
    }
    return false;
  };

  const blank = (text) => text.replace(/[^\n]/g, ' ');

  function consumeLineComment() {
    let j = i;
    while (j < n && source[j] !== '\n') j++;
    out += blank(source.slice(i, j));
    i = j;
  }

  function consumeBlockComment() {
    let j = i + 2;
    while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++;
    j = Math.min(j + 2, n);
    out += blank(source.slice(i, j));
    i = j;
  }

  function consumeQuotedString(quote) {
    let j = i + 1;
    while (j < n && source[j] !== quote) {
      if (source[j] === '\\') j += 2;
      else j++;
    }
    j = Math.min(j + 1, n);
    out += blank(source.slice(i, j));
    i = j;
  }

  function consumeRegexLiteral() {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      if (source[j] === '\\') {
        j += 2;
        continue;
      }
      if (source[j] === '[') {
        inClass = true;
      } else if (source[j] === ']') {
        inClass = false;
      } else if (source[j] === '/' && !inClass) {
        j++;
        break;
      } else if (source[j] === '\n') {
        break;
      }
      j++;
    }
    out += blank(source.slice(i, j));
    i = j;
  }

  function dispatchOne() {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      consumeLineComment();
      return true;
    }
    if (c === '/' && c2 === '*') {
      consumeBlockComment();
      return true;
    }
    if (c === "'" || c === '"') {
      consumeQuotedString(c);
      return true;
    }
    if (c === '`') {
      consumeTemplateLiteral();
      return true;
    }
    if (c === '/' && isRegexContext()) {
      consumeRegexLiteral();
      return true;
    }
    return false;
  }

  function consumeTemplateExprBody() {
    let depth = 0;
    while (i < n) {
      if (dispatchOne()) continue;
      const c = source[i];
      if (c === '{') {
        depth++;
        out += c;
        i++;
        continue;
      }
      if (c === '}') {
        if (depth === 0) {
          out += '}';
          i++;
          return;
        }
        depth--;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
    }
  }

  function consumeTemplateLiteral() {
    out += ' ';
    i++;
    while (i < n) {
      if (source[i] === '\\') {
        out += blank(source.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (source[i] === '`') {
        out += ' ';
        i++;
        return;
      }
      if (source[i] === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        consumeTemplateExprBody();
        continue;
      }
      out += source[i] === '\n' ? '\n' : ' ';
      i++;
    }
  }

  while (i < n) {
    if (dispatchOne()) continue;
    out += source[i];
    i++;
  }
  return out;
}

export const PATTERNS = [
  {
    id: 'spread-process-env',
    re: /\.\.\.\s*(?:\(\s*)*process\.env\b/g,
    describe: '`...process.env`（スプレッドで丸ごと展開。丸括弧で包んだ形も含む）',
  },
  {
    id: 'env-direct-process-env',
    re: /\benv\s*:\s*(?:\(\s*)*process\.env(?![\w.])/g,
    describe:
      '`env: process.env`（丸ごとそのまま渡す。`(process.env)` / ' +
      '`(process.env as NodeJS.ProcessEnv)` のように丸括弧・型アサーションで' +
      '包んだ形も含む。Issue #2042）',
  },
];

// `[^)]*` で `Object.assign(` の引数を切らない: `getBase()` のような内側の `)` で終端して見逃すため。
function findObjectAssignEnvHits(masked) {
  const hits = [];
  const callRe = /\bObject\.assign\s*\(/g;
  let m;
  while ((m = callRe.exec(masked))) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdxAfter = findMatchingParenEnd(masked, openIdx);
    const argsText = masked.slice(openIdx + 1, closeIdxAfter - 1);
    if (/\bprocess\.env(?![\w.])/.test(argsText)) {
      hits.push({ index: m.index });
    }
    callRe.lastIndex = openIdx + 1; // 呼び出し本体の中を再走査しない: 入れ子の Object.assign は別途拾われるため
  }
  return hits;
}

// マスク前の生のテキストを走査し、マスク後の同じ範囲に `process.env` が残るか確かめる: マスクが `'env'` の字面を空白へ潰すため。
function findQuotedEnvKeyHits(rawContent, masked) {
  const hits = [];
  const re = /(\[\s*)?(['"`])env\2(?:\s*\])?\s*:\s*(?:\(\s*)*process\.env(?![\w.])/g;
  let m;
  while ((m = re.exec(rawContent))) {
    const start = m.index;
    const end = start + m[0].length;
    if (masked.slice(start, end).includes('process.env')) {
      hits.push({ index: start, computed: Boolean(m[1]) });
    }
  }
  return hits;
}

export function findEnvPassthroughHits(files) {
  const hits = [];
  for (const file of files) {
    const masked = maskCommentsAndStrings(file.content);
    const rawLines = file.content.split('\n');
    const lineOf = (index) => masked.slice(0, index).split('\n').length;
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let m;
      while ((m = pattern.re.exec(masked))) {
        const line = lineOf(m.index);
        hits.push({
          path: file.path,
          line,
          kind: pattern.id,
          describe: pattern.describe,
          snippet: (rawLines[line - 1] ?? '').trim(),
        });
        if (m[0].length === 0) pattern.re.lastIndex += 1;
      }
    }
    for (const { index } of findObjectAssignEnvHits(masked)) {
      const line = lineOf(index);
      hits.push({
        path: file.path,
        line,
        kind: 'object-assign-process-env',
        describe: '`Object.assign(…, process.env)`（丸ごと合成。括弧を挟んだ引数の形も含む）',
        snippet: (rawLines[line - 1] ?? '').trim(),
      });
    }
    for (const { index, computed } of findQuotedEnvKeyHits(file.content, masked)) {
      const line = lineOf(index);
      hits.push({
        path: file.path,
        line,
        kind: computed ? 'computed-env-key-process-env' : 'quoted-env-key-process-env',
        describe: computed
          ? "`['env']: process.env`（計算プロパティ名で丸ごと渡す。丸括弧で包んだ値も含む）"
          : "`'env': process.env`（引用符付きの普通のキーで丸ごと渡す。Issue #2042）",
        snippet: (rawLines[line - 1] ?? '').trim(),
      });
    }
  }
  return hits;
}

export const ALLOWLIST = [
  {
    path: '.github/scripts/update-claude-sdk.test.ts',
    reason:
      '`gitIsolatedEnv()` — git の identity（`GIT_AUTHOR_*` / `GIT_COMMITTER_*`）の' +
      '優先順位を測る歯で、親の env を丸ごと受け継ぐこと自体が前提になっている' +
      '（4つの identity 系の鍵だけを落とし、残りはそのまま通す設計）。' +
      'Issue #1854 の領域 D マネージャーコメント（2026-09-28T02:09:06Z）で' +
      '「直さないと決めたもの」として明示されている。',
  },
  {
    path: 'apps/daemon/src/runner-client.test.ts',
    reason:
      '別担当の領域。Issue #1854 の同コメントが「別担当の領域なので触っていないもの」' +
      'として明示している。この PR（#1935）ではこのファイルを書き換えない。',
  },
  {
    path: 'vitest.env-scrub.test.ts',
    reason:
      '別担当の領域。Issue #1854 の同コメントが「別担当の領域なので触っていないもの」' +
      'として明示している。この PR（#1935）ではこのファイルを書き換えない。',
  },
];

export function classifyEnvPassthroughHits(hits, allowlist) {
  const allowedPaths = new Set(allowlist.map((e) => e.path));
  const violations = hits.filter((h) => !allowedPaths.has(h.path));
  const hitPaths = new Set(hits.map((h) => h.path));
  const stale = allowlist.filter((e) => !hitPaths.has(e.path));
  return { violations, stale };
}

// `missing-env` だけを違反にし、オプションを変数で渡す形（`undeterminable`）は赤にも緑にも倒さない: 静的には判定できないため。
// `ARGS_ARRAY_FAMILY` の分類には局所名ではなく元の名前を使う: 別名（`sp`）を局所名で照らすと、別名経由の呼び出しだけ分類が狂うため。
const CHILD_PROCESS_CALL_NAMES = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
];

const ARGS_ARRAY_FAMILY = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']);

function splitTopLevelByComma(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim().length > 0 || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function findMatchingParenEnd(text, openIdx) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < text.length && depth > 0) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') depth--;
    j++;
  }
  return j;
}

function classifyOptionsObjectLiteral(objText) {
  const inner = objText.slice(1, -1);
  const segments = splitTopLevelByComma(inner);
  let hasEnvKey = false;
  let hasSpread = false;
  for (const seg of segments) {
    if (seg.startsWith('...')) {
      hasSpread = true;
      continue;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(seg) ?? /^([A-Za-z_$][\w$]*)$/.exec(seg);
    if (m && m[1] === 'env') hasEnvKey = true;
  }
  if (hasEnvKey) return 'has-env';
  if (hasSpread) return 'undeterminable';
  return 'missing-env';
}

export function classifyChildProcessCallEnv(kind, args) {
  let rest = args.slice(1);
  if (rest.length > 0) {
    const last = rest[rest.length - 1];
    if (/=>/.test(last) || /^(async\s+)?function\b/.test(last)) {
      rest = rest.slice(0, -1);
    }
  }

  if (!ARGS_ARRAY_FAMILY.has(kind)) {
    if (rest.length === 0) return 'missing-env';
    const candidate = rest[rest.length - 1];
    if (candidate.startsWith('{')) return classifyOptionsObjectLiteral(candidate);
    return 'undeterminable';
  }

  if (rest.length === 0) return 'missing-env';
  if (rest.length === 1) {
    const candidate = rest[0];
    if (candidate.startsWith('[')) return 'missing-env';
    if (candidate.startsWith('{')) return classifyOptionsObjectLiteral(candidate);
    return 'undeterminable';
  }
  const candidate = rest[rest.length - 1];
  if (candidate.startsWith('{')) return classifyOptionsObjectLiteral(candidate);
  return 'undeterminable';
}

function parseNamedBindings(clause, renameToken) {
  const map = new Map();
  const renameRe =
    renameToken === 'as'
      ? /^([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/
      : /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?$/;
  for (const rawPart of clause.split(',')) {
    const part = rawPart.trim().replace(/^type\s+/, '');
    if (!part) continue;
    const m = renameRe.exec(part);
    if (!m) continue;
    const [, orig, alias] = m;
    if (!CHILD_PROCESS_CALL_NAMES.includes(orig)) continue;
    map.set(alias ?? orig, orig);
  }
  return map;
}

// import の節を1つ取ってから中を読む: 既定 import と named・名前空間の併記（`cp, { spawn }`）は、別々の正規表現ではどれにも当たらないため。
const IMPORT_CLAUSE_RE =
  /^[ \t]*import\s*(?!type\b)([^'"`;]*?)\s*from\s*['"](?:node:)?child_process['"]/gm;
const IMPORT_DEFAULT_PART_RE = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/;
const IMPORT_NAMESPACE_PART_RE = /\*\s*as\s+([A-Za-z_$][\w$]*)/;
const IMPORT_NAMED_PART_RE = /\{([^}]*)\}/;
const REQUIRE_OR_IMPORT_NS_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:require|(?:await\s+)?import)\(\s*['"](?:node:)?child_process['"]\s*\)/g;
const REQUIRE_OR_IMPORT_DESTRUCTURE_RE =
  /\b(?:const|let|var)\s*\{\s*([^}]*)\}\s*=\s*(?:require|(?:await\s+)?import)\(\s*['"](?:node:)?child_process['"]\s*\)/g;

function escapeIdentifier(name) {
  return name.replace(/\$/g, '\\$');
}

function findChildProcessBindings(rawContent) {
  const callNameToOriginal = new Map();
  const namespaceLocalNames = new Set();
  let m;

  IMPORT_CLAUSE_RE.lastIndex = 0;
  while ((m = IMPORT_CLAUSE_RE.exec(rawContent))) {
    const clause = m[1];
    const defaultPart = IMPORT_DEFAULT_PART_RE.exec(clause);
    if (defaultPart) namespaceLocalNames.add(defaultPart[1]);
    const namespacePart = IMPORT_NAMESPACE_PART_RE.exec(clause);
    if (namespacePart) namespaceLocalNames.add(namespacePart[1]);
    const namedPart = IMPORT_NAMED_PART_RE.exec(clause);
    if (namedPart) {
      for (const [local, orig] of parseNamedBindings(namedPart[1], 'as')) {
        callNameToOriginal.set(local, orig);
      }
    }
  }

  REQUIRE_OR_IMPORT_DESTRUCTURE_RE.lastIndex = 0;
  while ((m = REQUIRE_OR_IMPORT_DESTRUCTURE_RE.exec(rawContent))) {
    for (const [local, orig] of parseNamedBindings(m[1], ':')) {
      callNameToOriginal.set(local, orig);
    }
  }

  REQUIRE_OR_IMPORT_NS_RE.lastIndex = 0;
  while ((m = REQUIRE_OR_IMPORT_NS_RE.exec(rawContent))) namespaceLocalNames.add(m[1]);

  // 上で集めた名前空間の変数にだけ掛ける: `const { execFile } = other` は束縛にしないため。
  for (const ns of namespaceLocalNames) {
    const re = new RegExp(
      `\\b(?:const|let|var)\\s*\\{\\s*([^}]*)\\}\\s*=\\s*${escapeIdentifier(ns)}(?![\\w$.(\\[])`,
      'g',
    );
    while ((m = re.exec(rawContent))) {
      for (const [local, orig] of parseNamedBindings(m[1], ':')) {
        callNameToOriginal.set(local, orig);
      }
    }
  }

  return { callNameToOriginal, namespaceLocalNames };
}

function findPromisifyAliases(maskedContent, callNameToOriginal, namespaceLocalNames) {
  const aliasMap = new Map();
  // 実在する束縛（`namespaceLocalNames` / `CHILD_PROCESS_CALL_NAMES`）に一致したものだけを別名にする: ただの `other.execFile` は拾わないため。
  const promisifyRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?promisify\(\s*([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\)/g;
  let m;
  while ((m = promisifyRe.exec(maskedContent))) {
    const [, aliasName, first, member] = m;
    if (member === undefined) {
      if (callNameToOriginal.has(first)) aliasMap.set(aliasName, callNameToOriginal.get(first));
    } else if (namespaceLocalNames.has(first) && CHILD_PROCESS_CALL_NAMES.includes(member)) {
      aliasMap.set(aliasName, member);
    }
  }
  return aliasMap;
}

export function findMissingEnvChildProcessCalls(files) {
  const hits = [];
  for (const file of files) {
    const masked = maskCommentsAndStrings(file.content);
    const { callNameToOriginal, namespaceLocalNames } = findChildProcessBindings(file.content);
    if (callNameToOriginal.size === 0 && namespaceLocalNames.size === 0) continue;

    const aliasMap = findPromisifyAliases(masked, callNameToOriginal, namespaceLocalNames);
    const callNameToKind = new Map(callNameToOriginal);
    for (const [alias, orig] of aliasMap) callNameToKind.set(alias, orig);

    const rawLines = file.content.split('\n');

    const scanCall = (displayName, kind, callRe) => {
      let cm;
      while ((cm = callRe.exec(masked))) {
        const openIdx = cm.index + cm[0].length - 1;
        const closeIdxAfter = findMatchingParenEnd(masked, openIdx);
        const argsText = masked.slice(openIdx + 1, closeIdxAfter - 1);
        const args = splitTopLevelByComma(argsText);
        const classification = classifyChildProcessCallEnv(kind, args);
        if (classification !== 'missing-env') continue;
        const line = masked.slice(0, cm.index).split('\n').length;
        hits.push({
          path: file.path,
          line,
          kind: 'missing-env-child-process',
          describe:
            `\`${displayName}(...)\`（\`${kind}\` 系。env オプションを指定していない —— ` +
            '親の process.env を丸ごと継承する）',
          snippet: (rawLines[line - 1] ?? '').trim(),
        });
      }
    };

    for (const [callName, kind] of callNameToKind) {
      scanCall(callName, kind, new RegExp(`(?<![\\w.$])${escapeIdentifier(callName)}\\s*\\(`, 'g'));
    }

    for (const ns of namespaceLocalNames) {
      for (const kind of CHILD_PROCESS_CALL_NAMES) {
        scanCall(
          `${ns}.${kind}`,
          kind,
          new RegExp(`(?<![\\w.$])${escapeIdentifier(ns)}\\.${kind}\\s*\\(`, 'g'),
        );
      }
    }
  }
  return hits;
}

// `ALLOWLIST` と別の一覧にする: 同じファイルが両方の形を含みうるため、混ぜると片方の形だけの許可を表現できない。
export const ALLOWLIST_MISSING_ENV = [];

export function isTargetPath(relPath) {
  const MUTATION_TESTING_DIR = '.claude/skills/mutation-testing/';
  if (relPath.startsWith(MUTATION_TESTING_DIR) && relPath.endsWith('.mjs')) {
    const rest = relPath.slice(MUTATION_TESTING_DIR.length);
    return !rest.includes('/');
  }
  const base = relPath.split('/').pop() ?? '';
  if (/\.test\.tsx?$/.test(base)) return true;
  if (/\.test-support\.tsx?$/.test(base)) return true;
  if (/^test-support\.tsx?$/.test(base)) return true;
  return false;
}

export function listTargetFiles(root) {
  return listGitScannableFiles({ cwd: root }).filter(isTargetPath);
}
