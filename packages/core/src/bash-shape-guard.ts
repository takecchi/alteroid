import { computeQuoteScan } from './bash-wait-guard.js';

// Bash の「形の歯」（#4947 で作業者に、#4949 でマネージャーにも）。依頼文で禁じても破られる形を、機械の門で断って代わりの道を返す。
// 引用符の中・注釈・`<`・`<<<`・`<(...)`・パイプ `|` は断らない（誤検知の防ぎ）。
// 引用符の中でも実行される所だけ中を読む: `bash -c` / `sh -c` の引数（1段）と、二重引用符の中の `$(...)`・バッククォート
// git は、コマンドの位置の `git` の全体の選択肢を読み飛ばした先の下位命令で判定する（`echo git reset` は通す）
// 既知の穴（断らない）: `eval`・変数に入れた命令（`$CMD`）・2段以上の入れ子の `bash -c`

export type BashShapeForm =
  | 'heredoc'
  | 'subst-heredoc'
  | 'redirect'
  | 'fd-dup'
  | 'pipe-stderr'
  | 'sed-in-place'
  | 'node-eval'
  | 'python-c'
  | 'perl-eval'
  | 'git-reset'
  | 'git-force-push'
  | 'git-rebase'
  | 'no-verify'
  | 'gh-merge-auto';

export type BashShapeVerdict =
  { blocked: false } | { blocked: true; form: BashShapeForm; reason: string };

const REASONS: Record<BashShapeForm, string> = {
  heredoc:
    'ヒアドキュメント（`<<EOF`）はこの Bash では使えない。ファイルを作るなら Write、直すなら Edit を使うこと。ファイルへ流し込むためなら、内容を Write でファイルに書いてから、そのパスを引数に渡して実行する。',
  'subst-heredoc':
    '二重引用符の中のコマンド置換（`"$(cat <<\'EOF\' …)"`）やバッククォートの中のヒアドキュメントは、実行されるのでこの Bash では使えない。コミットメッセージや PR の本文は、Write でメッセージのファイルを作り、`git commit -F <絶対パス>`・`gh pr create --body-file <絶対パス>` のようにファイルを渡すこと。',
  redirect:
    '出力のリダイレクト（`>`・`>>`・`>|`・`&>`・`>/dev/null`・`2>/dev/null`）はこの Bash では使えない。ファイルへ書くなら Write を使うこと。出力を捨てるためなら、捨てずに `| tail -n 20` か `| head` で絞る。要る行だけなら `| grep` を使う。',
  'fd-dup':
    '記述子の付け替え（`2>&1`・`>&2`）はこの Bash では使えない。Bash の道具は標準エラーも一緒に返すので要らない。出力を絞るなら、付け替えずに `| tail -n 20` を使うこと。',
  'pipe-stderr':
    '`|&`（標準エラーも一緒にパイプへ流す記述子の付け替え）はこの Bash では使えない。`|` だけでよい。Bash の道具は標準エラーも一緒に返すので、絞るなら `| tail -n 20` を使うこと。',
  'sed-in-place':
    '`sed -i`（`--in-place`・`-Ei`・`-i.bak` を含む）はこの Bash では使えない。ファイルの置き換えは Edit を使うこと。例えば `foo` を `bar` に直すなら、Edit で old_string に `foo`、new_string に `bar` を渡す（同じ語が複数あるなら replace_all を立てるか、前後の行を含めて一意にする）。',
  'node-eval':
    '`node -e`・`--eval`・`-p`・`--print` はこの Bash では使えない。読むだけなら Read か grep を使うこと。処理が要るなら、スクリプトを Write で作業ディレクトリの中に書き、絶対パスで `node /絶対パス/script.mjs` と実行する。',
  'python-c':
    '`python -c`・`python3 -c` はこの Bash では使えない。読むだけなら Read か grep を使うこと。処理が要るなら、スクリプトを Write で作業ディレクトリの中に書き、絶対パスで `python3 /絶対パス/script.py` と実行する。',
  'perl-eval':
    '`perl -e`・`-E`・`-i` はこの Bash では使えない。読むだけなら Read か grep を使うこと。ファイルの置き換えは Edit を使う。処理が要るなら、スクリプトを Write で作業ディレクトリの中に書き、絶対パスで `perl /絶対パス/script.pl` と実行する。',
  'git-reset':
    '`git reset`（`--hard`・`--soft`・`--mixed` を含む全ての形）はこの Bash では使えない。ステージを外すなら `git restore --staged <path>` を使うこと。作業ツリーの変更を捨てる・枝を動かすなら、捨てる前に依頼者へ確かめる。コミットを取り消して戻すなら `git revert <commit>` を使う。',
  'git-force-push':
    '`git push` の `--force`・`--force-with-lease`・`--force-if-includes`・`-f`（`-uf` のような組み合わせを含む）と、`+` で始まる refspec（`git push origin +main`）はこの Bash では使えない。新しいコミットを積んで普通に push すること。履歴を書き換える必要があるなら、新しい枝を切って PR にする。',
  'git-rebase':
    '`git rebase`（`git pull --rebase`・`git pull -r` を含む）はこの Bash では使えない。最新の main を取り込むなら `git merge origin/main` を使うこと。',
  'no-verify':
    '`--no-verify`（git のどの下位命令でも）と `git commit -n` はこの Bash では使えない。フックが落ちたなら、落ちた理由を直してから打ち直すこと。',
  'gh-merge-auto':
    '`gh pr merge --auto` はこの Bash では使えない。CI を前面で `timeout 530 gh run watch <id> --exit-status` で待ち、緑なら `gh pr merge <番号> --squash --match-head-commit <sha>` のように `--match-head-commit` を付けてマージすること。',
};

function blocked(form: BashShapeForm): BashShapeVerdict {
  return { blocked: true, form, reason: REASONS[form] };
}

const SEGMENT_BOUNDARY = new Set([';', '&', '|', '\n', '(', ')', '\u0060']);

// 中を読む入れ子の深さの上限: `bash -c` の引数は最初の1段だけ（depth 0 のときだけ）、コマンド置換は depth 1 まで。無限に再帰しない
const MAX_SUBSTITUTION_DEPTH = 1;

// `$((…))`・`((…))`・`[[ … ]]` の中の `>` は比較で、リダイレクトではない
function computeNonShellRegions(command: string, outside: readonly boolean[]): boolean[] {
  const skip: boolean[] = new Array<boolean>(command.length).fill(false);
  for (let i = 0; i < command.length; i += 1) {
    if (!outside[i]) continue;
    if (command[i] === '(' && command[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < command.length; j += 1) {
        if (!outside[j]) continue;
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      for (let k = i; k <= j && k < command.length; k += 1) skip[k] = true;
      i = j;
    } else if (command[i] === '[' && command[i + 1] === '[') {
      let j = i + 2;
      while (j < command.length && !(outside[j] && command[j] === ']' && command[j + 1] === ']')) {
        j += 1;
      }
      for (let k = i; k <= j + 1 && k < command.length; k += 1) skip[k] = true;
      i = j + 1;
    }
  }
  return skip;
}

function findHeredocOpener(command: string, outside: readonly boolean[]): boolean {
  for (let i = 0; i + 1 < command.length; i += 1) {
    if (!outside[i] || command[i] !== '<' || command[i + 1] !== '<') continue;
    if (command[i - 1] === '<' || command[i + 2] === '<') continue;
    let j = i + 2;
    if (command[j] === '-') j += 1;
    while (command[j] === ' ' || command[j] === '\t') j += 1;
    if (/[A-Za-z_'"\\]/.test(command[j] ?? '')) return true;
  }
  return false;
}

function findRedirect(
  command: string,
  outside: readonly boolean[],
  skip: readonly boolean[],
): 'redirect' | 'fd-dup' | 'pipe-stderr' | undefined {
  for (let i = 0; i < command.length; i += 1) {
    if (!outside[i] || skip[i]) continue;
    if (command[i] === '|' && command[i + 1] === '&') return 'pipe-stderr';
    if (command[i] !== '>') continue;
    if (command[i - 1] === '<') continue;
    let next = i + 1;
    if (command[next] === '>') next += 1;
    if (command[next] === '(' && next === i + 1) continue;
    if (command[next] === '&') return 'fd-dup';
    return 'redirect';
  }
  return undefined;
}

function unquote(token: string): string {
  return token.replace(/['"\\]/g, '');
}

// 語の引用符を、シェルが外すのと同じ順で1段はがす（`bash -c` の引数・バッククォートの中身を取り出すため）
function dequote(token: string): string {
  let out = '';
  for (let i = 0; i < token.length; i += 1) {
    const ch = token.charAt(i);
    if (ch === "'") {
      const j = token.indexOf("'", i + 1);
      if (j < 0) {
        out += token.slice(i + 1);
        break;
      }
      out += token.slice(i + 1, j);
      i = j;
    } else if (ch === '"') {
      i += 1;
      while (i < token.length && token.charAt(i) !== '"') {
        const c = token.charAt(i);
        if (c === '\\' && '"\\$\u0060\n'.includes(token.charAt(i + 1)) && i + 1 < token.length) {
          out += token.charAt(i + 1);
          i += 2;
        } else {
          out += c;
          i += 1;
        }
      }
    } else if (ch === '\\') {
      out += token.charAt(i + 1);
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

// ヒアドキュメントの本文の終わり（終端の行の末尾）の位置を返す。終端が無い・ヒアドキュメントでなければ -1
function heredocEnd(command: string, at: number): number {
  let j = at + 2;
  let dash = false;
  if (command.charAt(j) === '-') {
    dash = true;
    j += 1;
  }
  while (command.charAt(j) === ' ' || command.charAt(j) === '\t') j += 1;
  if (!/[A-Za-z_'"\\]/.test(command.charAt(j))) return -1;
  let delimiter: string;
  const q = command.charAt(j);
  if (q === "'" || q === '"') {
    const close = command.indexOf(q, j + 1);
    if (close < 0) return -1;
    delimiter = command.slice(j + 1, close);
    j = close + 1;
  } else {
    const m = /^\\?([A-Za-z_][A-Za-z0-9_]*)/.exec(command.slice(j));
    if (m === null) return -1;
    delimiter = m[1] ?? '';
    j += m[0].length;
  }
  let lineStart = command.indexOf('\n', j);
  if (lineStart < 0) return -1;
  lineStart += 1;
  while (lineStart <= command.length) {
    let lineEnd = command.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = command.length;
    const line = command.slice(lineStart, lineEnd);
    if ((dash ? line.replace(/^\t+/, '') : line) === delimiter) return lineEnd;
    if (lineEnd >= command.length) return -1;
    lineStart = lineEnd + 1;
  }
  return -1;
}

// `from` は `$(` の直後。対応する `)` の位置を返す（無ければ -1）。入れ子の引用符・括弧・ヒアドキュメントの本文を読み飛ばす
function findMatchingParen(command: string, from: number): number {
  let depth = 1;
  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\') {
      i += 1;
    } else if (ch === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
    } else if (ch === '"') {
      const j = skipDouble(command, i + 1);
      if (j < 0) return -1;
      i = j;
    } else if (
      ch === '<' &&
      command.charAt(i + 1) === '<' &&
      command.charAt(i + 2) !== '<' &&
      command.charAt(i - 1) !== '<'
    ) {
      const end = heredocEnd(command, i);
      if (end >= 0) i = end;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// `from` は開き `"` の直後。閉じ `"` の位置を返す（無ければ -1）
function skipDouble(command: string, from: number): number {
  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\') {
      i += 1;
    } else if (ch === '"') {
      return i;
    } else if (ch === '$' && command.charAt(i + 1) === '(') {
      const close = findMatchingParen(command, i + 2);
      if (close < 0) return -1;
      i = close;
    } else if (ch === '\u0060') {
      const close = findBacktickClose(command, i + 1);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

function findBacktickClose(command: string, from: number): number {
  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === '\u0060') return i;
  }
  return -1;
}

type Substitution = { start: number; end: number; body: string };

// 二重引用符の中の `$(...)` とバッククォートを集める（実行されるので中を読む）。単一引用符・ANSI-C 引用・注釈の中は見ない
// `$((...))`（算術）は集めない
function findQuotedSubstitutions(command: string): Substitution[] {
  const found: Substitution[] = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command.charAt(i);
    if (ch === '\\') {
      i += 2;
    } else if (ch === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) break;
      i = j + 1;
    } else if (ch === '$' && command.charAt(i + 1) === "'") {
      i += 2;
      while (i < n && command.charAt(i) !== "'") i += command.charAt(i) === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '#' && (i === 0 || ' \t\n;&|()'.includes(command.charAt(i - 1)))) {
      const j = command.indexOf('\n', i);
      if (j < 0) break;
      i = j + 1;
    } else if (ch === '"') {
      i += 1;
      while (i < n && command.charAt(i) !== '"') {
        const c = command.charAt(i);
        if (c === '\\') {
          i += 2;
        } else if (c === '$' && command.charAt(i + 1) === '(') {
          const close = findMatchingParen(command, i + 2);
          const end = close < 0 ? n : close + 1;
          if (command.charAt(i + 2) !== '(') {
            found.push({ start: i, end, body: command.slice(i + 2, close < 0 ? n : close) });
          }
          i = end;
        } else if (c === '\u0060') {
          const close = findBacktickClose(command, i + 1);
          const end = close < 0 ? n : close + 1;
          const raw = command.slice(i + 1, close < 0 ? n : close);
          found.push({ start: i, end, body: raw.replace(/\\([\\$\u0060])/g, '$1') });
          i = end;
        } else {
          i += 1;
        }
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return found;
}

// 取り出した置換の範囲を同じ長さの `x` に置き換えた写しを返す（外側の引用符の読み取りが、入れ子の引用符で狂わないようにする）
function maskSubstitutions(command: string, subs: readonly Substitution[]): string {
  let out = '';
  let at = 0;
  for (const s of subs) {
    out += command.slice(at, s.start) + 'x'.repeat(s.end - s.start);
    at = s.end;
  }
  return out + command.slice(at);
}

// 注釈の文字を空白へ置き換えた写しを返す（注釈はここで落とす）
function scrubComments(command: string, comment: readonly boolean[]): string {
  if (!comment.some(Boolean)) return command;
  let out = '';
  for (let i = 0; i < command.length; i += 1) out += comment[i] ? ' ' : command.charAt(i);
  return out;
}

function splitSegments(command: string, outside: readonly boolean[]): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let tokenStart = -1;
  const endToken = (end: number): void => {
    if (tokenStart >= 0) tokens.push(command.slice(tokenStart, end));
    tokenStart = -1;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (outside[i] && SEGMENT_BOUNDARY.has(ch)) {
      endToken(i);
      segments.push(tokens);
      tokens = [];
    } else if (outside[i] && (ch === ' ' || ch === '\t')) {
      endToken(i);
    } else if (tokenStart < 0) {
      tokenStart = i;
    }
  }
  endToken(command.length);
  segments.push(tokens);
  return segments;
}

const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'time',
  'coproc',
  '!',
  '{',
]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

// 前置きの命令ごとに、値を1つ取る短い選択肢
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  setsid: new Set(),
  stdbuf: new Set(['-i', '-o', '-e']),
  chronic: new Set(),
  unbuffer: new Set(),
  caffeinate: new Set(['-t', '-w']),
  xargs: new Set(['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a']),
};

const TIMEOUT_VALUE_OPTIONS = new Set(['-k', '-s', '--signal', '--kill-after']);

type CommandWord = { name: string; args: string[]; rawArgs: string[] };

// コマンドの位置にある語と、その引数を返す（前置きを読み飛ばす）。`rawArgs` は引用符を外す前の引数（`args` と同じ並び）
function commandWordOf(tokens: readonly string[]): CommandWord | undefined {
  const t = tokens.map(unquote);
  let i = 0;
  while (i < t.length) {
    const word = t[i] ?? '';
    const base = word.slice(word.lastIndexOf('/') + 1);
    if (word === '' || KEYWORDS.has(word) || ASSIGNMENT_RE.test(word)) {
      i += 1;
    } else if (base === 'env') {
      i += 1;
      while (i < t.length) {
        const o = t[i] ?? '';
        if (o === '-u' || o === '-C' || o === '-S') i += 2;
        else if (o.startsWith('-') || ASSIGNMENT_RE.test(o)) i += 1;
        else break;
      }
    } else if (base === 'timeout') {
      i += 1;
      while (i < t.length && (t[i] ?? '').startsWith('-')) {
        i += TIMEOUT_VALUE_OPTIONS.has(t[i] ?? '') ? 2 : 1;
      }
      i += 1;
    } else if (WRAPPERS[base] !== undefined) {
      const valued = WRAPPERS[base];
      i += 1;
      while (i < t.length && (t[i] ?? '').startsWith('-')) {
        i += valued?.has(t[i] ?? '') === true ? 2 : 1;
      }
    } else {
      return { name: base, args: t.slice(i + 1), rawArgs: tokens.slice(i + 1) };
    }
  }
  return undefined;
}

// 選択肢の並びを、最初の位置引数（スクリプト名など）まで読む。値を取る選択肢の次の語は読み飛ばす
function optionsBeforeOperand(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '--' || !a.startsWith('-') || a === '-') break;
    out.push(a);
    if (valued.has(a)) i += 1;
  }
  return out;
}

const NODE_VALUED = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '-C',
  '--conditions',
]);
const PYTHON_VALUED = new Set(['-W', '-X', '--check-hash-based-pycs']);

function inspectInterpreter(name: string, args: readonly string[]): BashShapeForm | undefined {
  if (name === 'sed') {
    return args.some(
      (a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='),
    )
      ? 'sed-in-place'
      : undefined;
  }
  if (name === 'node' || name === 'nodejs') {
    const opts = optionsBeforeOperand(args, NODE_VALUED);
    return opts.some(
      (a) => /^-[ep]{1,2}$/.test(a) || a === '--eval' || a === '--print' || a.startsWith('--eval='),
    )
      ? 'node-eval'
      : undefined;
  }
  if (/^python[0-9.]*$/.test(name)) {
    const opts = optionsBeforeOperand(args, PYTHON_VALUED);
    for (const a of opts) {
      if (/^-[bBdEiIOPqsSuvxR]*c/.test(a)) return 'python-c';
      if (/^-[bBdEiIOPqsSuvxR]*m/.test(a)) return undefined;
    }
    return undefined;
  }
  if (name === 'perl') {
    const opts = optionsBeforeOperand(args, new Set());
    return opts.some((a) => /^-[0-9acdfFlnpsStTuUvwWX]*[eEi]/.test(a)) ? 'perl-eval' : undefined;
  }
  return undefined;
}

// 値を取る選択肢（`-C <path>`・`-c <k=v>`・`--git-dir <path>` など）。`--git-dir=…` のように `=` で続けた形は1語なので、ここに無くても読み飛ばせる
const GIT_GLOBAL_VALUED = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);

// コマンドの位置の `git` の全体の選択肢（`--no-pager`・`-P`・`-C <path>` など）を読み飛ばした先の下位命令
function gitSubcommandOf(args: readonly string[]): { sub: string; rest: string[] } | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (!a.startsWith('-')) return { sub: a, rest: args.slice(i + 1) };
    if (GIT_GLOBAL_VALUED.has(a)) i += 1;
  }
  return undefined;
}

// 短い選択肢の組み合わせ（`-uf`）に `flag` があるか。値を取る文字（`valueChars`）に当たったら、その先は値なので読まない
function hasShortFlag(args: readonly string[], flag: string, valueChars: string): boolean {
  for (const a of args) {
    if (!a.startsWith('-') || a.startsWith('--') || a.length < 2) continue;
    for (const ch of a.slice(1)) {
      if (ch === flag) return true;
      if (valueChars.includes(ch)) break;
    }
  }
  return false;
}

function isForcePush(rest: readonly string[]): boolean {
  if (hasShortFlag(rest, 'f', 'o')) return true;
  return rest.some(
    (a) =>
      a === '--force' ||
      a === '--force-with-lease' ||
      a.startsWith('--force-with-lease=') ||
      a === '--force-if-includes' ||
      (!a.startsWith('-') && a.startsWith('+')),
  );
}

function inspectGit(args: readonly string[]): BashShapeForm | undefined {
  const g = gitSubcommandOf(args);
  if (g === undefined) return undefined;
  const dd = g.rest.indexOf('--');
  const opts = dd < 0 ? g.rest : g.rest.slice(0, dd);
  if (opts.includes('--no-verify')) return 'no-verify';
  switch (g.sub) {
    case 'reset':
      return 'git-reset';
    case 'rebase':
      return 'git-rebase';
    case 'pull':
      return hasShortFlag(opts, 'r', 'sXSj') ||
        opts.some((a) => a === '--rebase' || (a.startsWith('--rebase=') && a !== '--rebase=false'))
        ? 'git-rebase'
        : undefined;
    case 'push':
      return isForcePush(g.rest) ? 'git-force-push' : undefined;
    case 'commit':
      return hasShortFlag(opts, 'n', 'mFCctSu') ? 'no-verify' : undefined;
    default:
      return undefined;
  }
}

function inspectGh(args: readonly string[]): BashShapeForm | undefined {
  const positional: string[] = [];
  for (let i = 0; i < args.length && positional.length < 2; i += 1) {
    const a = args[i] ?? '';
    if (a.startsWith('-')) {
      if (a === '-R' || a === '--repo') i += 1;
    } else {
      positional.push(a);
    }
  }
  return positional[0] === 'pr' && positional[1] === 'merge' && args.includes('--auto')
    ? 'gh-merge-auto'
    : undefined;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

// `bash -c '<script>'` の `<script>`（引用符を外す前の語）。`-lc`・`-ec` のような組み合わせも読む
function shellScriptOperand(rawArgs: readonly string[]): string | undefined {
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = unquote(rawArgs[i] ?? '');
    if (a === '--' || !(a.startsWith('-') || a.startsWith('+')) || a === '-') return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return rawArgs[i + 1];
    if (a === '-o' || a === '+o' || a === '-O' || a === '+O') i += 1;
  }
  return undefined;
}

export function inspectBashShape(command: string, depth = 0): BashShapeVerdict {
  const subs = depth <= MAX_SUBSTITUTION_DEPTH ? findQuotedSubstitutions(command) : [];
  const visible = subs.length > 0 ? maskSubstitutions(command, subs) : command;

  const scan = computeQuoteScan(visible);
  const outside = scan.outside;

  if (findHeredocOpener(visible, outside)) return blocked('heredoc');

  const skip = computeNonShellRegions(visible, outside);
  const redirect = findRedirect(visible, outside, skip);
  if (redirect !== undefined) return blocked(redirect);

  const scrubbed = scrubComments(visible, scan.comment);
  const tokenMask = outside.map((o, i) => o || scan.comment[i] === true);
  for (const tokens of splitSegments(scrubbed, tokenMask)) {
    const word = commandWordOf(tokens);
    if (word === undefined) continue;
    const form = inspectInterpreter(word.name, word.args);
    if (form !== undefined) return blocked(form);
    if (word.name === 'git') {
      const gitForm = inspectGit(word.args);
      if (gitForm !== undefined) return blocked(gitForm);
    } else if (word.name === 'gh') {
      const ghForm = inspectGh(word.args);
      if (ghForm !== undefined) return blocked(ghForm);
    } else if (depth === 0 && SHELLS.has(word.name)) {
      const script = shellScriptOperand(word.rawArgs);
      if (script !== undefined) {
        const inner = inspectBashShape(dequote(script), depth + 1);
        if (inner.blocked) return inner;
      }
    }
  }

  for (const sub of subs) {
    const inner = inspectBashShape(sub.body, depth + 1);
    if (!inner.blocked) continue;
    return inner.form === 'heredoc' ? blocked('subst-heredoc') : inner;
  }
  return { blocked: false };
}
